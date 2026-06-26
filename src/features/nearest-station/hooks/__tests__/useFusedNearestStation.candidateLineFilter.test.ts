/* eslint-disable import/no-restricted-paths -- cross-feature orchestration (#890) */

/**
 * #1902 (RC-18) — candidate-generator line filter 회귀 가드.
 *
 * 배경: T4 trip evidence — 사용자 trip line=2인데 5/6/7호선 + 공항철도 + 경의중앙선 후보가
 *   enumerate 단계에서 무차별 reject. reject 카운트 trip 길이 비례 폭증(T1 14건 → T4 66건),
 *   fusionDebugBuffer 200 cap 점령 자기 파괴 회귀.
 *
 * 검증:
 *   1. routeContext 없으면 line filter 우회 — 자유 화면 동작 보존 (기존 fusion 흐름).
 *   2. routeContext direct (line=2) — line 7 후보가 enumerate 차단되고 candidateRejectBuffer/alarmLog 적재.
 *   3. routeContext transfer (line=2 → line=7) — 양 line 모두 허용 (환승역 cross-line 자연 통과).
 *   4. line 2 후보는 그대로 통과 (정상 trip 영향 0).
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
import {
  getFusionDebugEntries,
  clearFusionDebugEntries,
} from '../../utils/fusionDebugBuffer';
import type { LinePositions } from '../../api/positionApi';
import type { FusedRouteContext } from '../useFusedNearestStation';
import type { DirectRoute, TransferRoute } from '../../../../shared/utils/stationRoute';

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
  readBackendSsotMirror: jest.fn().mockResolvedValue(null),
}));

const mockNearest = useNearestStation as jest.Mock;
const mockArrival = useArrivalInfo as jest.Mock;
const mockPos = useTrainPositions as jest.Mock;
const mockFindTop = findTopNearestStations as jest.Mock;

const gangnam2 = findStationByNameAndLine('강남', '2')!;
const yongmasan7 = findStationByNameAndLine('용마산', '7')!;
const junggok7 = findStationByNameAndLine('중곡', '7')!;
const gunja7 = findStationByNameAndLine('군자', '7')!;

const T0 = 1_700_000_000_000;

function setupGpsAt(stationLat: number, stationLng: number) {
  mockNearest.mockReturnValue({
    result: null,
    liveResult: null,
    stickyDisplayOnly: null,
    variants: [],
    userLocation: { lat: stationLat, lng: stationLng },
    ...GPS_BASE_DEFAULTS,
    lastFixAtMs: T0,
    refresh: jest.fn(),
  });
  mockFindTop.mockReturnValue([]);
  mockArrival.mockReturnValue(arrivalRet(null));
}

/** line 7 positions response (사용자 trip route에 line 7이 포함되지 않은 케이스 검증용). */
function line7Positions(): LinePositions {
  return {
    line: '7',
    trains: [
      makeTrain('용마산', TRAIN_STATUS.DEPARTED, {
        trainNo: 'T-7-1',
        receivedAtMs: T0,
      }),
    ],
  };
}

/** line 2 positions response. */
function line2Positions(): LinePositions {
  return {
    line: '2',
    trains: [
      makeTrain('강남', TRAIN_STATUS.DEPARTED, {
        trainNo: 'T-2-1',
        receivedAtMs: T0,
      }),
    ],
  };
}

