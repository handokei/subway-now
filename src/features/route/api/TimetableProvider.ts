import type { LineNumber } from '../../../shared/types/station';
import type {
  BoardableDeparture,
  DayType,
  Direction,
} from '../../../shared/utils/timetableShared';

/**
 * 정적 timetable + 외부 OpenAPI를 같은 인터페이스로 조회하기 위한 추상 Provider (#1480).
 *
 * 본 PR 1차 구현체: `StaticTimetableProvider` (정적 JSON SSOT).
 * Follow-up: `SeoulOpenApiTimetableProvider` (`SearchSTNTimeTableByIDService`),
 * `SeoulTrainSchProvider` (`getTrainSch` — 급행 여부/환승 가능/임시시간표/열차번호/지선명).
 *
 * Provider cascade (사용자 명시 정정 2026-06-18 — getTrainSch 1순위):
 *   1. `SeoulTrainSchProvider` (`getTrainSch`) — 호선 단위, 급행 여부 포함 (follow-up sub)
 *   2. `SeoulOpenApiTimetableProvider` (`SearchSTNTimeTableByIDService`) — 역 단위 (follow-up sub)
 *   3. `StaticTimetableProvider` (본 PR) — 정적 JSON, 1~9호선 build-time
 *   4. (호출자) 정적 ETA fallback (`transferTimes` + `stationDistances` + `lineSpeeds`)
 */

export interface TimetableLookupParams {
  stationName: string;
  line: LineNumber;
  direction: Direction;
  /** 기준 시각 — 이 시각 이후 (>=) 첫 boardable departure. */
  from: Date;
}

export type TimetableLookupStatus =
  | 'ok'
  | 'no-timetable'
  | 'station-missing'
  | 'day-type-unknown'
  | 'no-departures'
  | 'provider-error';

export interface TimetableLookupSuccess {
  status: 'ok';
  departure: BoardableDeparture;
  /**
   * follow-up sub에서 endpoint별 부가 정보(급행/완행, 열차번호 등)를 채택할 자리.
   * 정적 Provider는 비워둔다.
   */
  meta?: {
    isExpress?: boolean;
    trainCode?: string;
    branchName?: string;
    isTemporary?: boolean;
  };
}

export interface TimetableLookupFailure {
  status: Exclude<TimetableLookupStatus, 'ok'>;
  reason?: string;
}

export type TimetableLookupResult = TimetableLookupSuccess | TimetableLookupFailure;

export interface TimetableProvider {
  readonly source: 'static' | 'seoul-train-sch' | 'seoul-station-timetable';
  getBoardableDeparture(params: TimetableLookupParams): Promise<TimetableLookupResult>;
  /**
   * 동기 lookup이 가능한 Provider만 구현 (정적 JSON). 비동기 Provider는 미구현.
   * 호출자가 `if (provider.getBoardableDepartureSync)`로 분기.
   */
  getBoardableDepartureSync?(params: TimetableLookupParams): TimetableLookupResult;
}

/**
 * `DayType`을 외부 endpoint의 평일/토/일 코드로 매핑 (follow-up Provider 구현체용).
 *
 * 사용자 제공 메타데이터 (`SearchSTNTimeTableByIDService` `WEEK_TAG`):
 *   - 1 = 평일
 *   - 2 = 토요일
 *   - 3 = 휴일/일요일
 */
export function dayTypeToWeekTag(dayType: DayType): 1 | 2 | 3 {
  if (dayType === 'weekday') return 1;
  if (dayType === 'saturday') return 2;
  return 3;
}

/**
 * `Direction`을 외부 endpoint의 상하행 코드로 매핑.
 *
 * 사용자 제공 메타데이터 (`SearchSTNTimeTableByIDService` `INOUT_TAG`):
 *   - 1 = 상행/내선
 *   - 2 = 하행/외선
 */
export function directionToInoutTag(direction: Direction): 1 | 2 {
  return direction === 'up' ? 1 : 2;
}
