/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: trip-end 시 recall(telemetry) + tripBoundCleanups(alarm/route/widget)
 * + groundTruthPrompt(debug) + tripCorrId(observability)를 한 곳에서 묶어 호출하는 shared
 * cleanup sequence. useLaunchTripReconciliation.ts와 동형 orchestrator라 file-level disable로
 * 옵트인 처리.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
/**
 * Backend-confirmed trip-ended cleanup sequence (#2178).
 *
 * `useLaunchTripReconciliation`(#1339 PR2, cold-launch backstop)의 `status === 'ended'` 분기가
 * 수행하던 5단 시퀀스를 그대로 추출한 shared 함수. 신규 pull death backstop(#2178 — silent push
 * 처리 말미 + BG location tick에서 backend에 직접 GET trip status로 생존 확인)이 동일 cleanup을
 * 중복 구현하지 않고 여기를 재사용한다.
 *
 * 호출 순서 고정: triggerTripEndRecall → runTripBoundCleanups → triggerTripGroundTruthPrompt →
 * destination store reset → setTripEndedSentinel → removeItem(ACTIVE_TRIP_KEY). recall이
 * cleanup보다 먼저여야 한다 — cleanup이 ROUTE_KEY/DESTINATION_KEY/TRIP_ORIGIN_KEY/
 * TRIP_STARTED_AT_KEY를 제거하므로 그 뒤에 recall이 돌면 입력이 비어 'empty'/'no-trip-start'로
 * skip된다.
 *
 * 멱등: setTripEndedSentinel + removeItem(ACTIVE_TRIP_KEY) 자체가 멱등이라 silent push
 * trip-ended handler / launch reconciliation과 중복 호출돼도 안전.
 *
 * `cleanupBackendConfirmedEndedTrip`은 backend가 명시적으로 `status: 'ended'`를 반환한 경우에만 호출한다.
 * 404/410(trip 부재)은 그것만으로 death 확정이 아니다(ADR-010, false positive는 miss와 동급) — PR-2부터는
 * `decideTripGone` 가드(하한/lock/알람)를 통과한 경우에 한해 `cleanupBackendGoneTrip`(별도 종료 사유)으로 종료한다.
 * 이 주석의 이전 문장("404/410은 death 아님")은 FG·launch 한정으로 개정됐다(BG pull은 여전히 무동작).
 *
 * #2419 — `runTripBoundCleanups`가 호출하는 `clearTripBoundStoreMemory`는 AsyncStorage의
 * DESTINATION_KEY만 제거하고 in-memory `useDestinationStore.destination`은 건드리지 않는다
 * (그 함수는 `setDestination(newStation)`으로 목적지를 전환하는 정상 플로우에서도 호출되므로
 * 거기서 무조건 destination을 null로 지우면 방금 설정한 새 목적지가 지워지는 회귀가 생긴다 —
 * 그래서 의도적으로 손대지 않는다). 이 함수는 backend가 trip 종료를 명시 확정한 경우에만
 * 호출되고 뒤이어 새 destination이 set될 일이 없으므로, 여기서 memory를 직접 reset한다 —
 * `useDeviceSelfEnd`(#2043) / `useStateRehydration`의 sentinel-reset 분기와 동형 패턴.
 * 이게 없으면 backend-confirmed 종료 후에도 stale destination이 메모리에 남아
 * `useFusedNearestStation`의 arcKey 판정이 lock 없는 유령 lockless trip을 재시작한다.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ACTIVE_TRIP_KEY } from '../../../shared/constants/storageKeys';
import { setTripEndedSentinel } from './tripEndedSentinel';
import { triggerTripEndRecall } from './triggerTripEndRecall';
import { runTripBoundCleanups } from '../store/tripBoundCleanups';
import { useBoardingLockStore } from '../store/useBoardingLockStore';
import { getCurrentTripCorrIdSync } from '../../observability/utils/tripCorrId';
import { triggerTripGroundTruthPrompt } from '../../debug/utils/triggerTripGroundTruthPrompt';
import { useDestinationStore } from '../../route/store/useDestinationStore';
import { addDomainBreadcrumb } from '../../../shared/infra/monitoring/breadcrumb';
import type { TripEndReason } from '../../../shared/types/tripEnd';
import {
  captureTripEndSnapshot,
  hasBoardingLock,
  notifyTripEnded,
  type TripEndedReason,
} from './tripEndedNotification';
import { claimTripEndAction } from './tripEndClaim';

/**
 * 정본 시퀀스 옵션.
 *
 * - `claim` — 종료 행동을 `claimTripEndAction`으로 선점한다(진입 직후 캡처한 identity로). 선점 실패면 아무것도 하지
 *   않고 `'skipped'`. 이미 호출부에서 선점한 진입점(backend-gone 등)은 켜지 않는다(같은 키라 스스로 막힌다).
 * - `notifyReason` — 주면 cleanup 앞에서 종료 알림 1건(진입 시점 identity로 dedupe). 생략하면 알리지 않는다
 *   (backend가 확정한 종료는 backend alert가 알린다, 사용자가 직접 끝낸 종료는 알리지 않는다).
 * - `notifyRequiresLock` — lock 없는 trip(역 탭·목적지 설정만)에는 알리지 않는다(lock-only-alerts, 2026-10-21).
 */
