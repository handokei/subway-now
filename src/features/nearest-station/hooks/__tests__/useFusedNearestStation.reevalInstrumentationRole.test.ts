/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
/**
 * #2594 (PR #2639 리뷰 P1/P4/P5) — useFusedNearestStation의 재평가 계측(candidatesRecompute/
 * candidateDistance/candidateEnv) 인스턴스 태깅 + cadence 대칭성 회귀 가드.
 *
 * P1: DebugModal이 표시용으로 자체 useFusedNearestStation 인스턴스를 추가 마운트한다
 *   (HomeScreen의 'primary' 인스턴스와 별개). reevalInstrumentation이 module-level singleton이라
 *   태깅 없이는 두 인스턴스의 재평가가 합산돼 계측값이 약 2배로 관측되는 회귀가 있었다.
 * P4: candidate-env effect가 candidates.length===0에서 early return해 이 cadence 자체가
 *   기록에서 빠졌었다(candidateDistanceFire는 반대로 reject=0 발화도 기록) — 비대칭 수정.
 * P5: record 호출을 useMemo 본문에서 useEffect로 이전 — 커밋된 렌더에서만, 값이 실제로 바뀔
 *   때만 기록되는지(중복 카운트 없이 정확히 1회) 확인.
 */
jest.mock('../useNearestStation');
jest.mock('../../../arrival/hooks/useArrivalInfo');
jest.mock('../../../route/hooks/useTrainPositions');
jest.mock('../useAccelerometerFingerprint', () => ({
  useAccelerometerFingerprint: jest.fn(() => 'automotive'),
}));
jest.mock('../useCellularTech', () => ({
  useCellularTech: jest.fn(() => 'surface'),
}));
jest.mock('../../utils/findNearestStation', () => ({
  findTopNearestStations: jest.fn(),
}));
jest.mock('../../../observability/utils/rawSignalBuffer', () => ({
  pushRawSignal: jest.fn(),
}));
jest.mock('../../../observability/utils/tripCorrId', () => ({
  getCurrentTripCorrIdSync: jest.fn(() => null),
}));
jest.mock('../../utils/reevalInstrumentation', () => ({
  recordCandidatesRecompute: jest.fn(),
  recordCandidateDistanceFire: jest.fn(),
  recordCandidateEnvFire: jest.fn(),
}));

import { renderHook } from '@testing-library/react-native';
import { useFusedNearestStation } from '../useFusedNearestStation';
import { useNearestStation } from '../useNearestStation';
import { useArrivalInfo } from '../../../arrival/hooks/useArrivalInfo';
import { useTrainPositions } from '../../../route/hooks/useTrainPositions';
import { findTopNearestStations } from '../../utils/findNearestStation';
import {
  recordCandidatesRecompute,
  recordCandidateDistanceFire,
  recordCandidateEnvFire,
} from '../../utils/reevalInstrumentation';
import { MOCK_STATIONS } from '../../../../testUtils/fixtures';

const mockUseNearest = useNearestStation as jest.Mock;
const mockUseArrival = useArrivalInfo as jest.Mock;
const mockUsePositions = useTrainPositions as jest.Mock;
const mockFindTop = findTopNearestStations as jest.Mock;
const mockRecordCandidatesRecompute = recordCandidatesRecompute as jest.Mock;
const mockRecordCandidateDistanceFire = recordCandidateDistanceFire as jest.Mock;
const mockRecordCandidateEnvFire = recordCandidateEnvFire as jest.Mock;

function gpsBase(userLocation = { lat: 37.5, lng: 127.0 }) {
  const live = { station: MOCK_STATIONS.gangnam, distanceKm: 0.1 };
  return {
    result: live,
    liveResult: live,
    stickyDisplayOnly: null,
    variants: [MOCK_STATIONS.gangnam],
    userLocation,
    speedMps: 2, // 이동 중 — stationaryBackoff 미적용, 매 렌더 실제 재계산 유도.
    accuracyMeters: 50,
    loading: false,
    error: null,
    permissionDenied: false,
    locationUncertain: false,
    refresh: jest.fn(),
  };
}

