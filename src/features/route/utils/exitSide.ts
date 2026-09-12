import exitSideData from '../../../data/exitSide.json';
import type { ExitSide, ExitSideMap, TravelDirection } from '../../../shared/types/exitSide';
import { normalizeStationName } from '../../../shared/utils/stationRoute';

const EXIT_SIDE_MAP: ExitSideMap = exitSideData;

// 진행방향별로 등록된 좌/우 정보를 조회한다. 데이터가 없으면 null을 반환해
// caller가 graceful fallback(좌/우 라인 생략) 할 수 있게 한다.
//
// 매칭 우선순위:
//   1) 원본 역명 그대로
//   2) 괄호 부제 제거한 정규화 이름 (예: "상봉(시외버스터미널)" → "상봉")
// 이 두 단계로 stations.json 표기와 데이터 키 표기가 살짝 달라도 매칭이 성립한다.
export function lookupExitSide(
  stationName: string,
  direction: TravelDirection,
): ExitSide | null {
  const entry =
    EXIT_SIDE_MAP[stationName] ?? EXIT_SIDE_MAP[normalizeStationName(stationName)];
  return entry?.[direction] ?? null;
}
