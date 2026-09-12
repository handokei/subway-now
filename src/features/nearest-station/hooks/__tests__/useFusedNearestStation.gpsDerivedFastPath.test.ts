/* eslint-disable import/no-restricted-paths -- cross-feature orchestration (#890) */

/**
 * #1657 — GPS-derived advance fast-path (지상 lock 활성 보완).
 *
 * PR #1646 보완 테스트 — 지상(subsurface===false) lock 활성 + GPS 신선 + 노선 정합 4-gate 합의.
 *
 * 시나리오:
 *   1. 4-gate 모두 충족 → GPS-derived station 1순위 (backend mirror 무시).
 *   2. GPS stale(accuracy > 50m) → 게이트 실패 → 기존 cascade(backend-ssot) 채택.
 *   3. GPS fix age 초과(> 30s) → 게이트 실패 → 기존 cascade.
 *   4. 지하(subsurface === true) → 게이트 실패 → PR #1646 경로(positionTrain 분기) 또는 기존 cascade.
 *   5. lockless trip(boardingLock=null) → 게이트 실패 → 기존 cascade.
 *   6. 노선 불일치(candidates[0].line !== boardingLine) → 게이트 실패 → 기존 cascade.
 *   7. 노선 정합이지만 100m 초과 → 게이트 실패 → 기존 cascade.
 */

import { renderHook, waitFor } from '@testing-library/react-native';
import { useFusedNearestStation } from '../useFusedNearestStation';
import { useNearestStation } from '../useNearestStation';
import { useArrivalInfo } from '../../../arrival/hooks/useArrivalInfo';
import { useTrainPositions } from '../../../route/hooks/useTrainPositions';
import { findTopNearestStations } from '../../utils/findNearestStation';
import { findStationByNameAndLine } from '../../../../shared/utils/stationRoute';
import {
  arrivalRet,
  positionRet,
  GPS_BASE_DEFAULTS,
} from '../../../../testUtils/positionApiFixtures';
import {
  BACKEND_SSOT_FIXTURE_T0 as T0,
  flushBackendSsotMirrorTick,
  makeBackendSsotMirrorEntry,
} from '../../../../testUtils/backendSsotMirrorFixtures';
import { readBackendSsotMirror } from '../../../alarm/utils/backendSsotMirror';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
import {
  GPS_DERIVED_ACCURACY_MAX_M,
  GPS_DERIVED_FIX_MAX_AGE_MS,
  GPS_DERIVED_ROUTE_MATCH_MAX_KM,
} from '../../../../shared/constants/realtime';

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
  readBackendSsotMirror: jest.fn(),
}));

const mockNearest = useNearestStation as jest.Mock;
const mockArrival = useArrivalInfo as jest.Mock;
const mockPos = useTrainPositions as jest.Mock;
const mockFindTop = findTopNearestStations as jest.Mock;
const mockRead = readBackendSsotMirror as jest.Mock;

const hanyangdae = findStationByNameAndLine('한양대', '2')!;
const ttukssom = findStationByNameAndLine('뚝섬', '2')!;
// 2호선과 노선이 다른 역 — line mismatch 시나리오용 (7호선 역)
const junggok7 = findStationByNameAndLine('중곡', '7')!;

const lockOn2: BoardingLock = {
  destinationId: 'dest-2',
  trainCode: 'T-LOCK',
  boardingLine: '2',
  boardingStationId: hanyangdae.id,
  boardedAt: T0,
  expectedDurationMs: 10 * 60_000,
};

/**
 * GPS를 stationName(2호선) + freshAge(ms) + accuracy(m) + distance(km)로 설정.
 * lastFixAtMs = T0 - freshAge.
 */
function setupSurfaceGps({
  station = hanyangdae,
  accuracy = GPS_DERIVED_ACCURACY_MAX_M,
  freshAgeMs = 0,
  distanceKm = GPS_DERIVED_ROUTE_MATCH_MAX_KM - 0.001,
}: {
  station?: typeof hanyangdae;
  accuracy?: number | null;
  freshAgeMs?: number;
  distanceKm?: number;
} = {}) {
  const live = { station, distanceKm };
  mockNearest.mockReturnValue({
    result: live,
    liveResult: live,
    stickyDisplayOnly: null,
    variants: [station],
    userLocation: { lat: station.lat, lng: station.lng },
    ...GPS_BASE_DEFAULTS,
    accuracyMeters: accuracy,
    lastFixAtMs: T0 - freshAgeMs,
    refresh: jest.fn(),
  });
  mockFindTop.mockReturnValue([{ station, distanceKm }]);
  mockArrival.mockReturnValue(arrivalRet(null));
  mockPos.mockReturnValue(positionRet(null));
}

