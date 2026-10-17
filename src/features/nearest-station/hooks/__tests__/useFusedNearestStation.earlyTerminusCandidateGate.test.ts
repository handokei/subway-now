/* eslint-disable import/no-restricted-paths -- cross-feature orchestration (#890) */

/**
 * #2914 (결함 2 + ⓐⓑⓒⓓ 거부 케이스) — position-train 채택 경로의 조기종착 배제 + 방향
 * 미해결 가드.
 *
 * 결함 2: `CandidateTrain`에 종착역 정보가 없어(이전) 이 레이어에서 조기종착 판정이
 * 구조적으로 불가능했다. `pickCandidateTrains`의 `buildCandidate`가 `terminalStationName`을
 * 보존하도록 고치고, `useFusedNearestStation.ts`의 lock 후처리 필터에 조기종착 배제를 추가했다.
 *
 * 거부 케이스(이슈 #2914):
 *   ⓐ 정상 방향·정상 종착 열차는 반드시 후보로 남는다 (과차단 금지 — 가장 위험).
 *   ⓑ lock.trainCode와 정확히 일치하는 후보는 어떤 필터에서도 제외되지 않는다.
 *   ⓒ direction 해석이 실패하면(route/destination은 있는데 resolveTripDirection이 null)
 *     전체 후보가 무효화된다(trainCode 정확 일치 예외, 양방향 병합 금지).
 *   ⓓ terminalStationName이 없는(레거시) 입력도 크래시 없이 보수적으로(배제하지 않고) 통과한다.
 */

import { renderHook } from '@testing-library/react-native';
import { useFusedNearestStation } from '../useFusedNearestStation';
import { useNearestStation } from '../useNearestStation';
import { useArrivalInfo } from '../../../arrival/hooks/useArrivalInfo';
import { useTrainPositions } from '../../../route/hooks/useTrainPositions';
import { findTopNearestStations } from '../../utils/findNearestStation';
import { findStationByNameAndLine } from '../../../../shared/utils/stationLookup';
import {
  arrivalRet,
  positionRet,
  makeTrain,
  GPS_BASE_DEFAULTS,
} from '../../../../testUtils/positionApiFixtures';
import { TRAIN_STATUS } from '../../../../shared/constants/trainStatus';
import {
  clearCandidateRejectEntries,
  getCandidateRejectEntries,
} from '../../utils/candidateRejectBuffer';
import { makeDirectRoute } from '../../../../testUtils/routeFixtures';
import type { LinePositions } from '../../api/positionApi';
import type { FusedRouteContext } from '../useFusedNearestStation';
import type { BoardingLock } from '../../../../shared/types/boardingLock';

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
  ...jest.requireActual('../../../alarm/utils/backendSsotMirror'),
  readBackendSsotMirror: jest.fn().mockResolvedValue(null),
}));

// #2914 — 테스트별로 resolveTripDirection을 직접 통제해(실제 노선 기하 추정에 의존하지 않고)
// "resolved(down)" / "resolution 실패(null)" 두 경로를 명시적으로 재현한다.
const mockResolveTripDirection = jest.fn();
jest.mock('../../../route/utils/tripDirection', () => ({
  resolveTripDirection: (...args: unknown[]) => mockResolveTripDirection(...args),
}));

const mockNearest = useNearestStation as jest.Mock;
const mockArrival = useArrivalInfo as jest.Mock;
const mockPos = useTrainPositions as jest.Mock;
const mockFindTop = findTopNearestStations as jest.Mock;

const jamsilnaru = findStationByNameAndLine('잠실나루', '2')!;
const seongsu = findStationByNameAndLine('성수', '2')!;
// 한양대는 잠실나루→성수 arc(강변·구의·건대입구·성수) 밖이라 "조기 종착역" 명으로만 쓴다 —
// GPS/열차 현재 위치는 arc 안의 건대입구를 쓴다(trackTrainProgress의 forward-only/arc 게이트가
// arc 밖 station을 독립적으로 reject하므로, #2914 필터만 격리 검증하려면 arc 내부가 필요).
const hanyangdae = findStationByNameAndLine('한양대', '2')!;
const gondae = findStationByNameAndLine('건대입구', '2')!;

const T0 = 1_700_000_000_000;

function setupGpsAt(station: { lat: number; lng: number; name: string; line: string; id: string }) {
  mockNearest.mockReturnValue({
    result: null,
    liveResult: null,
    stickyDisplayOnly: null,
    variants: [],
    userLocation: { lat: station.lat, lng: station.lng },
    ...GPS_BASE_DEFAULTS,
    lastFixAtMs: T0,
    refresh: jest.fn(),
  });
  mockFindTop.mockReturnValue([{ station, distanceKm: 0 }]);
  mockArrival.mockReturnValue(arrivalRet(null));
}

function lockAtJamsilnaru(): BoardingLock {
  return {
    destinationId: 'dest-1',
    trainCode: 'T-LOCK-REAL',
    boardingStationId: jamsilnaru.id,
    boardingLine: '2',
    boardedAt: T0,
    expectedDurationMs: 30 * 60_000,
  };
}

function routeContextToSeongsu(): FusedRouteContext {
  return {
    route: makeDirectRoute(10, '2'),
    origin: jamsilnaru,
    destination: seongsu,
  };
}

function mockLine2Positions(trains: ReturnType<typeof makeTrain>[]) {
  const line2Positions: LinePositions = { line: '2', trains };
  mockPos.mockImplementation((line: string | null) => {
    if (line === '2') return positionRet(line2Positions);
    return positionRet(null);
  });
}

