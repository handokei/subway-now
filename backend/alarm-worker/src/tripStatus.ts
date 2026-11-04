/**
 * Trip status retention KV (#1339, Epic #1204) — killed-app launch reconciliation 백스톱.
 *
 * iOS가 silent push로 trip-ended cleanup을 진행하지 못한 채 종료(앱 kill / push drop / 디바이스 OFF)된
 * 케이스에서, 디바이스가 다음 launch 시 backend에 trip 상태를 조회해 stale route/destination/lock
 * state를 자체 정리할 수 있도록 ended 마커를 1h TTL로 보존한다.
 *
 * Key: `tripStatus:<token>`
 * Value: `{ endedAt: number, endReason: TripStatusEndReason }`
 *
 * 발사 진입점은 단일 — `cleanupTripWithLa` (liveActivity.ts). scheduled.ts의 4곳 trip-end
 * 호출자(L305 expired / L878 eta-missing / L1049 destination-arrived / L1260 push-unrecoverable)
 * 가 모두 그 wrapper를 통과한다. HTTP DELETE 경로는 reason 미지정이라 status 미기록 — 사용자
 * 명시 종료는 디바이스가 이미 정리한 상태라 launch reconciliation 대상이 아니다.
 */

import type { TripEndedReason } from './types';

const TRIP_STATUS_PREFIX = 'tripStatus:';

/**
 * 외부 응답에 노출하는 endReason — `destination-arrived` → `destination`로 축약 (contract).
 * `seoul-outage` (#1663) — Seoul API HTTP error로 인한 false-end. #1425 cooldown 면제 대상.
 *
 * #2196 (ADR-025 cleanup) — 'rotated'(#2174)/'superseded-by-reregister'(#2175)는 rotation 폐기
 * (#2194)로 발생부가 없어져 제거. 남은 legacy KV 엔트리(TTL 7일 내 자연 만료)는
 * `readTripEndedStatus`가 unknown value로 처리해 null 반환 — "trip 미발견"과 동등하게 degrade된다.
 */
export type TripStatusEndReason =
  | 'expired'
  | 'eta-missing'
  | 'seoul-outage'
  | 'destination'
  | 'push-unrecoverable';

export interface TripStatusRecord {
  endedAt: number;
  endReason: TripStatusEndReason;
  /**
   * #3005 PR-D-b — 종료된 trip 인스턴스의 corrId. status 보존이 10h로 늘어 같은 token의 이전 trip marker가
   * 현재 trip 조회에 섞일 수 있으므로, device가 현재 corrId와 대조해 다르면 ended로 보지 않게 한다.
   * trip이 corrId를 보유하지 않았거나 구 레코드면 생략.
   */
  corrId?: string;
}

/**
 * GET /trips/:token/status 응답 보존 윈도우. `now - endedAt` 이 이 값을 넘으면 410(expired-retention).
 * #3005 PR-D-b — 기기 Signal 4 판정 상한(`SIGNAL_4_KTX_ETA_UPPER_BOUND_MS`=10h)과 맞춘다.
 * 1h였을 때 종료 61분 뒤 조회가 410이라 기기가 backend 확정 종료를 받지 못했다(11/03 실측).
 */
export const TRIP_STATUS_RETENTION_MS = 10 * 60 * 60 * 1000;

/**
 * #1425 — 같은 token 재등록 쿨다운. status 보존(`TRIP_STATUS_RETENTION_MS`)과 분리해 1h 유지한다
 * (보존만 늘리고 쿨다운이 같이 늘면 정상 재등록이 10h 막힌다).
 */
export const REGISTER_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * KV expirationTtl — 정확한 만료 응답을 위해 retention보다 충분히 길게 잡는다.
 * `now - endedAt` 기반 410 판정과 별개로, KV가 자연 폐기되면 404로 떨어진다 (record 자체가 사라짐).
 * 7d면 운영 디버깅 윈도우로도 충분.
 */
export const TRIP_STATUS_TTL_SEC = 7 * 24 * 60 * 60;

export function tripStatusKey(token: string): string {
  return `${TRIP_STATUS_PREFIX}${token}`;
}