describe('#1657 GPS-derived advance fast-path (지상 lock 활성)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    // 기본: backend mirror는 ttukssom(다른 역)으로 fresh하게 세팅 → gate 미충족 시 backend-ssot 채택 확인
    mockRead.mockResolvedValue(
      makeBackendSsotMirrorEntry({
        currentStationId: ttukssom.name,
        lastAdvanceAt: T0,
        receivedAt: T0,
      }),
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('4-gate 모두 충족 → GPS-derived station 1순위 (backend mirror 무시)', async () => {
    // 한양대 GPS 신선(accuracy 50m, age 0s, distance 0.09km, 2호선 정합)
    setupSurfaceGps({ station: hanyangdae, accuracy: GPS_DERIVED_ACCURACY_MAX_M, freshAgeMs: 0 });

    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        undefined,
        lockOn2,
        undefined,
        { subsurface: false },
      ),
    );
    await flushBackendSsotMirrorTick();
    // backend mirror는 ttukssom이지만 GPS-derived fast-path가 1순위 → hanyangdae 채택
    await waitFor(() => {
      expect(hook.result.current.result?.station.id).toBe(hanyangdae.id);
    });
    // confidence는 gps-only (GPS 신호원), source는 gps
    expect(hook.result.current.confidence).toBe('gps-only');
    expect(hook.result.current.source).toBe('gps');
  });

  it('GPS accuracy > MAX → 게이트 실패 → backend-ssot 채택', async () => {
    setupSurfaceGps({ accuracy: GPS_DERIVED_ACCURACY_MAX_M + 1 });

    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        undefined,
        lockOn2,
        undefined,
        { subsurface: false },
      ),
    );
    await flushBackendSsotMirrorTick();
    await waitFor(() => {
      expect(hook.result.current.source).toBe('backend-ssot');
    });
    expect(hook.result.current.result?.station.id).toBe(ttukssom.id);
  });

  it('GPS fix age > MAX(30s) → 게이트 실패 → backend-ssot 채택', async () => {
    setupSurfaceGps({ freshAgeMs: GPS_DERIVED_FIX_MAX_AGE_MS + 1 });

    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        undefined,
        lockOn2,
        undefined,
        { subsurface: false },
      ),
    );
    await flushBackendSsotMirrorTick();
    await waitFor(() => {
      expect(hook.result.current.source).toBe('backend-ssot');
    });
    expect(hook.result.current.result?.station.id).toBe(ttukssom.id);
  });

  it('lastFixAtMs=null(GPS 미fix) → 게이트 실패 → backend-ssot 채택', async () => {
    const live = { station: hanyangdae, distanceKm: 0.05 };
    mockNearest.mockReturnValue({
      result: live,
      liveResult: live,
      stickyDisplayOnly: null,
      variants: [hanyangdae],
      userLocation: { lat: hanyangdae.lat, lng: hanyangdae.lng },
      ...GPS_BASE_DEFAULTS,
      accuracyMeters: GPS_DERIVED_ACCURACY_MAX_M,
      lastFixAtMs: null, // GPS fix 없음
      refresh: jest.fn(),
    });
    mockFindTop.mockReturnValue([{ station: hanyangdae, distanceKm: 0.05 }]);
    mockArrival.mockReturnValue(arrivalRet(null));
    mockPos.mockReturnValue(positionRet(null));

    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        undefined,
        lockOn2,
        undefined,
        { subsurface: false },
      ),
    );
    await flushBackendSsotMirrorTick();
    await waitFor(() => {
      expect(hook.result.current.source).toBe('backend-ssot');
    });
  });

  it('지하(subsurface=true) → 게이트 실패 → backend-ssot 채택', async () => {
    setupSurfaceGps();

    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        undefined,
        lockOn2,
        undefined,
        { subsurface: true }, // 지하
      ),
    );
    await flushBackendSsotMirrorTick();
    await waitFor(() => {
      expect(hook.result.current.source).toBe('backend-ssot');
    });
  });

  it('lockless trip(boardingLock=null) → 게이트 실패 → backend-ssot 채택', async () => {
    setupSurfaceGps();

    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        undefined,
        null, // boardingLock 없음
        undefined,
        { subsurface: false },
      ),
    );
    await flushBackendSsotMirrorTick();
    await waitFor(() => {
      expect(hook.result.current.source).toBe('backend-ssot');
    });
  });

  it('candidates[0] 노선 불일치(7호선) → 게이트 실패 → backend-ssot 채택', async () => {
    // 7호선 중곡역이 candidates[0]가 되도록 설정 (lock은 2호선) → boardingLine mismatch
    setupSurfaceGps({ station: junggok7, distanceKm: 0.05 });

    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        undefined,
        lockOn2, // boardingLine: '2'
        undefined,
        { subsurface: false },
      ),
    );
    await flushBackendSsotMirrorTick();
    await waitFor(() => {
      expect(hook.result.current.source).toBe('backend-ssot');
    });
  });

  it('노선 정합이지만 distance > 100m → 게이트 실패 → backend-ssot 채택', async () => {
    setupSurfaceGps({ distanceKm: GPS_DERIVED_ROUTE_MATCH_MAX_KM + 0.001 });

    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        undefined,
        lockOn2,
        undefined,
        { subsurface: false },
      ),
    );
    await flushBackendSsotMirrorTick();
    await waitFor(() => {
      expect(hook.result.current.source).toBe('backend-ssot');
    });
  });

  it('subsurface=undefined(barometer 미전달) → 게이트 실패 → backend-ssot 채택', async () => {
    setupSurfaceGps();

    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        undefined,
        lockOn2,
        undefined,
        undefined, // barometer 미전달
      ),
    );
    await flushBackendSsotMirrorTick();
    await waitFor(() => {
      expect(hook.result.current.source).toBe('backend-ssot');
    });
  });
});
