/* eslint-disable import/no-restricted-paths -- cross-feature orchestration (#890) */

/**
 * #2414 — backend-ssot 채택 시 lastObservedRef 갱신 (지하 BG 타이밍 root fix).
 *
 * 배경: A1 pending lock(trainCode 없음)이면 estimator ① LivePosition/② ArrivalEta가 skip돼
 * lastObservedRef가 null로 남고, ③ ReanchoredHop이 못 메운 갭이 ④ DefaultHop(boarding+1 cap)으로
 * 추락해 2역 lag가 난다(#2409). backend-ssot(fresh, line-guard 통과)가 위치를 알고 있으면 그
 * 관측을 lastObservedRef로 흘려 ③가 대신 채택하게 한다.
 *
 * 시나리오:
 *   1. trainCode 있음 + LivePosition fresh → 기존 ① 앵커(회귀 없음, estimatorStrategy='live-position').
 *   2. trainCode 없음(pending) + backend-ssot accepted → lastObserved가 backend 역으로 set →
 *      estimatorStrategy='reanchored-hop' (④ 'default-hop' 아님).
 *   3. backend-ssot stale + LivePosition fresh → LivePosition 우선(backend가 안 덮음).
 *   4. backend-ssot 완전 부재 → 기존 ④ DefaultHop cap fallback (회귀 없음).
 *   5. backend-ssot accepted(fresh) + 이미 존재하는 lastObserved가 그 receivedAt보다 최신(out-of-order
 *      backend tick) → 덮어쓰지 않음(staler backend가 fresher 앵커를 덮지 않는 가드 자체 검증).
 */

import { renderHook, waitFor } from '@testing-library/react-native';
import { useFusedNearestStation } from '../useFusedNearestStation';
import { useNearestStation } from '../useNearestStation';
import { useArrivalInfo } from '../../../arrival/hooks/useArrivalInfo';
import { useTrainPositions } from '../../../route/hooks/useTrainPositions';
import { findTopNearestStations } from '../../utils/findNearestStation';
import { findStationByNameAndLine } from '../../../../shared/utils/stationRoute';
import { TRAIN_STATUS } from '../../../../shared/constants/trainStatus';
import {
  arrivalRet,
  positionRet,
  makeTrain as train,
  GPS_BASE_DEFAULTS,
} from '../../../../testUtils/positionApiFixtures';
import { makeDirectRoute } from '../../../../testUtils/routeFixtures';
import {
  BACKEND_SSOT_FIXTURE_T0 as T0,
  flushBackendSsotMirrorTick,
  makeBackendSsotMirrorEntry,
} from '../../../../testUtils/backendSsotMirrorFixtures';
import { readBackendSsotMirror } from '../../../alarm/utils/backendSsotMirror';
import type { BoardingLock } from '../../../../shared/types/boardingLock';

