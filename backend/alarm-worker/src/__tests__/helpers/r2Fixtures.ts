/**
 * R2 archive 테스트 fixture — #1621 alarmLogStats.test.ts / baselineCheck.test.ts 공용.
 *
 * `alarmLogForward.ts:storeAlarmLogForward`가 archive하는 ndjson 본문과 customMetadata
 * tripEndedAt을 mimic해, R2Bucket.list + R2Bucket.get을 in-memory로 구현한다.
 *
 * Sonar dup 사전 차단 — 두 테스트 파일에서 같은 mock 로직을 직접 작성하면 100+ token 중복이
 * 검출된다 ([[lesson_sonarcloud_dup_prevention]]).
 */

export interface FakeR2Archive {
  /** R2 key, 보통 `trip-evidence/YYYY/MM/DD/{tokenPrefix}-{tripStartedAt}.ndjson` */
  key: string;
  /** customMetadata.tripEndedAt 으로 채워질 epoch ms — 윈도우 판정 source */
  tripEndedAt: number;
  /** ndjson 본문 — `buildAlarmLogNdjson` helper로 생성 */
  body: string;
}

/**
 * `alarmLog` kind 1줄 + header를 가진 ndjson 본문 빌더.
 *
 * 실 운영 ndjson은 6 line(header / alarmLog / fusionLog / gpsDrops / backendSsotSnapshot /
 * deviceMetadata)이지만 stats 산출엔 alarmLog만 필요하므로 최소 2 line으로 축약.
 */
export function buildAlarmLogNdjsonFixture(
  entries: Array<{ source?: string; outcome?: string; reason?: string; stationName?: string }>,
  tripEndedAt: number,
): string {
  return [
    JSON.stringify({ kind: 'header', tripEndedAt }),
    JSON.stringify({ kind: 'alarmLog', entries }),
  ].join('\n');
}

/**
 * In-memory R2Bucket double. `list` + `get`만 구현 — alarmLogStats/baselineCheck이 사용하는 표면.
 *
 * 페이지네이션은 `pageSize`(default Infinity)로 강제할 수 있어 cursor 회귀 테스트 가능.
 */
export function makeFakeR2(
  archives: FakeR2Archive[],
  pageSize = Number.POSITIVE_INFINITY,
): R2Bucket {
  return {
    async list({
      prefix,
      cursor,
      limit,
      include,
    }: {
      prefix?: string;
      cursor?: string;
      limit?: number;
      include?: ('httpMetadata' | 'customMetadata')[];
    }) {
      const matching = archives.filter((a) => !prefix || a.key.startsWith(prefix));
      const startIdx = cursor ? Number.parseInt(cursor, 10) : 0;
      const cap = Math.min(limit ?? matching.length, pageSize);
      const page = matching.slice(startIdx, startIdx + cap);
      const endIdx = startIdx + page.length;
      const truncated = endIdx < matching.length;
      // #2116 — 실 Cloudflare R2 runtime은 `include: ['customMetadata']`를 명시하지
      // 않으면 listed object에 customMetadata를 채우지 않는다. 이 mock도 동일 제약을
      // 재현해야 alarmLogStats.ts가 include 누락 시 회귀를 테스트에서 잡을 수 있다.
      const includeCustomMetadata = include?.includes('customMetadata') ?? false;
      return {
        objects: page.map((a) => ({
          key: a.key,
          ...(includeCustomMetadata
            ? { customMetadata: { tripEndedAt: String(a.tripEndedAt) } }
            : {}),
        })),
        truncated,
        cursor: truncated ? String(endIdx) : undefined,
      };
    },
    async get(key: string) {
      const archive = archives.find((a) => a.key === key);
      if (!archive) return null;
      return { async text() { return archive.body; } };
    },
  } as unknown as R2Bucket;
}

/** 빈 archive R2 — endpoint binding/auth 회귀 테스트가 자주 쓴다. */
export function makeEmptyFakeR2(): R2Bucket {
  return makeFakeR2([]);
}
