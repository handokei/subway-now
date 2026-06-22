/* eslint-disable import/no-restricted-paths -- cross-feature orchestration (#890) */

/**
 * #1677 — silent push FG fallback: cascade `silentPushHealthy=false` 시 backend-ssot 강등.
 *
 * 시나리오:
 *   1. silentPushHealthy=false + mirror fresh → backend-ssot 거부 → GPS fallback.
 *   2. silentPushHealthy=true + mirror fresh → 기존대로 backend-ssot 채택.
 *   3. silentPushHealthy=undefined(미전달) + mirror fresh → 기존대로 backend-ssot 채택.
 *   4. silentPushHealthy=false + mirror stale → 기존 stale 거부 그대로 (부작용 없음).
 *   5. silentPushHealthy=false + mirror 없음 → 기존 GPS fallback (변화 없음).
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

const yongmasan = findStationByNameAndLine('용마산', '7')!;
const chungang = findStationByNameAndLine('청담', '7')!;

/** GPS를 특정 역(7호선)에 설정. */
function setupGpsAt(stationName: string) {
  const stn = findStationByNameAndLine(stationName, '7')!;
  const live = { station: stn, distanceKm: 0 };
  mockNearest.mockReturnValue({
    result: live,
    liveResult: live,
    stickyDisplayOnly: null,
    variants: [stn],
    userLocation: { lat: stn.lat, lng: stn.lng },
    ...GPS_BASE_DEFAULTS,
    accuracyMeters: 14,
    refresh: jest.fn(),
  });
  mockFindTop.mockReturnValue([{ station: stn, distanceKm: 0 }]);
  mockArrival.mockReturnValue(arrivalRet(null));
  mockPos.mockReturnValue(positionRet(null));
}

describe('#1677 cascade — silentPushHealthy gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(T0);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('시나리오 1: silentPushHealthy=false + mirror fresh → backend-ssot 거부, GPS fallback', async () => {
    // GPS는 청담, mirror는 용마산을 권위 산출 — healthy=false 시 mirror 무시 → GPS(청담) 채택.
    setupGpsAt('청담');
    mockRead.mockResolvedValue(makeBackendSsotMirrorEntry({ currentStationId: yongmasan.name }));

    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined,
        /* silentPushHealthy= */ false,
      ),
    );
    await flushBackendSsotMirrorTick();
    // backend-ssot가 아닌 GPS fallback.
    await waitFor(() => {
      expect(hook.result.current.source).not.toBe('backend-ssot');
    });
    expect(hook.result.current.result?.station.name).toBe(chungang.name);
  });

  it('시나리오 2: silentPushHealthy=true + mirror fresh → backend-ssot 채택', async () => {
    setupGpsAt('청담');
    mockRead.mockResolvedValue(makeBackendSsotMirrorEntry({ currentStationId: yongmasan.name }));

    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined,
        /* silentPushHealthy= */ true,
      ),
    );
    await flushBackendSsotMirrorTick();
    await waitFor(() => {
      expect(hook.result.current.source).toBe('backend-ssot');
    });
    expect(hook.result.current.result?.station.id).toBe(yongmasan.id);
  });

  it('시나리오 3: silentPushHealthy=undefined(미전달) + mirror fresh → backend-ssot 채택', async () => {
    setupGpsAt('청담');
    mockRead.mockResolvedValue(makeBackendSsotMirrorEntry({ currentStationId: yongmasan.name }));

    const hook = renderHook(() =>
      useFusedNearestStation(undefined, undefined, undefined, undefined, undefined),
    );
    await flushBackendSsotMirrorTick();
    await waitFor(() => {
      expect(hook.result.current.source).toBe('backend-ssot');
    });
    expect(hook.result.current.result?.station.id).toBe(yongmasan.id);
  });

  it('시나리오 4: silentPushHealthy=false + mirror stale → GPS fallback (부작용 없음)', async () => {
    setupGpsAt('청담');
    mockRead.mockResolvedValue(
      makeBackendSsotMirrorEntry({
        currentStationId: yongmasan.name,
        lastAdvanceAt: T0 - 240_000, // 4분 전 — stale
      }),
    );

    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined,
        /* silentPushHealthy= */ false,
      ),
    );
    await flushBackendSsotMirrorTick();
    // stale이므로 healthy 여부 무관하게 backend-ssot 채택 안 됨.
    expect(hook.result.current.source).not.toBe('backend-ssot');
  });

  it('시나리오 5: silentPushHealthy=false + mirror 없음 → GPS fallback (변화 없음)', async () => {
    setupGpsAt('청담');
    mockRead.mockResolvedValue(null);

    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined,
        /* silentPushHealthy= */ false,
      ),
    );
    await flushBackendSsotMirrorTick();
    expect(hook.result.current.source).not.toBe('backend-ssot');
    // GPS 청담이 cascade fallback.
    expect(hook.result.current.result?.station.name).toBe(chungang.name);
  });
});
