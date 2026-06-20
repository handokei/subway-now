/* eslint-disable import/no-restricted-paths -- cross-feature orchestration (#890) */

/**
 * #1605 (Estimator lockless-route-hop idx 비정상 — Backend SSoT 우선) 회귀 가드.
 *
 * 시나리오 (2026-06-20 trip dump 21:16:05 evidence):
 *   - 사용자 실제 위치 = 용마산 (origin, arc idx=0, 7호선)
 *   - destination 성수 (arc idx=arcEnd)
 *   - lockless-route-hop estimator가 시간 적분으로 destination 성수(idx=arcEnd)를 가리킴 (wrong)
 *   - backend SSoT mirror가 용마산(권위) 산출
 *
 * 본 PR로:
 *   - displayOnlyEstimate.strategy='backend-ssot-override' + station=용마산 (mirror 우선)
 *   - mirror stale/null이면 estimator 결과 그대로 fallback (graceful)
 *   - 라벨 backend-ssot-override가 estimator buffer push 시 strategy로 기록되어 DebugModal 추적 가능
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
import { makeDirectRoute } from '../../../../testUtils/routeFixtures';
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
const chungdam = findStationByNameAndLine('청담', '7')!;

/**
 * GPS hook mock + arrival/position empty mock 셋업 helper.
 * setupLocklessTripAtYongmasan과 'mirror fresh + estimator null' 케이스가 동일 패턴이라 추출.
 */
function setupQuietGpsAtYongmasan() {
  const live = { station: yongmasan, distanceKm: 0 };
  mockNearest.mockReturnValue({
    result: live,
    liveResult: live,
    stickyDisplayOnly: null,
    variants: [yongmasan],
    userLocation: { lat: yongmasan.lat, lng: yongmasan.lng },
    ...GPS_BASE_DEFAULTS,
    accuracyMeters: 14,
    refresh: jest.fn(),
  });
  mockFindTop.mockReturnValue([{ station: yongmasan, distanceKm: 0 }]);
  mockArrival.mockReturnValue(arrivalRet(null));
  mockPos.mockReturnValue(positionRet(null));
}

function setupLocklessTripAtYongmasan() {
  // GPS 용마산 정적 보고 (위치는 origin, estimator가 lockless-route-hop으로 destination을 가리킴).
  setupQuietGpsAtYongmasan();
  // 8개 hop arc (yongmasan → chungdam). tripStartedAt 60분 전 → lockless-route-hop이 arc 끝으로 적분.
  const route = makeDirectRoute(8, '7');
  return { route, routeContext: { route, origin: yongmasan, destination: chungdam } };
}

