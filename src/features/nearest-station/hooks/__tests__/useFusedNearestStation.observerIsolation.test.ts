/* eslint-disable import/no-restricted-paths -- cross-feature orchestration (#890) */

/**
 * #3191 PR-0 (측정 정화) — DebugModal이 띄우는 'observer' 인스턴스는 측정 버퍼에 아무것도 쓰지 않는다.
 *
 * 배경: observer가 막는 측정은 reevalInstrumentation 3종(`record*Recompute/DistanceFire/EnvFire`)과
 * 일부 push뿐이었고, candidateReject / record*(breadcrumb) / alarm log / Fusion log / estimator /
 * lock drift / Raw / 하위 hook의 gps-drop·accel 기록은 primary와 observer가 섞여 들어갔다
 * (Raw `sub=—` 행 = observer, 덤프 해석 오염). 각 시나리오는 primary에서 기록점이 실제로 발화함을
 * 먼저 단언(시나리오 유효성)하고, 같은 시나리오를 observer로 돌리면 0건임을 단언한다.
 */
jest.mock('../../utils/findNearestStation', () => ({
  findTopNearestStations: jest.fn(),
}));
jest.mock('../useNearestStation');
jest.mock('../../../arrival/hooks/useArrivalInfo');
jest.mock('../../../route/hooks/useTrainPositions');
jest.mock('../useAccelerometerFingerprint', () => ({
  useAccelerometerFingerprint: jest.fn(() => 'automotive'),
}));
jest.mock('../useCellularTech', () => ({
  useCellularTech: jest.fn(() => 'surface'),
}));
jest.mock('../../../alarm/utils/tripStartStorage', () => ({
  getTripStartedAt: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../../../shared/infra/monitoring/breadcrumb', () => ({
  ...jest.requireActual('../../../../shared/infra/monitoring/breadcrumb'),
  recordEnvironmentTransition: jest.fn(),
  recordFusionTierAdopted: jest.fn(),
}));
jest.mock('../../../alarm/utils/alarmLog', () => ({
  ...jest.requireActual('../../../alarm/utils/alarmLog'),
  logFusionPickerTier: jest.fn(),
  logSuppressedLocklessForwardOnly: jest.fn(),
  logBackendSsotRouteRegressionReject: jest.fn(),
}));
jest.mock('../../utils/pickFusionTier', () => ({
  ...jest.requireActual('../../utils/pickFusionTier'),
  isCandidateEnvMismatch: jest.fn(() => true),
}));

import { renderHook } from '@testing-library/react-native';
import { useFusedNearestStation, type FusedRouteContext } from '../useFusedNearestStation';
import { useNearestStation } from '../useNearestStation';
import { useAccelerometerFingerprint } from '../useAccelerometerFingerprint';
import { useArrivalInfo } from '../../../arrival/hooks/useArrivalInfo';
import { useTrainPositions } from '../../../route/hooks/useTrainPositions';
import { findTopNearestStations } from '../../utils/findNearestStation';
import { findStationByNameAndLine } from '../../../../shared/utils/stationRoute';
import { TRAIN_STATUS } from '../../../../shared/constants/trainStatus';
import { GPS_QUALITY_GATE_MAX_AGE_MS } from '../../../../shared/constants/gpsQualityGate';
import { clearCandidateRejectEntries, getCandidateRejectEntries } from '../../utils/candidateRejectBuffer';
import { clearFusionDebugEntries, getFusionDebugEntries } from '../../utils/fusionDebugBuffer';
import { clearEstimatorEntries, getEstimatorEntries } from '../../../route/utils/estimatorDebugBuffer';
import {
  __resetRawSignalForTests__,
  getRawSignalEntries,
} from '../../../observability/utils/rawSignalBuffer';
import {
  recordEnvironmentTransition,
  recordFusionTierAdopted,
} from '../../../../shared/infra/monitoring/breadcrumb';
import { logFusionPickerTier } from '../../../alarm/utils/alarmLog';
import {
  arrivalRet,
  positionRet,
  makeTrain as train,
  GPS_BASE_DEFAULTS,
} from '../../../../testUtils/positionApiFixtures';
import { makeDirectRoute } from '../../../../testUtils/routeFixtures';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
import type { DirectRoute } from '../../../../shared/utils/stationRoute';