export interface TripEndSequenceOptions {
  claim?: boolean;
  notifyReason?: TripEndedReason;
  notifyRequiresLock?: boolean;
}

export type TripEndSequenceOutcome = 'ended' | 'skipped';

/**
 * trip-ended cleanup 시퀀스 본체. `cleanupBackendConfirmedEndedTrip` / `cleanupUserInitiatedEndedTrip`(#2428) /
 * `cleanupDeviceSelfEndedTrip`(#3005 PR-C: Signal 4 / 9h / 일시정지 / device self-end)이 공유하는 단일 구현 —
 * drift 방지를 위해 여기 외에는 재구현하지 않는다.
 *
 * #3005 — 진입 직후 trip 신원을 한 번 캡처(`captureTripEndSnapshot`)해 claim·알림 키·cleanup `expected`·prompt corrId에
 * 같은 값을 쓴다. recall await 중 새 trip이 등록되면(운영 token은 APNs 토큰이라 고정이므로 corrId로만 구분된다)
 * 신원에 묶인 정리와 아래 꼬리 단계(메모리 reset·lock release·sentinel·ACTIVE_TRIP 제거)는 새 trip을 건드리지 않는다.
 */
async function runFullTripEndCleanupSequence(
  endedAt: number,
  reason: TripEndReason,
  options: TripEndSequenceOptions = {},
): Promise<TripEndSequenceOutcome> {
  const { claim = false, notifyReason, notifyRequiresLock = false } = options;
  const capturedAt = Date.now();
  const { identity, corrId, activeTripToken } = await captureTripEndSnapshot();
  const endedDestination = useDestinationStore.getState().destination;
  const lockTrip = notifyReason !== undefined && notifyRequiresLock ? await hasBoardingLock() : false;
  const endClaim = claim ? await claimTripEndAction(identity) : null;
  if (endClaim && !endClaim.claimed) return 'skipped';
  try {
    // 알림은 recall·cleanup 앞 — corrId(dedupe 키)·ACTIVE_TRIP_KEY(data.tripToken)가 cleanup에서 지워진다.
    // 알림 실패는 notifyTripEnded가 삼킨다.
    if (notifyReason !== undefined && (!notifyRequiresLock || lockTrip)) {
      await notifyTripEnded({ destination: endedDestination, reason: notifyReason, identity });
    }
    await triggerTripEndRecall();
    // 알림·recall await 사이에 다른 trip이 등록됐는지(corrId 인스턴스 비교). 이후 await 없이 cleanup에 진입한다.
    const sameTrip = getCurrentTripCorrIdSync() === corrId;
    // #2302 — 이 정본 시퀀스의 모든 진입점은 자기 `reason`을 backend end_reason·breadcrumb·lock release 사유로
    // 동일하게 전달한다. #3005 PR-A — `expected`로 신원에 묶인 정리를 캡처한 trip에만 적용한다.
    await runTripBoundCleanups(reason, { expected: { corrId, activeTripToken, capturedAt } });
    // #1597 — trip-end 사용자 정답지 prompt enqueue (cleanup 후, 진입 시점 corrId snapshot으로).
    await triggerTripGroundTruthPrompt(corrId);
    // #2428 — trip 종료 트리거 구분 breadcrumb (V/X dashboard 관측용: Sentry breadcrumb trail).
    addDomainBreadcrumb('trip', 'end', { reason });
    if (sameTrip) {
      // #2419 — in-memory destination/customOrigin/tripOrigin reset. runTripBoundCleanups는
      // storage만 정리하므로 이게 없으면 stale destination이 메모리에 남아 lockless trip이
      // 유령 재시작된다 (헤더 주석 참고).
      useDestinationStore.setState({ destination: null, customOrigin: null, tripOrigin: null });
      // #2715 — cleanup이 같은 사유로 이미 release했으므로 정상 경로에선 no-op(`releaseLock`의 `if (prev)` 가드).
      // cleanup이 부분 실패해 lock이 남은 경우에만 동작하는 backstop이다(사유가 같아 드리프트 없음).
      await useBoardingLockStore.getState().releaseLock(reason);
      // #2114 (방안 C′) — sentinel에 corrId 동봉.
      await setTripEndedSentinel(endedAt, corrId);
      await AsyncStorage.removeItem(ACTIVE_TRIP_KEY);
    }
    return 'ended';
  } catch (e) {
    endClaim?.release();
    throw e;
  }
}