describe('#1605 — Estimator backend SSoT 우선 + lockless-route-hop fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(T0);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('mirror fresh + estimator wrong(lockless-route-hop) → displayOnlyEstimate.strategy=backend-ssot-override + station=mirror', async () => {
    const { routeContext } = setupLocklessTripAtYongmasan();
    // mirror lastAdvanceAt이 trip 시간과 함께 fresh로 유지되도록 60min 뒤 시점으로 stamp.
    // 시간 진행은 trip 시작 60분 → lockless-route-hop이 destination으로 적분.
    const nowMs = T0 + 60 * 60_000;
    jest.setSystemTime(nowMs);
    mockRead.mockResolvedValue(
      makeBackendSsotMirrorEntry({ currentStationId: yongmasan.name, lastAdvanceAt: nowMs, receivedAt: nowMs }),
    );

    const hook = renderHook(() =>
      useFusedNearestStation(undefined, undefined, routeContext),
    );
    await flushBackendSsotMirrorTick();

    await waitFor(() => {
      expect(hook.result.current.displayOnlyEstimate?.strategy).toBe('backend-ssot-override');
    });
    expect(hook.result.current.displayOnlyEstimate?.station.id).toBe(yongmasan.id);
    // arcStations[0]=yongmasan → idx=0.
    expect(hook.result.current.displayOnlyEstimate?.index).toBe(0);
  });

  it('mirror null → estimator 그대로 (lockless-route-hop) — fallback graceful', async () => {
    const { routeContext } = setupLocklessTripAtYongmasan();
    const nowMs = T0 + 60 * 60_000;
    jest.setSystemTime(nowMs);
    mockRead.mockResolvedValue(null);

    const hook = renderHook(() =>
      useFusedNearestStation(undefined, undefined, routeContext),
    );
    await flushBackendSsotMirrorTick();

    // mirror 없으면 estimator 결과 그대로 노출 (lockless-route-hop).
    expect(hook.result.current.displayOnlyEstimate?.strategy).toBe('lockless-route-hop');
  });

  it('mirror stale (>180s) → estimator 그대로 fallback', async () => {
    const { routeContext } = setupLocklessTripAtYongmasan();
    const nowMs = T0 + 60 * 60_000;
    jest.setSystemTime(nowMs);
    // lastAdvanceAt이 nowMs보다 240s 전 — staleness 180s 초과.
    mockRead.mockResolvedValue(
      makeBackendSsotMirrorEntry({
        currentStationId: yongmasan.name,
        lastAdvanceAt: nowMs - 240_000,
        receivedAt: nowMs - 240_000,
      }),
    );

    const hook = renderHook(() =>
      useFusedNearestStation(undefined, undefined, routeContext),
    );
    await flushBackendSsotMirrorTick();

    // stale mirror → estimator fallback.
    expect(hook.result.current.displayOnlyEstimate?.strategy).not.toBe('backend-ssot-override');
  });

  it('mirror fresh + ssotStation이 arc 밖 → strategy=backend-ssot-override + estimator idx fallback', async () => {
    // arc는 7호선 8 hop, mirror는 2호선 강남(arc 밖). lockless trip이라 lock line 가드 없음 → resolve 됨.
    // ssotArcIdx=-1 → estimator의 idx (lockless-route-hop이 적분한 마지막 idx)로 fallback.
    const { routeContext } = setupLocklessTripAtYongmasan();
    const gangnam2 = findStationByNameAndLine('강남', '2')!;
    const nowMs = T0 + 60 * 60_000;
    jest.setSystemTime(nowMs);
    mockRead.mockResolvedValue(
      makeBackendSsotMirrorEntry({ currentStationId: gangnam2.name, lastAdvanceAt: nowMs, receivedAt: nowMs }),
    );

    const hook = renderHook(() =>
      useFusedNearestStation(undefined, undefined, routeContext),
    );
    await flushBackendSsotMirrorTick();

    await waitFor(() => {
      expect(hook.result.current.displayOnlyEstimate?.strategy).toBe('backend-ssot-override');
    });
    // station은 mirror가 가리킨 곳.
    expect(hook.result.current.displayOnlyEstimate?.station.id).toBe(gangnam2.id);
    // idx는 estimator의 fallback (arc 밖이라 -1 대신 estimator idx).
    expect(hook.result.current.displayOnlyEstimate?.index).toBeGreaterThanOrEqual(0);
  });

  it('mirror fresh + estimator null → displayOnlyEstimate.station=mirror, index=0 fallback', async () => {
    // route 없음 → arcStations=[] → estimator=null. mirror만 있는 경우 idx=0으로 fallback.
    setupQuietGpsAtYongmasan();
    const nowMs = T0;
    mockRead.mockResolvedValue(
      makeBackendSsotMirrorEntry({ currentStationId: yongmasan.name, lastAdvanceAt: nowMs, receivedAt: nowMs }),
    );

    const hook = renderHook(() => useFusedNearestStation()); // routeContext 없음
    await flushBackendSsotMirrorTick();

    await waitFor(() => {
      expect(hook.result.current.displayOnlyEstimate?.strategy).toBe('backend-ssot-override');
    });
    // arcStations=[] → arcIndexOfStation=-1 → estimator 없으니 0 fallback.
    expect(hook.result.current.displayOnlyEstimate?.index).toBe(0);
    expect(hook.result.current.displayOnlyEstimate?.station.id).toBe(yongmasan.id);
  });
});
