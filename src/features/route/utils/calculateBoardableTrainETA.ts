import type { LineNumber } from '../../../shared/types/station';
import {
  findBoardableDeparture,
  type BoardableDeparture,
  type DepartureLookupResult,
  type Direction,
} from '../../../shared/utils/timetableShared';
import { createLogger } from '../../../shared/utils/logger';

const logger = createLogger('BoardableTrainETA');

/**
 * 환승 boardable train ETA 알고리즘 (#1480).
 *
 * 사용자 시나리오 (PR body 예시):
 *   A역 → 환승 도보 3분 → B역. B역 도착 시각 1분 후 열차 = 못 탐. 다음 열차 10분 후 = boardable.
 *
 * 본 알고리즘이 받아 처리하는 시간 구간:
 *   환승역 도착 시각 (= now + 도보 시간 + buffer) 이후 첫 boardable 열차 lookup
 *
 * buffer 결정은 **호출자 책임**. `decideBufferSeconds`를 호출자가 적용해 doorway/플랫폼 마진을
 * 도보 시간에 비례해 산출 후 본 함수 인자로 전달한다 (#1480 정정 — buffer 30s 상수 X).
 *
 * 1~9호선 외 노선은 `findBoardableDeparture`가 `status: 'no-timetable'` 반환 — 호출자가
 * 정적 ETA fallback. station alias mismatch는 `status: 'station-missing'`.
 */

const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;

/** 도보 시간(초) → buffer(초) — 짧으면 작게, 길면 크게 (사용자 명시 정정). */
const BUFFER_BREAKPOINTS = [
  { maxWalkingSeconds: 60, bufferSeconds: 10 },
  { maxWalkingSeconds: 180, bufferSeconds: 20 },
  { maxWalkingSeconds: 300, bufferSeconds: 30 },
] as const;
const BUFFER_DEFAULT_LONG_WALK_SECONDS = 60;

/**
 * 환승 도보 시간(초) → 플랫폼/문 buffer(초).
 *
 * 4단계 분기 (≤60s: 10s / ≤180s: 20s / ≤300s: 30s / 그 외: 60s).
 * 명시적 breakpoint는 디버깅 시 "어느 슬롯에 들어갔나" 추적이 쉬워 비례식보다 우선.
 */
export function decideBufferSeconds(transferWalkingSeconds: number): number {
  for (const breakpoint of BUFFER_BREAKPOINTS) {
    if (transferWalkingSeconds <= breakpoint.maxWalkingSeconds) {
      return breakpoint.bufferSeconds;
    }
  }
  return BUFFER_DEFAULT_LONG_WALK_SECONDS;
}

export interface BoardableTrainETAParams {
  /** 환승역 도착 예상 시각 (= now + 도보 시간 — buffer는 본 함수가 더해서 환산). */
  arrivalAt: Date;
  /** 호출자가 `decideBufferSeconds`로 산출한 buffer(초). */
  bufferSeconds: number;
  /** 다음 leg의 lookup 좌표. */
  nextLeg: {
    stationName: string;
    line: LineNumber;
    direction: Direction;
  };
}

export type BoardableTrainETAResult =
  | {
      status: 'ok';
      /** boardable 열차 출발 시각 + 대기 + miss count (timetableShared 원형). */
      departure: BoardableDeparture;
      /** 환승역 도착(= arrivalAt + buffer) 시각. 디버깅/표시용. */
      effectiveArrivalAt: Date;
    }
  | {
      status:
        | 'no-timetable' // 1~9호선 외 노선 → 호출자가 정적 ETA fallback
        | 'station-missing' // alias 불일치 — 호출자가 logger.debug 후 fallback
        | 'day-type-unknown' // Hermes weekday part 누락 (#1088) — fallback
        | 'no-departures'; // 막차 + 다음날 첫차도 없음 (비정상) — fallback
    };

export function calculateBoardableTrainETA(
  params: BoardableTrainETAParams,
): BoardableTrainETAResult {
  const { arrivalAt, bufferSeconds, nextLeg } = params;

  // 환승역에서 다음 열차를 탈 수 있는 가장 빠른 시각.
  const effectiveArrivalAt = new Date(arrivalAt.getTime() + bufferSeconds * MS_PER_SECOND);

  const lookupResult: DepartureLookupResult = findBoardableDeparture({
    stationName: nextLeg.stationName,
    line: nextLeg.line,
    direction: nextLeg.direction,
    from: effectiveArrivalAt,
  });

  if (lookupResult.status !== 'ok') {
    if (lookupResult.status === 'station-missing') {
      logger.debug(
        `boardable lookup miss: line=${nextLeg.line} station=${nextLeg.stationName} dir=${nextLeg.direction}`,
      );
    }
    return { status: lookupResult.status };
  }

  return {
    status: 'ok',
    departure: lookupResult.departure,
    effectiveArrivalAt,
  };
}

/**
 * 분 단위 helper — 외부에서 boardable 결과를 stationRoute 단위(travelMinutes 등)와 합산할 때 사용.
 */
export function waitMinutesFromBoardable(departure: BoardableDeparture): number {
  return Math.ceil(departure.waitSeconds / SECONDS_PER_MINUTE);
}
