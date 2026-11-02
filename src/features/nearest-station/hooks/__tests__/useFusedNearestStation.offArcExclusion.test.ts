/* eslint-disable import/no-restricted-paths -- cross-feature orchestration (#890) */

/**
 * #3191 PR-1(A) - lock 없는 route trip에서 경로 arc 밖 후보 제외 (10/31 09:37~09:39 용마산->사가정 오전환 replay).
 *
 * 입력: `replay_20261031_lockless_offarc_hold.ts`(덤프 3DCCD Raw L611-627 원문, 불변). 사용자는 용마산(7-015)에 있었고
 * trip route는 용마산->논현(하행)이라 사가정(7-014)은 출발역보다 상류(arc 밖)다. Raw에는 비최근접 후보의 열차 신호가 없어
 * 사가정 arrival(arvlCd 도착)은 합성이다 - fix 나이/정확도/시각은 각 행 값 그대로.
 */
import { renderHook } from '@testing-library/react-native';
import { useFusedNearestStation, type FusedRouteContext } from '../useFusedNearestStation';
import { useNearestStation } from '../useNearestStation';
import { useArrivalInfo } from '../../../arrival/hooks/useArrivalInfo';
import { useTrainPositions } from '../../../route/hooks/useTrainPositions';
import { findTopNearestStations } from '../../utils/findNearestStation';
import { findRoutes, findStationByNameAndLine } from '../../../../shared/utils/stationRoute';
import { getCandidateRejectEntries, clearCandidateRejectEntries } from '../../utils/candidateRejectBuffer';
import { arrivalRet, positionRet, GPS_BASE_DEFAULTS } from '../../../../testUtils/positionApiFixtures';
import { Y31_ROWS } from '../../../../testUtils/fixtures/replay_20261031_lockless_offarc_hold';
import type { ArrivalInfo, StationArrival } from '../../../../shared/types/arrival';
import type { BoardingLock } from '../../../../shared/types/boardingLock';

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
  useCellularTech: jest.fn(() => 'surface-weak-nrnsa'),
}));
jest.mock('../../../alarm/utils/tripStartStorage', () => ({
  getTripStartedAt: jest.fn().mockResolvedValue(null),
}));

const mockNearest = useNearestStation as jest.Mock;
const mockArrival = useArrivalInfo as jest.Mock;
const mockPos = useTrainPositions as jest.Mock;
const mockFindTop = findTopNearestStations as jest.Mock;

const yongmasan = findStationByNameAndLine('용마산', '7')!; // 7-015 (출발역)
const sagajeong = findStationByNameAndLine('사가정', '7')!; // 7-014 (출발역 상류, arc 밖)
const junggok = findStationByNameAndLine('중곡', '7')!; // 7-016 (arc 위 다음 역)
const nonhyeon = findStationByNameAndLine('논현', '7')!;

const [route] = findRoutes(yongmasan.id, nonhyeon.id);
const routeContext: FusedRouteContext = { route: route.route, origin: yongmasan, destination: nonhyeon };

const NOW_ARRIVED: ArrivalInfo = {
  destination: '',
  arrivalSeconds: 10,
  stopsAway: null,
  statusMessage: '',
  trainCode: 'S1',
  line: '7',
  receivedAtMs: 0, // 테스트에서 now로 덮어쓴다
  arrivalCode: 1, // 도착
  isLastTrain: false,
  trainType: 'normal',
} as ArrivalInfo;

function arrivedDown(receivedAtMs: number): StationArrival {
  return { up: [], down: [{ ...NOW_ARRIVED, receivedAtMs }] };
}

interface DumpRow {
  raw: string;
  nowMs: number;
  fixMs: number;
  accM: number;
  stationId: string;
  event: string;
  source: string;
  fixAgeS: number;
}

