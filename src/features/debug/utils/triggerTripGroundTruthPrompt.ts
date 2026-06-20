/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: debug feature가 trip 종료 경로에서 prompt enqueue trigger를
 * 노출한다. setDestination(switch) / silentPushTask(trip-ended) / useLaunchTripReconciliation /
 * useStateRehydration(sentinel/force-end) 4 종료 경로의 호출 entry-point이므로 본질적 cross-feature.
 */
/**
 * Trip ground truth (#1502 M2) — trip 종료 시 사용자 정답지 prompt enqueue trigger.
 *
 * #1597 fix: 호출자가 corrId를 명시적으로 캡처해서 전달한다. 과거에는 `TRIP_BOUND_CLEANUPS`
 * 배열에 등록되어 sync cache(`getCurrentTripCorrIdSync`)에서 corrId를 read했지만, 같은 배열이
 * trip 시작 경로(setDestination(null→station) switch)에서도 호출되며 `setTripCorrId(generateTripCorrId())`가
 * 이미 새 corrId로 cache를 덮어쓴 뒤 cleanup chain microtask가 돌아 새 trip 시작과 동시에
 * prompt가 fire되는 회귀가 발생했다 (사용자 보고 2026-06-20).
 *
 * 본 함수는 trip-end 경로에서만 호출된다. 호출자가 종료 시점의 corrId snapshot을 캡처해서
 * 넘기면 trigger는 그 snapshot으로 enqueue한다. `corrId === null`이면 graceful skip — prompt
 * 미발사 (측정 가치 없는 trip에 noise 응답 합류 차단).
 */
import { useTripGroundTruthStore } from '../store/useTripGroundTruthStore';

export async function triggerTripGroundTruthPrompt(corrId: string | null): Promise<void> {
  if (corrId === null) return;
  await useTripGroundTruthStore.getState().enqueuePrompt({
    corrId,
    endedAt: Date.now(),
  });
}
