import type { ArrivalInfo } from '../api/arrivalApi';

// StationArrival을 caller가 함께 import할 수 있도록 re-export.
export type { StationArrival } from '../api/arrivalApi';

export interface NextArrivalPick {
  etaSeconds: number | null;
  direction: 'up' | 'down' | null;
  trainCode: string | null;
}

const EMPTY_PICK: NextArrivalPick = {
  etaSeconds: null,
  direction: null,
  trainCode: null,
};

/**
 * 진행 방향 열차의 가장 빠른 양수 arrivalSeconds를 선택하고, 함께 방향/trainCode를 반환한다.
 * 사전 예약 알람의 ETA 선택(#370) + stamp(#372)에 공통 사용된다.
 *
 * `filterDirection`이 주어지면 그 방향 list만 검색한다 — 반대방향 열차 ETA 오인 회피(#370).
 * null이면 양방향 best-effort fallback (환상선/노선 이탈 등 방향 미판정 경계 케이스).
 *
 * isMock arrival은 명시적으로 null을 반환 — alarmScheduler의 staticETA fallback으로 위임.
 *
 * 입력 형태가 두 가지(StationArrival, 또는 fetch 결과 {up, down})를 모두 수용하기 위해
 * isMock을 optional로 둔다.
 */
export function pickNextArrival(
  arrival: { up: ArrivalInfo[]; down: ArrivalInfo[]; isMock?: boolean } | null,
  filterDirection: 'up' | 'down' | null = null,
): NextArrivalPick {
  if (!arrival || arrival.isMock) return EMPTY_PICK;
  const directions = directionsToSearch(filterDirection);
  let pick: { info: ArrivalInfo; direction: 'up' | 'down' } | null = null;
  for (const direction of directions) {
    for (const info of arrival[direction]) {
      if (info.arrivalSeconds <= 0) continue;
      if (pick === null || info.arrivalSeconds < pick.info.arrivalSeconds) {
        pick = { info, direction };
      }
    }
  }
  if (!pick) return EMPTY_PICK;
  return {
    etaSeconds: pick.info.arrivalSeconds,
    direction: pick.direction,
    trainCode: pick.info.trainCode || null,
  };
}

function directionsToSearch(filter: 'up' | 'down' | null): Array<'up' | 'down'> {
  if (filter === 'up') return ['up'];
  if (filter === 'down') return ['down'];
  return ['up', 'down'];
}
