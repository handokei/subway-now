/**
 * Device alarmLog forward → R2 archive (#1579, Phase 0 epic #1576 — P0-3).
 *
 * Device가 trip 종료 시 `POST /telemetry/alarm-log`로 alarmLog 200 + fusionLog 200 + gpsDrops
 * + backendSsotSnapshot + deviceMetadata를 한 번 보낸다. 본 모듈이 payload 검증 + R2 put을
 * 담당. handler는 index.ts에 inline 등록 (기존 라우트 패턴과 동형).
 *
 * R2 key: `trip-evidence/YYYY/MM/DD/{tokenPrefix}-{tripStartedAt}.ndjson`
 *   - tokenPrefix는 8자 prefix (`tokenPrefix(token)`와 동일 PII 정책).
 *   - tripStartedAt epoch ms로 같은 device의 동시 trip 충돌 차단.
 *   - YYYY/MM/DD는 tripStartedAt UTC 기준 — operator가 prefix list로 일자별 조회 가능.
 *
 * Body: ndjson (1줄 = JSON 객체). 7줄: header + alarmLog 1줄 + fusionLog 1줄
 *   + fusionTierLog 1줄(#1706) + gpsDrops 1줄 + ssotSnapshot 1줄 + deviceMetadata 1줄.
 *   사후 분석 도구가 줄 단위 stream parse 가능.
 *
 * R2 lifecycle 90일 삭제는 Cloudflare Dashboard에서 운영자가 수동 설정 (PR 본문 참고).
 *
 * Privacy:
 *   - token은 8자 prefix만 R2 key/customMetadata에 적재 (원문 미저장).
 *   - alarmLog/fusionLog/gpsDrops/ssot는 device fusion 측정값 — 원문 사용자 식별자 없음.
 */
import { tokenPrefix } from './telemetry';

/**
 * entries cap — alarmLog 200 + fusionLog 200 + fusionTierLog 200 + gpsDrops 100 = 700 + overhead.
 * 1500 cap.
 */
export const MAX_ENTRIES_PER_BUCKET = 1500;

/** R2 key prefix. */
export const ALARM_LOG_FORWARD_KEY_PREFIX = 'trip-evidence/';

export interface AlarmLogForwardUpload {
  token: string;
  tripStartedAt: number;
  tripEndedAt: number;
  alarmLog: unknown[];
  fusionLog: unknown[];
  /**
   * #1706 — fusion picker tier 별 ring buffer entries.
   * alarmLog ring 점령 회귀 차단을 위해 device-side에서 분리된 채널.
   * alarmLogStats.ts의 `obj.kind !== 'alarmLog'` 필터로 자동 stats에서 제외 — fusion-picker-tier
   * 가 sources/reasons 분포를 점령하지 않는다.
   */
  fusionTierLog: unknown[];
  gpsDrops: unknown[];
  backendSsotSnapshot: unknown;
  deviceMetadata: {
    os: string;
    appVersion?: string;
    locale?: string;
  };
}

function isStringRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object';
}

export function validateAlarmLogForward(input: unknown): AlarmLogForwardUpload | null {
  if (!isStringRecord(input)) return null;
  const {
    token,
    tripStartedAt,
    tripEndedAt,
    alarmLog,
    fusionLog,
    fusionTierLog,
    gpsDrops,
    backendSsotSnapshot,
    deviceMetadata,
  } = input;
  if (typeof token !== 'string' || token.length === 0) return null;
  if (typeof tripStartedAt !== 'number' || tripStartedAt <= 0) return null;
  if (typeof tripEndedAt !== 'number' || tripEndedAt < tripStartedAt) return null;
  if (!Array.isArray(alarmLog) || alarmLog.length > MAX_ENTRIES_PER_BUCKET) return null;
  if (!Array.isArray(fusionLog) || fusionLog.length > MAX_ENTRIES_PER_BUCKET) return null;
  // #1706 — fusionTierLog는 신규 채널. 누락 시 기본값 [] 허용(구 device 호환). 배열이면 cap 검증.
  let safeFusionTierLog: unknown[];
  if (fusionTierLog === undefined) {
    safeFusionTierLog = [];
  } else if (Array.isArray(fusionTierLog) && fusionTierLog.length <= MAX_ENTRIES_PER_BUCKET) {
    safeFusionTierLog = fusionTierLog;
  } else {
    return null;
  }
  if (!Array.isArray(gpsDrops) || gpsDrops.length > MAX_ENTRIES_PER_BUCKET) return null;
  if (!isStringRecord(deviceMetadata)) return null;
  if (typeof deviceMetadata.os !== 'string') return null;
  return {
    token,
    tripStartedAt,
    tripEndedAt,
    alarmLog,
    fusionLog,
    fusionTierLog: safeFusionTierLog,
    gpsDrops,
    backendSsotSnapshot: backendSsotSnapshot ?? null,
    deviceMetadata: {
      os: deviceMetadata.os,
      appVersion:
        typeof deviceMetadata.appVersion === 'string'
          ? deviceMetadata.appVersion
          : undefined,
      locale:
        typeof deviceMetadata.locale === 'string' ? deviceMetadata.locale : undefined,
    },
  };
}

/** `trip-evidence/YYYY/MM/DD/{tokenPrefix}-{tripStartedAt}.ndjson` */
export function buildR2Key(upload: AlarmLogForwardUpload): string {
  const d = new Date(upload.tripStartedAt);
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = d.getUTCDate().toString().padStart(2, '0');
  const prefix = tokenPrefix(upload.token);
  return `${ALARM_LOG_FORWARD_KEY_PREFIX}${yyyy}/${mm}/${dd}/${prefix}-${upload.tripStartedAt}.ndjson`;
}

/** ndjson — 줄 단위 stream parse 가능한 형태로 직렬화. */
export function buildNdjsonBody(upload: AlarmLogForwardUpload): string {
  const lines = [
    {
      kind: 'header',
      tokenPrefix: tokenPrefix(upload.token),
      tripStartedAt: upload.tripStartedAt,
      tripEndedAt: upload.tripEndedAt,
      durationMs: upload.tripEndedAt - upload.tripStartedAt,
      uploadedAt: Date.now(),
    },
    { kind: 'alarmLog', entries: upload.alarmLog },
    { kind: 'fusionLog', entries: upload.fusionLog },
    // #1706 — fusion picker tier 별 채널. alarmLogStats가 `obj.kind !== 'alarmLog'` 필터로 제외.
    { kind: 'fusionTierLog', entries: upload.fusionTierLog },
    { kind: 'gpsDrops', entries: upload.gpsDrops },
    { kind: 'backendSsotSnapshot', value: upload.backendSsotSnapshot },
    { kind: 'deviceMetadata', value: upload.deviceMetadata },
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n');
}

/** R2 put with customMetadata. R2Bucket subset만 사용 — test mock 표면 최소화. */
export async function storeAlarmLogForward(
  r2: R2Bucket,
  upload: AlarmLogForwardUpload,
): Promise<{ key: string; size: number }> {
  const key = buildR2Key(upload);
  const body = buildNdjsonBody(upload);
  await r2.put(key, body, {
    httpMetadata: { contentType: 'application/x-ndjson' },
    customMetadata: {
      tokenPrefix: tokenPrefix(upload.token),
      tripStartedAt: String(upload.tripStartedAt),
      tripEndedAt: String(upload.tripEndedAt),
      deviceOs: upload.deviceMetadata.os,
    },
  });
  return { key, size: body.length };
}
