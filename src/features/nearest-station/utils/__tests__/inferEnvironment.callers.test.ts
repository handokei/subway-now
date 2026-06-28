/* eslint-disable import/no-restricted-paths -- cross-feature orchestration integration test (#890) */

/**
 * #1932 (Epic #1927 G2) — `inferEnvironment` 호출자 통합 unit test.
 *
 * 목적:
 *   1. SSOT 단일화 — fusion cascade가 environment 변수 직접 참조함을 호출 시점 보장.
 *   2. semantic equivalence — `barometerSubsurface === true/false` 시 cascade tier 1/2가
 *      기존 raw subsurface gate와 동일 분기를 채택함을 증명.
 *   3. semantic widening 시뮬 — `barometerSubsurface === undefined` + SSOT 합의 시 cascade tier가
 *      surface/underground로 확장 진입함을 측정 (V8 cycle 영향 0 — undergroundSSOT/surfaceSSOT는
 *      별도 산출 비용 없이 cascade 앞 1회).
 *
 * 호출자:
 *   - `useFusedNearestStation` cascade picker — environment 변수가 tier 1/2 게이트.
 *   - `useStationMismatchDetector` — HomeScreen이 useFusedNearestStation return을 위임 (공유 산출).
 */

import { renderHook, waitFor } from '@testing-library/react-native';
import { useFusedNearestStation } from '../../hooks/useFusedNearestStation';
import { useNearestStation } from '../../hooks/useNearestStation';
import { useArrivalInfo } from '../../../arrival/hooks/useArrivalInfo';
import { useTrainPositions } from '../../../route/hooks/useTrainPositions';
import { findTopNearestStations } from '../findNearestStation';
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
import { ARRIVAL_CODE } from '../../../../shared/constants/arrivalCodes';
import {
  GPS_DERIVED_ACCURACY_MAX_M,
} from '../../../../shared/constants/realtime';
import { inferEnvironment } from '../inferEnvironment';

jest.mock('../findNearestStation', () => ({
  findTopNearestStations: jest.fn(),
}));
jest.mock('../../hooks/useNearestStation');
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

const lockOn2: BoardingLock = {
  destinationId: 'dest-2',
  trainCode: 'T-LOCK',
  boardingLine: '2',
  boardingStationId: hanyangdae.id,
  boardedAt: T0,
  expectedDurationMs: 10 * 60_000,
};

/**
 * 지상 GPS 30m accuracy + arvlCd 1(ARRIVED) arrival 매칭 → surfaceSSOT 합의 성립.
 * inferEnvironment가 surfaceSSOT=true 받음.
 */
function setupSurfaceSsotConsensus(): void {
  const live = { station: hanyangdae, distanceKm: 0.05 };
  mockNearest.mockReturnValue({
    result: live,
    liveResult: live,
    stickyDisplayOnly: null,
    variants: [hanyangdae],
    userLocation: { lat: hanyangdae.lat, lng: hanyangdae.lng },
    ...GPS_BASE_DEFAULTS,
    accuracyMeters: 30, // surfaceSSOT 합의 임계 (GPS_ACC_MAX_M=30)
    lastFixAtMs: T0,
    refresh: jest.fn(),
  });
  mockFindTop.mockReturnValue([{ station: hanyangdae, distanceKm: 0.05 }]);
  mockArrival.mockReturnValue(
    arrivalRet({
      up: [
        {
          destination: 'dest',
          arrivalMinutes: 0,
          arrivalSeconds: 0,
          statusMessage: '도착',
          trainCode: 'T-LOCK',
          line: '2',
          receivedAtMs: T0,
          arrivalCode: ARRIVAL_CODE.ARRIVED,
          isLastTrain: false,
          trainType: 'normal',
        },
      ],
      down: [],
    }),
  );
  mockPos.mockReturnValue(positionRet(null));
}

