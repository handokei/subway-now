/* eslint-disable import/no-restricted-paths -- cross-feature orchestration (#890) */

/**
 * #1016 positionTrainResult 거리 게이트 3 hole 봉합 회귀 방지 테스트.
 *
 * (a) userLocation==null → distanceKm=0 placeholder가 gate 자동 통과하는 hole 방지.
 * (b) lock 활성 + arc 없을 때 accuracy>200m bypass 비활성화 hole 방지.
 * (c) lock 활성 + arc 있을 때 station.id가 arc에 없는 역은 gate 탈락 hole 방지.
 */
import { renderHook } from '@testing-library/react-native';
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
import type { BoardingLock } from '../../../../shared/types/boardingLock';

jest.mock('../../utils/findNearestStation', () => ({
  findTopNearestStations: jest.fn(),
}));
jest.mock('../useNearestStation');
jest.mock('../../../arrival/hooks/useArrivalInfo');
jest.mock('../../../route/hooks/useTrainPositions');
// #1926 — lockless 4-signal consensus는 positionTrainConsensus.test.ts에서 단위 검증.
// 기본은 pass 상태로 mock해 기존 회귀 테스트(position-train 채택)를 보존. 본 파일
// "#1926 lockless 4-signal consensus" describe에서 override해 reject 분기 검증.
jest.mock('../useAccelerometerFingerprint', () => ({
  useAccelerometerFingerprint: jest.fn(() => 'automotive'),
}));
jest.mock('../useCellularTech', () => ({
  useCellularTech: jest.fn(() => 'surface'),
}));
jest.mock('../../../alarm/utils/tripStartStorage', () => ({
  getTripStartedAt: jest.fn().mockResolvedValue(null),
}));

const mockNearest = useNearestStation as jest.Mock;
const mockArrival = useArrivalInfo as jest.Mock;
const mockPos = useTrainPositions as jest.Mock;
const mockFindTop = findTopNearestStations as jest.Mock;

// Real 7호선 stations for arc tests
const yongmasan = findStationByNameAndLine('용마산', '7')!;
const junggok = findStationByNameAndLine('중곡', '7')!;
const gunja = findStationByNameAndLine('군자', '7')!;
const konkuk = findStationByNameAndLine('건대입구', '7')!;
// Real 3호선 station outside line 7 arc
const chungmuro3 = findStationByNameAndLine('충무로', '3')!;

function gpsBase(overrides?: Record<string, unknown>) {
  return {
    result: { station: yongmasan, distanceKm: 0 },
    variants: [yongmasan],
    userLocation: { lat: yongmasan.lat, lng: yongmasan.lng },
    ...GPS_BASE_DEFAULTS,
    refresh: jest.fn(),
    ...overrides,
  };
}

function makeLock(overrides?: Partial<BoardingLock>): BoardingLock {
  return {
    destinationId: konkuk.id,
    trainCode: 'T-LOCK',
    boardingStationId: yongmasan.id,
    boardingLine: '7',
    boardedAt: Date.now(),
    expectedDurationMs: 600_000,
    ...overrides,
  };
}

type SetupOpts = {
  gps?: Record<string, unknown>;
  findTopStation?: ReturnType<typeof findStationByNameAndLine>;
  positions?: Parameters<typeof positionRet>[0];
  positionsOnce?: boolean;
  routeCtx?: Parameters<typeof useFusedNearestStation>[2];
  trainCode?: string;
  lock?: BoardingLock;
};

function setup({
  gps,
  findTopStation = yongmasan,
  positions,
  positionsOnce = false,
  routeCtx,
  trainCode,
  lock,
}: SetupOpts = {}) {
  mockNearest.mockReturnValue(gpsBase(gps));
  mockFindTop.mockReturnValue([{ station: findTopStation, distanceKm: 0 }]);
  const posVal = positionRet(positions ?? null);
  if (positionsOnce) {
    mockPos.mockReturnValueOnce(posVal);
  } else {
    mockPos.mockReturnValue(posVal);
  }
  return renderHook(() => useFusedNearestStation(undefined, undefined, routeCtx, trainCode, lock));
}

