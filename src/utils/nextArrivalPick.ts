import type { ArrivalInfo, StationArrival } from '../api/arrivalApi';

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
 * up/down 양방향에서 가장 빠른 양수 arrivalSeconds를 선택하고, 함께 방향/trainCode를
 * 반환한다. 사전 예약 알람의 stamp(#372) 산출에 공통 사용된다.
 *
 * isMock arrival은 명시적으로 null을 반환 — alarmScheduler의 staticETA fallback으로 위임.
 *
 * 입력 형태가 두 가지 (StationArrival, 또는 fetch 결과 {up, down})를 모두 수용하기 위해
 * isMock을 optional로 둔다.
 */
export function pickNextArrival(
  arrival: { up: ArrivalInfo[]; down: ArrivalInfo[]; isMock?: boolean } | null,
): NextArrivalPick {
  if (!arrival || arrival.isMock) return EMPTY_PICK;
  let pick: { info: ArrivalInfo; direction: 'up' | 'down' } | null = null;
  for (const direction of ['up', 'down'] as const) {
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

// 타입 export — caller가 StationArrival을 직접 다루지 않을 때 사용.
export type { StationArrival };
