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

    it('GPS 좌표 복구되면 positionTrainResult 정상 채택', () => {
      // accuracyMeters=1500: 지하 bypass 모드. userLocation 있으므로 (a) 통과.
      // arc 없으므로 fix(b) 적용 — 하지만 거리 0(같은 좌표)이므로 gate 통과.
      const { result } = setup({
        gps: { userLocation: { lat: yongmasan.lat, lng: yongmasan.lng }, accuracyMeters: 1500 },
        positions: { line: '7', trains: [train(yongmasan.name, TRAIN_STATUS.ARRIVED, { trainNo: 'T-A' })] },
      });

      expect(result.current.source).toBe('position-train');
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

    it('lock 없을 때 accuracy=1500(지하) bypass는 그대로 동작', () => {
      // fix(b)는 lock 활성 시에만 적용 — lock 없으면 기존 bypass 유지.
      const { result } = setup({
        gps: { accuracyMeters: 1500 },
        positions: { line: '7', trains: [train(yongmasan.name, TRAIN_STATUS.ARRIVED, { trainNo: 'T-NOLOCK' })] },
      });

      expect(result.current.source).toBe('position-train');
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

    it('lock 없으면 arc 소속 검사 미작동 (기존 동작 유지)', () => {
      // fix(c)는 boardingLock 활성 시에만 동작.
      const myeonmok = findStationByNameAndLine('면목', '7')!;
      const { result } = setup({
        gps: { userLocation: { lat: yongmasan.lat, lng: yongmasan.lng }, accuracyMeters: 1500 },
        positions: { line: '7', trains: [train(myeonmok.name, TRAIN_STATUS.ARRIVED, { trainNo: 'T-C-NOLOCK' })] },
        routeCtx: routeContext,
      });

      // lock 없으면 arc 검사 안 함 → 면목도 통과 가능
      expect(result.current.source).toBe('position-train');
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

      // positionTrainResult = 용마산 → lockedTrainCode 매칭으로 source='boarding-lock'.
      // 앵커(lastObservedRef)는 arcIndexOfStation=-1 반환으로 미갱신 — line 487 early return.
      expect(result.current.source).toBe('boarding-lock');
    });
  });

  describe('observation ceiling — line 564 커버', () => {
    it('interpolated estimate + positionTrainResult null → livePositionIdx=-1 분기 통과', () => {
      // boardingLock 활성 + 90s 경과 → estimator default-hop 채택 (isInterpolated=true).
      // 열차 위치 없음 → positionTrainResult null → line 564 ternary false branch(: -1) 실행.
      jest.useFakeTimers();
      const T0 = 1_700_000_000_000;
      jest.setSystemTime(T0);

      const routeCtx = { route: makeDirectRoute(4, '7'), origin: yongmasan, destination: konkuk };
      const lock = makeLock({
        trainCode: 'T-INTERP',
        boardingStationId: yongmasan.id,
        boardingLine: '7',
        boardedAt: T0,
        expectedDurationMs: 600_000,
      });

      mockNearest.mockReturnValue(gpsBase());
      mockFindTop.mockReturnValue([{ station: yongmasan, distanceKm: 0 }]);
      // 열차 위치 없음 → trainProgress null → positionTrainResult null.
      // mockPos는 beforeEach에서 null로 설정됨.

      const { result, rerender } = renderHook(() =>
        useFusedNearestStation(undefined, undefined, routeCtx, 'T-INTERP', lock),
      );

      // 90s 후 default-hop이 중곡(arc idx 1)을 채택. positionTrainResult null.
      // → line 564 positionTrainResult ? ... : -1 의 false branch 실행.
      jest.setSystemTime(T0 + 90_000);
      rerender({});

      expect(result.current.source).toBe('boarding-lock-interp');

      jest.useRealTimers();
    });
  });
});
