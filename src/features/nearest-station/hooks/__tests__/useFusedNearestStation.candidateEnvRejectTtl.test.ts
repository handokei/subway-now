/* eslint-disable import/no-restricted-paths -- cross-feature orchestration (#890) */

/**
 * #2619 (#2594 후속) — candidate-env reject TTL 회귀 가드.
 *
 * 배경: 데스크 실증(#2594) — 정지 상태에서 같은 후보(사가정, underground)가 cascade
 * environment=surface와 반복 불일치해 초당 14~21회 재평가/reject 루프에 재진입. 게이트 판정
 * 자체는 옳지만(surface cascade vs underground candidate) 반려된 후보가 즉시 재평가되는
 * 빈도가 발열 root. 같은 (station,line) 조합은 CANDIDATE_ENV_REJECT_TTL_MS(30s) 동안
 * 재평가 자체를 skip한다.
 *
 * 검증:
 *   1. 최초 렌더 — 환경 불일치 후보가 candidate-env reject 1건 적재.
 *   2. TTL 이내 재렌더(candidates 재계산) — 재평가 자체 skip, 추가 push 없음(1건 유지).
 *   3. TTL 만료 후 재렌더 — 정상적으로 다시 평가되어 reject 2건째 적재.
 */

import { renderHook } from '@testing-library/react-native';
import { useFusedNearestStation } from '../useFusedNearestStation';
import { useNearestStation } from '../useNearestStation';
import { useArrivalInfo } from '../../../arrival/hooks/useArrivalInfo';
import { useTrainPositions } from '../../../route/hooks/useTrainPositions';
import { findTopNearestStations } from '../../utils/findNearestStation';
import { findStationByNameAndLine } from '../../../../shared/utils/stationLookup';
import { arrivalRet, positionRet, GPS_BASE_DEFAULTS } from '../../../../testUtils/positionApiFixtures';
import {
  clearCandidateRejectEntries,
  getCandidateRejectEntries,
} from '../../utils/candidateRejectBuffer';
import { CANDIDATE_ENV_REJECT_TTL_MS } from '../../../../shared/constants/realtime';

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

// 사가정(7호선) — stations.json environment='underground' (실증 evidence 실제 후보).
const sagajeong7 = findStationByNameAndLine('사가정', '7')!;

const T0 = 1_700_000_000_000;

describe('#2619 (#2594 후속) candidate-env reject TTL', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    clearCandidateRejectEntries();

    // GPS는 정지 상태(용마산 지상 evidence 시뮬레이션) — barometer.subsurface=false +
    // 양호한 accuracy(GPS_BASE_DEFAULTS.accuracyMeters=50 ≤ threshold)로 cascade
    // environment='surface' 확정(inferEnvironment 우선순위 4a).
    // #2619 — mockImplementation(매 호출마다 새 userLocation 객체)으로 candidates useMemo가
    // 매 rerender마다 재계산되도록 강제 — TTL skip/재평가 분기를 실제로 exercise하기 위함.
    // (mockReturnValue였다면 참조가 고정돼 useMemo가 재계산되지 않아 effect 자체가 재실행되지 않는다.)
    mockNearest.mockImplementation(() => ({
      result: null,
      liveResult: null,
      stickyDisplayOnly: null,
      variants: [],
      userLocation: { lat: 37.5, lng: 127.0 },
      ...GPS_BASE_DEFAULTS,
      lastFixAtMs: T0,
      refresh: jest.fn(),
    }));
    // 매 render마다 사가정 1개 후보 재생성 — surface cascade와 반복 불일치.
    mockFindTop.mockImplementation(() => [{ station: sagajeong7, distanceKm: 0.3 }]);
    mockArrival.mockReturnValue(arrivalRet(null));
    mockPos.mockReturnValue(positionRet(null));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('TTL 이내 재렌더는 재평가 skip, TTL 만료 후 재렌더는 정상 재평가', () => {
    const { rerender } = renderHook(() =>
      useFusedNearestStation(undefined, undefined, undefined, undefined, undefined, undefined, {
        subsurface: false,
      }),
    );

    const afterFirst = getCandidateRejectEntries().filter((r) => r.reason === 'candidate-env');
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].stationName).toBe(sagajeong7.name);
    expect(afterFirst[0].line).toBe(sagajeong7.line);

    // TTL(30s) 이내 + 기존 candidateRejectBuffer 집계 윈도우(10s)는 지난 시점(15s) — 집계
    // 윈도우만 있었다면 새 entry가 push됐겠지만(집계 윈도우 만료), TTL 캐시가 재평가 자체를
    // skip해 push가 추가되지 않아야 한다(#2619 fix가 실제로 억제하는지 구분되는 지점).
    jest.setSystemTime(T0 + 15_000);
    rerender(undefined);
    const afterSecond = getCandidateRejectEntries().filter((r) => r.reason === 'candidate-env');
    expect(afterSecond).toHaveLength(1);

    // TTL 만료 후 재렌더 — 정상적으로 다시 평가되어 2건째 적재.
    jest.setSystemTime(T0 + CANDIDATE_ENV_REJECT_TTL_MS + 1);
    rerender(undefined);
    const afterThird = getCandidateRejectEntries().filter((r) => r.reason === 'candidate-env');
    expect(afterThird).toHaveLength(2);
  });
});
