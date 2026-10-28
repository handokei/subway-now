/* eslint-disable import/no-restricted-paths -- cross-feature orchestration (#890) */

/**
 * #3191 PR-2D — fused 방향 필터 실측 replay (2026-10-28 06:26 trip 179 중곡 오승리).
 *
 * 입력은 전부 실측 원문이다(`replay_20261028_trip179_junggok.ts`): R2 7호선 position / 용마산 arrival
 * 원문을 production 파서(`fetchTrainPositions` / `fetchArrivalInfo`)에 그대로 통과시킨다.
 * 사용자 열차 7035(석남행, updn 1)는 용마산 sttus0, 반대 방향 7012(도봉산행, updn 0)는 중곡 sttus1.
 * 방향 필터 없이는 7012의 100점이 7035의 80점을 이겨 중곡이 현재역이 된다(덤프 W 06:26:49 enter 7-016).
 */
import { renderHook } from '@testing-library/react-native';
import { useFusedNearestStation, type FusedRouteContext } from '../useFusedNearestStation';
import { useNearestStation } from '../useNearestStation';
import { useArrivalInfo } from '../../../arrival/hooks/useArrivalInfo';
import { useTrainPositions } from '../../../route/hooks/useTrainPositions';
import { findTopNearestStations } from '../../utils/findNearestStation';
import { fetchTrainPositions } from '../../api/positionApi';
import { fetchArrivalInfo } from '../../../arrival/api/arrivalApi';
import { findRoutes, findStationByNameAndLine } from '../../../../shared/utils/stationRoute';
import { getCandidateRejectEntries, clearCandidateRejectEntries } from '../../utils/candidateRejectBuffer';
import { GPS_QUALITY_GATE_MAX_AGE_MS } from '../../../../shared/constants/gpsQualityGate';
import { arrivalRet, positionRet, GPS_BASE_DEFAULTS } from '../../../../testUtils/positionApiFixtures';
import {
  CYCLE_0626_46_POSITION_7_BODY,
  CYCLE_0626_46_ARRIVAL_YONGMASAN_BODY,
  CYCLE_0627_46_POSITION_7_BODY,
  CYCLE_0627_46_ARRIVAL_YONGMASAN_BODY,
} from '../../../../testUtils/fixtures/replay_20261028_trip179_junggok';
import type { LinePositions } from '../../../../shared/types/position';
import type { StationArrival } from '../../../../shared/types/arrival';

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
  // W 06:26:49 cell=NRNSA/surface-weak-nrnsa — vote!=='surface'라 lockless tier6(position-train)은 합의 미충족으로 abstain.
  useCellularTech: jest.fn(() => 'surface-weak-nrnsa'),
}));
jest.mock('../../../alarm/utils/tripStartStorage', () => ({
  getTripStartedAt: jest.fn().mockResolvedValue(null),
}));

const mockNearest = useNearestStation as jest.Mock;
const mockArrival = useArrivalInfo as jest.Mock;
const mockPos = useTrainPositions as jest.Mock;
const mockFindTop = findTopNearestStations as jest.Mock;

const yongmasan = findStationByNameAndLine('용마산', '7')!;
const junggok = findStationByNameAndLine('중곡', '7')!;
const ttukseom = findStationByNameAndLine('뚝섬', '2')!;

// 06:26:49 / 06:27:49 KST (R2 cycle 직후 덤프 W 시각).
const T_0626_49 = Date.parse('2026-10-28T06:26:49+09:00');
const T_0627_49 = Date.parse('2026-10-28T06:27:49+09:00');

// trip 179: 용마산(7) → 건대입구 → 뚝섬(2). production findRoutes 산출 그대로.
const [route179] = findRoutes(yongmasan.id, ttukseom.id);
const routeContext179: FusedRouteContext = {
  route: route179.route,
  origin: yongmasan,
  destination: ttukseom,
};

function rawFetch(body: string) {
  return jest.fn().mockResolvedValue({ ok: true, json: async () => JSON.parse(body) });
}

async function loadCycle(positionBody: string, arrivalBody: string, nowMs: number) {
  jest.setSystemTime(nowMs);
  const realFetch = global.fetch;
  global.fetch = rawFetch(positionBody) as unknown as typeof fetch;
  const positions = await fetchTrainPositions('7');
  global.fetch = rawFetch(arrivalBody) as unknown as typeof fetch;
  const arrival = await fetchArrivalInfo('용마산', { lineHint: '7' });
  global.fetch = realFetch;
  return { positions, arrival };
}

