import type { TrainType } from '../../../shared/constants/trainTypes';
import type { LineNumber } from '../../../shared/types/station';
import { EXPRESS_STOPS } from '../../../data/expressStops';

const EMPTY: ReadonlySet<string> = new Set();

/**
 * 주어진 노선에서 trainType이 정차하는 역 이름 셋을 반환한다.
 * 데이터가 없는 노선/타입이면 빈 셋.
 * `normal`은 모든 역에 정차하므로 빈 셋 — 호출자는 normal일 때 이 함수 대신
 * `isExpressStop`을 사용한다.
 */
export function getExpressStopsOnLine(
  line: LineNumber,
  trainType: TrainType,
): ReadonlySet<string> {
  if (trainType === 'normal') return EMPTY;
  return EXPRESS_STOPS[line]?.[trainType] ?? EMPTY;
}

/**
 * 해당 역이 trainType의 정차역인지 판단.
 * - `normal`: 모든 역에 정차하므로 항상 true.
 * - 데이터 미보유 노선/타입: 보수적으로 true (잘못된 '통과' 경고로 사용자를 오도하지 않기 위함).
 * - 데이터가 존재하는 노선/타입: 셋 멤버십으로 정확히 판정.
 *
 * 후속 UI에서 "이 역 통과" 경고를 띄울 때는 이 함수가 false인 경우에만 표시하면 안전하다.
 */
export function isExpressStop(
  stationName: string,
  line: LineNumber,
  trainType: TrainType,
): boolean {
  if (trainType === 'normal') return true;
  const stops = EXPRESS_STOPS[line]?.[trainType];
  if (!stops) return true;
  return stops.has(stationName);
}
