import type { ArrivalInfo } from '../api/arrivalApi';

// StationArrival을 caller가 함께 import할 수 있도록 re-export.
export type { StationArrival } from '../api/arrivalApi';

export interface NextArrivalPick {
  etaSeconds: number | null;
  direction: 'up' | 'down' | null;
  trainCode: string | null;
  /** preferTrainCode 매치로 결정론적 ETA를 채택했는지 (#373 PoC 측정용). */
  matchedByTrainCode: boolean;
}

const EMPTY_PICK: NextArrivalPick = {
  etaSeconds: null,
  direction: null,
  trainCode: null,
  matchedByTrainCode: false,
};

/**
 * trainCode 매치가 비현실적으로 큰 값을 반환했을 때 stale로 강등할 상한선.
 * 서울 지하철 인접역 평균 ETA의 ~12배. 이 이상이면 진입 신호로 보기 어렵다.
 */
const MAX_PLAUSIBLE_APPROACH_SECONDS = 1200;

export interface PickOptions {
  /**
   * #373 PoC: trainCode lock-in. 일치하는 trainCode의 ETA를 우선 채택한다.
   * 매칭 실패 또는 상한 초과 시 방향별 min ETA로 fallback.
   */
  preferTrainCode?: string | null;
}

/**
 * 진행 방향 열차의 가장 빠른 양수 arrivalSeconds를 선택하고, 함께 방향/trainCode를 반환한다.
 * 사전 예약 알람의 ETA 선택(#370) + stamp(#372) + trainCode lock-in(#373)에 공통 사용된다.
 *
 * `filterDirection`이 주어지면 그 방향 list만 검색한다 — 반대방향 열차 ETA 오인 회피(#370).
 * null이면 양방향 best-effort fallback (환상선/노선 이탈 등 방향 미판정 경계 케이스).
 *
 * `options.preferTrainCode`가 주어지면 해당 trainCode를 가진 열차의 ETA를 우선 채택한다.
 * 매칭 실패 시 기존 방식(방향별 min ETA)으로 fallback — 회귀 안전.
 *
 * isMock arrival은 명시적으로 null을 반환 — alarmScheduler의 staticETA fallback으로 위임.
 */
export function pickNextArrival(
  arrival: { up: ArrivalInfo[]; down: ArrivalInfo[]; isMock?: boolean } | null,
  filterDirection: 'up' | 'down' | null = null,
  options?: PickOptions,
): NextArrivalPick {
  if (!arrival || arrival.isMock) return EMPTY_PICK;
  const directions = directionsToSearch(filterDirection);

  const preferCode = options?.preferTrainCode ?? null;
  if (preferCode) {
    const matched = findByTrainCode(arrival, directions, preferCode);
    if (matched) {
      // preferCode가 truthy일 때만 진입하고, findByTrainCode가 string-equality로 매치하므로
      // matched.info.trainCode는 항상 preferCode와 동일한 비어있지 않은 문자열이다.
      return {
        etaSeconds: matched.info.arrivalSeconds,
        direction: matched.direction,
        trainCode: matched.info.trainCode,
        matchedByTrainCode: true,
      };
    }
  }

  const pick = pickMinEta(arrival, directions);
  if (!pick) return EMPTY_PICK;
  return {
    etaSeconds: pick.info.arrivalSeconds,
    direction: pick.direction,
    trainCode: pick.info.trainCode || null,
    matchedByTrainCode: false,
  };
}

function pickMinEta(
  arrival: { up: ArrivalInfo[]; down: ArrivalInfo[] },
  directions: Array<'up' | 'down'>,
): { info: ArrivalInfo; direction: 'up' | 'down' } | null {
  let pick: { info: ArrivalInfo; direction: 'up' | 'down' } | null = null;
  for (const direction of directions) {
    for (const info of arrival[direction]) {
      if (info.arrivalSeconds <= 0) continue;
      if (pick === null || info.arrivalSeconds < pick.info.arrivalSeconds) {
        pick = { info, direction };
      }
    }
  }
  return pick;
}

function findByTrainCode(
  arrival: { up: ArrivalInfo[]; down: ArrivalInfo[] },
  directions: Array<'up' | 'down'>,
  trainCode: string,
): { info: ArrivalInfo; direction: 'up' | 'down' } | null {
  for (const direction of directions) {
    for (const info of arrival[direction]) {
      if (
        info.trainCode === trainCode &&
        info.arrivalSeconds > 0 &&
        info.arrivalSeconds <= MAX_PLAUSIBLE_APPROACH_SECONDS
      ) {
        return { info, direction };
      }
    }
  }
  return null;
}

function directionsToSearch(filter: 'up' | 'down' | null): Array<'up' | 'down'> {
  if (filter === 'up') return ['up'];
  if (filter === 'down') return ['down'];
  return ['up', 'down'];
}
