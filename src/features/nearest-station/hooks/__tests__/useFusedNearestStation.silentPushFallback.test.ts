/* eslint-disable import/no-restricted-paths -- cross-feature orchestration (#890) */

/**
 * #1677 — silent push FG fallback: cascade `silentPushHealthy=false` 시 backend-ssot 강등.
 * #2261 (ADR-031 Phase 0) — 위 게이트를 제거. freshness가 `receivedAt`(FG position pull이
 * mirror에 도달한 시각) 기준으로 재정의되면서, push 건강도와 무관하게 backend 생존이 이미
 * 증명되므로 silentPushHealthy AND-gate가 지하·정지(non-advancing) trip을 영구 미채택시키는
 * deadlock을 유발했다 (RCA 2026-08-09). 본 파일은 게이트 소멸을 회귀 가드로 검증한다.
 *
 * 시나리오:
 *   1. silentPushHealthy=false + mirror fresh(receivedAt) → backend-ssot **채택** (게이트 소멸,
 *      #2261 핵심 회귀 가드 — deadlock 해소).
 *   2. silentPushHealthy=true + mirror fresh → 기존대로 backend-ssot 채택.
 *   3. silentPushHealthy=undefined(미전달) + mirror fresh → 기존대로 backend-ssot 채택.
 *   4. silentPushHealthy=false + mirror stale(receivedAt) → 기존 stale 거부 그대로 (staleness는
 *      push 건강도와 독립적으로 여전히 적용).
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

describe('#1677 / #2261 cascade — silentPushHealthy gate 소멸 회귀 가드', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(T0);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('#2261 핵심: silentPushHealthy=false + mirror fresh(receivedAt) → backend-ssot 채택 (deadlock 해소)', async () => {
    // GPS는 청담, mirror는 용마산을 권위 산출 — receivedAt이 fresh하면 push 건강도 무관하게 채택.
    // 지하·정지(non-advancing) trip에서 push 60s 미수신이어도 FG pull이 mirror를 계속 갱신한다면
    // 이 케이스가 실제 동작이다.
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
    await waitFor(() => {
      expect(hook.result.current.source).toBe('backend-ssot');
    });
    expect(hook.result.current.result?.station.id).toBe(yongmasan.id);
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

  it('시나리오 4: silentPushHealthy=false + mirror stale(receivedAt) → GPS fallback (staleness는 여전히 적용)', async () => {
    setupGpsAt('청담');
    mockRead.mockResolvedValue(
      makeBackendSsotMirrorEntry({
        currentStationId: yongmasan.name,
        receivedAt: T0 - 240_000, // 4분 전 — stale
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
