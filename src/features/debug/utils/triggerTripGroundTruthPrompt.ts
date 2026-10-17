/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: debug feature가 trip 종료 경로에서 prompt enqueue trigger를
 * 노출한다. setDestination(switch) / silentPushTask(trip-ended) / useLaunchTripReconciliation /
 * useStateRehydration(sentinel/force-end) 4 종료 경로의 호출 entry-point이므로 본질적 cross-feature.
 * #2309 — 같은 이유로 alarm 슬라이스의 `consumeAccurateDestinationFire`도 여기서 직접 참조한다.
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
 *
 * #2309 — destination imminent 발사가 fusion arrival-confirmed였다면(`consumeAccurateDestinationFire`)
 * 수동 Yes/No 없이 즉시 'accurate'로 확정한다. 발사 직후 사용자가 바로 "안내 종료"를 눌러 정답지
 * 응답 창이 완료되지 못해 miss로 self-report되던 지표 왜곡의 fix — 이미 객관적으로 정확했던
 * 발사를 굳이 다시 물어서 사용자의 즉흥 오답/미응답에 노출시키지 않는다.
 */
import { useTripGroundTruthStore } from '../store/useTripGroundTruthStore';
import { consumeAccurateDestinationFire } from '../../alarm/utils/alarmLog';

export async function triggerTripGroundTruthPrompt(corrId: string | null): Promise<void> {
  if (corrId === null) return;
  if (consumeAccurateDestinationFire()) {
    await useTripGroundTruthStore.getState().recordAutoConfirmed(corrId);
    return;
  }
  await useTripGroundTruthStore.getState().enqueuePrompt({
    corrId,
    endedAt: Date.now(),
  });
}