const mockNearest = useNearestStation as jest.Mock;
const mockArrival = useArrivalInfo as jest.Mock;
const mockPos = useTrainPositions as jest.Mock;
const mockFindTop = findTopNearestStations as jest.Mock;
const mockAccel = useAccelerometerFingerprint as jest.Mock;

const konkuk = findStationByNameAndLine('건대입구', '7')!;
const junggok = findStationByNameAndLine('중곡', '7')!;
const yongmasan = findStationByNameAndLine('용마산', '7')!;
const gangnam2 = findStationByNameAndLine('강남', '2')!;

const NOW = 1_700_000_000_000;
const TRAIN_CODE = '7256';
type Role = 'primary' | 'observer';

const lock: BoardingLock = {
  destinationId: yongmasan.id,
  trainCode: TRAIN_CODE,
  boardingStationId: konkuk.id,
  boardingLine: '7',
  boardedAt: NOW,
  expectedDurationMs: 600_000,
};
const lockRoute: FusedRouteContext = {
  route: makeDirectRoute(4, '7'),
  origin: konkuk,
  destination: yongmasan,
};

function arrangeGps(fixAgeMs: number) {
  mockNearest.mockReturnValue({
    result: { station: konkuk, distanceKm: 0 },
    variants: [konkuk],
    userLocation: { lat: konkuk.lat, lng: konkuk.lng },
    ...GPS_BASE_DEFAULTS,
    accuracyMeters: 74,
    lastFixAtMs: NOW - fixAgeMs,
    refresh: jest.fn(),
  });
  mockFindTop.mockReturnValue([{ station: konkuk, distanceKm: 0 }]);
}

/** lock 활성 + stale fix — gps-stale / Fusion log / estimator / Raw / breadcrumb / tier log 기록점 발화. */
function renderLockStale(role: Role) {
  arrangeGps(GPS_QUALITY_GATE_MAX_AGE_MS + 5_000);
  mockPos.mockReturnValue(
    positionRet({
      line: '7',
      trains: [train(junggok.name, TRAIN_STATUS.ARRIVED, { trainNo: TRAIN_CODE })],
    }),
  );
  return renderHook(() =>
    useFusedNearestStation(undefined, undefined, lockRoute, TRAIN_CODE, lock, undefined, undefined, undefined, undefined, role),
  );
}

/** trip route(2호선)에 없는 7호선 position이 enumerate에 진입 — candidate-line reject 기록점. */
function renderOffLine(role: Role) {
  arrangeGps(0);
  mockPos.mockReturnValue(
    positionRet({ line: '7', trains: [train(yongmasan.name, TRAIN_STATUS.DEPARTED, { trainNo: 'T-7-1' })] }),
  );
  const route: DirectRoute = {
    type: 'direct',
    stops: 5,
    line: '2',
    travelSeconds: 600,
    destinationStationId: '2-001',
  };
  const ctx: FusedRouteContext = { route, origin: gangnam2, destination: gangnam2 };
  return renderHook(() =>
    useFusedNearestStation(undefined, undefined, ctx, undefined, undefined, undefined, undefined, undefined, undefined, role),
  );
}

/** lock 없음 + stale 아님 + 후보 환경 불일치 — candidate-env reject 기록점. */
function renderEnvMismatch(role: Role) {
  arrangeGps(0);
  mockPos.mockReturnValue(positionRet(null));
  return renderHook(() =>
    useFusedNearestStation(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, role),
  );
}

