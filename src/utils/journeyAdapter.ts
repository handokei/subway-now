import i18next from 'i18next';
import type { JourneyDisplay } from './stationRoute';
import type { ArrivalInfo } from '../api/arrivalApi';
import type { NearestStationResult, LineNumber } from '../types/station';

export interface Stop {
  station: string;
  line: string | null;
  stopsFromPrev?: string;
  mark: 'filled' | 'transfer' | 'dest';
  note?: string;
}

export interface ArrivalTrain {
  direction: string;
  line: string;
  arrivalAtMs: number;
  subtext?: string;
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
        station: seg.fromName,
        line: seg.line,
        mark: 'filled',
      });
    }

    // stopsFromPrev 동적 포맷("N정거장")은 Phase 3에서 i18n 처리 예정
    if (!isLast) {
      stops.push({
        station: seg.toName,
        line: segments[i + 1].line,
        stopsFromPrev: `${seg.stops}정거장`,
        mark: 'transfer',
        note: i18next.t('journey.transferNote'),
      });
    } else {
      stops.push({
        station: seg.toName,
        line: seg.line,
        stopsFromPrev: `${seg.stops}정거장`,
        mark: 'dest',
        note: i18next.t('journey.arrivalNote'),
      });
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
  // direction 동적 포맷("X 방면")은 Phase 3에서 i18n 처리 예정
  return items.map((item) => ({
    direction: item.destination ? `${item.destination} 방면` : direction,
    line,
    arrivalAtMs: now + item.arrivalSeconds * 1000,
    subtext: item.statusMessage || undefined,
  }));
}

export function nearestResultToNearest(result: NearestStationResult): HandoffNearest {
  const distanceM = Math.round(result.distanceKm * 1000);
  return {
    name: result.station.name,
    line: result.station.line,
    distanceM,
    walkMin: Math.max(1, Math.ceil(distanceM / WALK_SPEED_M_PER_MIN)),
  };
}
