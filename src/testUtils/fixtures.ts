import type { NearestStationResult } from '../shared/types/station';
import type { ArrivalInfo } from '../features/arrival/api/arrivalApi';
import type { JourneyDisplay } from '../features/route/utils/stationRoute';
import type { Stop, ArrivalTrain } from '../features/route/utils/journeyAdapter';

export const MOCK_STATIONS = {
  hyochang: { id: '0601', name: '효창공원앞', line: '6' as const, lineColor: '#CD7C2F', lat: 37.5, lng: 126.9 },
  gangnam: { id: '0201', name: '강남', line: '2' as const, lineColor: '#009D3E', lat: 37.5, lng: 127.0 },
  chungmuro: { id: '0301', name: '충무로', line: '3' as const, lineColor: '#EF7C1C', lat: 37.5, lng: 127.0 },
  yeouinaru: { id: '0501', name: '여의나루', line: '5' as const, lineColor: '#996CAC', lat: 37.5, lng: 126.9 },
  seoulStation: { id: 'AP01', name: '서울역', line: 'airport' as const, lineColor: '#4B81BF', lat: 37.5, lng: 126.9 },
};

export function makeNearestResult(stationKey: keyof typeof MOCK_STATIONS, distanceKm: number): NearestStationResult {
  return { station: MOCK_STATIONS[stationKey], distanceKm };
}

export function makeArrivalInfo(overrides: Partial<ArrivalInfo> & { destination: string; arrivalSeconds: number }): ArrivalInfo {
  return {
    arrivalMinutes: Math.floor(overrides.arrivalSeconds / 60),
    statusMessage: '',
    trainCode: 'T001',
    line: '2',
    receivedAtMs: 0,
    arrivalCode: -1,
    isLastTrain: false,
    trainType: 'normal',
    ...overrides,
  };
}

export const MOCK_JOURNEYS = {
  direct: {
    segments: [
      { line: '2', lineColor: '#009D3E', fromName: '강남', toName: '역삼', stops: 1 },
    ],
    totalStops: 1,
  } satisfies JourneyDisplay,
  transfer: {
    segments: [
      { line: '6', lineColor: '#CD7C2F', fromName: '효창공원앞', toName: '공덕', stops: 2 },
      { line: '5', lineColor: '#996CAC', fromName: '공덕', toName: '여의나루', stops: 3 },
    ],
    totalStops: 5,
  } satisfies JourneyDisplay,
};

export const MOCK_STOPS = {
  twoStops: [
    { station: '강남', line: '2', mark: 'filled' },
    { station: '역삼', line: '2', stopsFromPrev: '1정거장', mark: 'dest', note: '도착' },
  ] satisfies Stop[],
  threeStops: [
    { station: '효창공원앞', line: '6', mark: 'filled' },
    { station: '공덕', line: '5', stopsFromPrev: '2정거장', mark: 'transfer', note: '환승' },
    { station: '여의나루', line: '5', stopsFromPrev: '3정거장', mark: 'dest', note: '도착' },
  ] satisfies Stop[],
};

export function makeArrivalTrain(overrides: Partial<ArrivalTrain> & { direction: string; line: string; arrivalAtMs: number }): ArrivalTrain {
  return { subtext: undefined, ...overrides };
}