function clearAll() {
  clearCandidateRejectEntries();
  clearFusionDebugEntries();
  clearEstimatorEntries();
  __resetRawSignalForTests__();
  jest.clearAllMocks();
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  clearAll();
  mockArrival.mockReturnValue(arrivalRet(null));
  mockPos.mockReturnValue(positionRet(null));
});

afterEach(() => {
  jest.useRealTimers();
});

const reasons = () => getCandidateRejectEntries().map((e) => e.reason);

describe('useFusedNearestStation — observer 측정 격리 (#3191 PR-0)', () => {
  describe('lock + stale fix 시나리오', () => {
    it('primary — 시나리오가 gps-stale / Fusion log / estimator / Raw / breadcrumb / tier log를 실제로 발화한다 (유효성)', () => {
      renderLockStale('primary');
      expect(reasons()).toContain('gps-stale');
      expect(getFusionDebugEntries().length).toBeGreaterThan(0);
      expect(getEstimatorEntries().length).toBeGreaterThan(0);
      expect(getRawSignalEntries().length).toBeGreaterThan(0);
      expect(recordEnvironmentTransition).toHaveBeenCalled();
      expect(recordFusionTierAdopted).toHaveBeenCalled();
      expect(logFusionPickerTier).toHaveBeenCalled();
    });

    it('observer — gps-stale reject push 0', () => {
      renderLockStale('observer');
      expect(reasons()).not.toContain('gps-stale');
      expect(reasons()).not.toContain('gps-stale-held');
    });

    it('observer — Fusion log(pushFusionDebugEntry) push 0', () => {
      renderLockStale('observer');
      expect(getFusionDebugEntries()).toHaveLength(0);
    });

    it('observer — estimator buffer push 0', () => {
      renderLockStale('observer');
      expect(getEstimatorEntries()).toHaveLength(0);
    });

    it('observer — Raw signal push 0 (cycle/enter/exit 전부)', () => {
      renderLockStale('observer');
      expect(getRawSignalEntries()).toHaveLength(0);
    });

    it('observer — recordEnvironmentTransition / recordFusionTierAdopted 호출 0', () => {
      renderLockStale('observer');
      expect(recordEnvironmentTransition).not.toHaveBeenCalled();
      expect(recordFusionTierAdopted).not.toHaveBeenCalled();
    });

    it('observer — alarm log logFusionPickerTier 호출 0', () => {
      renderLockStale('observer');
      expect(logFusionPickerTier).not.toHaveBeenCalled();
    });

    it("observer — 하위 useAccelerometerFingerprint에 role='observer'를 전달한다", () => {
      renderLockStale('observer');
      expect(mockAccel).toHaveBeenCalledWith('observer');
    });

    it("primary — 하위 useAccelerometerFingerprint에 role='primary'를 전달한다", () => {
      renderLockStale('primary');
      expect(mockAccel).toHaveBeenCalledWith('primary');
    });

    it('판정 불변 — observer와 primary의 현재역/source/confidence 동일', () => {
      const p = renderLockStale('primary').result.current;
      clearAll();
      const o = renderLockStale('observer').result.current;
      expect(o.result?.station.id).toBe(p.result?.station.id);
      expect(o.source).toBe(p.source);
      expect(o.confidence).toBe(p.confidence);
    });
  });

  describe('candidate-line 시나리오', () => {
    it('primary — candidate-line reject 발화 (유효성)', () => {
      renderOffLine('primary');
      expect(reasons()).toContain('candidate-line');
    });

    it('observer — candidate-line reject push 0', () => {
      renderOffLine('observer');
      expect(reasons()).not.toContain('candidate-line');
    });
  });

  describe('candidate-env 시나리오', () => {
    it('primary — candidate-env reject 발화 (유효성)', () => {
      renderEnvMismatch('primary');
      expect(reasons()).toContain('candidate-env');
    });

    it('observer — candidate-env reject push 0', () => {
      renderEnvMismatch('observer');
      expect(reasons()).not.toContain('candidate-env');
    });
  });
});