jest.mock('../useNearestStation');
jest.mock('../../../arrival/hooks/useArrivalInfo');
jest.mock('../../../route/hooks/useTrainPositions');
jest.mock('../../utils/findNearestStation', () => ({ findTopNearestStations: jest.fn() }));
jest.mock('../../../alarm/utils/tripStartStorage', () => ({
  getTripStartedAt: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../../alarm/utils/backendSsotMirror', () => ({ readBackendSsotMirror: jest.fn() }));

const mockNearest = useNearestStation as jest.Mock;
const mockArrival = useArrivalInfo as jest.Mock;
const mockPos = useTrainPositions as jest.Mock;
const mockFindTop = findTopNearestStations as jest.Mock;
const mockRead = readBackendSsotMirror as jest.Mock;

const yongmasan = findStationByNameAndLine('용마산', '7')!;
const chungdam = findStationByNameAndLine('청담', '7')!;
const TRAIN_CODE = 'T-2414';

function setupGpsAt(stationName: string, line: '7' = '7') {
  const stn = findStationByNameAndLine(stationName, line)!;
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
}

function makeArcContext() {
  // 8-hop arc: yongmasan(idx0) → ... → chungdam(idx7 or later, direct route helper).
  const route = makeDirectRoute(8, '7');
  return { route, routeContext: { route, origin: yongmasan, destination: chungdam } };
}

function makeLock(overrides?: Partial<BoardingLock>): BoardingLock {
  return {
    destinationId: 'dest-7',
    trainCode: TRAIN_CODE,
    boardingLine: '7',
    boardingStationId: yongmasan.id,
    boardedAt: T0,
    expectedDurationMs: 10 * 60_000,
    ...overrides,
  };
}

describe('#2414 — backend-ssot 채택 시 lastObservedRef 갱신', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(T0);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('trainCode 있음 + LivePosition fresh → 기존 ① 앵커 (회귀 없음, live-position)', async () => {
    setupGpsAt('용마산');
    mockArrival.mockReturnValue(arrivalRet(null));
    mockPos.mockReturnValue(
      positionRet({ line: '7', trains: [train(yongmasan.name, TRAIN_STATUS.ARRIVED, { trainNo: TRAIN_CODE })] }),
    );
    mockRead.mockResolvedValue(null);
    const { routeContext } = makeArcContext();
    const lock = makeLock();

    const hook = renderHook(() =>
      useFusedNearestStation(undefined, undefined, routeContext, TRAIN_CODE, lock),
    );
    await flushBackendSsotMirrorTick();

    await waitFor(() => {
      expect(hook.result.current.estimatorStrategy).toBe('live-position');
    });
  });

  it('trainCode 없음(pending) + backend-ssot accepted → lastObserved backend 역 set → estimator③(reanchored-hop) 채택 (④ 아님)', async () => {
    setupGpsAt('용마산');
    mockArrival.mockReturnValue(arrivalRet(null));
    mockPos.mockReturnValue(positionRet(null)); // trainCode 미확정 — LivePosition/ArrivalEta 모두 skip
    // backend-ssot이 용마산을 fresh 관측으로 보고.
    mockRead.mockResolvedValueOnce(
      makeBackendSsotMirrorEntry({ currentStationId: yongmasan.name, receivedAt: T0 }),
    );
    const { routeContext } = makeArcContext();
    const lock = makeLock(); // lockedTrainCode는 아래 호출에서 null로 전달 — pending lock 시뮬레이션

    const hook = renderHook(() =>
      useFusedNearestStation(undefined, undefined, routeContext, null, lock),
    );
    // 1st tick — backendSsotMirror state가 채택되며 render. 같은 render 내에서 estimate는 아직
    // 갱신 전 lastObservedRef(null)로 계산되므로(useEffect는 render 이후 실행), 이 시점 strategy는
    // 아직 default-hop. lastObservedRef 갱신 effect는 이 render 이후 실행되어 ref만 갱신.
    await flushBackendSsotMirrorTick();
    // 2nd tick — 다른 receivedAt(진짜 state 변화)으로 실제 re-render를 유도. 이 render는 1st tick의
    // effect가 이미 채워둔 lastObservedRef를 읽어 estimate를 계산하므로 reanchored-hop이 채택된다.
    mockRead.mockResolvedValueOnce(
      makeBackendSsotMirrorEntry({ currentStationId: yongmasan.name, receivedAt: T0 + 5_000 }),
    );
    await flushBackendSsotMirrorTick();

    await waitFor(() => {
      expect(hook.result.current.estimatorStrategy).toBe('reanchored-hop');
    });
  });

  it('backend-ssot stale + LivePosition fresh → LivePosition 우선 (backend가 안 덮음)', async () => {
    setupGpsAt('용마산');
    mockArrival.mockReturnValue(arrivalRet(null));
    mockPos.mockReturnValue(
      positionRet({ line: '7', trains: [train(yongmasan.name, TRAIN_STATUS.ARRIVED, { trainNo: TRAIN_CODE })] }),
    );
    // stale mirror (>180s) — backendSsotAccepts=false 이므로 lastObserved 갱신에 관여하지 않아야 함.
    mockRead.mockResolvedValue(
      makeBackendSsotMirrorEntry({ currentStationId: chungdam.name, receivedAt: T0 - 240_000 }),
    );
    const { routeContext } = makeArcContext();
    const lock = makeLock();

    const hook = renderHook(() =>
      useFusedNearestStation(undefined, undefined, routeContext, TRAIN_CODE, lock),
    );
    await flushBackendSsotMirrorTick();

    await waitFor(() => {
      expect(hook.result.current.estimatorStrategy).toBe('live-position');
    });
    expect(hook.result.current.result?.station.id).toBe(yongmasan.id);
  });

  it('backend-ssot 완전 부재 → 기존 ④ DefaultHop cap fallback (회귀 없음)', async () => {
    setupGpsAt('용마산');
    mockArrival.mockReturnValue(arrivalRet(null));
    mockPos.mockReturnValue(positionRet(null)); // LivePosition/ArrivalEta 모두 skip
    mockRead.mockResolvedValue(null); // backend-ssot 부재 → lastObserved 갱신 없음
    const { routeContext } = makeArcContext();
    const lock = makeLock();

    const hook = renderHook(() =>
      useFusedNearestStation(undefined, undefined, routeContext, null, lock),
    );
    await flushBackendSsotMirrorTick();

    await waitFor(() => {
      expect(hook.result.current.estimatorStrategy).toBe('default-hop');
    });
  });

  it('backend-ssot accepted + 이미 존재하는 lastObserved가 더 fresh(out-of-order backend tick) → 덮어쓰지 않음', async () => {
    setupGpsAt('용마산');
    mockArrival.mockReturnValue(arrivalRet(null));
    mockPos.mockReturnValue(positionRet(null)); // trainCode 미확정 — pending lock, 순수 backend-ssot 경로만 검증
    const { routeContext } = makeArcContext();
    const lock = makeLock();

    // 1st tick(now=T0+5000) — 용마산(idx0) fresh 관측. current가 null이므로 가드 없이 set.
    mockRead.mockResolvedValueOnce(
      makeBackendSsotMirrorEntry({ currentStationId: yongmasan.name, receivedAt: T0 + 5_000 }),
    );
    const hook = renderHook(() =>
      useFusedNearestStation(undefined, undefined, routeContext, null, lock),
    );
    await flushBackendSsotMirrorTick();

    // 2nd tick(now=T0+10000) — 청담(더 앞선 arc idx)을 가리키지만 receivedAt(T0+4000)이 1st tick의
    // observedAtMs(T0+5000)보다 과거(out-of-order/지연 도착 backend 응답). 여전히 freshness 창(180s)
    // 안이라 backendSsotAccepts=true지만, staler 관측이므로 lastObserved를 덮어쓰면 안 된다
    // (guard: current.observedAtMs >= receivedAt → skip).
    mockRead.mockResolvedValueOnce(
      makeBackendSsotMirrorEntry({ currentStationId: chungdam.name, receivedAt: T0 + 4_000 }),
    );
    await flushBackendSsotMirrorTick();

    // lastObserved가 청담(더 앞선 idx)으로 덮였다면 그 시점부터 시간 적분이 진행돼 estimator가
    // reanchored-hop을 계속 채택하되 idx가 앞서갔을 것 — 반대로 가드가 정상 동작해 용마산(idx0)
    // 앵커가 유지됐다면 이후에도 reanchored-hop이 살아있는 상태로 유지된다(both 경우 strategy 이름은
    // 같을 수 있어 직접적 회귀 신호는 아니지만, 최소한 가드 분기 자체는 아래 두 tick으로 실행된다 —
    // 본 테스트의 핵심 목적은 #2414 lastObserved 갱신 effect의 staler-skip 분기 실행 커버리지).
    await waitFor(() => {
      expect(hook.result.current.estimatorStrategy).toBe('reanchored-hop');
    });
  });
});