/**
 * backend-confirmed 'ended' trip을 device 상태에 반영한다.
 *
 * @param endedAt backend가 보고한 종료 시각(epoch ms). 미상이면 호출자가 `Date.now()` fallback.
 */
export async function cleanupBackendConfirmedEndedTrip(endedAt: number): Promise<void> {
  await runFullTripEndCleanupSequence(endedAt, 'backend-confirmed');
}

/**
 * PR-2 — backend가 404/410(트립 없음)을 냈고 `decideTripGone` 가드를 통과해 device가 스스로 종료하는
 * 진입점. 정본 시퀀스를 그대로 쓰되 종료 사유만 분리한다(D1 `end_reason`으로 분모 측정).
 * destination 계열 reset + `ACTIVE_TRIP_KEY` 제거까지 정본이 하므로 종료 후 register 입력이 소멸한다(#2972).
 */
export async function cleanupBackendGoneTrip(endedAt: number): Promise<void> {
  await runFullTripEndCleanupSequence(endedAt, 'backend-gone-device-confirmed');
}

/**
 * #2428 — 사용자가 `ALARM_CATEGORY` 알림의 [trip 종료] 액션(`ALARM_ACTION_END_TRIP`)을 직접
 * 탭했을 때 호출하는 진입점. 시퀀스는 `cleanupBackendConfirmedEndedTrip`과 동일
 * (`runFullTripEndCleanupSequence` 공유, 재구현 금지) — 사용자 명시 탭도 종료 확정 신호로
 * backend 통지와 동급이다(ADR-014 "사용자 명시 의향 trip = lock 활성과 동급").
 *
 * @param endedAt 사용자가 탭한 시각(epoch ms). 호출자가 `Date.now()`를 전달.
 */
export async function cleanupUserInitiatedEndedTrip(endedAt: number): Promise<void> {
  await runFullTripEndCleanupSequence(endedAt, 'user-end-trip-button');
}

/**
 * #3007 A — 사용자가 15분 종료 제안(`trip-end-offer`)의 [종료] 액션을 탭했을 때의 진입점.
 * 시퀀스는 `cleanupUserInitiatedEndedTrip`과 동일(정본 공유)하고 종료 사유만 분리 기록한다 —
 * "사용자가 제안을 받고 끝냈다"의 분모를 D1 `end_reason='user-end-offer'`로 측정하기 위함.
 */
export async function cleanupUserEndOfferEndedTrip(endedAt: number): Promise<void> {
  await runFullTripEndCleanupSequence(endedAt, 'user-end-offer');
}

/**
 * #3005 PR-C — device가 스스로 종료를 판정한 경로(Signal 4 / 9시간 force-end / 일시정지 backstop /
 * device self-end)의 진입점. 정본 시퀀스를 그대로 쓰되 `claim`으로 같은 종료의 중복 실행을 막는다.
 * 선점당하면 `'skipped'`(알림·recall·cleanup·sentinel 전부 생략). 시퀀스가 throw하면 claim을 풀고 다시 던진다 —
 * 호출부는 자기 graceful 처리로 삼키면 다음 진입이 재시도한다.
 *
 * @param endedAt 종료 판정 시각(epoch ms) — sentinel에 기록된다.
 * @param reason  경로 고유 사유 — backend end_reason / breadcrumb / lock release 사유로 동일하게 쓰인다.
 */
export function cleanupDeviceSelfEndedTrip(
  endedAt: number,
  reason: TripEndReason,
  options: Pick<TripEndSequenceOptions, 'notifyReason' | 'notifyRequiresLock'> = {},
): Promise<TripEndSequenceOutcome> {
  return runFullTripEndCleanupSequence(endedAt, reason, { ...options, claim: true });
}
