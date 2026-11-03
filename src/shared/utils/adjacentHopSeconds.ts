import stationTravelTimesJson from '../../data/stationTravelTimes.json';
import type { LineNumber } from '../types/station';

const TRAVEL_TIMES = stationTravelTimesJson as Record<string, number>;

/**
 * 인접 두 역 사이 운행시간(초). stationTravelTimes.json은 인접 hop만 등록하므로 인접이 아니면 null.
 * `${line}|${fromId}|${toId}` 키는 `stationRoute.ts`와 동일하게 양방향 모두 등록되어 있다.
 *
 * barometerState(기압 ETA narrow)와 useFusedNearestStation(#3191 D-hop 도달 불가 이웃 제외)이 공유한다.
 * `features/route/utils/hopTime.ts`의 `getStopSeconds`는 데이터에 없으면 120s 폴백을 돌려줘 인접 판정에 쓸 수 없다.
 */
export function lookupAdjacentHopSeconds(
  line: LineNumber,
  fromId: string,
  toId: string,
): number | null {
  const key = `${line}|${fromId}|${toId}`;
  return TRAVEL_TIMES[key] ?? null;
}