describe('#1932 inferEnvironment 호출자 통합 (SSOT 단일화 + cascade 직접 참조)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    // 기본: backend mirror는 ttukssom(다른 역)으로 fresh하게 세팅 → cascade tier 1/2 미진입 시 fallback 확인
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

  describe('호출자 SSOT 단일화', () => {
    it('useFusedNearestStation return.environment가 inferEnvironment 결과와 일관', async () => {
      // 지상 GPS + arrival 합의 → surfaceSSOT 활성 → environment='surface'
      setupSurfaceSsotConsensus();

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
        expect(hook.result.current.environment).toBe('surface');
      });
      // 환경 변수가 별도 산출 없이 cascade 산출 결과를 직접 expose.
      // 분산 산출 0건 acceptance §1.
    });
  });

  describe('cascade tier 1 semantic equivalence (positionTrainBoardingLockMatch)', () => {
    it('subsurface=true (raw → underground 등가) → environment 변수 "underground"', async () => {
      // 지하 GPS dead zone 시뮬: GPS 부정확 + 모든 신호 부재. surfaceSSOT 비활성.
      // cascade tier 1 trigger는 useFusedNearestStation.test.ts(PR #1646 보강)에서 cover —
      // 본 test는 environment 변수 산출이 SSOT 단일화 후 cascade picker 앞에서 일관 산출됨을 보장.
      const live = { station: hanyangdae, distanceKm: 0.05 };
      mockNearest.mockReturnValue({
        result: live,
        liveResult: live,
        stickyDisplayOnly: null,
        variants: [hanyangdae],
        userLocation: { lat: hanyangdae.lat, lng: hanyangdae.lng },
        ...GPS_BASE_DEFAULTS,
        accuracyMeters: 200, // 지하 GPS는 부정확 — surfaceSSOT 미합의
        lastFixAtMs: T0,
        refresh: jest.fn(),
      });
      mockFindTop.mockReturnValue([{ station: hanyangdae, distanceKm: 0.05 }]);
      mockArrival.mockReturnValue(arrivalRet(null));
      mockPos.mockReturnValue(positionRet({ line: '2', trains: [] }));

      const hook = renderHook(() =>
        useFusedNearestStation(
          undefined,
          undefined,
          undefined,
          undefined,
          lockOn2,
          undefined,
          { subsurface: true }, // 지하 raw 신호
        ),
      );
      await flushBackendSsotMirrorTick();
      await waitFor(() => {
        expect(hook.result.current.environment).toBe('underground');
      });
      // raw `subsurface === true` → inferEnvironment 우선순위 1 → 'underground'.
      // cascade tier 1 게이트(positionTrainBoardingLockMatch)가 이 변수를 직접 read.
    });
  });

  describe('cascade tier 2 semantic equivalence (gpsDerivedFastPath)', () => {
    it('subsurface=false (raw → surface 등가) + surfaceSSOT 없음 + GPS 신선 → tier 2 진입', async () => {
      // 4-gate 충족: boardingLock + subsurface=false + GPS 신선 + 노선 정합 + 100m 이내
      // surfaceSSOT 미합의여도 #1932 raw subsurface=false 신뢰 → environment='surface'
      const live = { station: hanyangdae, distanceKm: 0.05 };
      mockNearest.mockReturnValue({
        result: live,
        liveResult: live,
        stickyDisplayOnly: null,
        variants: [hanyangdae],
        userLocation: { lat: hanyangdae.lat, lng: hanyangdae.lng },
        ...GPS_BASE_DEFAULTS,
        accuracyMeters: GPS_DERIVED_ACCURACY_MAX_M, // 50m — surfaceSSOT 임계(30m) 초과
        lastFixAtMs: T0,
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
          { subsurface: false }, // 지상 raw 신호 (SSOT 합의 없음)
        ),
      );
      await flushBackendSsotMirrorTick();
      await waitFor(() => {
        expect(hook.result.current.source).toBe('gps');
      });
      expect(hook.result.current.confidence).toBe('gps-only');
      // raw subsurface=false → SSOT 비활성에도 environment='surface' (V8 cycle 영향 0).
      expect(hook.result.current.environment).toBe('surface');
    });
  });

  describe('semantic widening 시뮬 — V8 회귀 점검', () => {
    it('subsurface=undefined + surfaceSSOT만 활성 → environment="surface"', () => {
      // inferEnvironment 함수 직접 호출 (hybrid 경로).
      // 기존 L1051 raw gate(`subsurface === false`)는 통과 X.
      // 변경 후 cascade tier 2 `environment === 'surface'`는 통과 — semantic widening.
      const result = inferEnvironment({
        subsurface: undefined,
        surfaceSSOT: true,
        undergroundSSOT: false,
      });
      expect(result.label).toBe('surface');
      // widening: cascade tier 2가 barometer 미지원 환경에서도 surfaceSSOT 4-signal 합의로 진입 가능.
      // V8 acceptance 4: /trips ≤10/10min — undergroundSSOT/surfaceSSOT는 cascade 앞 1회 산출이므로
      // sampling 빈도 증가 0. GPS-derived fast path 진입 빈도는 surfaceSSOT 합의 정도와 동등.
    });

    it('subsurface=undefined + undergroundSSOT만 활성 → environment="underground"', () => {
      // cascade tier 1 widening 시뮬 — barometer 미지원이어도 4-signal 합의 underground 진입 가능.
      const result = inferEnvironment({
        subsurface: undefined,
        surfaceSSOT: false,
        undergroundSSOT: true,
      });
      expect(result.label).toBe('underground');
    });

    it('subsurface=undefined + 둘 다 활성 → environment="unknown" (분간 불가)', () => {
      // hybrid 시 SSOT 양쪽 다 활성이면 cascade tier 1/2 모두 비진입 → 기존 cascade fallback.
      const result = inferEnvironment({
        subsurface: undefined,
        surfaceSSOT: true,
        undergroundSSOT: true,
      });
      expect(result.label).toBe('unknown');
    });
  });

  describe('cascade environment 변수 분포 trace (DebugModal/측정 prereq)', () => {
    it('useFusedNearestStation return이 environment + environmentHintReason 둘 다 expose', async () => {
      setupSurfaceSsotConsensus();
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
        expect(hook.result.current.environment).toBe('surface');
      });
      // hint는 surfaceSSOT 합의 시 undefined.
      expect(hook.result.current.environmentHintReason).toBeUndefined();
      // 1주 environment 분포 측정 인프라 prereq — Sentry breadcrumb는 useEffect에서 emit (deps environment).
    });
  });
});
