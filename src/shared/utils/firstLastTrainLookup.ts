import firstLastTrainData from '../../data/firstLastTrainTimes.json';

/**
 * `stations.json` id → 평일/토/일 × 상/하행 첫차/막차 시각 (HH:MM 24h, 막차는 종착 시각).
 *
 * SSOT: `src/data/firstLastTrainTimes.json` (derive script:
 * `scripts/fetch-station-codes-and-times.js`, 입력은 `src/data/timetables/line-{1..9}.json`).
 *
 * - `dayType`: 요일 구분 (`weekday`/`saturday`/`sunday`).
 * - `direction`: 상/하행 (`up`/`down`). 종착역은 한쪽 방향만 운행 → 미운행 방향 lookup 시 `null`.
 * - 막차는 정규화(`24:30` → `00:30`) — `formatHHmm()` mod 24 결과.
 *
 * 매핑 부재 / 해당 direction 미운행 / 외부 노선 → `null`. 호출자가 fallback 처리.
 */
export type DayType = 'weekday' | 'saturday' | 'sunday';
export type Direction = 'up' | 'down';

type DirectionTimes = { first: string | null; last: string | null };
type DayTimes = Partial<Record<Direction, DirectionTimes>>;
type StationTimes = Partial<Record<DayType, DayTimes>>;

const firstLastTrain = firstLastTrainData as Record<string, StationTimes>;

export type FirstLastTrainQuery = {
  stationsJsonId: string;
  dayType: DayType;
  direction: Direction;
};

export function getFirstLastTrainTime({
  stationsJsonId,
  dayType,
  direction,
}: FirstLastTrainQuery): DirectionTimes | null {
  const station = firstLastTrain[stationsJsonId];
  if (!station) return null;
  const day = station[dayType];
  if (!day) return null;
  const times = day[direction];
  if (!times) return null;
  return times;
}
