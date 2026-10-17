/**
 * Shared arc fixtures for useFusedNearestStation tests (#1015 forwardOnly + #1401 trainProgressing).
 *
 * 두 테스트 파일이 동일한 3-역 arc + boardingLock + routeContext fixture를 재정의해 Sonar CPD 발생.
 * 공통 fixture를 본 파일로 추출 — 호출자는 station id prefix와 boardingStationIdIndex만 결정.
 */
import type { Station } from '../shared/types/station';
import type { BoardingLock } from '../shared/types/boardingLock';
import { MOCK_STATIONS } from './fixtures';
import { makeDirectRoute } from './routeFixtures';

export type ArcFixture = {
  ARC_STATIONS: readonly [Station, Station, Station];
  BOARDING_LOCK: BoardingLock;
  routeContext: { route: ReturnType<typeof makeDirectRoute>; origin: Station; destination: Station };
};

/**
 * 3-역 arc(A/B/C, line='2') fixture 생성.
 * @param idPrefix 각 station.id의 접두사 (예: 'tp-' → 'tp-A', 'tp-B', 'tp-C')
 * @param boardingStationIdx 탑승역 arc 인덱스 (0=A, 1=B, 2=C)
 */
export function makeArcFixture(
  idPrefix: string,
  boardingStationIdx: 0 | 1 | 2,
): ArcFixture {
  const A: Station = {
    id: `${idPrefix}A`, name: '역A', line: '2', lineColor: '#009D3E', lat: 37.5, lng: 127,
  };
  const B: Station = {
    id: `${idPrefix}B`, name: '역B', line: '2', lineColor: '#009D3E', lat: 37.5, lng: 127.1,
  };
  const C: Station = {
    id: `${idPrefix}C`, name: '역C', line: '2', lineColor: '#009D3E', lat: 37.5, lng: 127.2,
  };
  const ARC_STATIONS = [A, B, C] as const;
  const boardingStation = ARC_STATIONS[boardingStationIdx];
  return {
    ARC_STATIONS,
    BOARDING_LOCK: {
      destinationId: 'dest-1',
      trainCode: 'T-2',
      boardingStationId: boardingStation.id,
      boardingLine: '2',
      boardedAt: Date.now(),
      expectedDurationMs: 1_800_000,
    },
    routeContext: {
      route: makeDirectRoute(2, '2'),
      origin: A,
      destination: C,
    },
  };
}

/** GPS base fixture — gangnam 좌표 + speed=2 + accuracy=50. 두 테스트가 동일하게 사용. */
export function makeArcGpsBase(): {
  result: { station: Station; distanceKm: number };
  variants: Station[];
  userLocation: { lat: number; lng: number };
  speedMps: number;
  accuracyMeters: number;
  loading: boolean;
  error: null;
  permissionDenied: boolean;
  locationUncertain: boolean;
  gpsActive: 'active';
  lastFixAtMs: number;
  refresh: jest.Mock;
} {
  return {
    result: { station: MOCK_STATIONS.gangnam, distanceKm: 0.1 },
    variants: [MOCK_STATIONS.gangnam],
    userLocation: { lat: 37.5, lng: 127 },
    speedMps: 2,
    accuracyMeters: 50,
    loading: false,
    error: null,
    permissionDenied: false,
    locationUncertain: false,
    gpsActive: 'active',
    lastFixAtMs: Date.now(),
    refresh: jest.fn(),
  };
}

/** trainProgress fixture — trainNo='T-2' + trainStatus=1 + confidence='single'. */
export function makeTrainProgressFor(station: Station): {
  trainNo: string;
  currentStation: Station;
  trainStatus: number;
  confidence: 'single';
} {
  return {
    trainNo: 'T-2',
    currentStation: station,
    trainStatus: 1,
    confidence: 'single',
  };
}
