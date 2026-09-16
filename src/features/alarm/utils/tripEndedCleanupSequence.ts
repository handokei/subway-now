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
 * caller는 backend가 명시적으로 `status: 'ended'`를 반환한 경우에만 이 함수를 호출해야 한다 —
 * 404/410(trip 부재)은 death 확정이 아니다(ADR-010, false positive는 miss와 동급).
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
import { getCurrentTripCorrIdSync } from '../../observability/utils/tripCorrId';
import { triggerTripGroundTruthPrompt } from '../../debug/utils/triggerTripGroundTruthPrompt';
import { useDestinationStore } from '../../route/store/useDestinationStore';
import { addDomainBreadcrumb } from '../../../shared/infra/monitoring/breadcrumb';

/** breadcrumb에서 trip 종료 트리거를 구분하는 reason. */
type TripEndReason = 'backend-confirmed' | 'user-end-trip-button';

/**
 * trip-ended cleanup 5단 시퀀스 본체. `cleanupBackendConfirmedEndedTrip` /
 * `cleanupUserInitiatedEndedTrip`(#2428) 양쪽이 공유하는 단일 구현 — drift 방지를 위해
 * 여기 외에는 재구현하지 않는다.
 */
async function runFullTripEndCleanupSequence(
  endedAt: number,
  reason: TripEndReason,
): Promise<void> {
  await triggerTripEndRecall();
  // #1597 — clearTripCorrId가 cache를 비우기 전에 종료된 trip의 corrId snapshot 캡처.
  const endedCorrIdSnapshot = getCurrentTripCorrIdSync();
  await runTripBoundCleanups();
  // #1597 — trip-end 사용자 정답지 prompt enqueue (cleanup 후, corrId snapshot으로).
  await triggerTripGroundTruthPrompt(endedCorrIdSnapshot);
  // #2419 — in-memory destination/customOrigin/tripOrigin reset. runTripBoundCleanups는
  // storage만 정리하므로 이게 없으면 stale destination이 메모리에 남아 lockless trip이
  // 유령 재시작된다 (헤더 주석 참고).
  useDestinationStore.setState({ destination: null, customOrigin: null, tripOrigin: null });
  // #2428 — trip 종료 트리거 구분 breadcrumb (V/X dashboard 관측용: Sentry breadcrumb trail).
  addDomainBreadcrumb('trip', 'end', { reason });
  // #2114 (방안 C′) — sentinel에 corrId 동봉.
  await setTripEndedSentinel(endedAt, endedCorrIdSnapshot);
  await AsyncStorage.removeItem(ACTIVE_TRIP_KEY);
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
