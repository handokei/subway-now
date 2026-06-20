/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: debug feature가 trip 종료 시점 trigger를 노출하기 위해
 * observability(tripCorrId)에서 sync read한다. trip-bound cleanup orchestrator(alarm/store/
 * tripBoundCleanups.ts)에서 호출되는 entry-point이므로 본질적 cross-feature 의존.
 */
/**
 * Trip ground truth (#1502 M2) — trip 종료 시 사용자 정답지 prompt enqueue trigger.
 *
 * `TRIP_BOUND_CLEANUPS`에 등록되어 trip 종료 시 자동 호출. 호출 순서가 어디든 — `clearTripCorrId`
 * 전후 무관 — 본 함수는 **호출 즉시 동기**로 `getCurrentTripCorrIdSync()`를 읽어 corrId를
 * 캡처한 뒤 store에 enqueue한다. 이후 `clearTripCorrId`가 cache를 비워도 캡처 값은 그대로.
 *
 * corrId가 null이면(트립 미시작/이미 종료) graceful skip — prompt 미발사. 측정 가치가 없는
 * trip(corrId 없음)에 noise 응답이 섞이는 것 차단.
 */
import { getCurrentTripCorrIdSync } from '../../observability/utils/tripCorrId';
import { useTripGroundTruthStore } from '../store/useTripGroundTruthStore';

export async function triggerTripGroundTruthPrompt(): Promise<void> {
  // 동기 read — clearTripCorrId가 같은 cleanup batch에서 cache를 비우기 전 캡처.
  const corrId = getCurrentTripCorrIdSync();
  if (corrId === null) return;
  await useTripGroundTruthStore.getState().enqueuePrompt({
    corrId,
    endedAt: Date.now(),
  });
}
