/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: useFusedNearestStation orchestrator 테스트라 직접 import가 본질적.
 */
/**
 * #3191 PR-F - 정지 fix 직후 도달 불가 이웃역(D-hop) 실측 replay. 이 파일의 "대조" 블록은 dev(수정 전)에서 green이고
 * 수정(PR-D) 후에도 green이어야 한다 - D-hop 조건 밖인 행은 동작이 바뀌지 않는다는 것을 실측 행으로 고정한다.
 *
 * 입력: `replay_20261103_unreachable_neighbor.ts`(덤프 원문, 불변). Raw Signal 행에는 열차 위치/도착 원문이 없으므로
 * (fusionReplayDriver.ts 주석) 이웃역 열차 신호는 행의 `source/confidence`로 합성한다 - 실측인 것은 fix 시각 /
 * 정확도 / 속도 / 좌표 / 기압계 가용 여부(holdBlk)다. 후보(candidates)는 행 `pos`로 실제 findTopNearestStations를 돌려 얻는다.
 *
 * 합성 규칙(행 source/confidence -> 신호): position+confirmed = ARRIVED(1), position+arriving = ENTERING(0),
 * arrival+confirmed = arvlCd 1, arrival+arriving = arvlCd 0. 그 외 source(gps/route-progress/boarding-lock)는 신호 없음.
 */
jest.mock('../useNearestStation');
jest.mock('../../../arrival/hooks/useArrivalInfo');
jest.mock('../../../route/hooks/useTrainPositions');
jest.mock('../../utils/findNearestStation', () => ({
  findTopNearestStations: jest.fn(),
}));
jest.mock('../../../observability/utils/rawSignalBuffer', () => ({
  pushRawSignal: jest.fn(),
}));
jest.mock('../../../observability/utils/tripCorrId', () => ({
  getCurrentTripCorrIdSync: jest.fn(() => null),
}));
jest.mock('../useAccelerometerFingerprint', () => ({
  useAccelerometerFingerprint: jest.fn(() => 'unknown'),
}));
jest.mock('../useCellularTech', () => ({
  useCellularTech: jest.fn(() => 'unknown'),
}));
jest.mock('../../../alarm/utils/tripStartStorage', () => ({
  getTripStartedAt: jest.fn().mockResolvedValue(null),
}));

import { renderHook } from '@testing-library/react-native';
import { useFusedNearestStation, type FusedRouteContext } from '../useFusedNearestStation';
import { computeRouteArc } from '../../../route/utils/routeProgress';
import { legDirectionByLine } from '../../../route/utils/tripDirection';
import { useNearestStation } from '../useNearestStation';
import { useArrivalInfo } from '../../../arrival/hooks/useArrivalInfo';
import { useTrainPositions } from '../../../route/hooks/useTrainPositions';
import { useAccelerometerFingerprint } from '../useAccelerometerFingerprint';
import { useCellularTech } from '../useCellularTech';
import { findTopNearestStations } from '../../utils/findNearestStation';
import { STATIC_SPEED_THRESHOLD_MPS } from '../../utils/movementGate';
import { findRoutes, findStationByNameAndLine, getStationById } from '../../../../shared/utils/stationRoute';
import { TRAIN_STATUS } from '../../../../shared/constants/trainStatus';
import { clearCandidateRejectEntries, getCandidateRejectEntries } from '../../utils/candidateRejectBuffer';
import {
  appendBarometerReading,
  resetBarometerInstrumentationForTest,
  resetBarometerState,
} from '../../../../shared/utils/barometerState';
import { canonicalStationName } from '../../../../testUtils/canonicalStationName';
import { arrivalRet, positionRet, makeTrain } from '../../../../testUtils/positionApiFixtures';
import { parseRawRow } from '../../../../testUtils/fixtures/replay_20261021_sagajeong_hold';
import {
  L797_OCT30,
  R0_NOV03,
  R10_NOV02,
  R11_NOV02,
  R12_NOV03,
  R789_OCT30,
  W_OCT30,
  type UnreachableDumpFixture,
} from '../../../../testUtils/fixtures/replay_20261103_unreachable_neighbor';
import type { ArrivalInfo } from '../../../../shared/types/arrival';
import type { BoardingLock } from '../../../../shared/types/boardingLock';
import type { Station } from '../../../../shared/types/station';