describe('#2914 — position-train 조기종착 배제 + 방향 미해결 가드', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    clearCandidateRejectEntries();
    mockPos.mockReturnValue(positionRet(null));
    // 잠실나루(5)→성수 destination 방향 — 'down'으로 고정(mock).
    mockResolveTripDirection.mockReturnValue('down');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('결함2 — 조기 종착(한양대 종착, 성수 목적지 도달 불가) 열차는 candidate-early-terminus로 제외된다', () => {
    setupGpsAt(gondae);
    const earlyTerminusTrain = makeTrain(gondae.name, TRAIN_STATUS.ARRIVED, {
      trainNo: '9001',
      updnLine: 1,
      receivedAtMs: T0,
      terminalStationName: hanyangdae.name,
    });
    mockLine2Positions([earlyTerminusTrain]);

    const { result } = renderHook(() =>
      useFusedNearestStation(undefined, undefined, routeContextToSeongsu(), undefined, lockAtJamsilnaru()),
    );

    expect(result.current.source).not.toBe('position-train');
    const rejects = getCandidateRejectEntries();
    const terminusRejects = rejects.filter((r) => r.reason === 'candidate-early-terminus');
    expect(terminusRejects.length).toBeGreaterThanOrEqual(1);
    expect(terminusRejects[0].trainNo).toBe('9001');
  });

  it('거부 케이스 ⓐ(과차단 금지) — 정상 종착(잠실나루 종착, 성수 목적지 도달 가능) 열차는 후보로 남는다', () => {
    setupGpsAt(gondae);
    const normalTerminusTrain = makeTrain(gondae.name, TRAIN_STATUS.ARRIVED, {
      trainNo: '9002',
      updnLine: 1,
      receivedAtMs: T0,
      terminalStationName: jamsilnaru.name,
    });
    mockLine2Positions([normalTerminusTrain]);

    const { result } = renderHook(() =>
      useFusedNearestStation(undefined, undefined, routeContextToSeongsu(), undefined, lockAtJamsilnaru()),
    );

    const rejects = getCandidateRejectEntries();
    expect(rejects.some((r) => r.reason === 'candidate-early-terminus' && r.trainNo === '9002')).toBe(
      false,
    );
    expect(result.current.source).toBe('position-train');
  });

  it('거부 케이스 ⓑ — lock.trainCode와 정확히 일치하면 조기 종착이어도 제외되지 않는다', () => {
    setupGpsAt(gondae);
    // lock.trainCode와 정확히 일치하는 실측 신호. terminalStationName은 조기종착(한양대)이지만
    // trainCode 일치가 어떤 필터보다 우선한다(#2696/#2914 공통 불변식).
    const lockedTrain = makeTrain(gondae.name, TRAIN_STATUS.ARRIVED, {
      trainNo: 'T-LOCK-REAL',
      updnLine: 1,
      receivedAtMs: T0,
      terminalStationName: hanyangdae.name,
    });
    mockLine2Positions([lockedTrain]);

    const { result } = renderHook(() =>
      useFusedNearestStation(undefined, undefined, routeContextToSeongsu(), undefined, lockAtJamsilnaru()),
    );

    const rejects = getCandidateRejectEntries();
    expect(
      rejects.some(
        (r) =>
          (r.reason === 'candidate-early-terminus' || r.reason === 'candidate-direction-unresolved') &&
          r.trainNo === 'T-LOCK-REAL',
      ),
    ).toBe(false);
    expect(result.current.source).toBe('position-train');
  });

  it('거부 케이스 ⓒ — direction 해석 실패(route/destination은 있지만 resolveTripDirection null)면 전부 제외(trainCode 예외)', () => {
    mockResolveTripDirection.mockReturnValue(null);
    setupGpsAt(gondae);
    const otherTrain = makeTrain(gondae.name, TRAIN_STATUS.ARRIVED, {
      trainNo: '9003',
      updnLine: 1,
      receivedAtMs: T0,
      terminalStationName: jamsilnaru.name,
    });
    const lockedTrain = makeTrain(gondae.name, TRAIN_STATUS.ARRIVED, {
      trainNo: 'T-LOCK-REAL',
      updnLine: 0,
      receivedAtMs: T0,
      terminalStationName: jamsilnaru.name,
    });
    mockLine2Positions([otherTrain, lockedTrain]);

    renderHook(() =>
      useFusedNearestStation(undefined, undefined, routeContextToSeongsu(), undefined, lockAtJamsilnaru()),
    );

    const rejects = getCandidateRejectEntries();
    const unresolvedRejects = rejects.filter((r) => r.reason === 'candidate-direction-unresolved');
    expect(unresolvedRejects.some((r) => r.trainNo === '9003')).toBe(true);
    // lock.trainCode exact match는 direction 미해결이어도 제외되지 않는다.
    expect(unresolvedRejects.some((r) => r.trainNo === 'T-LOCK-REAL')).toBe(false);
  });

  it('거부 케이스 ⓓ — terminalStationName이 없는(레거시, 빈 문자열) 입력도 크래시 없이 보수적으로 통과한다', () => {
    setupGpsAt(gondae);
    const legacyTrain = makeTrain(gondae.name, TRAIN_STATUS.ARRIVED, {
      trainNo: '9004',
      updnLine: 1,
      receivedAtMs: T0,
      terminalStationName: '',
    });
    mockLine2Positions([legacyTrain]);

    expect(() =>
      renderHook(() =>
        useFusedNearestStation(undefined, undefined, routeContextToSeongsu(), undefined, lockAtJamsilnaru()),
      ),
    ).not.toThrow();

    const rejects = getCandidateRejectEntries();
    expect(rejects.some((r) => r.reason === 'candidate-early-terminus' && r.trainNo === '9004')).toBe(
      false,
    );
  });
});
