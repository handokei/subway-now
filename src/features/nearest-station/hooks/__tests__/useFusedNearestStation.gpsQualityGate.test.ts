/* eslint-disable import/no-restricted-paths -- cross-feature orchestration integration test (#890) */

/**
 * #2070 — useNearestStation이 자체 산출한 gpsQualityDegraded가 useFusedNearestStation의
 * inferEnvironment 호출에 추가 입력으로 전달됨을 검증. barometer/SSOT 명시 판정이 없는
 * (subsurface===undefined, 두 SSOT 무판정) 구간에서만 관여하고, 다른 판정(surfaceSSOT 등)이
 * 있으면 여전히 그 결과가 우선한다.
 */

import { renderHook, waitFor } from '@testing-library/react-native';
import { useFusedNearestStation } from '../useFusedNearestStation';
import { useNearestStation } from '../useNearestStation';
import { useArrivalInfo } from '../../../arrival/hooks/useArrivalInfo';
import { useTrainPositions } from '../../../route/hooks/useTrainPositions';
import { findTopNearestStations } from '../../utils/findNearestStation';
import { findStationByNameAndLine } from '../../../../shared/utils/stationRoute';
import { arrivalRet, positionRet, GPS_BASE_DEFAULTS } from '../../../../testUtils/positionApiFixtures';
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

const hanyangdae = findStationByNameAndLine('한양대', '2')!;
const ttukssom = findStationByNameAndLine('뚝섬', '2')!;

function setupNearest(gpsQualityDegraded: boolean): void {
  const live = { station: hanyangdae, distanceKm: 0.05 };
  mockNearest.mockReturnValue({
    result: live,
    liveResult: live,
    stickyDisplayOnly: null,
    variants: [hanyangdae],
    userLocation: { lat: hanyangdae.lat, lng: hanyangdae.lng },
    ...GPS_BASE_DEFAULTS,
    accuracyMeters: 200, // surfaceSSOT/undergroundSSOT 둘 다 미합의 (부정확 GPS)
    lastFixAtMs: T0,
    gpsQualityDegraded,
    refresh: jest.fn(),
  });
  mockFindTop.mockReturnValue([{ station: hanyangdae, distanceKm: 0.05 }]);
  mockArrival.mockReturnValue(arrivalRet(null));
  mockPos.mockReturnValue(positionRet(null));
}

describe('#2070 useFusedNearestStation — gpsQualityDegraded → inferEnvironment 추가 입력', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    // backend mirror는 다른 역으로 fresh하게 세팅 — cascade tier 1/2 미진입 시 fallback 확인.
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

  it('subsurface 미전달 + SSOT 무판정 + gpsQualityDegraded=true → environment=underground (hint gps-quality-drop)', async () => {
    setupNearest(true);

    const hook = renderHook(() => useFusedNearestStation());
    await flushBackendSsotMirrorTick();

    await waitFor(() => {
      expect(hook.result.current.environment).toBe('underground');
    });
    expect(hook.result.current.environmentHintReason).toBe('gps-quality-drop');
  });

  it('subsurface 미전달 + SSOT 무판정 + gpsQualityDegraded=false → environment=unknown (기존 동작 보존)', async () => {
    setupNearest(false);

    const hook = renderHook(() => useFusedNearestStation());
    await flushBackendSsotMirrorTick();

    await waitFor(() => {
      expect(hook.result.current.environment).toBe('unknown');
    });
    expect(hook.result.current.environmentHintReason).toBeUndefined();
  });

  it('barometer.subsurface=false 명시 시 gpsQualityDegraded=true여도 surface 우선 (기존 판정 대체 아님)', async () => {
    setupNearest(true);

    const hook = renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { subsurface: false },
      ),
    );
    await flushBackendSsotMirrorTick();

    await waitFor(() => {
      expect(hook.result.current.environment).toBe('surface');
    });
    expect(hook.result.current.environmentHintReason).toBeUndefined();
  });
});
