/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: gone 판정 입력(alarm 스토리지·OS 예약) + destination store(route 슬라이스) +
 * 종료 정본 시퀀스를 한 곳에서 묶는다. `tripEndedCleanupSequence.ts`와 동형 orchestrator.
 */
/**
 * B 최소판(PR-2) — backend 404/410 확정 시 device 자가 종료. launch reconciliation 과 FG tick 이 공유한다.
 *
 * 순서: 입력 수집 -> `decideTripGone` -> (end) 종료 행동 claim -> 통지 -> alarmLog -> 정본 종료 시퀀스.
 * 통지는 cleanup **앞**: corrId(dedupe 키)와 ACTIVE_TRIP_KEY(data.tripToken)가 cleanup에서 지워진다.
 * claim은 9h force-end / 일시정지와 공유(`claimTripEndAction`) — 같은 launch에서 동시에 통과해 이중 종료되는
 * 경쟁을 동기 check-and-set으로 직렬화한다. 종료가 실패하면 claim을 풀고 오류를 전파한다(호출부가 graceful).
 *
 * BG pull(silent-push / bg-location-tick)은 이 함수를 부르지 않는다 — gone을 `alive`로 두는 기존 보수 동작 유지.
 */
import { useDestinationStore } from '../../route/store/useDestinationStore';
import { createLogger } from '../../../shared/utils/logger';
import type { TripStatusFetchResult } from '../api/tripStatus';
import { appendAlarmLog } from './alarmLog';
import { getBoardingLock } from './boardingLockStorage';
import { claimTripEndAction } from './tripEndClaim';
import { cleanupBackendGoneTrip } from './tripEndedCleanupSequence';
import { notifyTripEnded } from './tripEndedNotification';
import { decideTripGone, hasFutureTripArrivalAlarm } from './tripGone';
import { getTripStartedAt } from './tripStartStorage';

const logger = createLogger('tripGoneSelfEnd');

export type TripGoneSite = 'launch' | 'fg-tick';

/**
 * - `ended`    : 종료를 수행했다.
 * - `young`    : 하한 미충족(전파 지연 가능) — launch는 기존 동작(키 삭제 = heal 재등록)을 유지한다.
 * - `deferred` : lock/알람 가드로 유예 — 키를 보존해 다음 pull이 재시도한다.
 * - `skipped`  : 다른 경로가 같은 종료를 먼저 선점했다.
 * - `not-gone` : gone 응답이 아니다.
 */
export type TripGoneOutcome = 'ended' | 'young' | 'deferred' | 'skipped' | 'not-gone';

export interface HandleTripGoneInput {
  result: TripStatusFetchResult;
  tripToken: string;
  site: TripGoneSite;
}

export async function handleTripGone(input: HandleTripGoneInput): Promise<TripGoneOutcome> {
  const { result, tripToken, site } = input;
  if (result.status !== 'gone') return 'not-gone';

  const now = Date.now();
  const [tripStartedAt, lock, hasFutureArrivalAlarm] = await Promise.all([
    getTripStartedAt(),
    getBoardingLock(),
    hasFutureTripArrivalAlarm(tripToken),
  ]);
  const decision = decideTripGone({ result, now, tripStartedAt, lock, hasFutureArrivalAlarm });
  if (decision.verdict === 'defer') {
    const { reason } = decision;
    appendAlarmLog({
      ts: now,
      source: 'lifecycle-backstop',
      outcome: 'suppressed',
      reason: `trip-gone-defer-${reason}`,
      stationName: `site=${site};code=${result.code}`,
    });
    logger.info(`gone(${result.code}) 유예: ${reason} (site=${site})`);
    return reason === 'young' ? 'young' : 'deferred';
  }

  const endClaim = await claimTripEndAction();
  if (!endClaim.claimed) {
    logger.info(`gone(${result.code}) 종료 skip — 다른 경로가 선점 (site=${site})`);
    return 'skipped';
  }
  try {
    await notifyTripEnded({
      destination: useDestinationStore.getState().destination,
      reason: 'backend-gone',
    });
    appendAlarmLog({
      ts: now,
      source: 'lifecycle-backstop',
      outcome: 'fired',
      reason: 'trip-gone-self-end',
      // GRACE 튜닝 입력: 하한을 얼마나 넘겨서 gone이 확정됐는지.
      // end 판정은 tripStartedAt non-null을 함의한다(null이면 young).
      stationName: `site=${site};code=${result.code};overStartMs=${now - (tripStartedAt as number)}`,
    });
    logger.info(`gone(${result.code}) 자가 종료 (site=${site}) -> cleanup`);
    await cleanupBackendGoneTrip(now);
  } catch (e) {
    endClaim.release();
    throw e;
  }
  return 'ended';
}