describe('#1902 candidate-generator line filter (RC-18)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    clearCandidateRejectEntries();
    clearFusionDebugEntries();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('routeContext 없으면 line filter 우회 — 자유 화면 fusion 보존', () => {
    setupGpsAt(yongmasan7.lat, yongmasan7.lng);
    mockPos.mockImplementation((line: string | null) => {
      if (line === '7') return positionRet(line7Positions());
      return positionRet(null);
    });

    // routeContext 미전달 — allowedLines = undefined → filter 자연 우회.
    renderHook(() => useFusedNearestStation());

    // candidateRejectBuffer에 line filter reject entry 없음.
    const rejects = getCandidateRejectEntries();
    const lineRejects = rejects.filter((r) => r.reason === 'candidate-line');
    expect(lineRejects).toHaveLength(0);
  });

  it('routeContext direct line=2: line 7 후보가 enumerate 단계에서 차단되고 reject buffer 적재', () => {
    // GPS는 line 7 station(용마산) 근처지만 trip route는 direct line 2.
    // 사용자 trip route 변경 후 stale lp.line=7 자료가 useTrainPositions에 남는 race 시뮬레이션.
    // `useTrainPositions` mock을 line 입력 무관 항상 line 7 lp 반환 → lps에 line=7 entry 진입.
    setupGpsAt(yongmasan7.lat, yongmasan7.lng);
    mockPos.mockImplementation(() => positionRet(line7Positions()));

    const route: DirectRoute = {
      type: 'direct',
      stops: 5,
      line: '2',
      travelSeconds: 600,
    };
    const ctx: FusedRouteContext = {
      route,
      origin: gangnam2,
      destination: gangnam2,
    };
    renderHook(() => useFusedNearestStation(undefined, undefined, ctx));

    const rejects = getCandidateRejectEntries();
    const lineRejects = rejects.filter((r) => r.reason === 'candidate-line');
    // line 7 후보가 차단됐어야 함 (≥1건).
    expect(lineRejects.length).toBeGreaterThanOrEqual(1);
    expect(lineRejects[0].line).toBe('7');
    // fusionDebugBuffer는 candidate-reject 적재 X (별 buffer로 이전).
    const fusionEntries = getFusionDebugEntries();
    const fusionRejects = fusionEntries.filter(
      (e: { kind: string }) => e.kind === 'candidate-reject',
    );
    expect(fusionRejects).toHaveLength(0);
  });

  it('routeContext transfer line=2→7: 양 line 후보 모두 enumerate 허용 (환승역 cross-line)', () => {
    setupGpsAt(gunja7.lat, gunja7.lng);
    mockPos.mockImplementation((line: string | null) => {
      if (line === '7') return positionRet(line7Positions());
      if (line === '2') return positionRet(line2Positions());
      return positionRet(null);
    });

    const route: TransferRoute = {
      type: 'transfer',
      transferName: '강변',
      fromLine: '2',
      toLine: '7',
      stopsToTransfer: 3,
      stopsFromTransfer: 4,
      secondsToTransfer: 300,
      secondsFromTransfer: 400,
    };
    const ctx: FusedRouteContext = {
      route,
      origin: gangnam2,
      destination: junggok7,
    };
    renderHook(() => useFusedNearestStation(undefined, undefined, ctx));

    const rejects = getCandidateRejectEntries();
    const lineRejects = rejects.filter((r) => r.reason === 'candidate-line');
    // line 2와 line 7 둘 다 allowedLines에 포함 → enumerate 차단 0건.
    expect(lineRejects).toHaveLength(0);
  });

  it('routeContext direct line=2: line 2 후보는 그대로 통과 (정상 trip 영향 0)', () => {
    setupGpsAt(gangnam2.lat, gangnam2.lng);
    mockPos.mockImplementation((line: string | null) => {
      if (line === '2') return positionRet(line2Positions());
      return positionRet(null);
    });

    const route: DirectRoute = {
      type: 'direct',
      stops: 5,
      line: '2',
      travelSeconds: 600,
    };
    const ctx: FusedRouteContext = {
      route,
      origin: gangnam2,
      destination: gangnam2,
    };
    renderHook(() => useFusedNearestStation(undefined, undefined, ctx));

    const rejects = getCandidateRejectEntries();
    const lineRejects = rejects.filter((r) => r.reason === 'candidate-line');
    // line 2는 allowed에 포함 → reject 없음.
    expect(lineRejects).toHaveLength(0);
  });
});
