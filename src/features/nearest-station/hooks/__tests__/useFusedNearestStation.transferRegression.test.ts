/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
/**
 * #671 — #662/#663/#664 fix의 데이터 주도 회귀 가드.
 *
 * stations.json의 모든 환승역(동명이역 양평 제외 73개)에 대해 다음 invariant 검증:
 * - BoardingLock이 line A로 활성 + position-train이 line B로 잠금 시도 → 강등 (GPS fallback)
 * - BoardingLock과 같은 line이면 position-train 유지
 *
 * stations.json 변경 시 새 환승역도 자동 검증 — 환승역별 가드 회귀 인프라.
 */

import { renderHook } from '@testing-library/react-native';
import { useFusedNearestStation } from '../useFusedNearestStation';
import { useNearestStation } from '../useNearestStation';
import { useArrivalInfo } from '../../../arrival/hooks/useArrivalInfo';
import { useTrainPositions } from '../../../route/hooks/useTrainPositions';
import { findTopNearestStations } from '../../utils/findNearestStation';
import { enumerateTransferStations } from '../../../route/utils/transferStations';
import { TRAIN_STATUS } from '../../../../shared/constants/trainStatus';
import type { TrainPosition, LinePositions } from '../../api/positionApi';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
import type { Station } from '../../../../shared/types/station';

jest.mock('../useNearestStation');
jest.mock('../../../arrival/hooks/useArrivalInfo');
jest.mock('../../../route/hooks/useTrainPositions');
jest.mock('../../utils/findNearestStation', () => ({
  findTopNearestStations: jest.fn(),
}));

const mockUseNearest = useNearestStation as jest.Mock;
const mockUseArrival = useArrivalInfo as jest.Mock;
const mockUsePositions = useTrainPositions as jest.Mock;
const mockFindTop = findTopNearestStations as jest.Mock;

function gpsAt(station: Station) {
  const live = { station, distanceKm: 0 };
  return {
    result: live,
    // #1486 (ADR-015 §2) — sticky 비활성: liveResult=result, stickyDisplayOnly=null.
    liveResult: live,
    stickyDisplayOnly: null,
    variants: [station],
    userLocation: { lat: station.lat, lng: station.lng },
    speedMps: 0,
    // 지하 fix 시뮬레이션 — passesFusionDistanceGate 면제로 line 가드만 검증
    accuracyMeters: 1500,
    loading: false,
    error: null,
    permissionDenied: false,
    locationUncertain: false,
    refresh: jest.fn(),
  };
}

function arrivalRet() {
  return { arrival: null, loading: false, isMock: false };
}

function positionRet(positions: LinePositions | null) {
  return { positions, loading: false, isMock: false };
}

function arrivedTrain(statnNm: string, trainNo: string): TrainPosition {
  return {
    statnId: '',
    statnNm,
    trainNo,
    trainStatus: TRAIN_STATUS.ARRIVED,
    updnLine: 0,
    terminalStationId: '',
    terminalStationName: '',
    trainType: 'normal',
    isLastTrain: false,
    receivedAtMs: 1_700_000_000_000,
  };
}

function mockPositionsForCandidates(
  lockSide: Station,
  otherSide: Station,
  arrivedOn: 'lockSide' | 'otherSide',
): void {
  // candidates 순서: [lockSide, otherSide]. activeLines도 동일 순서로 dedup.
  // useTrainPositions는 l0/l1/l2 슬롯 3개 — p2는 항상 null.
  const lockTrain =
    arrivedOn === 'lockSide' ? [arrivedTrain(lockSide.name, 'T-LOCK-SIDE')] : [];
  const otherTrain =
    arrivedOn === 'otherSide' ? [arrivedTrain(otherSide.name, 'T-OTHER-SIDE')] : [];
  mockUsePositions
    .mockReturnValueOnce(positionRet({ line: lockSide.line, trains: lockTrain }))
    .mockReturnValueOnce(positionRet({ line: otherSide.line, trains: otherTrain }))
    .mockReturnValueOnce(positionRet(null));
}

function lockFor(lockSide: Station): BoardingLock {
  return {
    destinationId: 'd1',
    trainCode: 'T-LOCK',
    boardingStationId: lockSide.id,
    boardingLine: lockSide.line,
    boardedAt: 1_700_000_000_000,
    expectedDurationMs: 600_000,
  };
}

const transfers = enumerateTransferStations();

function runTransferScenario(
  lockSide: Station,
  otherSide: Station,
  arrivedOn: 'lockSide' | 'otherSide',
) {
  mockUseNearest.mockReturnValue(gpsAt(lockSide));
  mockFindTop.mockReturnValue([
    { station: lockSide, distanceKm: 0.05 },
    { station: otherSide, distanceKm: 0.2 },
  ]);
  mockPositionsForCandidates(lockSide, otherSide, arrivedOn);
  return renderHook(() =>
    useFusedNearestStation(undefined, undefined, undefined, null, lockFor(lockSide)),
  );
}

describe('#671 환승역 fusion line 잠금 회귀 가드', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseArrival.mockReturnValue(arrivalRet());
    mockUsePositions.mockReturnValue(positionRet(null));
  });

  describe.each(transfers)('환승역 $name', ({ variants }) => {
    // variants 첫 두 개를 lockSide/otherSide로 사용 — invariant는 line equality라 어느 쌍이든 동일.
    const [lockSide, otherSide] = variants;

    it('lock.boardingLine과 다른 line이 position-train 잠금 시도 → 강등 → GPS fallback (lockSide)', () => {
      const { result } = runTransferScenario(lockSide, otherSide, 'otherSide');
      expect(result.current.source).toBe('gps');
      expect(result.current.result?.station.line).toBe(lockSide.line);
    });

    it('lock.boardingLine과 같은 line이 position-train 잠금 → 유지', () => {
      const { result } = runTransferScenario(lockSide, otherSide, 'lockSide');
      expect(result.current.source).toBe('position-train');
      expect(result.current.result?.station.line).toBe(lockSide.line);
    });
  });
});
