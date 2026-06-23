import i18next from 'i18next';
import type { JourneyDisplay, JourneySegment } from '../../../shared/utils/stationRoute';
import { getStationsOnLine, isSameStationName } from '../../../shared/utils/stationRoute';
import { shortestLinePathIndices } from '../../../shared/utils/lineLoopPath';
import type { ArrivalInfo } from '../../../shared/types/arrival';
import type { NearestStationResult, LineNumber, Station } from '../../../shared/types/station';
import { getStationDisplayName, getStationDisplayNameByName } from '../../../shared/utils/stationDisplay';
import { parseTrainLineDirection } from './trainLineDirection';
import { arrivalAt } from '../../../shared/utils/arrivalClock';
import stationsData from '../../../data/stations.json';

const allStations = stationsData as Station[];

// Stop/StopArrivalContext/StopTransferTarget/ArrivalTrain/HandoffNearest는
// shared/types/journey로 추출됨 (#890, Phase 5). 기존 호출자 호환을 위해 re-export 유지.
import type {
  StopArrivalContext,
  StopTransferTarget,
  Stop,
  ArrivalTrain,
  HandoffNearest,
} from '../../../shared/types/journey';
export type { StopArrivalContext, StopTransferTarget, Stop, ArrivalTrain, HandoffNearest };

const WALK_SPEED_M_PER_MIN = 80;

// segment의 from/to 사이 중간 정거장을 노선 데이터에서 슬라이스한다.
// #1717 — 2호선 본선 closed loop은 shortestLinePathIndices가 짧은 쪽 path를 반환.
// 이전 단순 slice 구현은 wraparound seg.stops(예: 16)와 직선 slice(예: 26) 불일치로
// 안전 가드에 빠져 빈 배열 fallback → "전체 역 보기" 토글 expand 시 중간역 0개 표시 회귀.
function intermediateStationsForSegment(seg: JourneySegment): Station[] {
  const lineStations = getStationsOnLine(seg.line);
  const fromIdx = lineStations.findIndex((s) => isSameStationName(s.name, seg.fromName));
  const toIdx = lineStations.findIndex((s) => isSameStationName(s.name, seg.toName));
  if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return [];
  const path = shortestLinePathIndices(lineStations, fromIdx, toIdx, seg.line);
  // path[0]=fromIdx, path[length-1]=toIdx. 중간 station은 양 끝 제외.
  const intermediate = path.slice(1, -1).map((i) => lineStations[i]);
  // 안전 가드: 산출된 중간역 수가 seg.stops-1과 다르면 invariant 위반 (데이터 drift).
  if (intermediate.length !== seg.stops - 1) return [];
  return intermediate;
}

