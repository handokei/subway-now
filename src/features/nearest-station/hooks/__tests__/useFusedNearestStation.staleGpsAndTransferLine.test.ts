/* eslint-disable import/no-restricted-paths -- cross-feature orchestration (#890) */

/**
 * #1723 — GPS fallback 정제: stale 거부 + 환승역 line 보정.
 *
 * 사용자 6/23 evidence:
 *   - 13:56 trip 종료 후 새로고침 → 을지로3가 stuck (실제 위치 다름, stale GPS lastFix 6분 전)
 *   - 14:20 광흥창 도착 시 현재역 신내/합정 toggle (환승역 cascade picker switching)
 *
 * fix 영역:
 *   1. GPS lastFixAtMs 5분+ stale → cascade 최종 fallback에서 result=null (gps.liveResult 거부).
 *   2. 환승역(동명 station 여러 line)에서 boardingLock.boardingLine 일치 line 우선.
 *
 * 시나리오:
 *   A. stale GPS:
 *      A1. lastFixAtMs 5분 초과 → cascade fallback result=null
 *      A2. lastFixAtMs 5분 이내 → 정상 fallback (liveResult 채택)
 *      A3. lastFixAtMs null (cold start) → liveResult가 null이라 fallback도 null (기존 동작)
 *      A4. lastFixAtMs undefined (미주입 fixture) → liveResult 그대로 채택 (graceful)
 *      A5. stale + 다른 tier(positionTrain) active → tier 채택 (본 게이트 비진입)
 *      A6. shouldDowngradeFusion 강등 후에도 stale GPS면 result=null
 *
 *   B. 환승역 line 보정:
 *      B1. lock 활성 + liveResult line != boardingLine → boardingLine line으로 재해석
 *      B2. lock 활성 + liveResult line == boardingLine → 그대로 (no-op)
 *      B3. lockless trip + allowedLines size=1 → 그 line으로 재해석
 *      B4. lockless trip + allowedLines size > 1 → 보정 없음 (그대로)
 *      B5. lock 활성 + line mismatch + findStationByNameAndLine 매칭 실패 → 원본 그대로 (graceful)
 */

import { renderHook } from '@testing-library/react-native';
import { useFusedNearestStation } from '../useFusedNearestStation';
import { useNearestStation } from '../useNearestStation';
import { useArrivalInfo } from '../../../arrival/hooks/useArrivalInfo';
import { useTrainPositions } from '../../../route/hooks/useTrainPositions';
import { findTopNearestStations } from '../../utils/findNearestStation';
import { findStationByNameAndLine } from '../../../../shared/utils/stationLookup';
import {
  arrivalRet,
  positionRet,
  GPS_BASE_DEFAULTS,
  makeTrain,
} from '../../../../testUtils/positionApiFixtures';
import { TRAIN_STATUS } from '../../../../shared/constants/trainStatus';
import { GPS_FALLBACK_STALE_MAX_AGE_MS } from '../../../../shared/constants/realtime';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
import type { Station } from '../../../../shared/types/station';
import type { LinePositions } from '../../api/positionApi';

jest.mock('../../utils/findNearestStation', () => ({
  findTopNearestStations: jest.fn(),
}));
jest.mock('../useNearestStation');
jest.mock('../../../arrival/hooks/useArrivalInfo');
jest.mock('../../../route/hooks/useTrainPositions');
jest.mock('../../../alarm/utils/tripStartStorage', () => ({
  getTripStartedAt: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../../alarm/utils/backendSsotMirror', () => ({
  readBackendSsotMirror: jest.fn().mockResolvedValue(null),
}));

const mockNearest = useNearestStation as jest.Mock;
const mockArrival = useArrivalInfo as jest.Mock;
const mockPos = useTrainPositions as jest.Mock;
const mockFindTop = findTopNearestStations as jest.Mock;

// 합정: 2호선/6호선 환승역 — 동명 station 다른 line 케이스의 fixture.
const hapjeong2 = findStationByNameAndLine('합정', '2')!;
const hapjeong6 = findStationByNameAndLine('합정', '6')!;
const yongmasan7 = findStationByNameAndLine('용마산', '7')!;

const T0 = 1_700_000_000_000;

function makeLock(station: Station): BoardingLock {
  return {
    destinationId: 'dest',
    trainCode: 'T-LOCK',
    boardingLine: station.line,
    boardingStationId: station.id,
    boardedAt: T0,
    expectedDurationMs: 10 * 60_000,
  };
}