const mockNearest = useNearestStation as jest.Mock;
const mockArrival = useArrivalInfo as jest.Mock;
const mockPos = useTrainPositions as jest.Mock;
const mockFindTop = findTopNearestStations as jest.Mock;
const mockAccel = useAccelerometerFingerprint as jest.Mock;
const mockCell = useCellularTech as jest.Mock;

const actualFindTop = (jest.requireActual('../../utils/findNearestStation') as {
  findTopNearestStations: typeof findTopNearestStations;
}).findTopNearestStations;

/** 행 `source/confidence`에서 합성하는 열차 신호. */
interface SyntheticSignal {
  station: Station;
  kind: 'arrival' | 'position';
  /** arrival: arvlCd, position: trainSttus. */
  code: number;
}

interface DumpRow {
  raw: string;
  event: string;
  stationId: string;
  source: string;
  confidence: string;
  speedMps: number | null;
  lat: number;
  lng: number;
  holdBlk: string;
  /** 덤프 모션 컬럼(가속도계 fingerprint 라벨). */
  accel: string;
  /** 덤프 `cell=<tech>/<vote>`의 vote. */
  cellVote: string;
  baroEvtMs: number | null;
  nowMs: number;
  fixMs: number;
  accM: number;
  hpa: number;
  fixAgeS: number;
}

function parseRow(raw: string, kstDate: string): DumpRow {
  const base = parseRawRow(raw, kstDate);
  const cols = raw.split(' | ').map((c) => c.trim());
  const [, event, stationId, sourceConf, gps] = cols;
  const kv = new Map(cols.slice(5).map((c) => c.split('=') as [string, string]));
  const [source, confidence] = sourceConf.split('/');
  const speed = /\/(\d+(?:\.\d+)?)m\/s\)/.exec(gps);
  const [lat, lng] = (kv.get('pos') as string).split(',').map(Number);
  return {
    raw,
    event,
    stationId,
    source,
    confidence,
    speedMps: speed ? Number(speed[1]) : null,
    lat,
    lng,
    holdBlk: kv.get('holdBlk') as string,
    accel: cols[5],
    cellVote: (kv.get('cell') as string).split('/')[1],
    baroEvtMs: base.baroEventAtMs,
    nowMs: base.nowMs,
    fixMs: base.fixAtMs,
    accM: base.accuracyMeters,
    hpa: base.hpa,
    fixAgeS: (base.nowMs - base.fixAtMs) / 1000,
  };
}

const cycleRows = (f: UnreachableDumpFixture) =>
  f.rows.map((r) => parseRow(r, f.kstDate)).filter((r) => r.event === 'cycle');

/** 행 source/confidence -> 합성 신호 (대상 역 = 행이 표시한 역). */
function signalOf(row: DumpRow): SyntheticSignal | null {
  if (row.source !== 'arrival' && row.source !== 'position') return null;
  const confirmed = row.confidence === 'arrival-confirmed';
  const station = getStationById(row.stationId) as Station;
  if (row.source === 'arrival') return { station, kind: 'arrival', code: confirmed ? 1 : 0 };
  return { station, kind: 'position', code: confirmed ? TRAIN_STATUS.ARRIVED : TRAIN_STATUS.ENTERING };
}

