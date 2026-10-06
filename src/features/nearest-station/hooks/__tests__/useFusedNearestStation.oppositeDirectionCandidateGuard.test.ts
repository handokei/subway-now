/* eslint-disable import/no-restricted-paths -- cross-feature orchestration (#890) */

/**
 * #2696 (4번째 picker) — position-train 채택 경로의 "반대 방향 다른 열차" 오채택 가드.
 *
 * 10/3 실측 root: lock 활성(boardingStationId=신당) 중 GPS가 한양대 근처를 보고하자, 반대
 * 방향(외선/하행)으로 운행 중인 **다른 trainNo**(8178 추정)가 lock의 forward arc 안에 우연히
 * 위치해 `pickCandidateTrains`(direction 미인지) → `trackTrainProgress`(단일 후보) →
 * `positionTrainResult`(line/arc/forward 통과) 전 구간을 그대로 통과해 position-train으로
 * 잘못 채택됐다.
 *
 * 검증: lock.trainCode와 다른 trainNo + lock leg 진행 방향과 반대인 candidate는 같은 line이어도
 * candidateTrains enumerate 단계에서 제외되고(candidateRejectBuffer 'candidate-opposite-direction'
 * 적재), positionTrainResult가 그 역을 채택하지 않는다.
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

const mockNearest = useNearestStation as jest.Mock;
const mockArrival = useArrivalInfo as jest.Mock;
const mockPos = useTrainPositions as jest.Mock;
const mockFindTop = findTopNearestStations as jest.Mock;

// 2호선 신당(5)→한양대(8): 짧은 forward 경로, idx 증가 = 'up'(내선) — #2867/#2872 확정 매핑.
const sindang = findStationByNameAndLine('신당', '2')!;
const hanyangdae = findStationByNameAndLine('한양대', '2')!;
const seongsu = findStationByNameAndLine('성수', '2')!;

const T0 = 1_700_000_000_000;

function setupGpsAt(station: { lat: number; lng: number }) {
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
  mockFindTop.mockReturnValue([{ station: hanyangdae, distanceKm: 0 }]);
  mockArrival.mockReturnValue(arrivalRet(null));
}

function lockAtSindang(): BoardingLock {
  return {
    destinationId: 'dest-1',
    trainCode: 'T-LOCK-REAL',
    boardingStationId: sindang.id,
    boardingLine: '2',
    boardedAt: T0,
    expectedDurationMs: 30 * 60_000,
  };
}

function routeContextToSeongsu(): FusedRouteContext {
  return {
    route: makeDirectRoute(5, '2'),
    origin: sindang,
    destination: seongsu,
  };
}

describe('#2696 (4번째 picker) — 반대 방향 다른 trainNo 오채택 가드', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    clearCandidateRejectEntries();
    mockPos.mockReturnValue(positionRet(null));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('red→green — 반대 방향(하행/외선) 다른 trainNo(8178)가 GPS와 정확히 겹쳐도 position-train으로 채택되지 않는다', () => {
    setupGpsAt(hanyangdae);
    // 8178: lock.trainCode('T-LOCK-REAL')와 다른 trainNo. updnLine=1(하행/외선) — 신당→성수
    // 진행(내선/up/0)의 반대 방향. 역은 GPS와 정확히 일치하는 한양대 — fix 전에는 distance=0으로
    // 가장 먼저 채택됐다.
    const wrongDirectionTrain = makeTrain(hanyangdae.name, TRAIN_STATUS.ARRIVED, {
      trainNo: '8178',
      updnLine: 1,
      receivedAtMs: T0,
    });
    const line2Positions: LinePositions = { line: '2', trains: [wrongDirectionTrain] };
    mockPos.mockImplementation((line: string | null) => {
      if (line === '2') return positionRet(line2Positions);
      return positionRet(null);
    });

    const { result } = renderHook(() =>
      useFusedNearestStation(undefined, undefined, routeContextToSeongsu(), undefined, lockAtSindang()),
    );

    // 반대 방향 다른 trainNo는 position-train으로 채택되지 않는다. GPS 자체가 한양대를 보고하는
    // 것은(GPS tier fallback) 정상 — 검증 대상은 "position-train tier가 이 열차를 근거로 승격
    // 했는가"이다. source/confidence가 'position-train'/'boarding-lock'이 아니면 fix 동작 확인.
    expect(result.current.source).not.toBe('position-train');
    expect(result.current.confidence).not.toBe('boarding-lock');

    // candidateRejectBuffer에 신규 reason으로 가시화 — V/X 관측 채널(#2696 요구 2 승계).
    const rejects = getCandidateRejectEntries();
    const directionRejects = rejects.filter((r) => r.reason === 'candidate-opposite-direction');
    expect(directionRejects.length).toBeGreaterThanOrEqual(1);
    expect(directionRejects[0].trainNo).toBe('8178');
  });

  it('lock.trainCode와 정확히 일치하는 candidate는 방향이 흔들려도(updnLine 다름) 절대 제외하지 않는다 — 과차단 회귀 가드', () => {
    setupGpsAt(hanyangdae);
    // lock.trainCode('T-LOCK-REAL')와 정확히 일치하는 실측 신호. updnLine=1(기대와 다른 방향으로
    // 순간 noise가 있어도) — 실측 열차 신호는 신뢰해야 한다(pickCandidateTrains의 arc bypass와
    // 동일 정신). 제외되면 정상 lock 추적이 끊긴다.
    const lockedTrain = makeTrain(hanyangdae.name, TRAIN_STATUS.ARRIVED, {
      trainNo: 'T-LOCK-REAL',
      updnLine: 1,
      receivedAtMs: T0,
    });
    const line2Positions: LinePositions = { line: '2', trains: [lockedTrain] };
    mockPos.mockImplementation((line: string | null) => {
      if (line === '2') return positionRet(line2Positions);
      return positionRet(null);
    });

    renderHook(() =>
      useFusedNearestStation(undefined, undefined, routeContextToSeongsu(), undefined, lockAtSindang()),
    );

    const rejects = getCandidateRejectEntries();
    const directionRejects = rejects.filter((r) => r.reason === 'candidate-opposite-direction');
    expect(directionRejects).toHaveLength(0);
  });
});
