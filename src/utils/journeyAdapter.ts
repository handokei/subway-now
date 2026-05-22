import i18next from 'i18next';
import type { JourneyDisplay } from './stationRoute';
import type { ArrivalInfo } from '../api/arrivalApi';
import type { NearestStationResult, LineNumber, Station } from '../types/station';
import { getStationDisplayName, getStationDisplayNameByName } from './stationDisplay';
import { parseTrainLineDirection } from './trainLineDirection';
import stationsData from '../data/stations.json';

const allStations = stationsData as Station[];

// 빠른하차 라벨 결정에 필요한 컨텍스트.
// 출발역(filled)은 도착 시점이 없으므로 미지정 — caller는 undefined를 라벨 미표시로 해석한다.
export interface StopArrivalContext {
  line: LineNumber;
  fromName: string;
  toName: string;
}

// 환승 stop에서 "갈아탈 다음 노선" — UI(EditorialTimeline)가 transferExit lookup에 사용.
// 환승역이 곧 목적지로 흡수되는 경우(0정거장 종착)에는 설정되지 않는다.
export interface StopTransferTarget {
  toLine: LineNumber;
}

export interface Stop {
  station: string;
  line: string | null;
  stopsFromPrev?: string;
  mark: 'filled' | 'transfer' | 'dest';
  note?: string;
  arrivalContext?: StopArrivalContext;
  transferTarget?: StopTransferTarget;
}

export interface ArrivalTrain {
  direction: string;
  line: string;
  arrivalAtMs: number;
  subtext?: string;
  /** 막차 여부 — UI 안전성 배지. */
  isLastTrain?: boolean;
  /** 열차 타입 — 'normal'은 배지 미표시. */
  trainType?: import('../constants/trainTypes').TrainType;
  /** arvlCd — 0:진입, 1:도착, 2:출발 등. UI 진입/도착 배지용. */
  arrivalCode?: number;
}

export interface HandoffNearest {
  name: string;
  line: string;
  distanceM: number;
  walkMin: number;
}

const WALK_SPEED_M_PER_MIN = 80;

export function journeyDisplayToStops(journey: JourneyDisplay): Stop[] {
  const { segments } = journey;
  if (segments.length === 0) return [];

  const stops: Stop[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isFirst = i === 0;
    const isLast = i === segments.length - 1;

    if (isFirst) {
      stops.push({
        station: getStationDisplayNameByName(seg.fromName, allStations),
        line: seg.line,
        mark: 'filled',
      });
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
): ArrivalTrain[] {
  const now = Date.now();
  // item.destination은 서울 열린데이터 API의 trainLineNm 기반("소요산행", "내선순환" 등 방면 표현).
  // parseTrainLineDirection이 패턴(역명+행, 내선/외선순환)을 인식해 현재 언어로 표시한다.
  return items.map((item) => ({
    direction: item.destination
      ? parseTrainLineDirection(item.destination, allStations)
      : direction,
    line,
    arrivalAtMs: now + item.arrivalSeconds * 1000,
    subtext: item.statusMessage || undefined,
    isLastTrain: item.isLastTrain,
    trainType: item.trainType,
    arrivalCode: item.arrivalCode,
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