function seedBarometer(row: DumpRow) {
  // holdBlk=baro-unavailable 행은 기압계가 못 보던 상태라 reading을 심지 않는다(= 관측 불가, 워밍업 전).
  if (row.holdBlk === 'baro-unavailable') return;
  appendBarometerReading({ t: row.nowMs - 600_000, pressureHpa: row.hpa });
  const evt = row.holdBlk === 'baro-event' ? row.baroEvtMs : null;
  if (evt !== null) {
    appendBarometerReading({ t: evt - 5_000, pressureHpa: row.hpa - 0.5 });
    appendBarometerReading({ t: evt, pressureHpa: row.hpa });
  }
  const lastAt = row.nowMs - 1_000;
  if (evt === null || lastAt > evt) appendBarometerReading({ t: lastAt, pressureHpa: row.hpa });
}

interface RunOpts {
  /** 행이 표시한 역 대신 쓸 합성 신호(null=신호 없음). */
  signal?: SyntheticSignal | null;
  boardingLock?: BoardingLock | null;
  /** 덤프에서 trip(route-progress / lock)이 활성이던 행 - 출발/도착 역 id. 없으면 route 없음(trip 없음). */
  route?: { originId: string; destinationId: string };
  /** 행 값 대신 쓸 fix 나이(초) - 경계 합성 테스트용. */
  fixAgeS?: number;
  accM?: number;
  speedMps?: number | null;
  /** 행 `pos` 대신 쓸 좌표 - 신선 fix였다면 거리 게이트를 통과했을 위치 합성용. */
  position?: { lat: number; lng: number };
}

/** trip route -> FusedRouteContext (route 없음이면 undefined). */
function routeContextOf(route: RunOpts['route']): FusedRouteContext | undefined {
  if (!route) return undefined;
  const origin = getStationById(route.originId) as Station;
  const destination = getStationById(route.destinationId) as Station;
  const [first] = findRoutes(origin.id, destination.id);
  return { route: first.route, origin, destination };
}

/** position `updnLine`: route leg 진행 방향(up=0, down=1). route 없으면 0 (방향 필터 미적용이라 무관). */
function updnLineOf(routeCtx: FusedRouteContext | undefined, line: Station['line']): number {
  if (!routeCtx) return 0;
  const arc = computeRouteArc(routeCtx.route, routeCtx.origin as Station, routeCtx.destination as Station);
  return legDirectionByLine((arc as { stations: Station[] }).stations).get(line) === 'down' ? 1 : 0;
}

