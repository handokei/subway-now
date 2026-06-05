/**
 * Trip waypoint advance progress — POST /trips race로부터 격리된 별도 KV 키 (#705).
 *
 * 배경:
 *   Trip 객체에 `waypoints`가 직접 포함되어 있어, 디바이스가 cold restart 후 동일
 *   trip을 재등록하면 backend가 advance해둔 waypoints가 wipe되는 race가 존재했다
 *   (#704는 isSameSession 강화로 같은 trainCode면 보존하지만, 진정한 격리는 advance
 *   상태를 trip 객체 밖으로 빼야 가능).
 *
 * 설계:
 *   - 키: `progress:<token>` (TRIPS KV 재사용 — 새 namespace 도입 비용 회피)
 *   - 값: shiftedCount + 추적 baseline. trainCode를 stamp해 다른 열차로 갈아탄
 *         새 세션이면 fresh start로 동작.
 *   - POST /trips: progress.trainCode가 incoming.boardingLock.trainCode와 같으면
 *     `incoming.waypoints.slice(progress.shiftedCount)`로 진행분을 잘라낸다.
 *     트레인이 다르면 progress는 무시 (호출부가 clearProgress).
 *   - advanceBoardingLockWaypoint: shiftedCount += 1과 baseline reset을 progress에 기록.
 *   - runTrainCodeTracking: 성공/실패 사이클에서 baseline(consecutiveEtaMissing,
 *     lastTrackedArrivalEpoch, lastLaPushEpoch)도 progress에 mirror해 race에 무관하게 유지.
 */

const PROGRESS_PREFIX = 'progress:';

export interface TripProgress {
  /** trainCode stamp. POST 시 incoming lock과 비교해 다른 열차면 progress 폐기. */
  trainCode: string;
  /** advance로 shift한 waypoint 개수. POST의 incoming.waypoints에 slice(shiftedCount) 적용. */
  shiftedCount: number;
  /** Trip의 lastTrackedArrivalEpoch 사본 — race-isolated. */
  lastTrackedArrivalEpoch?: number;
  /** Trip의 lastLaPushEpoch 사본. */
  lastLaPushEpoch?: number;
  /** Trip의 lastLaPushAt(wall-clock) 사본 — #900 heartbeat 게이트 기준점. */
  lastLaPushAt?: number;
  /** Trip의 consecutiveEtaMissing 사본. */
  consecutiveEtaMissing?: number;
}

export function progressKey(token: string): string {
  return `${PROGRESS_PREFIX}${token}`;
}

/**
 * caller가 KV `cacheTtl`을 지정하기 위한 옵션.
 * cron path는 cacheTtl=10s를 명시해 PUT 직후 stale read를 방지한다 (#766).
 * POST handler는 인자 없이 호출 — 기본 cacheTtl(60s)이 적용된다.
 */
export interface GetProgressOptions {
  cacheTtl?: number;
}

export async function getProgress(
  kv: KVNamespace,
  token: string,
  options?: GetProgressOptions,
): Promise<TripProgress | null> {
  const raw = await kv.get(progressKey(token), options);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as TripProgress;
    if (typeof parsed.trainCode !== 'string' || typeof parsed.shiftedCount !== 'number') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function putProgress(
  kv: KVNamespace,
  token: string,
  progress: TripProgress,
  ttlSec: number,
): Promise<void> {
  await kv.put(progressKey(token), JSON.stringify(progress), {
    expirationTtl: Math.max(60, Math.floor(ttlSec)),
  });
}

export async function deleteProgress(kv: KVNamespace, token: string): Promise<void> {
  await kv.delete(progressKey(token));
}