/**
 * TripEndedReason(내부 enum) → TripStatusEndReason(외부 contract) 매핑.
 * 클라이언트 API 응답은 `destination`으로 축약 — `destination-arrived`는 backend 내부 식별자라
 * 외부 노출 표면에는 단축형이 깔끔하다.
 * `seoul-outage` (#1663) — 1:1 pass-through. POST /trips 핸들러가 cooldown 면제 분기에 사용.
 * `la-stale-backstop` (#1933) — 외부 contract는 `expired`로 매핑 — client 기존 graceful handler가
 *   그대로 동작 (#1652 force-end가 'expired' 재사용한 backward-compat 패턴과 동일).
 *   backend log/stat은 `la-stale-backstop` 그대로 유지해 회귀 분석 가시성 보존.
 */
export function toTripStatusEndReason(reason: TripEndedReason): TripStatusEndReason {
  if (reason === 'destination-arrived') return 'destination';
  return toExternalTripEndedReason(reason) as TripStatusEndReason;
}

/**
 * backend 내부 전용 종료 사유 → 클라이언트가 아는 `TripEndedReason`. 내부 식별자는 D1/log에만 남기고
 * 외부 표면(alert push payload `reason`, trip status 마커)에는 기존 `'expired'`로 노출한다(client enum 불변).
 * - `la-stale-backstop` (#1933), `end-prompt-timeout` (#3007 PR-3).
 */
const INTERNAL_ONLY_END_REASONS: ReadonlySet<TripEndedReason> = new Set(['la-stale-backstop', 'end-prompt-timeout']);
export function toExternalTripEndedReason(reason: TripEndedReason): TripEndedReason {
  return INTERNAL_ONLY_END_REASONS.has(reason) ? 'expired' : reason;
}

/**
 * `cleanupTripWithLa`가 reason과 함께 호출될 때 trip 종료 마커를 KV에 기록한다.
 * 호출은 graceful — KV write 실패는 cleanup 흐름을 차단하지 않는다 (라우트 핸들러에서 catch).
 */
export async function writeTripEndedStatus(
  kv: KVNamespace,
  token: string,
  reason: TripEndedReason,
  now: number,
  corrId?: string,
): Promise<void> {
  const record: TripStatusRecord = {
    endedAt: now,
    endReason: toTripStatusEndReason(reason),
    ...(corrId ? { corrId } : {}),
  };
  await kv.put(tripStatusKey(token), JSON.stringify(record), {
    expirationTtl: TRIP_STATUS_TTL_SEC,
  });
}

/**
 * #2144 — 같은 token으로 새 trip이 성공 등록되면 옛 종료 마커는 더 이상 유효하지 않다.
 * 호출은 register 성공 경로에서 cooldown 판정(bypass 분기 포함) **뒤**에 실행해야 한다 —
 * 먼저 지우면 `readTripEndedStatus` 기반 #1425 cooldown/#1663 bypass 판정이 무력화된다.
 */
export async function deleteTripEndedStatus(kv: KVNamespace, token: string): Promise<void> {
  await kv.delete(tripStatusKey(token));
}

/**
 * 저장된 trip 종료 마커 조회. JSON parse 실패 또는 schema 불일치 시 null 반환 — KV 손상 엔트리는
 * 미존재와 동일하게 처리(launch reconciliation은 best-effort, fail-soft).
 */
export async function readTripEndedStatus(
  kv: KVNamespace,
  token: string,
): Promise<TripStatusRecord | null> {
  const raw = await kv.get(tripStatusKey(token));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TripStatusRecord>;
    if (typeof parsed.endedAt !== 'number') return null;
    if (
      parsed.endReason !== 'expired' &&
      parsed.endReason !== 'eta-missing' &&
      parsed.endReason !== 'seoul-outage' &&
      parsed.endReason !== 'destination' &&
      parsed.endReason !== 'push-unrecoverable'
    ) {
      return null;
    }
    const { endedAt, endReason, corrId } = parsed;
    return {
      endedAt,
      endReason,
      ...(typeof corrId === 'string' && corrId ? { corrId } : {}),
    };
  } catch {
    return null;
  }
}