function run(row: DumpRow, opts: RunOpts = {}) {
  // 행마다 독립 시나리오 - 직전 행의 기압/관측 상태가 새어 들어오지 않게 초기화한다.
  resetBarometerState();
  resetBarometerInstrumentationForTest();
  clearCandidateRejectEntries();
  jest.setSystemTime(row.nowMs);
  seedBarometer(row);
  mockAccel.mockReturnValue(row.accel);
  mockCell.mockReturnValue(row.cellVote);
  const signal = opts.signal === undefined ? signalOf(row) : opts.signal;
  const fixMs = opts.fixAgeS === undefined ? row.fixMs : row.nowMs - opts.fixAgeS * 1000;

  const { lat, lng } = opts.position ?? { lat: row.lat, lng: row.lng };
  const top = actualFindTop(lat, lng, 5, 1.0);
  mockFindTop.mockImplementation(actualFindTop);
  const speedMps = opts.speedMps === undefined ? row.speedMps : opts.speedMps;
  const nearestWith = (speed: number | null) => ({
    result: top[0],
    liveResult: top[0],
    stickyDisplayOnly: null,
    variants: [top[0].station],
    userLocation: { lat, lng },
    speedMps: speed,
    accuracyMeters: opts.accM ?? row.accM,
    loading: false,
    error: null,
    permissionDenied: false,
    locationUncertain: false,
    gpsActive: 'bg' as const,
    lastFixAtMs: fixMs,
    lastFixFromBg: false,
    isWatchActive: () => false,
    refresh: jest.fn(),
  });
  // 정지(speed<0.5) ∧ trip/lock 없음이면 hook은 후보 재계산을 멈추고(stationaryBackoff) 직전 후보를 재사용한다.
  // 실측 정지 행 직전에는 이동 중 fix로 후보가 채워져 있었으므로, 같은 좌표의 이동 render 1회로 후보를 먼저 채운다.
  const routeCtx = routeContextOf(opts.route);
  const stationaryRow = !routeCtx && speedMps !== null && speedMps < STATIC_SPEED_THRESHOLD_MPS;
  mockNearest.mockReturnValue(nearestWith(stationaryRow ? STATIC_SPEED_THRESHOLD_MPS : speedMps));
  mockArrival.mockImplementation((name: string | null, line: string | null) => {
    if (signal?.kind !== 'arrival' || name !== signal.station.name || line !== signal.station.line) {
      return arrivalRet(null);
    }
    const info = {
      destination: '',
      arrivalSeconds: 10,
      stopsAway: null,
      statusMessage: '',
      trainCode: 'S1',
      line: signal.station.line,
      receivedAtMs: row.nowMs,
      arrivalCode: signal.code,
      isLastTrain: false,
      trainType: 'normal',
    } as ArrivalInfo;
    return arrivalRet({ up: [info], down: [info] });
  });
  mockPos.mockImplementation((line: string | null) =>
    signal?.kind === 'position' && line === signal.station.line
      ? positionRet({
          line: signal.station.line,
          trains: [
            makeTrain(signal.station.name, signal.code, {
              trainNo: '9001',
              receivedAtMs: row.nowMs,
              updnLine: updnLineOf(routeCtx, signal.station.line),
            }),
          ],
        })
      : positionRet(null),
  );
  const hook = renderHook(() =>
    useFusedNearestStation(undefined, undefined, routeCtx, undefined, opts.boardingLock ?? undefined, undefined, {
      subsurface: false,
      signal: { subsurface: false, stop: undefined, unavailableReason: 'readings' },
    }),
  );
  if (stationaryRow) {
    mockNearest.mockReturnValue(nearestWith(speedMps));
    hook.rerender({});
  }
  const { result, source, confidence } = hook.result.current;
  hook.unmount();
  return {
    stationId: result?.station.id,
    source,
    confidence,
    rejects: getCandidateRejectEntries(),
    rejectReasons: getCandidateRejectEntries().map((e) => e.reason as string),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  resetBarometerState();
  resetBarometerInstrumentationForTest();
  clearCandidateRejectEntries();
  mockArrival.mockReturnValue(arrivalRet(null));
  mockPos.mockReturnValue(positionRet(null));
});

afterEach(() => {
  jest.useRealTimers();
});

/** R11/R12/L797/lock 행 - 뚝섬(2-010)에서 건대입구(2호선) 방향으로 trip 활성 (route-progress / boarding-lock 행 존재). */
const ROUTE_2_SEONGSU = {
  originId: '2-010',
  destinationId: (findStationByNameAndLine('건대입구', '2') as Station).id,
};
/** R12 - 18:56:11 이후 행은 건대입구에서 7호선으로 환승한 구간(7-019)이라 환승 trip. */
const ROUTE_2_THEN_7 = {
  originId: '2-010',
  destinationId: (findStationByNameAndLine('논현', '7') as Station).id,
};

/** W 행 - 어린이대공원(7-018)에서 논현 방향 trip 활성 (7-018이 arc 위라 off-arc 제외(#3191 PR-1)로는 안 걸린다). */
const ROUTE_7_WAYPOINT = {
  originId: '7-018',
  destinationId: (findStationByNameAndLine('논현', '7') as Station).id,
};