function setup(
  cycle: { positions: LinePositions; arrival: StationArrival },
  route: FusedRouteContext | undefined,
) {
  mockNearest.mockReturnValue({
    result: { station: yongmasan, distanceKm: 0.02 },
    variants: [yongmasan],
    userLocation: { lat: yongmasan.lat, lng: yongmasan.lng },
    ...GPS_BASE_DEFAULTS,
    accuracyMeters: 45,
    // W 06:26:49: fix=06:26:34 → age 15s = GPS_QUALITY_GATE_MAX_AGE_MS → stale(거리 게이트 열림)
    lastFixAtMs: Date.now() - GPS_QUALITY_GATE_MAX_AGE_MS,
    refresh: jest.fn(),
  });
  mockFindTop.mockReturnValue([
    { station: yongmasan, distanceKm: 0.02 },
    { station: junggok, distanceKm: 0.9 },
  ]);
  mockPos.mockReturnValue(positionRet(cycle.positions));
  mockArrival.mockImplementation((name: string | null) =>
    name === yongmasan.name ? arrivalRet(cycle.arrival) : arrivalRet(null),
  );
  return renderHook(() => useFusedNearestStation(undefined, undefined, route));
}

const ENV_KEY = 'EXPO_PUBLIC_SEOUL_DATA_API_KEY';
let prevKey: string | undefined;

beforeAll(() => {
  prevKey = process.env[ENV_KEY];
  process.env[ENV_KEY] = 'test-key';
});
afterAll(() => {
  if (prevKey === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = prevKey;
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  clearCandidateRejectEntries();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('#3191 PR-2D fused 방향 필터 — 10/28 06:26 중곡 오승리 replay', () => {
  it('⑦ trip 179(route 있음): 반대 방향 7012(중곡 100점)가 빠져 사용자 열차 7035의 용마산이 현재역', async () => {
    const cycle = await loadCycle(CYCLE_0626_46_POSITION_7_BODY, CYCLE_0626_46_ARRIVAL_YONGMASAN_BODY, T_0626_49);
    const { result } = setup(cycle, routeContext179);
    expect(result.current.result?.station.id).toBe(yongmasan.id);
    expect(result.current.source).toBe('position');
  });

  it("⑦ 06:27:49 cycle(7035 용마산 도착 / 7012 중곡 출발): 용마산 유지", async () => {
    const cycle = await loadCycle(CYCLE_0627_46_POSITION_7_BODY, CYCLE_0627_46_ARRIVAL_YONGMASAN_BODY, T_0627_49);
    const { result } = setup(cycle, routeContext179);
    expect(result.current.result?.station.id).toBe(yongmasan.id);
  });

  it("⑦' route 없음(trip 없음): 방향 정의 불가 — 필터 미적용(현행), 중곡 유지 + 반대 방향 관측 push 없음", async () => {
    const cycle = await loadCycle(CYCLE_0626_46_POSITION_7_BODY, CYCLE_0626_46_ARRIVAL_YONGMASAN_BODY, T_0626_49);
    const { result } = setup(cycle, undefined);
    expect(result.current.result?.station.id).toBe(junggok.id);
    const opposite = getCandidateRejectEntries().filter((e) => e.reason === 'candidate-opposite-direction');
    expect(opposite).toHaveLength(0);
  });

  it('⑪ 반대 방향 100점 position이 빠지면 후보·cycle당 position 1건(7012 → 중곡) push, arrival 1건(용마산 7012 전역진입)', async () => {
    const cycle = await loadCycle(CYCLE_0626_46_POSITION_7_BODY, CYCLE_0626_46_ARRIVAL_YONGMASAN_BODY, T_0626_49);
    setup(cycle, routeContext179);
    const opposite = getCandidateRejectEntries().filter((e) => e.reason === 'candidate-opposite-direction');
    const byKind = (signal: string) => opposite.filter((e) => e.signal === signal);
    expect(byKind('position')).toHaveLength(1);
    expect(byKind('position')[0]).toMatchObject({ stationName: '중곡', line: '7' });
    expect(byKind('arrival')).toHaveLength(1);
    expect(byKind('arrival')[0]).toMatchObject({ stationName: '용마산', line: '7' });
  });
});