/** GPS mock: liveResult + lastFixAtMs를 명시 제어 (스테일 시나리오) */
function setupGps(
  liveStation: Station,
  options: {
    lastFixAtMs?: number | null;
    distanceKm?: number;
  } = {},
) {
  const distanceKm = options.distanceKm ?? 0.05;
  const live = { station: liveStation, distanceKm };
  mockNearest.mockReturnValue({
    result: live,
    liveResult: live,
    stickyDisplayOnly: null,
    variants: [liveStation],
    userLocation: { lat: liveStation.lat, lng: liveStation.lng },
    ...GPS_BASE_DEFAULTS,
    lastFixAtMs: options.lastFixAtMs,
    refresh: jest.fn(),
  });
  mockFindTop.mockReturnValue([{ station: liveStation, distanceKm }]);
  mockArrival.mockReturnValue(arrivalRet(null));
  mockPos.mockReturnValue(positionRet(null));
}

describe('#1723 GPS fallback stale + 환승역 line 보정', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(T0);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('A. stale GPS 처리', () => {
    it('A1: lastFixAtMs 5분 초과 → cascade fallback result=null', () => {
      setupGps(hapjeong2, { lastFixAtMs: T0 - (GPS_FALLBACK_STALE_MAX_AGE_MS + 1) });
      const hook = renderHook(() => useFusedNearestStation());
      expect(hook.result.current.result).toBeNull();
      expect(hook.result.current.source).toBe('gps');
      expect(hook.result.current.confidence).toBe('gps-only');
    });

    it('A2: lastFixAtMs 5분 이내 → 정상 fallback (liveResult 채택)', () => {
      setupGps(hapjeong2, { lastFixAtMs: T0 - (GPS_FALLBACK_STALE_MAX_AGE_MS - 1) });
      const hook = renderHook(() => useFusedNearestStation());
      expect(hook.result.current.result?.station.id).toBe(hapjeong2.id);
    });

    it('A3: lastFixAtMs=null + liveResult=null → fallback도 null (cold start)', () => {
      mockNearest.mockReturnValue({
        result: null,
        liveResult: null,
        stickyDisplayOnly: null,
        variants: [],
        userLocation: null,
        ...GPS_BASE_DEFAULTS,
        lastFixAtMs: null,
        refresh: jest.fn(),
      });
      mockFindTop.mockReturnValue([]);
      mockArrival.mockReturnValue(arrivalRet(null));
      mockPos.mockReturnValue(positionRet(null));
      const hook = renderHook(() => useFusedNearestStation());
      expect(hook.result.current.result).toBeNull();
    });

    it('A4: lastFixAtMs=undefined (테스트 fixture 미주입) → liveResult 그대로 (graceful)', () => {
      // 기존 테스트 호환: GPS_BASE_DEFAULTS는 lastFixAtMs를 포함 안 함 → undefined.
      // 이 경우 stale 게이트 비진입 → liveResult 그대로 채택.
      const live = { station: hapjeong2, distanceKm: 0.05 };
      mockNearest.mockReturnValue({
        result: live,
        liveResult: live,
        stickyDisplayOnly: null,
        variants: [hapjeong2],
        userLocation: { lat: hapjeong2.lat, lng: hapjeong2.lng },
        ...GPS_BASE_DEFAULTS,
        // lastFixAtMs 미주입 → undefined
        refresh: jest.fn(),
      });
      mockFindTop.mockReturnValue([{ station: hapjeong2, distanceKm: 0.05 }]);
      mockArrival.mockReturnValue(arrivalRet(null));
      mockPos.mockReturnValue(positionRet(null));
      const hook = renderHook(() => useFusedNearestStation());
      expect(hook.result.current.result?.station.id).toBe(hapjeong2.id);
    });

    it('A5: stale GPS + positionTrain active → positionTrain 채택 (게이트 비진입)', () => {
      // stale GPS임에도 positionTrain tier가 살아있으면 cascade가 positionTrain 채택 — 본 게이트는 미진입.
      const lock = makeLock(yongmasan7);
      const liveAtChungdam = findStationByNameAndLine('청담', '7')!;
      mockNearest.mockReturnValue({
        result: { station: liveAtChungdam, distanceKm: 0 },
        liveResult: { station: liveAtChungdam, distanceKm: 0 },
        stickyDisplayOnly: null,
        variants: [liveAtChungdam],
        userLocation: { lat: liveAtChungdam.lat, lng: liveAtChungdam.lng },
        ...GPS_BASE_DEFAULTS,
        lastFixAtMs: T0 - (GPS_FALLBACK_STALE_MAX_AGE_MS + 60_000), // 6분 전 stale
        refresh: jest.fn(),
      });
      mockFindTop.mockReturnValue([{ station: yongmasan7, distanceKm: 0 }]);
      // positionTrain: 7호선 용마산에 lock.trainCode 매칭 열차 정차 → positionTrain tier 진입.
      const train = makeTrain('용마산', TRAIN_STATUS.ARRIVED, { trainNo: lock.trainCode });
      const linePositions: LinePositions = {
        line: '7',
        trains: [train],
      };
      mockPos.mockImplementation((line: string | null) => {
        if (line === '7') return positionRet(linePositions);
        return positionRet(null);
      });
      mockArrival.mockReturnValue(arrivalRet(null));
      const hook = renderHook(() =>
        useFusedNearestStation(undefined, undefined, undefined, lock.trainCode, lock),
      );
      // positionTrain tier가 1순위 → 용마산 채택 (stale GPS의 청담 무시).
      expect(hook.result.current.source).not.toBe('gps');
      expect(hook.result.current.result?.station.id).toBe(yongmasan7.id);
    });

    it('A6: shouldDowngradeFusion 강등 후 stale GPS면 result=null (motionStationary + speedMps=0 합의)', () => {
      // 정적 합의 2 signal(speed=0 + motionStationary=true) + position-train 채택 → shouldDowngradeFusion 강등.
      // 강등 후 GPS fallback이 stale → applyTransferLineCorrection(null) = null.
      const lock = makeLock(yongmasan7);
      const train = makeTrain('용마산', TRAIN_STATUS.ARRIVED, { trainNo: 'OTHER-TRAIN' });
      const linePositions: LinePositions = { line: '7', trains: [train] };
      mockNearest.mockReturnValue({
        result: { station: yongmasan7, distanceKm: 0 },
        liveResult: { station: yongmasan7, distanceKm: 0 },
        stickyDisplayOnly: null,
        variants: [yongmasan7],
        userLocation: { lat: yongmasan7.lat, lng: yongmasan7.lng },
        ...GPS_BASE_DEFAULTS,
        speedMps: 0, // 정적 신호 1
        accuracyMeters: 14,
        lastFixAtMs: T0 - (GPS_FALLBACK_STALE_MAX_AGE_MS + 60_000), // 6분 전 stale
        refresh: jest.fn(),
      });
      mockFindTop.mockReturnValue([{ station: yongmasan7, distanceKm: 0 }]);
      mockPos.mockImplementation((line: string | null) => {
        if (line === '7') return positionRet(linePositions);
        return positionRet(null);
      });
      mockArrival.mockReturnValue(arrivalRet(null));
      // motionStationary=true (정적 신호 2) → consensus 2 충족 → shouldDowngradeFusion 강등.
      // 강등 후 fallback이 stale GPS이므로 result=null.
      const hook = renderHook(() =>
        useFusedNearestStation(
          undefined,
          undefined,
          undefined,
          lock.trainCode,
          lock,
          true, // motionStationary
        ),
      );
      expect(hook.result.current.source).toBe('gps');
      expect(hook.result.current.result).toBeNull();
    });

    it('A7: shouldDowngradeFusion 강등 후 fresh GPS + 환승역 line drift → 환승역 line 보정 적용', () => {
      // lock 활성 (line 6) + position-train tier 채택 → 정적 신호 2건 합의 → 강등 → gps-only.
      // 강등 후 fallback이 fresh이지만 hapjeong2(line 2) → 환승역 line 보정으로 hapjeong6(line 6) 노출.
      const lock = makeLock(hapjeong6);
      const train = makeTrain('합정', TRAIN_STATUS.ARRIVED, { trainNo: 'OTHER-TRAIN' });
      const linePositions: LinePositions = { line: '6', trains: [train] };
      mockNearest.mockReturnValue({
        result: { station: hapjeong2, distanceKm: 0.05 }, // GPS는 hapjeong2 (line 2)로 산출
        liveResult: { station: hapjeong2, distanceKm: 0.05 },
        stickyDisplayOnly: null,
        variants: [hapjeong2, hapjeong6],
        userLocation: { lat: hapjeong2.lat, lng: hapjeong2.lng },
        ...GPS_BASE_DEFAULTS,
        speedMps: 0,
        accuracyMeters: 14,
        lastFixAtMs: T0, // fresh
        refresh: jest.fn(),
      });
      mockFindTop.mockReturnValue([{ station: hapjeong6, distanceKm: 0.05 }]);
      mockPos.mockImplementation((line: string | null) => {
        if (line === '6') return positionRet(linePositions);
        return positionRet(null);
      });
      mockArrival.mockReturnValue(arrivalRet(null));
      const hook = renderHook(() =>
        useFusedNearestStation(
          undefined,
          undefined,
          undefined,
          lock.trainCode,
          lock,
          true,
        ),
      );
      // 강등 결과: source='gps', result=hapjeong6 (lock.boardingLine=6으로 재해석).
      expect(hook.result.current.source).toBe('gps');
      expect(hook.result.current.result?.station.id).toBe(hapjeong6.id);
      expect(hook.result.current.result?.station.line).toBe('6');
    });
  });

  describe('B. 환승역 line 보정', () => {
    it('B1: lock 활성 + liveResult line != boardingLine → boardingLine line으로 재해석', () => {
      // liveResult가 합정@2호선(stations.json entry order로 GPS top-1 채택)이지만 lock은 6호선.
      // gpsFallbackResult helper가 boardingLine=6으로 재해석.
      const lock = makeLock(hapjeong6);
      setupGps(hapjeong2, { lastFixAtMs: T0 });
      const hook = renderHook(() =>
        useFusedNearestStation(undefined, undefined, undefined, undefined, lock),
      );
      // fallback 결과는 같은 name '합정'이지만 line='6' (lock.boardingLine).
      expect(hook.result.current.result?.station.name).toBe('합정');
      expect(hook.result.current.result?.station.line).toBe('6');
      expect(hook.result.current.result?.station.id).toBe(hapjeong6.id);
    });

    it('B2: lock 활성 + liveResult line == boardingLine → 그대로 (no-op)', () => {
      const lock = makeLock(hapjeong2);
      setupGps(hapjeong2, { lastFixAtMs: T0 });
      const hook = renderHook(() =>
        useFusedNearestStation(undefined, undefined, undefined, undefined, lock),
      );
      expect(hook.result.current.result?.station.id).toBe(hapjeong2.id);
    });

    it('B3: lockless trip + allowedLines size=1 → 그 line으로 재해석', () => {
      // direct route on 6호선 → allowedLines = {'6'}. liveResult는 합정@2 → 재해석 합정@6.
      setupGps(hapjeong2, { lastFixAtMs: T0 });
      const origin = findStationByNameAndLine('상수', '6')!;
      const destination = findStationByNameAndLine('망원', '6')!;
      const routeContext = {
        route: { type: 'direct' as const, line: '6' as const, stops: 2, travelSeconds: 120 },
        origin,
        destination,
      };
      const hook = renderHook(() =>
        useFusedNearestStation(undefined, undefined, routeContext),
      );
      expect(hook.result.current.result?.station.line).toBe('6');
      expect(hook.result.current.result?.station.id).toBe(hapjeong6.id);
    });

    it('B4: liveResult가 환승역이 아닌 단일 line station → 보정 없음 (그대로)', () => {
      // 용마산은 7호선 단일 — boardingLine 일치 여부와 무관하게 그대로.
      setupGps(yongmasan7, { lastFixAtMs: T0 });
      const lock = makeLock(yongmasan7);
      const hook = renderHook(() =>
        useFusedNearestStation(undefined, undefined, undefined, undefined, lock),
      );
      expect(hook.result.current.result?.station.id).toBe(yongmasan7.id);
    });

    it('B5: lock 활성 + line mismatch + findStationByNameAndLine 매칭 실패 → 원본 그대로 (graceful)', () => {
      // 용마산은 7호선만 — boardingLine='2'로 재해석 시도 시 매칭 실패 → 원본(용마산@7) 그대로.
      // lockOn2: 2호선 lock인데 GPS는 7호선 단일 station을 가리킴 (실제 production에선 allowedLines가
      // 이미 차단하지만 본 helper graceful 분기 커버).
      setupGps(yongmasan7, { lastFixAtMs: T0 });
      const lockOn2: BoardingLock = {
        destinationId: 'dest',
        trainCode: 'T-LOCK',
        boardingLine: '2',
        boardingStationId: 'dummy-2',
        boardedAt: T0,
        expectedDurationMs: 10 * 60_000,
      };
      const hook = renderHook(() =>
        useFusedNearestStation(undefined, undefined, undefined, undefined, lockOn2),
      );
      // 매칭 실패 → 원본 용마산@7 그대로.
      expect(hook.result.current.result?.station.id).toBe(yongmasan7.id);
      expect(hook.result.current.result?.station.line).toBe('7');
    });

    it('B6: lockless + allowedLines undefined → 보정 없음 (그대로)', () => {
      // routeContext 없음 → allowedLines undefined → 보정 helper에서 preferredLine null → 원본 그대로.
      setupGps(hapjeong2, { lastFixAtMs: T0 });
      const hook = renderHook(() => useFusedNearestStation());
      expect(hook.result.current.result?.station.id).toBe(hapjeong2.id);
    });
  });
});
