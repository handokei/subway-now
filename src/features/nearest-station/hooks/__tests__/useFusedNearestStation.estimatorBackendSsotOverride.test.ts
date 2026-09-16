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

// #1605 — useFusedNearestStation 의존 hook/util mock + cascade I/O mock 세트.
// jest.mock은 호이스팅돼 module scope에서만 가능 — 공통 helper로 추출 불가.
// 본 fixture 그룹은 backendSsotCascade.test.ts와 의도적으로 같은 구성 (Backend SSoT cascade 검증).
jest.mock('../useNearestStation');
jest.mock('../../../arrival/hooks/useArrivalInfo');
jest.mock('../../../route/hooks/useTrainPositions');
jest.mock('../../utils/findNearestStation', () => ({ findTopNearestStations: jest.fn() }));
jest.mock('../../../alarm/utils/tripStartStorage', () => ({
  getTripStartedAt: jest.fn().mockResolvedValue(null),
}));
// #2589 (code review 2번) — resolveBackendSsotMirrorStation은 실제 구현(순수 함수, 실 stations.json
// 경유)을 유지. readBackendSsotMirror만 이 파일의 시나리오대로 mock.
jest.mock('../../../alarm/utils/backendSsotMirror', () => ({
  ...jest.requireActual('../../../alarm/utils/backendSsotMirror'),
  readBackendSsotMirror: jest.fn(),
}));

const mockNearest = useNearestStation as jest.Mock;
const mockArrival = useArrivalInfo as jest.Mock;
const mockPos = useTrainPositions as jest.Mock;
const mockFindTop = findTopNearestStations as jest.Mock;
const mockRead = readBackendSsotMirror as jest.Mock;

// 시나리오: lockless trip yongmasan→chungdam(7호선). 정적 사용자가 origin에 머무름.
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

  // #2669 — 경로 역행 가드의 **거부 분기**를 훅 레벨에서 실제로 태운다(코드리뷰 P1: 순수 함수만
  // 검증하면 부품 green / whole inert). 2026-09-16 재현: backend가 leg-2에서 전진을 멈춰
  // lastAdvanceAt이 10분째 고정인데 receivedAt만 계속 갱신돼 "fresh"였고, 사용자는 GPS상 경로
  // 끝(청담)에 도착해 있었다. 그 상태에서 backend가 표시를 origin으로 되돌리면 안 된다.
  it('#2669 — backend 정체 + GPS가 경로상 앞 → backend-ssot 채택 거부(표시 역행 차단)', async () => {
    const { routeContext } = setupLocklessTripAtYongmasan();
    const nowMs = T0 + 60 * 60_000;
    jest.setSystemTime(nowMs);
    // GPS는 경로 끝(청담)을 신뢰 가능하게 가리킨다 — arc index가 mirror(용마산, idx 0)보다 크다.
    const live = { station: chungdam, distanceKm: 0 };
    mockNearest.mockReturnValue({
      result: live,
      liveResult: live,
      stickyDisplayOnly: null,
      variants: [chungdam],
      userLocation: { lat: chungdam.lat, lng: chungdam.lng },
      ...GPS_BASE_DEFAULTS,
      accuracyMeters: 12,
      refresh: jest.fn(),
    });
    mockFindTop.mockReturnValue([{ station: chungdam, distanceKm: 0 }]);
    mockRead.mockResolvedValue(
      makeBackendSsotMirrorEntry({
        currentStationId: yongmasan.name,
        lastAdvanceAt: nowMs - 10 * 60_000, // backend는 10분째 전진 없음
        receivedAt: nowMs, // 그런데 mirror 자체는 방금 갱신돼 "fresh"
      }),
    );

    const hook = renderHook(() => useFusedNearestStation(undefined, undefined, routeContext));
    await flushBackendSsotMirrorTick();

    // 표시 채널: backend-ssot-override로 되돌아가지 않는다.
    expect(hook.result.current.displayOnlyEstimate?.strategy).not.toBe('backend-ssot-override');
    // fire path: cascade도 backend-ssot tier를 채택하지 않는다.
    expect(hook.result.current.source).not.toBe('backend-ssot');
    expect(hook.result.current.result?.station.id).not.toBe(yongmasan.id);
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