export function journeyDisplayToStops(
  journey: JourneyDisplay,
  options: { readonly expanded?: boolean } = {},
): Stop[] {
  const { segments } = journey;
  if (segments.length === 0) return [];

  const stops: Stop[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isFirst = i === 0;
    const isLast = i === segments.length - 1;

    // #665: 출발=첫 환승역(stops=0)인 경우 transfer 노드를 출발 노드에 흡수.
    // 출발 마크의 line을 다음 segment의 line으로 두면 환승 후 노선이 시각적으로 그대로 표시되고
    // "0정거장" 표기가 사라진다. 흡수 후에는 아래 transfer push 분기를 skip.
    const isCollapsedZeroFirstHop =
      isFirst && !isLast && seg.stops === 0 && isSameStationName(seg.fromName, seg.toName);

    if (isFirst) {
      const nextSeg = segments[i + 1];
      stops.push({
        station: getStationDisplayNameByName(seg.fromName, allStations),
        line: isCollapsedZeroFirstHop ? nextSeg.line : seg.line,
        mark: 'filled',
      });
    }

    if (isCollapsedZeroFirstHop) {
      continue;
    }

    if (options.expanded) {
      for (const mid of intermediateStationsForSegment(seg)) {
        stops.push({
          station: getStationDisplayName(mid),
          line: seg.line,
          mark: 'intermediate',
        });
      }
    }

    const arrivalContext: StopArrivalContext = {
      line: seg.line,
      fromName: seg.fromName,
      toName: seg.toName,
    };

    if (!isLast) {
      const nextSeg = segments[i + 1];
      stops.push({
        station: getStationDisplayNameByName(seg.toName, allStations),
        line: nextSeg.line,
        stopsFromPrev: i18next.t('route.stops', { count: seg.stops }),
        mark: 'transfer',
        note: i18next.t('journey.transferNote'),
        arrivalContext,
        transferTarget: { toLine: nextSeg.line },
      });
    } else {
      // 환승역이 곧 목적지인 케이스(0정거장 도착 노드 잉여)는 직전 환승 노드를 도착으로 흡수.
      // 언어 독립성을 위해 표시명이 아닌 원본 역명(toName)으로 비교한다.
      // stopsFromPrev는 환승 노드의 기존 값(직전 segment의 정거장 수)을 그대로 유지.
      // arrivalContext도 prev(이전 segment의 도착)로 유지 — 사용자가 실제로 그 역에 내릴 때
      // 탑승 중이던 노선은 prevSeg 노선이기 때문.
      const prevSeg = segments[i - 1];
      const prev = stops[stops.length - 1];
      if (seg.stops === 0 && prev?.mark === 'transfer' && prevSeg?.toName === seg.toName) {
        prev.mark = 'dest';
        prev.note = i18next.t('journey.transferArrivalNote');
        // prev.arrivalContext는 이미 seg[i-1]의 값(사용자가 실제 탑승한 노선) — 덮어쓰지 않는다.
        // transferTarget은 그대로 둔다 — UI(EditorialTimeline)가 mark==='transfer'에만 적용하므로
        // 도착 stop으로 흡수된 후에는 자동으로 무시된다.
      } else {
        stops.push({
          station: getStationDisplayNameByName(seg.toName, allStations),
          line: seg.line,
          stopsFromPrev: i18next.t('route.stops', { count: seg.stops }),
          mark: 'dest',
          note: i18next.t('journey.arrivalNote'),
          arrivalContext,
        });
      }
    }
  }

  return stops;
}

export function arrivalInfoToArrivalTrain(
  items: ArrivalInfo[],
  direction: string,
  line: LineNumber,
  /** #1035 — 막차 시각 lookup 컨텍스트. 호출자가 알면 전달, 없으면 시각 미표기 fallback. */
  context?: { stationName?: string; directionKey?: 'up' | 'down' },
): ArrivalTrain[] {
  // #1400 — 환승역에서 같은 statnNm 응답에 다른 노선 열차가 섞이는 회귀가 관측됐다("논현인데
  // 3호선 신사행" 등). 호출자가 line 파라미터를 명시한 컨텍스트에서는 그 line과 다른 row를
  // 노출 자체에서 제외해 잘못된 방면/지난 호선 시간표가 사용자에게 보이지 않도록 한다. BFF가
  // line을 정확히 채우면 본 필터는 no-op(정상 응답)이며, line이 어긋난 row만 차단한다.
  const filteredItems = items.filter((item) => item.line === line);
  // item.destination은 서울 열린데이터 API의 trainLineNm 기반("소요산행", "내선순환" 등 방면 표현).
  // parseTrainLineDirection이 패턴(역명+행, 내선/외선순환)을 인식해 현재 언어로 표시한다.
  // #897 Seam A: arrivalAt(item) — BoardingTrainList와 동일한 anchor. useArrivalCountdown tick과 동기.
  return filteredItems.map((item) => ({
    direction: item.destination
      ? parseTrainLineDirection(item.destination, allStations)
      : direction,
    line,
    arrivalAtMs: arrivalAt(item),
    subtext: item.statusMessage || undefined,
    isLastTrain: item.isLastTrain,
    trainType: item.trainType,
    arrivalCode: item.arrivalCode,
    stationName: context?.stationName,
    lineNumber: line,
    directionKey: context?.directionKey,
  }));
}

export function nearestResultToNearest(result: NearestStationResult): HandoffNearest {
  const distanceM = Math.round(result.distanceKm * 1000);
  return {
    // handoff 정보의 name은 사용자에게 표시되므로 현재 언어로 변환
    name: getStationDisplayName(result.station),
    line: result.station.line,
    distanceM,
    walkMin: Math.max(1, Math.ceil(distanceM / WALK_SPEED_M_PER_MIN)),
  };
}
