/**
 * #2230 — `maybeReschedulePush` per-station once dedup.
 *
 * 선결 조사 결론: #2202는 sleepMode OFF(매역 사전예약) 소비자만 퇴역시켰다. reschedule push의
 * 나머지 소비자(`silentPushTask.applyReschedule` → sleepMode ON → `rescheduleSafetyNetAlarm`)는
 * #2202 이후에도 실제로 안전망 알람을 재조정하므로 vestigial이 아니다 — reschedule push 자체를
 * 제거하면 취침모드 안전망 정정 채널이 사라진다. 따라서 발사 경로는 보존하고 dedup만 보강한다.
 *
 * RCA(2026-08-09 실기기 dump): 기존 억제는 motion=stationary 게이트 + `lastTrackedArrivalEpoch`
 * 15s 델타 임계뿐이었다. destination ETA가 매 cron(60s)마다 15s+ 드리프트하면 무한 반복
 * 발사한다(불광 도착 후 15:57~16:03 6회). 같은 (tripToken, stationName) 조합은 TTL 동안 1회만
 * 발사하도록 KV once-dedup을 추가한다.
 *
 * TTL은 `scheduled.ts`의 `POLLING_WINDOW_MS`(5분)와 같은 5분 값을 사용한다(독립 상수 — 두 값이
 * 의미적으로 결합돼 있지는 않다). 그 안에서는 이미 한 번 정정 신호를 보냈으므로 추가 발사 가치가
 * 낮고, 5분 밖에서는 여전히 ETA가 크게 벌어져 있다면 재발사를 허용한다.
 */

const RESCHEDULE_FIRE_PREFIX = 'reschedule-fire:';

/** `scheduled.ts`의 `POLLING_WINDOW_MS`와 같은 5분(300s) — 별도 정의된 독립 상수. */
export const RESCHEDULE_FIRE_DEDUP_TTL_SEC = 300;

export function rescheduleFireKey(tripToken: string, stationName: string): string {
  return `${RESCHEDULE_FIRE_PREFIX}${tripToken}|${stationName}`;
}

/** 같은 (tripToken, stationName)에 TTL 내 이미 reschedule push를 발사했는지 확인. */
export async function hasRescheduleFired(
  kv: KVNamespace,
  tripToken: string,
  stationName: string,
): Promise<boolean> {
  return (await kv.get(rescheduleFireKey(tripToken, stationName))) !== null;
}

/** 발사 직후 dedup marker stamp. */
export async function markRescheduleFired(
  kv: KVNamespace,
  tripToken: string,
  stationName: string,
): Promise<void> {
  await kv.put(rescheduleFireKey(tripToken, stationName), '1', {
    expirationTtl: RESCHEDULE_FIRE_DEDUP_TTL_SEC,
  });
}
