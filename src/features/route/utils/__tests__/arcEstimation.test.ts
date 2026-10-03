import {
  estimateArcStationsFromRoute,
  ESTIMATE_ARC_WINDOW_STATIONS,
} from '../arcEstimation';
import { findStationByNameAndLine } from '../../../../shared/utils/stationRoute';
import type { Station } from '../../../../shared/types/station';
import {
  makeDirectRoute,
  makeMultiTransferRoute,
  makeTransferRoute,
} from '../../../../testUtils/routeFixtures';

const childrenPark = findStationByNameAndLine('어린이대공원', '7')!;
const sagajeong = findStationByNameAndLine('사가정', '7')!;
const gunja = findStationByNameAndLine('군자', '7')!;
const konkukUni7 = findStationByNameAndLine('건대입구', '7')!;
const jamsil2 = findStationByNameAndLine('잠실', '2')!;

// userLocation near 어린이대공원
const NEAR_CHILDREN_PARK = { lat: childrenPark.lat, lng: childrenPark.lng };
const NEAR_SAGAJEONG = { lat: sagajeong.lat, lng: sagajeong.lng };

describe('estimateArcStationsFromRoute', () => {
  describe('graceful fallback (returns undefined)', () => {
    it.each<{ label: string; override: Record<string, unknown> }>([
      { label: 'route null', override: { route: null } },
      { label: 'origin null', override: { origin: null } },
      { label: 'destination null', override: { destination: null } },
      { label: 'userLocation null', override: { userLocation: null } },
    ])('returns undefined when $label', ({ override }) => {
      const base = {
        route: makeDirectRoute(4, '7'),
        origin: sagajeong,
        destination: childrenPark,
        userLocation: NEAR_CHILDREN_PARK,
      };
      const result = estimateArcStationsFromRoute({ ...base, ...override });
      expect(result).toBeUndefined();
    });

    it('returns undefined when arc cannot be computed (invalid endpoints on direct route)', () => {
      // direct route line=7, origin id가 line 7에 없으면 computeRouteArc null.
      const fake: Station = { ...gunja, id: 'nonexistent-id' };
      const result = estimateArcStationsFromRoute({
        route: makeDirectRoute(4, '7'),
        origin: fake,
        destination: childrenPark,
        userLocation: NEAR_CHILDREN_PARK,
      });
      expect(result).toBeUndefined();
    });
  });

  describe('window computation', () => {
    it('returns window around user-nearest station on direct route arc', () => {
      const result = estimateArcStationsFromRoute({
        route: makeDirectRoute(4, '7'),
        origin: sagajeong,
        destination: childrenPark,
        userLocation: NEAR_CHILDREN_PARK,
      });
      expect(result).not.toBeUndefined();
      expect(result!.segmentStations.length).toBeGreaterThan(0);
      // userLocation이 childrenPark이므로 윈도우는 childrenPark를 포함해야 함.
      const names = result!.segmentStations.map((s) => s.name);
      expect(names).toContain(childrenPark.name);
      // boardingStationId = window 첫 station의 id.
      expect(result!.boardingStationId).toBe(result!.segmentStations[0].id);
    });

    it('clamps window at arc start when user is near origin', () => {
      const result = estimateArcStationsFromRoute({
        route: makeDirectRoute(4, '7'),
        origin: sagajeong,
        destination: childrenPark,
        userLocation: NEAR_SAGAJEONG,
      });
      expect(result).not.toBeUndefined();
      // sagajeong(=origin)이 첫 station이어야 — start 인덱스 0으로 clamp.
      expect(result!.segmentStations[0].name).toBe(sagajeong.name);
    });

    it('uses default window when windowStations omitted', () => {
      const result = estimateArcStationsFromRoute({
        route: makeDirectRoute(4, '7'),
        origin: sagajeong,
        destination: childrenPark,
        userLocation: NEAR_CHILDREN_PARK,
      });
      // window=3 default → max 2*3+1 = 7 stations (end clamp 시 ≤ arc 길이).
      expect(result!.segmentStations.length).toBeLessThanOrEqual(2 * ESTIMATE_ARC_WINDOW_STATIONS + 1);
    });

    it('respects custom windowStations override', () => {
      const result = estimateArcStationsFromRoute({
        route: makeDirectRoute(4, '7'),
        origin: sagajeong,
        destination: childrenPark,
        userLocation: NEAR_CHILDREN_PARK,
        windowStations: 1,
      });
      expect(result!.segmentStations.length).toBeLessThanOrEqual(3);
    });

    it('clamps negative windowStations to 0 (single station window)', () => {
      const result = estimateArcStationsFromRoute({
        route: makeDirectRoute(4, '7'),
        origin: sagajeong,
        destination: childrenPark,
        userLocation: NEAR_CHILDREN_PARK,
        windowStations: -1,
      });
      // window=0 → 단일 station만(user nearest).
      expect(result!.segmentStations).toHaveLength(1);
    });
  });

  describe('route variants', () => {
    it('works with transfer route', () => {
      const route = makeTransferRoute({
        transferName: '건대입구',
        fromLine: '7',
        toLine: '2',
        stopsToTransfer: 1,
        stopsFromTransfer: 4,
      });
      const result = estimateArcStationsFromRoute({
        route,
        origin: childrenPark,
        destination: jamsil2,
        userLocation: { lat: konkukUni7.lat, lng: konkukUni7.lng },
      });
      expect(result).not.toBeUndefined();
      expect(result!.segmentStations.length).toBeGreaterThan(0);
    });

    it('works with multi-transfer route', () => {
      const route = makeMultiTransferRoute({
        transfers: [
          {
            transferName: '건대입구',
            fromLine: '7',
            toLine: '2',
            stopsToTransfer: 1,
          },
        ],
        stopsAfterLastTransfer: 4,
      });
      const result = estimateArcStationsFromRoute({
        route,
        origin: childrenPark,
        destination: jamsil2,
        userLocation: { lat: konkukUni7.lat, lng: konkukUni7.lng },
      });
      expect(result).not.toBeUndefined();
      expect(result!.segmentStations.length).toBeGreaterThan(0);
    });
  });
});
