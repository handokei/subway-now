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
 * setTripEndedSentinel → removeItem(ACTIVE_TRIP_KEY). recall이 cleanup보다 먼저여야 한다 —
 * cleanup이 ROUTE_KEY/DESTINATION_KEY/TRIP_ORIGIN_KEY/TRIP_STARTED_AT_KEY를 제거하므로 그 뒤에
 * recall이 돌면 입력이 비어 'empty'/'no-trip-start'로 skip된다.
 *
 * 멱등: setTripEndedSentinel + removeItem(ACTIVE_TRIP_KEY) 자체가 멱등이라 silent push
 * trip-ended handler / launch reconciliation과 중복 호출돼도 안전.
 *
 * caller는 backend가 명시적으로 `status: 'ended'`를 반환한 경우에만 이 함수를 호출해야 한다 —
 * 404/410(trip 부재)은 death 확정이 아니다(ADR-010, false positive는 miss와 동급).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ACTIVE_TRIP_KEY } from '../../../shared/constants/storageKeys';
import { setTripEndedSentinel } from './tripEndedSentinel';
import { triggerTripEndRecall } from './triggerTripEndRecall';
import { runTripBoundCleanups } from '../store/tripBoundCleanups';
import { getCurrentTripCorrIdSync } from '../../observability/utils/tripCorrId';
import { triggerTripGroundTruthPrompt } from '../../debug/utils/triggerTripGroundTruthPrompt';

/**
 * backend-confirmed 'ended' trip을 device 상태에 반영한다.
 *
 * @param endedAt backend가 보고한 종료 시각(epoch ms). 미상이면 호출자가 `Date.now()` fallback.
 */
export async function cleanupBackendConfirmedEndedTrip(endedAt: number): Promise<void> {
  await triggerTripEndRecall();
  // #1597 — clearTripCorrId가 cache를 비우기 전에 종료된 trip의 corrId snapshot 캡처.
  const endedCorrIdSnapshot = getCurrentTripCorrIdSync();
  await runTripBoundCleanups();
  // #1597 — trip-end 사용자 정답지 prompt enqueue (cleanup 후, corrId snapshot으로).
  await triggerTripGroundTruthPrompt(endedCorrIdSnapshot);
  // #2114 (방안 C′) — sentinel에 corrId 동봉.
  await setTripEndedSentinel(endedAt, endedCorrIdSnapshot);
  await AsyncStorage.removeItem(ACTIVE_TRIP_KEY);
}