function parseRow(raw: string): DumpRow {
  const cols = raw.split(' | ');
  const [time, event, stationId, sourceConf, gps] = cols;
  const kv = new Map(cols.slice(5).map((c) => c.split('=') as [string, string]));
  const kst = (t: string) => Date.parse(`2026-10-31T${t}+09:00`);
  const nowMs = kst(time);
  const fixMs = kst(kv.get('fix') as string);
  const accM = Number(/gps\((\d+)m/.exec(gps)![1]);
  return {
    raw,
    nowMs,
    fixMs,
    accM,
    stationId,
    event,
    source: sourceConf.split('/')[0],
    fixAgeS: (nowMs - fixMs) / 1000,
  };
}

const ROWS = Y31_ROWS.map(parseRow);
// 결함 cycle 행 1-5: lock 없음 primary, 결과가 사가정(7-014)이고 source=arrival (계획 §2.1)
const DEFECT_ROWS = ROWS.filter((r) => r.event === 'cycle' && r.stationId === '7-014' && r.source === 'arrival');

function setup(opts: {
  nowMs: number;
  fixMs: number;
  accM: number;
  route?: FusedRouteContext;
  arrivals: Record<string, StationArrival>;
  boardingLock?: BoardingLock | null;
}) {
  jest.setSystemTime(opts.nowMs);
  mockNearest.mockReturnValue({
    result: { station: yongmasan, distanceKm: 0.034 },
    variants: [yongmasan],
    userLocation: { lat: 37.57395, lng: 127.0868 },
    ...GPS_BASE_DEFAULTS,
    accuracyMeters: opts.accM,
    lastFixAtMs: opts.fixMs,
    refresh: jest.fn(),
  });
  mockFindTop.mockReturnValue([
    { station: yongmasan, distanceKm: 0.034 },
    { station: sagajeong, distanceKm: 0.786 },
    { station: junggok, distanceKm: 0.95 },
  ]);
  mockPos.mockReturnValue(positionRet(null));
  mockArrival.mockImplementation((name: string | null) =>
    name != null && opts.arrivals[name] ? arrivalRet(opts.arrivals[name]) : arrivalRet(null),
  );
  return renderHook(() =>
    useFusedNearestStation(
      undefined,
      undefined,
      opts.route,
      undefined,
      opts.boardingLock ?? undefined,
    ),
  );
}

const offArcRejects = () => getCandidateRejectEntries().filter((e) => e.reason === 'candidate-off-arc');

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  clearCandidateRejectEntries();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('#3191 PR-1(A) 경로 arc 밖 후보 제외 - 10/31 용마산->사가정 오전환 replay', () => {
  it('fixture 정합: 결함 cycle 행이 5개이고 각 행의 fix 나이는 15~121s, 정확도는 86~87m', () => {
    expect(DEFECT_ROWS).toHaveLength(5);
    for (const r of DEFECT_ROWS) {
      expect(r.fixAgeS).toBeGreaterThanOrEqual(15);
      expect(r.fixAgeS).toBeLessThanOrEqual(121);
      expect([86, 87]).toContain(r.accM);
    }
  });

  it.each(DEFECT_ROWS.map((r, i) => [`#${i + 1} ${r.raw.slice(0, 40)}`, r] as const))(
    '결함 행 %s: 사가정(arc 밖) 도착 신호가 있어도 fused는 사가정이 되지 않고 용마산(출발역) + candidate-off-arc 사유',
    (_label, row) => {
      const { result } = setup({
        nowMs: row.nowMs,
        fixMs: row.fixMs,
        accM: row.accM,
        route: routeContext,
        arrivals: { [sagajeong.name]: arrivedDown(row.nowMs) },
      });
      expect(result.current.result?.station.id).not.toBe(sagajeong.id);
      expect(result.current.result?.station.id).toBe(yongmasan.id);
      const rejects = offArcRejects();
      expect(rejects).toHaveLength(1);
      expect(rejects[0]).toMatchObject({ stationName: '사가정', line: '7', signal: 'arrival' });
    },
  );

  it('정당 전환: arc 위 다음 역(중곡)의 도착 신호는 같은 조건(묵은 fix)에서도 채택된다 + off-arc 사유 없음', () => {
    const row = DEFECT_ROWS[0];
    const { result } = setup({
      nowMs: row.nowMs,
      fixMs: row.fixMs,
      accM: row.accM,
      route: routeContext,
      arrivals: { [junggok.name]: arrivedDown(row.nowMs) },
    });
    expect(result.current.result?.station.id).toBe(junggok.id);
    expect(offArcRejects()).toHaveLength(0);
  });

  it('정당 전환: 출발역(용마산) 자체의 도착 신호는 arc 위라 유지된다', () => {
    const row = DEFECT_ROWS[0];
    const { result } = setup({
      nowMs: row.nowMs,
      fixMs: row.fixMs,
      accM: row.accM,
      route: routeContext,
      arrivals: { [yongmasan.name]: arrivedDown(row.nowMs) },
    });
    expect(result.current.result?.station.id).toBe(yongmasan.id);
    expect(offArcRejects()).toHaveLength(0);
  });

  it('거부(현행 보존): route 없음(arc 없음)이면 제외하지 않는다 - 사가정 도착 신호가 그대로 채택, off-arc 사유 없음', () => {
    const row = DEFECT_ROWS[0];
    const { result } = setup({
      nowMs: row.nowMs,
      fixMs: row.fixMs,
      accM: row.accM,
      route: undefined,
      arrivals: { [sagajeong.name]: arrivedDown(row.nowMs) },
    });
    expect(result.current.result?.station.id).toBe(sagajeong.id);
    expect(offArcRejects()).toHaveLength(0);
  });

  it('거부(현행 보존): lock이 있으면 A는 적용되지 않는다 - off-arc 사유가 적재되지 않는다', () => {
    const row = DEFECT_ROWS[0];
    const lock: BoardingLock = {
      destinationId: nonhyeon.id,
      trainCode: 'T1',
      boardingStationId: yongmasan.id,
      boardingLine: '7',
      boardedAt: row.nowMs - 60_000,
      expectedDurationMs: 30 * 60_000,
    };
    setup({
      nowMs: row.nowMs,
      fixMs: row.fixMs,
      accM: row.accM,
      route: routeContext,
      boardingLock: lock,
      arrivals: { [sagajeong.name]: arrivedDown(row.nowMs) },
    });
    expect(offArcRejects()).toHaveLength(0);
  });
});