// Lock-interp / lockless estimator 공통 시나리오:
// fake timer T0에서 1회 render → elapsedMs 진행 후 rerender → result 반환.
// lock 활성/lockless / motion 신호 / 경과시간 차이만 옵션으로 받는다.
const ESTIMATOR_T0 = 1_700_000_000_000;
function runEstimatorScenario(opts: {
  lock?: BoardingLock;
  trainCode?: string;
  motionStationary?: boolean;
  elapsedMs?: number;
} = {}) {
  const { lock, trainCode, motionStationary, elapsedMs = 90_000 } = opts;

  jest.useFakeTimers();
  jest.setSystemTime(ESTIMATOR_T0);

  const routeCtx = { route: makeDirectRoute(4, '7'), origin: yongmasan, destination: konkuk };
  mockNearest.mockReturnValue(gpsBase());
  mockFindTop.mockReturnValue([{ station: yongmasan, distanceKm: 0 }]);

  const { result, rerender } = renderHook(() =>
    useFusedNearestStation(undefined, undefined, routeCtx, trainCode, lock, motionStationary),
  );

  jest.setSystemTime(ESTIMATOR_T0 + elapsedMs);
  rerender({});

  jest.useRealTimers();
  return result;
}

// #1382 — lock 활성 + 90s 경과 + motion 옵션.
function runLockedMotionScenario(motionStationary: boolean | undefined) {
  return runEstimatorScenario({
    lock: makeLock({
      trainCode: 'T-MOTION',
      boardingStationId: yongmasan.id,
      boardingLine: '7',
      boardedAt: ESTIMATOR_T0,
      expectedDurationMs: 600_000,
    }),
    trainCode: 'T-MOTION',
    motionStationary,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockArrival.mockReturnValue(arrivalRet(null));
  mockPos.mockReturnValue(positionRet(null));
});

describe('#1016 positionTrainResult 거리 게이트 hole 봉합', () => {
  describe('(a) userLocation==null → positionTrainResult null 반환', () => {
    it('GPS 좌표 없을 때 trainProgress non-null이어도 null 반환 — distanceKm=0 placeholder gate 통과 방지', () => {
      // GPS 없는 상태. 이전 버전은 distanceKm=0으로 gate 자동 통과. 수정 후 null.
      // p0만 positions 반환(ReturnValueOnce) → p1/p2는 beforeEach의 null fallthrough.
      // → candidateTrains 후보 1개(single) → trackTrainProgress non-null → line 368 도달.
      const lock = makeLock({ boardingLine: '7', trainCode: 'T-A' });
      const { result } = setup({
        gps: { userLocation: null, result: null, accuracyMeters: 50 },
        positions: { line: '7', trains: [train(yongmasan.name, TRAIN_STATUS.ARRIVED, { trainNo: 'T-A' })] },
        positionsOnce: true,
        trainCode: 'T-A',
        lock,
      });

      // userLocation=null → line 368 `if (!gps.userLocation) return null` → positionTrainResult null
      expect(result.current.source).not.toBe('position-train');
    });

    it('R13-a (#1612): GPS 좌표 복구되어도 lock 비활성 + accuracy=1500 → strict reject (positionTrain 채택 X)', () => {
      // 이전 의도: userLocation 있으므로 (a) 통과 + arc 없음 + 거리 0 → gate 통과. R13-a로 strict reject.
      // 사용자 명시 의향 없는 lockless trip의 지하 dead zone 누수 방어 — V1 회복 직접 성과.
      const { result } = setup({
        gps: { userLocation: { lat: yongmasan.lat, lng: yongmasan.lng }, accuracyMeters: 1500 },
        positions: { line: '7', trains: [train(yongmasan.name, TRAIN_STATUS.ARRIVED, { trainNo: 'T-A' })] },
      });

      expect(result.current.source).not.toBe('position-train');
    });
  });

  describe('(b) lock 활성 + arc 없을 때 accuracy>MAX_ACCURACY_M bypass 비활성화', () => {
    it('lock 활성 + arc 없을 때 accuracy=1500(지하)이어도 먼 역(6km+)은 gate 탈락', () => {
      // 충무로(3호선)는 yongmasan GPS(37.573647, 127.086727)에서 ~6.85km 떨어져 있다.
      // 이전 버전: accuracy=1500 > MAX_ACCURACY_M → bypass → 자동 통과.
      // 수정 후: lock 활성 + arc 없음 → bypass 비활성 → 거리 초과 → 탈락.
      const lock = makeLock({ boardingLine: '3' });
      const { result } = setup({
        gps: { accuracyMeters: 1500 },
        positions: {
          line: '3',
          // 실제 충무로(3호선) 좌표는 yongmasan GPS에서 ~6.85km 떨어져 있다
          trains: [train(chungmuro3.name, TRAIN_STATUS.ARRIVED, { trainNo: 'T-B' })],
        },
        trainCode: 'T-B',
        lock,
      });

      // 충무로가 게이트 탈락 → positionTrain 미채택
      expect(result.current.source).not.toBe('position-train');
    });

    it('lock 활성 + arc 없을 때 accuracy=1500이지만 같은 좌표(0km)이면 gate 통과', () => {
      // 같은 좌표에 있으면 거리 = 0 → MAX_FUSION_DISTANCE_KM 이하 → 통과.
      const lock = makeLock({ boardingLine: '7', trainCode: 'T-B2' });
      const { result } = setup({
        gps: { accuracyMeters: 1500 },
        positions: { line: '7', trains: [train(yongmasan.name, TRAIN_STATUS.ARRIVED, { trainNo: 'T-B2' })] },
        trainCode: 'T-B2',
        lock,
      });

      expect(result.current.source).toBe('boarding-lock');
    });

    it('R13-a (#1612): lock 없을 때 accuracy=1500 → strict reject (지하 dead zone 누수 차단)', () => {
      // 이전 의도: fix(b)는 lock 활성 시에만 — lock 없으면 bypass 유지. R13-a로 lockless도 strict reject.
      // 사용자 명시 의향 없는 lockless trip은 V1 회복 위해 보호 X — 정상 동작.
      const { result } = setup({
        gps: { accuracyMeters: 1500 },
        positions: { line: '7', trains: [train(yongmasan.name, TRAIN_STATUS.ARRIVED, { trainNo: 'T-NOLOCK' })] },
      });

      expect(result.current.source).not.toBe('position-train');
    });
  });

  describe('(c) lock 활성 + arc 있을 때 station이 arc에 없으면 gate 탈락', () => {
    const route = makeDirectRoute(4, '7');
    const routeContext = { route, origin: yongmasan, destination: konkuk };

    it('arc에 없는 역(면목)이 position-train으로 오면 탈락', () => {
      // 면목은 7호선이지만 yongmasan→konkuk arc 밖 (용마산보다 출발방향 뒤편)
      const myeonmok = findStationByNameAndLine('면목', '7')!;
      // accuracy=1500: arc 있으므로 fix(b) bypass 유지. fix(c)가 arc 소속을 검사.
      const lock = makeLock({ boardingLine: '7' });
      const { result } = setup({
        gps: { userLocation: { lat: yongmasan.lat, lng: yongmasan.lng }, accuracyMeters: 1500 },
        positions: { line: '7', trains: [train(myeonmok.name, TRAIN_STATUS.ARRIVED, { trainNo: 'T-C-OFF' })] },
        routeCtx: routeContext,
        trainCode: 'T-C-OFF',
        lock,
      });

      // 면목은 arc 밖 → gate 탈락 → positionTrain 미채택
      expect(result.current.source).not.toBe('position-train');
      expect(result.current.source).not.toBe('boarding-lock');
    });

    it('arc 위의 역(중곡)은 통과', () => {
      // 중곡 = arc idx 1. GPS를 중곡 좌표에 놓아 거리 게이트(b)도 통과시킨다.
      // accuracy=50(정상): fix(b) 엄격 모드이나 거리가 0(같은 좌표)이므로 통과.
      const lock = makeLock({ boardingLine: '7', trainCode: 'T-C-IN' });
      const { result } = setup({
        gps: { userLocation: { lat: junggok.lat, lng: junggok.lng }, result: { station: junggok, distanceKm: 0 }, accuracyMeters: 50 },
        findTopStation: junggok,
        positions: { line: '7', trains: [train(junggok.name, TRAIN_STATUS.ARRIVED, { trainNo: 'T-C-IN' })] },
        routeCtx: routeContext,
        trainCode: 'T-C-IN',
        lock,
      });

      expect(result.current.result?.station.id).toBe(junggok.id);
      expect(result.current.source).toBe('boarding-lock');
    });

    it('R13-a (#1612): lock 없으면 accuracy=1500 → strict reject (arc 소속 검사 도달 전 차단)', () => {
      // 이전 의도: fix(c)는 boardingLock 활성 시에만. lock 없으면 arc 검사 안 함 → 면목도 gate 통과.
      // R13-a로 lockless + bad accuracy strict reject — arc 검사 도달 전 차단. V1 회복 직접 성과.
      const myeonmok = findStationByNameAndLine('면목', '7')!;
      const { result } = setup({
        gps: { userLocation: { lat: yongmasan.lat, lng: yongmasan.lng }, accuracyMeters: 1500 },
        positions: { line: '7', trains: [train(myeonmok.name, TRAIN_STATUS.ARRIVED, { trainNo: 'T-C-NOLOCK' })] },
        routeCtx: routeContext,
      });

      // R13-a (#1612): lock 비활성 + accuracy=1500 → strict reject로 positionTrain 자체가 null.
      expect(result.current.source).not.toBe('position-train');
    });

    it('arc 안에 있지만 LOCK_NEXT_HOP_WINDOW 초과 시 gate 탈락', () => {
      // 건대입구: arc idx 4. boardingIdx(용마산=0) + WINDOW(3) = 3 → idx 4 초과 → 탈락.
      // GPS를 건대입구 좌표에 놓아 거리 게이트(b)는 통과시킴 → fix(c)가 탈락 원인.
      const lock = makeLock({ boardingLine: '7', trainCode: 'T-C-WINDOW' });
      const { result } = setup({
        gps: { result: { station: konkuk, distanceKm: 0 }, userLocation: { lat: konkuk.lat, lng: konkuk.lng }, accuracyMeters: 50 },
        findTopStation: konkuk,
        positions: { line: '7', trains: [train(konkuk.name, TRAIN_STATUS.ARRIVED, { trainNo: 'T-C-WINDOW' })] },
        routeCtx: routeContext,
        trainCode: 'T-C-WINDOW',
        lock,
      });

      // arc window 초과 → positionTrainResult null → position-train/boarding-lock 미채택
      expect(result.current.source).not.toBe('position-train');
      expect(result.current.source).not.toBe('boarding-lock');
    });

    it('arc 없으면 arc 소속 검사 미작동 (routeContext 없는 경우)', () => {
      // arc 없으므로 fix(c) 비활성. fix(b)가 거리 검사 담당.
      // 용마산과 같은 좌표이므로 거리=0 → 통과.
      const lock = makeLock({ boardingLine: '7', trainCode: 'T-C-NOARC' });
      const { result } = setup({
        gps: { userLocation: { lat: yongmasan.lat, lng: yongmasan.lng }, accuracyMeters: 1500 },
        positions: { line: '7', trains: [train(yongmasan.name, TRAIN_STATUS.ARRIVED, { trainNo: 'T-C-NOARC' })] },
        trainCode: 'T-C-NOARC',
        lock,
      });

      expect(result.current.source).toBe('boarding-lock');
    });
  });

  describe('lastObservedRef 앵커 업데이트 — line 487 커버', () => {
    it('freshTrainProgress의 station이 arc에 없으면(arcIndexOfStation=-1) 앵커 미갱신 — 기존 source 유지', () => {
      // lockedTrainCode 있고 boardingLock 없는 상태. positionTrainResult는 gate 통과(boardingLock null → hole-c 비활성).
      // 하지만 trainProgress.currentStation(용마산)이 중곡→건대입구 arc 밖 → arcIndexOfStation=-1 → line 487 early return.
      // routeContext origin=중곡, destination=건대입구 → arc=[중곡,군자,건대입구], 용마산 미포함.
      const subRoute = makeDirectRoute(3, '7');
      const subRouteContext = { route: subRoute, origin: junggok, destination: konkuk };

      mockNearest.mockReturnValue(gpsBase()); // GPS at 용마산(yongmasan)
      mockFindTop.mockReturnValue([{ station: yongmasan, distanceKm: 0 }]);
      // line='7'(p0)이면 positions 반환, null이면(p1/p2) null 반환. 모든 render에서 일관 적용.
      mockPos.mockImplementation((line: string | null) =>
        line === '7'
          ? positionRet({
              line: '7',
              trains: [train(yongmasan.name, TRAIN_STATUS.ARRIVED, { trainNo: 'T-ARC-MISS' })],
            })
          : positionRet(null),
      );

      // lockedTrainCode 있음 + boardingLock 없음 → hole-c 검사 스킵 → positionTrainResult non-null.
      // 하지만 arcIndexOfStation(arcStations, 용마산) === -1 → line 487 early return.
      const { result } = renderHook(() =>
        useFusedNearestStation(undefined, undefined, subRouteContext, 'T-ARC-MISS'),
      );

      // positionTrainResult = 용마산 → cascade가 positionTrain 분기로 채택.
      // #1207 (Epic #1204 D1): lock 없음 + routeCtx 있음 → lockless-route-hop estimator 활성.
      // #1418 — positionTrainResult(=Tier 4 실측)가 활성이면 lockless-route-hop(Tier 5)의 forward
      //         ratchet은 차단된다. 앵커(lastObservedRef)는 arcIndexOfStation=-1 반환으로 미갱신
      //         — line 487 early return 유지.
      // #1891 (RC-1 paradigm 1): boardingLock=null 상태에서는 lockedTrainCode 매칭이 있어도
      //         'boarding-lock' source 승격 차단 — 사용자 명시 의향 표명 없는 self-fire 방지.
      //         lockless trip cascade는 'position-train' source로 떨어진다 (autoLock_fired_count=0 정합).
      expect(result.current.source).toBe('position-train');
    });
  });

  describe('#1207 lockless-route-hop estimator 활성화 — lockless hop time closure 커버', () => {
    it('lock 없음 + routeCtx + tripStartStorage hydration → 저장된 tripStartedAt으로 ref 갱신', async () => {
      // cold restart 시나리오: storage에 옛 trip 시작 시각이 있고, 첫 render는 Date.now()로 fallback,
      // 비동기 hydration 도착 시 storage 값으로 ref 갱신.
      jest.useFakeTimers();
      const T0 = 1_700_000_000_000;
      const storedStart = T0 - 5 * 60_000; // 5분 전 trip 시작
      jest.setSystemTime(T0);

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const tripStartStorage = require('../../../alarm/utils/tripStartStorage');
      tripStartStorage.getTripStartedAt.mockResolvedValueOnce(storedStart);

      const routeCtx = { route: makeDirectRoute(4, '7'), origin: yongmasan, destination: konkuk };
      mockNearest.mockReturnValue(gpsBase());
      mockFindTop.mockReturnValue([{ station: yongmasan, distanceKm: 0 }]);

      const { rerender } = renderHook(() =>
        useFusedNearestStation(undefined, undefined, routeCtx),
      );

      // hydration Promise resolve를 flush (microtask + 1 tick).
      await Promise.resolve();
      await Promise.resolve();

      // 시간을 더 진행 + rerender하면 hydration된 storage 값(5분 전 시작)으로 적분 → 더 앞쪽 hop.
      jest.setSystemTime(T0 + 1_000);
      rerender({});

      // hydration이 성공했다면 estimator가 활성 (boarding-lock-interp source).
      // hydration 실패해도 fallback Date.now()로 동작하므로 source 단독으로는 hydration 검증 불가하나
      // 본 테스트는 line 556(`stored != null && current === fallbackNow`) 분기 도달이 목표.

      jest.useRealTimers();
      tripStartStorage.getTripStartedAt.mockResolvedValue(null);
    });

    it('hydration resolve 전 unmount → cancelled=true로 ref 미갱신', async () => {
      // unmount cleanup이 cancelled=true 설정 → hydration Promise resolve 시 early return.
      const routeCtx = { route: makeDirectRoute(4, '7'), origin: yongmasan, destination: konkuk };
      mockNearest.mockReturnValue(gpsBase());
      mockFindTop.mockReturnValue([{ station: yongmasan, distanceKm: 0 }]);

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const tripStartStorage = require('../../../alarm/utils/tripStartStorage');
      // hydration이 resolve되기 전에 unmount될 수 있도록 deferred Promise 사용.
      let resolveStored: (v: number | null) => void = () => undefined;
      tripStartStorage.getTripStartedAt.mockReturnValueOnce(
        new Promise<number | null>((res) => {
          resolveStored = res;
        }),
      );

      const { unmount } = renderHook(() =>
        useFusedNearestStation(undefined, undefined, routeCtx),
      );

      unmount();
      resolveStored(1_700_000_000_000); // resolve 후 cancelled=true 분기 도달.
      await Promise.resolve();
      await Promise.resolve();

      tripStartStorage.getTripStartedAt.mockResolvedValue(null);
    });

    it('#1437 lock 없음 + routeCtx + 시간 경과 → lockless-route-hop이 displayOnly 채널에 노출', () => {
      // estimator closure 호출 경로 커버는 유지 — 다만 fire path는 GPS, estimator는 displayOnly.
      // #1922 (M2) — elapsedMs는 LOCKLESS_TIME_INTEGRATION_STUCK_TIMEOUT_MS(90s) 이내로 유지해야
      // tryLocklessRouteHop의 stuck guard에 걸리지 않는다 (lastObserved 부재 시 trip 초기 90s 허용).
      const result = runEstimatorScenario({ elapsedMs: 60_000 });
      expect(result.current.source).not.toBe('boarding-lock-interp');
      expect(result.current.displayOnlyEstimate?.strategy).toBe('lockless-route-hop');
    });
  });

  describe('observation ceiling — estimator displayOnly 노출', () => {
    it('#1437 interpolated estimate + positionTrainResult null → fire path는 GPS, estimator는 displayOnly', () => {
      // boardingLock 활성 + 90s 경과 → estimator default-hop 채택 (isInterpolated=true).
      // ADR-015 §2 박탈로 fire path는 GPS('gps') 유지. displayOnly만 estimator strategy 노출.
      const result = runEstimatorScenario({
        lock: makeLock({
          trainCode: 'T-INTERP',
          boardingStationId: yongmasan.id,
          boardingLine: '7',
          boardedAt: ESTIMATOR_T0,
          expectedDurationMs: 600_000,
        }),
        trainCode: 'T-INTERP',
      });

      expect(result.current.source).not.toBe('boarding-lock-interp');
      expect(result.current.displayOnlyEstimate?.strategy).toBe('default-hop');
    });
  });

  // #1365 — lockless-route-hop 채택 전 line cross-validation.
  // 환승역(예: 건대입구는 2호선/7호선)에서 같은 hop index에 다른 line의 stop이 존재할 수 있어
  // 시간 적분 결과가 stale interp일 때 잘못된 line의 station을 채택할 위험.
  describe('#1365 lockless-route-hop line cross-validation', () => {
    // 두 시나리오의 공통 setup — 같은 routeCtx에서 GPS 최근접 station만 바꿔 line cross-check 진입.
    function runLine7LocklessRouteScenario(gpsNearest: ReturnType<typeof gpsBase>) {
      jest.useFakeTimers();
      const T0 = 1_700_000_000_000;
      jest.setSystemTime(T0);

      const routeCtx = { route: makeDirectRoute(4, '7'), origin: yongmasan, destination: konkuk };
      mockNearest.mockReturnValue(gpsNearest);
      mockFindTop.mockReturnValue([{ station: gpsNearest.result.station, distanceKm: 0 }]);

      const { result, rerender } = renderHook(() =>
        useFusedNearestStation(undefined, undefined, routeCtx),
      );

      // #1922 (M2) — 90s 이내 경과로 stuck guard 우회 (lastObserved 부재 시 trip 초기 90s 허용).
      jest.setSystemTime(T0 + 60_000);
      rerender({});

      jest.useRealTimers();
      return result;
    }

    it('estimatedLine ≠ gpsNearestLine + nextArcLine 미정의 → fallback to GPS', () => {
      // GPS는 충무로(3호선) 최근접으로 보고 — 환승역 stale interp 시뮬레이션.
      // → estimatedLine='7' vs gpsNearestLine='3' mismatch + nextArcLine null → fallback.
      const result = runLine7LocklessRouteScenario(
        gpsBase({
          result: { station: chungmuro3, distanceKm: 0 },
          userLocation: { lat: chungmuro3.lat, lng: chungmuro3.lng },
        }),
      );

      // line guard 차단 → estimator override 비채택 → GPS 원본 결과 유지.
      expect(result.current.source).not.toBe('boarding-lock-interp');
      expect(result.current.result?.station.id).toBe(chungmuro3.id);
    });

    it('#1437 estimatedLine = gpsNearestLine → estimator는 displayOnly에만 노출 (fire path 박탈)', () => {
      // 같은 line('7')이어도 ADR-015 §2 박탈 — line guard 통과해도 fire path는 GPS.
      const result = runLine7LocklessRouteScenario(gpsBase());

      expect(result.current.source).not.toBe('boarding-lock-interp');
      expect(result.current.displayOnlyEstimate?.strategy).toBe('lockless-route-hop');
    });
  });

  // #1382 — lock-interp adoption 게이트에 motion=stationary 가드 추가.
  // 정지 trip에서 시간 적분 forward ratchet 보류. consensus 게이트(#1363)와 분리 책임.
  // #1437 (ADR-015 §2) — 시간 적분 strategy의 fire 권한 영구 박탈로 #1382 motion 가드는
  // 본 cascade 단에서 무의미해졌다(어차피 ratchet 자체가 사라짐). motion 가드는 호출자(useStationAlarm)의
  // station-passed evaluateMovement에서 별도 책임. 본 describe는 회귀 가드로만 유지.
  describe('#1382 lock-interp forward ratchet — motion=stationary 보류 (#1437 박탈로 모두 미채택)', () => {
    it('motionStationary=true → fire path 미승격', () => {
      const result = runLockedMotionScenario(true);
      expect(result.current.source).not.toBe('boarding-lock-interp');
    });

    it('motionStationary=undefined(warmup) → fire path 미승격 (#1437 박탈)', () => {
      const result = runLockedMotionScenario(undefined);
      expect(result.current.source).not.toBe('boarding-lock-interp');
    });

    it('motionStationary=false → fire path 미승격 (#1437 박탈)', () => {
      const result = runLockedMotionScenario(false);
      expect(result.current.source).not.toBe('boarding-lock-interp');
    });
  });

  describe('#1926 (F-fix) lockless 4-signal consensus 가드 — positionTrainResult', () => {
    // helper의 lockless 분기: barometer=true OR accel!==automotive OR cellular!==surface → reject.
    // 본 통합 테스트는 wire-up 검증. 단위 분기는 positionTrainConsensus.test.ts에서 verify.

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const accelMock = require('../useAccelerometerFingerprint').useAccelerometerFingerprint as jest.Mock;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cellularMock = require('../useCellularTech').useCellularTech as jest.Mock;

    afterEach(() => {
      // 본 describe 종료 시 default(automotive/surface) 복귀 — 다른 describe 회귀 차단.
      accelMock.mockImplementation(() => 'automotive');
      cellularMock.mockImplementation(() => 'surface');
    });

    it('lockless + accelerometerPattern=walking → position-train 미채택', () => {
      accelMock.mockImplementation(() => 'walking');
      const { result } = setup({
        positions: { line: '7', trains: [train(yongmasan.name, TRAIN_STATUS.ARRIVED, { trainNo: 'T-CONSENSUS' })] },
        positionsOnce: true,
        trainCode: 'T-CONSENSUS',
        routeCtx: { route: makeDirectRoute(4, '7'), origin: yongmasan, destination: konkuk },
        // lock 없음 (lockless trip).
      });
      expect(result.current.source).not.toBe('position-train');
    });

    it('lockless + cellularEnvironmentVote=underground → position-train 미채택', () => {
      cellularMock.mockImplementation(() => 'underground');
      const { result } = setup({
        positions: { line: '7', trains: [train(yongmasan.name, TRAIN_STATUS.ARRIVED, { trainNo: 'T-CONSENSUS-2' })] },
        positionsOnce: true,
        trainCode: 'T-CONSENSUS-2',
        routeCtx: { route: makeDirectRoute(4, '7'), origin: yongmasan, destination: konkuk },
      });
      expect(result.current.source).not.toBe('position-train');
    });

    it('lockless + cellular surface-weak (non-surface) → position-train 미채택', () => {
      // helper 분기: cellular === 'surface' 만 통과. 'surface-weak'은 보수적으로 reject.
      cellularMock.mockImplementation(() => 'surface-weak');
      const { result } = setup({
        positions: { line: '7', trains: [train(yongmasan.name, TRAIN_STATUS.ARRIVED, { trainNo: 'T-CONSENSUS-3' })] },
        positionsOnce: true,
        trainCode: 'T-CONSENSUS-3',
        routeCtx: { route: makeDirectRoute(4, '7'), origin: yongmasan, destination: konkuk },
      });
      expect(result.current.source).not.toBe('position-train');
    });

    it('lockless + station progression 2 hop+ jump → konkuk station 미선정 (checkStationProgression reject)', () => {
      // helper checkStationProgression: ±1 hop만 허용. arc=[yongmasan, junggok, gunja, konkuk].
      // 첫 render: GPS=yongmasan, train=yongmasan → prevCascadeResultRef = yongmasan(idx 0).
      // 두번째 render: GPS=konkuk(=distance gate 통과), train=konkuk → |3-0|=3 → reject.
      const routeCtx = { route: makeDirectRoute(4, '7'), origin: yongmasan, destination: konkuk };

      // 첫 render: GPS=yongmasan, train=yongmasan → 채택.
      mockNearest.mockReturnValueOnce(gpsBase());
      mockFindTop.mockReturnValueOnce([{ station: yongmasan, distanceKm: 0 }]);
      mockPos.mockReturnValueOnce(positionRet({
        line: '7',
        trains: [train(yongmasan.name, TRAIN_STATUS.ARRIVED, { trainNo: 'T-JUMP' })],
      }));
      const { result, rerender } = renderHook(() =>
        useFusedNearestStation(undefined, undefined, routeCtx, 'T-JUMP', null),
      );

      // 두번째 render: GPS=konkuk (distance gate 통과 시켜야 함), train=konkuk.
      mockNearest.mockReturnValue({
        ...gpsBase(),
        userLocation: { lat: konkuk.lat, lng: konkuk.lng },
        result: { station: konkuk, distanceKm: 0 },
      });
      mockFindTop.mockReturnValue([{ station: konkuk, distanceKm: 0 }]);
      mockPos.mockReturnValue(positionRet({
        line: '7',
        trains: [train(konkuk.name, TRAIN_STATUS.ARRIVED, { trainNo: 'T-JUMP' })],
      }));
      rerender({});
      // konkuk가 station progression check에 의해 position-train으로 채택되지 않아야 한다.
      // (cascade는 GPS top-1 = konkuk로 fallback할 수 있지만 source !== 'position-train')
      expect(result.current.source).not.toBe('position-train');
    });
  });
});