describe('useFusedNearestStation — 재평가 계측 인스턴스 태깅/cadence 대칭성 (#2594 PR #2639 리뷰 P1/P4/P5)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // #2594 P5 — 매 호출마다 새 배열 참조를 반환해야 candidates memo가 실제 "재계산"을
    // 했는지 여부가 참조 변화로 관측 가능하다(실제 findTopNearestStations도 매 호출 새 배열).
    mockFindTop.mockImplementation(() => [{ station: MOCK_STATIONS.gangnam, distanceKm: 0.1 }]);
    mockUseArrival.mockReturnValue({ arrival: null, loading: false, isMock: false });
    mockUsePositions.mockReturnValue({ positions: null, loading: false, isMock: false });
  });

  it('instrumentationRole 미전달(default) — candidatesRecompute/candidateDistance/candidateEnv 모두 기록', () => {
    mockUseNearest.mockReturnValue(gpsBase());
    renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        null,
        null,
        undefined,
        undefined,
        undefined,
        undefined,
        // instrumentationRole 생략 — 마지막 인자
      ),
    );

    expect(mockRecordCandidatesRecompute).toHaveBeenCalledTimes(1);
    expect(mockRecordCandidateDistanceFire).toHaveBeenCalledTimes(1);
    expect(mockRecordCandidateEnvFire).toHaveBeenCalledTimes(1);
  });

  it("instrumentationRole='primary' 명시 — 동일하게 기록", () => {
    mockUseNearest.mockReturnValue(gpsBase());
    renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        null,
        null,
        undefined,
        undefined,
        undefined,
        undefined,
        'primary',
      ),
    );

    expect(mockRecordCandidatesRecompute).toHaveBeenCalledTimes(1);
    expect(mockRecordCandidateDistanceFire).toHaveBeenCalledTimes(1);
    expect(mockRecordCandidateEnvFire).toHaveBeenCalledTimes(1);
  });

  it("instrumentationRole='observer' — 3개 record 모두 skip (useNearestStation에도 role이 그대로 전달됨)", () => {
    mockUseNearest.mockReturnValue(gpsBase());
    renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        null,
        null,
        undefined,
        undefined,
        undefined,
        undefined,
        'observer',
      ),
    );

    expect(mockRecordCandidatesRecompute).not.toHaveBeenCalled();
    expect(mockRecordCandidateDistanceFire).not.toHaveBeenCalled();
    expect(mockRecordCandidateEnvFire).not.toHaveBeenCalled();

    // useNearestStation이 받은 inputs에도 role이 'observer'로 그대로 흘러갔는지 확인
    // (GPS fix 계측 게이팅은 useNearestStation 내부에서 수행 — 별도 테스트 파일에서 검증).
    const inputsArg = mockUseNearest.mock.calls[0][0];
    expect(inputsArg.instrumentationRole).toBe('observer');
  });

  // #2594 P4 — candidate-env effect가 candidates.length===0에서도 기록해야 한다(구 코드는
  // early return으로 이 cadence 자체가 기록에서 빠졌음 — candidateDistanceFire와의 비대칭).
  it('candidates가 빈 배열(0건)이어도 candidateEnv는 reject=0으로 기록 (P4 대칭성)', () => {
    mockFindTop.mockImplementation(() => []);
    mockUseNearest.mockReturnValue(gpsBase());
    renderHook(() =>
      useFusedNearestStation(undefined, undefined, undefined, null, null, undefined),
    );

    expect(mockRecordCandidateEnvFire).toHaveBeenCalledWith(0, expect.any(Number));
  });

  // #2594 P5 — record가 useMemo 본문이 아니라 useEffect로 이전됐으므로, candidates 참조가
  // 실제로 바뀔 때만(=실제 재계산될 때만) 정확히 1회 기록돼야 한다. 동일 userLocation으로
  // rerender해도(참조 불변 — 아래는 매 mockFindTop 호출이 새 배열을 반환하므로 실제로는 매
  // 렌더 재계산되지만) rerender 2회 시 정확히 2회 누적되는지로 "정확한 1:1 대응"을 검증한다.
  it('실제 재계산 2회(userLocation 변경 2회) → 3개 record 각각 정확히 2회씩', () => {
    mockUseNearest.mockReturnValue(gpsBase());
    const { rerender } = renderHook(() =>
      useFusedNearestStation(undefined, undefined, undefined, null, null, undefined),
    );
    expect(mockRecordCandidatesRecompute).toHaveBeenCalledTimes(1);

    mockUseNearest.mockReturnValue(gpsBase({ lat: 37.50001, lng: 127.00001 }));
    rerender({});

    expect(mockRecordCandidatesRecompute).toHaveBeenCalledTimes(2);
    expect(mockRecordCandidateDistanceFire).toHaveBeenCalledTimes(2);
    expect(mockRecordCandidateEnvFire).toHaveBeenCalledTimes(2);
  });

  // #2594 P1 핵심 회귀 재현 — 'primary' + 'observer' 두 인스턴스를 동시에 마운트해도
  // record 호출 횟수가 'primary' 단독 마운트와 정확히 같아야 한다(이중 카운트 없음).
  it("동시 마운트('primary' + 'observer') — record 호출 횟수가 'primary' 단독과 동일", () => {
    mockUseNearest.mockReturnValue(gpsBase());
    renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        null,
        null,
        undefined,
        undefined,
        undefined,
        undefined,
        'primary',
      ),
    );
    renderHook(() =>
      useFusedNearestStation(
        undefined,
        undefined,
        undefined,
        null,
        null,
        undefined,
        undefined,
        undefined,
        undefined,
        'observer',
      ),
    );

    // 'observer' 인스턴스가 동시에 돌아도 'primary' 단독 마운트와 동일하게 1회씩만 기록.
    expect(mockRecordCandidatesRecompute).toHaveBeenCalledTimes(1);
    expect(mockRecordCandidateDistanceFire).toHaveBeenCalledTimes(1);
    expect(mockRecordCandidateEnvFire).toHaveBeenCalledTimes(1);
  });
});