describe('#3191 PR-F 대조 - D-hop 조건 밖 실측 행은 동작이 바뀌지 않는다 (dev에서 green, PR-D 후에도 green)', () => {
  it('R0 (11/03 20:08, 신선 fix 용마산): 사가정 도착 신호(합성)가 있어도 거리 게이트(delta)가 거부해 용마산 유지', () => {
    const rows = cycleRows(R0_NOV03);
    expect(rows).toHaveLength(6);
    const sagajeong = getStationById('7-014') as Station;
    for (const row of rows) {
      expect(row.fixAgeS).toBeLessThan(15);
      const { stationId, rejectReasons } = run(row, { signal: { station: sagajeong, kind: 'arrival', code: 1 } });
      expect(stationId).toBe('7-015');
      expect(rejectReasons).not.toContain('candidate-unreachable');
    }
  });

  it('R12 (11/03 18:46~18:56, 실제 탑승 이동 speed 0.6): 성수 표시 유지 - 전 cycle (D는 speed 조건으로 비활성)', () => {
    const rows = cycleRows(R12_NOV03);
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const row of rows) {
      const { stationId, rejectReasons } = run(row, { route: ROUTE_2_THEN_7 });
      expect(stationId).toBe(row.stationId);
      expect(rejectReasons).not.toContain('candidate-unreachable');
    }
  });

  it('R7-R9 (10/30 집 사가정 표시, trip 없음 BG): fix 나이가 hop보다 길어 현행(사가정 표시) 유지', () => {
    const rows = cycleRows(R789_OCT30);
    expect(rows.length).toBeGreaterThanOrEqual(6);
    for (const row of rows) {
      const { stationId, rejectReasons } = run(row);
      expect(stationId).toBe(row.stationId);
      expect(rejectReasons).not.toContain('candidate-unreachable');
    }
  });

  it('R10 (11/02 06:27, 보행 speed 1.5 + 신선 fix 복귀): 현행 유지', () => {
    const rows = cycleRows(R10_NOV02);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      const { stationId, rejectReasons } = run(row);
      expect(stationId).toBe(row.stationId);
      expect(rejectReasons).not.toContain('candidate-unreachable');
    }
  });

  it('L797 계열 (10/30 17:13, acc 189): 성수 표시 유지 - D는 acc<=30 조건으로 비활성', () => {
    const rows = cycleRows(L797_OCT30);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      expect(row.accM).toBe(189);
      const { stationId, rejectReasons } = run(row, { route: ROUTE_2_SEONGSU });
      expect(stationId).toBe(row.stationId);
      expect(rejectReasons).not.toContain('candidate-unreachable');
    }
  });

  it('W 정상 행 (10/30 17:24, 결함 행 17:24:06 제외): 건대입구(7-019) 표시 유지 - 결함 행 자체는 PR-D red 테스트가 다룬다', () => {
    const rows = cycleRows(W_OCT30).filter((r) => r.stationId !== '7-018');
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      const { stationId, rejectReasons } = run(row, { route: ROUTE_7_WAYPOINT });
      expect(stationId).toBe('7-019');
      expect(rejectReasons).not.toContain('candidate-unreachable');
    }
  });

  it('lock 행 (R11 L627, 11/02 19:45:02 boarding-lock 2-010): lock이 있으면 이웃 신호가 있어도 2-010 유지', () => {
    const row = cycleRows(R11_NOV02).find((r) => r.source === 'boarding-lock') as DumpRow;
    const lock: BoardingLock = {
      destinationId: ROUTE_2_SEONGSU.destinationId,
      trainCode: '9001',
      boardingStationId: '2-010',
      boardingLine: '2',
      boardedAt: row.nowMs - 5_000,
      expectedDurationMs: 30 * 60_000,
    };
    const seongsu = getStationById('2-011') as Station;
    const { stationId, rejectReasons } = run(row, {
      boardingLock: lock,
      route: ROUTE_2_SEONGSU,
      signal: { station: seongsu, kind: 'position', code: TRAIN_STATUS.ARRIVED },
    });
    expect(stationId).toBe('2-010');
    expect(rejectReasons).not.toContain('candidate-unreachable');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// PR-D (D-hop) - 정지 fix 직후 도달 불가 이웃역 제외. 아래 테스트는 수정 전에 red다.
// ---------------------------------------------------------------------------------------------------------------------
const R11_ROW = cycleRows(R11_NOV02).find((r) => r.raw.startsWith('19:44:34')) as DumpRow; // AB2FB L633
const W_ROW = cycleRows(W_OCT30).find((r) => r.raw.startsWith('17:24:06')) as DumpRow; // B8D812 L762

const seongsu = getStationById('2-011') as Station;
const ttukseom = getStationById('2-010') as Station;
const eorinidaegongwon = getStationById('7-018') as Station;

/** 비최근접 후보(이웃역) 신호의 가능한 값 범위 - 계획 §5.2 (arrivalCodes.ts / trainStatus.ts). */
const NEIGHBOR_SIGNAL_VALUES: ReadonlyArray<readonly ['arrival' | 'position', number]> = [
  ...[0, 1, 4, 5].map((code) => ['arrival', code] as const),
  ...[0, 1].map((code) => ['position', code] as const),
];

const unreachableRejects = (rejects: ReturnType<typeof run>['rejects']) =>
  rejects.filter((e) => (e.reason as string) === 'candidate-unreachable');

describe('#3191 PR-D 도달 불가 이웃역 제외 (D-hop) - 실측 결함 행', () => {
  it('R11 (11/02 19:44:34, AB2FB L633/L634): 뚝섬 정지 fix 16s 후 성수 도착 신호 -> 뚝섬 유지 + candidate-unreachable{성수}', () => {
    expect(R11_ROW.fixAgeS).toBe(16);
    const { stationId, rejects } = run(R11_ROW, { route: ROUTE_2_SEONGSU });
    expect(stationId).toBe('2-010');
    const dropped = unreachableRejects(rejects);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({
      stationName: canonicalStationName('성수', '2'),
      line: '2',
      signal: 'position',
    });
  });

  it('W (10/30 17:24:06, B8D812 L762/L763): 건대입구 정지 fix 15s 후 어린이대공원 신호 -> 건대입구(7-019) 유지 + candidate-unreachable{어린이대공원}', () => {
    expect(W_ROW.fixAgeS).toBe(15);
    const { stationId, rejects } = run(W_ROW, { route: ROUTE_7_WAYPOINT });
    expect(stationId).toBe('7-019');
    const dropped = unreachableRejects(rejects);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({
      stationName: canonicalStationName('어린이대공원', '7'),
      line: '7',
      signal: 'arrival',
    });
  });

  describe.each([
    ['R11 (뚝섬 -> 성수, hop 60s)', R11_ROW, ROUTE_2_SEONGSU, seongsu, '2-010'],
    ['W (건대입구 -> 어린이대공원, hop 80s)', W_ROW, ROUTE_7_WAYPOINT, eorinidaegongwon, '7-019'],
  ] as const)('%s - 이웃 신호 값 범위 전체', (_name, row, route, neighbor, anchorId) => {
    it.each(NEIGHBOR_SIGNAL_VALUES)('%s 신호 코드 %i: 점수와 무관하게 앵커 유지 + 사유 적재', (kind, code) => {
      const { stationId, rejects } = run(row, { route, signal: { station: neighbor, kind, code } });
      expect(stationId).toBe(anchorId);
      expect(unreachableRejects(rejects)).toHaveLength(1);
    });
  });
});

describe('#3191 PR-D 경계 (합성, 입력은 R11 행 값에서 한 항목만 변경)', () => {
  const base = { route: ROUTE_2_SEONGSU } as const;

  it.each([
    [59, '2-010', 1],
    [60, '2-011', 0],
  ])('fix 나이 %is (hop 60s 미만만 제외): 결과 %s, 사유 %i건', (fixAgeS, expectedId, expectedDrops) => {
    const { stationId, rejects } = run(R11_ROW, { ...base, fixAgeS });
    expect(stationId).toBe(expectedId);
    expect(unreachableRejects(rejects)).toHaveLength(expectedDrops);
  });

  it.each([
    [30, '2-010', 1],
    [31, '2-011', 0],
  ])('정확도 %im (acc<=30만 제외): 결과 %s, 사유 %i건', (accM, expectedId, expectedDrops) => {
    const { stationId, rejects } = run(R11_ROW, { ...base, accM });
    expect(stationId).toBe(expectedId);
    expect(unreachableRejects(rejects)).toHaveLength(expectedDrops);
  });

  it.each([
    [0.49, '2-010', 1],
    [0.5, '2-011', 0],
  ])('속도 %f m/s (speed<0.5만 제외): 결과 %s, 사유 %i건', (speedMps, expectedId, expectedDrops) => {
    const { stationId, rejects } = run(R11_ROW, { ...base, speedMps });
    expect(stationId).toBe(expectedId);
    expect(unreachableRejects(rejects)).toHaveLength(expectedDrops);
  });

  it('속도 정보 없음(null)은 정지 품질로 본다: 제외', () => {
    const { stationId, rejects } = run(R11_ROW, { ...base, speedMps: null });
    expect(stationId).toBe('2-010');
    expect(unreachableRejects(rejects)).toHaveLength(1);
  });

  it('신선 fix였다면 거리 게이트를 통과했을 위치(뚝섬 0.35km / 성수 0.46km 지점)면 제외하지 않는다 - 현행(성수) 유지', () => {
    const t = 0.43;
    const position = {
      lat: ttukseom.lat + t * (seongsu.lat - ttukseom.lat),
      lng: ttukseom.lng + t * (seongsu.lng - ttukseom.lng),
    };
    const { stationId, rejects } = run(R11_ROW, { ...base, position });
    expect(stationId).toBe('2-011');
    expect(unreachableRejects(rejects)).toHaveLength(0);
  });

  it('lock이 있으면 적용하지 않는다 (lock 있는 trip은 기존 lock 가드 담당)', () => {
    const lock: BoardingLock = {
      destinationId: ROUTE_2_SEONGSU.destinationId,
      trainCode: '9001',
      boardingStationId: '2-010',
      boardingLine: '2',
      boardedAt: R11_ROW.nowMs - 5_000,
      expectedDurationMs: 30 * 60_000,
    };
    const { rejectReasons } = run(R11_ROW, { ...base, boardingLock: lock });
    expect(rejectReasons).not.toContain('candidate-unreachable');
  });

  it('hold가 활성이면 적용하지 않는다 (기존 hold가 L을 거리 게이트에 계속 쓴다) - 사유 적재 없이 뚝섬 유지', () => {
    const t = 0.3;
    const position = {
      lat: ttukseom.lat + t * (seongsu.lat - ttukseom.lat),
      lng: ttukseom.lng + t * (seongsu.lng - ttukseom.lng),
    };
    // holdBlk '-' = 기압계 관측 가능(워밍업 완료, 이동 증거 없음) -> G2(최근접역 >=150m)만 만족하면 hold.
    const { stationId, rejectReasons } = run({ ...R11_ROW, holdBlk: '-' }, { ...base, position });
    expect(stationId).toBe('2-010');
    expect(rejectReasons).toContain('gps-stale-held');
    expect(rejectReasons).not.toContain('candidate-unreachable');
  });

  it('경로 arc 밖 후보는 기존대로 candidate-off-arc가 우선한다 (R1-5 유지) - candidate-unreachable로 바뀌지 않는다', () => {
    // 뚝섬에서 반대 방향(한양대 쪽) trip이면 성수는 출발역 상류 = arc 밖.
    const reverse = { originId: '2-010', destinationId: (findStationByNameAndLine('한양대', '2') as Station).id };
    const { stationId, rejectReasons } = run(R11_ROW, { route: reverse });
    expect(stationId).toBe('2-010');
    expect(rejectReasons).toContain('candidate-off-arc');
    expect(rejectReasons).not.toContain('candidate-unreachable');
  });
});
