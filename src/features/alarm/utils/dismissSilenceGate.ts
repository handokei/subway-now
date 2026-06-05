import { haversine } from '../../../shared/utils/haversine';
import { DISMISS_SILENCE_MS, DISMISS_SILENCE_RADIUS_M } from '../../../shared/constants/alarmSilence';
import type { DismissSilenceState } from './dismissSilenceStorage';

export type DismissSilenceDecision =
  | { silenced: true }
  | { silenced: false; expired: boolean };

/**
 * #746 — 사용자가 알람을 dismiss한 후의 silence 게이트.
 *
 * 활성 조건:
 *  - state가 null이면 즉시 통과(silenced=false, expired=false).
 *  - `now - state.sinceTs >= DISMISS_SILENCE_MS` 이면 시간 만료 → silenced=false, expired=true.
 *  - state에 좌표가 있고 currentPosition이 주어졌으며 두 점 사이 거리 >= DISMISS_SILENCE_RADIUS_M
 *    이면 거리 만료 → silenced=false, expired=true.
 *  - 그 외엔 silenced=true.
 *
 * 좌표 한쪽이라도 누락(state가 dismiss 시 GPS 없음, 또는 현재 GPS 없음)이면 거리 평가는
 * 건너뛰고 시간 조건만 사용한다 — 누락 자체로 silence를 해제하지 않는다.
 *
 * 호출자는 expired=true를 받으면 dismissSilenceStorage.clearDismissSilence()를 호출해 stale
 * 항목을 정리한다 — 게이트 자체는 순수 함수로 IO 없음.
 */
export function evaluateDismissSilence(
  state: DismissSilenceState | null,
  now: number,
  currentPosition: { lat: number; lng: number } | null,
): DismissSilenceDecision {
  if (!state) return { silenced: false, expired: false };

  if (now - state.sinceTs >= DISMISS_SILENCE_MS) {
    return { silenced: false, expired: true };
  }

  if (state.sinceLat != null && state.sinceLng != null && currentPosition) {
    const distanceM =
      haversine(state.sinceLat, state.sinceLng, currentPosition.lat, currentPosition.lng) * 1000;
    if (distanceM >= DISMISS_SILENCE_RADIUS_M) {
      return { silenced: false, expired: true };
    }
  }

  return { silenced: true };
}
