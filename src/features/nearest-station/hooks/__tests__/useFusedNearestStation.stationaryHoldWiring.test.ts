/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: useFusedNearestStation orchestrator 테스트라 직접 import가 본질적.
 */
/**
 * #3191 PR-2 - 정지 fix 유지(hold) 배선: 지상에서 정지한 사용자의 마지막 fix L을 나이와 무관하게
 * 결정 tier 거리 게이트에 계속 쓴다.
 *
 * 입력은 10/18~21 덤프 원문 행(replay_20261021_sagajeong_hold.ts)이다. Raw 행에는 열차 위치/도착
 * 원문이 없으므로(fusionReplayDriver.ts 주석: cascade 전체는 덤프만으로 재생 불가) 사가정 열차 신호는
 * 합성이다 - 실측인 것은 fix 시각/정확도/hpa/최근접역 거리/좌표다.
 *
 * red 기준(구현 전): fix가 15초를 넘으면 decisionUserLocation=null 이라 거리 게이트가 꺼지고
 * 사가정(593m)이 용마산(227m)을 이긴다.
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
jest.mock('../../../alarm/utils/tripStartStorage', () => ({
  getTripStartedAt: jest.fn().mockResolvedValue(null),
}));

import { renderHook } from '@testing-library/react-native';
import { useFusedNearestStation } from '../useFusedNearestStation';
import { useNearestStation } from '../useNearestStation';
import { useArrivalInfo } from '../../../arrival/hooks/useArrivalInfo';
import { useTrainPositions } from '../../../route/hooks/useTrainPositions';
import { findTopNearestStations } from '../../utils/findNearestStation';
import { pushRawSignal } from '../../../observability/utils/rawSignalBuffer';
import { findStationByNameAndLine } from '../../../../shared/utils/stationRoute';
import { haversine } from '../../../../shared/utils/haversine';
import { TRAIN_STATUS } from '../../../../shared/constants/trainStatus';
import { clearCandidateRejectEntries, getCandidateRejectEntries } from '../../utils/candidateRejectBuffer';
import {
  appendBarometerReading,
  resetBarometerInstrumentationForTest,
  resetBarometerState,
} from '../../../../shared/utils/barometerState';
import { arrivalRet, positionRet, makeTrain } from '../../../../testUtils/positionApiFixtures';
import {
  A_18_OCT_HOME,
  T_21_OCT_HOME,
  W_28_OCT,
  kstEpochMs,
  parseRawRow,
  type ParsedRawRow,
  type SagajeongDumpFixture,
} from '../../../../testUtils/fixtures/replay_20261021_sagajeong_hold';

const mockNearest = useNearestStation as jest.Mock;
const mockArrival = useArrivalInfo as jest.Mock;
const mockPos = useTrainPositions as jest.Mock;
const mockFindTop = findTopNearestStations as jest.Mock;
const mockPushRaw = pushRawSignal as jest.Mock;

const yongmasan = findStationByNameAndLine('용마산', '7')!;
const sagajeong = findStationByNameAndLine('사가정', '7')!;

type Dumped = { holdEligible?: boolean | null; holdBlock?: string | null; distM?: number | null };

interface RunOpts {
  fixture: SagajeongDumpFixture;
  row: string;
  /** GPS 최근접역(없으면 용마산 227m = 집). */
  nearestDistanceM?: number;
  /** 좌표를 덮어쓴다(기본: 덤프 `## GPS` 헤더). */
  location?: { lat: number; lng: number };
  /** speedMps 덮어쓰기. */
  speedMps?: number | null;
  /** 기압계 신호 unavailableReason. */
  unavailableReason?: 'readings' | 'sensor';
  /** 첫 기압 reading을 now에서 얼마나 앞에 둘지(기본 10분 - 워밍업 충분). */
  baroFirstAgoMs?: number;
  /** 마지막 기압 reading을 now에서 얼마나 앞에 둘지(기본 1초). */
  baroLastAgoMs?: number;
  /** 기압 ΔP 이벤트 시각(없으면 이벤트 없음). */
  baroEventAtMs?: number | null;
  /** 사가정 열차 신호를 주지 않는다. */
  noTrain?: boolean;
  /** gps.lastFixFromBg 패스스루 확인용. */
  fixFromBg?: boolean;
}

function seedBarometer(row: ParsedRawRow, opts: RunOpts) {
  const { nowMs, hpa } = row;
  const firstAt = nowMs - (opts.baroFirstAgoMs ?? 600_000);
  appendBarometerReading({ t: firstAt, pressureHpa: hpa });
  const evt = opts.baroEventAtMs ?? null;
  if (evt !== null) {
    appendBarometerReading({ t: evt - 5_000, pressureHpa: hpa - 0.5 });
    appendBarometerReading({ t: evt, pressureHpa: hpa });
  }
  const lastAt = nowMs - (opts.baroLastAgoMs ?? 1_000);
  if (evt === null || lastAt > evt) appendBarometerReading({ t: lastAt, pressureHpa: hpa });
}

function run(opts: RunOpts) {
  const { fixture, row: rowLine } = opts;
  const row = parseRawRow(rowLine, fixture.header.kstDate);
  jest.setSystemTime(row.nowMs);
  seedBarometer(row, opts);

  const { lat, lng } = opts.location ?? fixture.header;
  const nearestM = opts.nearestDistanceM ?? fixture.header.nearestDistanceM;
  const live = { station: yongmasan, distanceKm: nearestM / 1000 };
  mockNearest.mockReturnValue({
    result: live,
    liveResult: live,
    stickyDisplayOnly: null,
    variants: [yongmasan],
    userLocation: { lat, lng },
    speedMps: opts.speedMps ?? null,
    accuracyMeters: row.accuracyMeters,
    loading: false,
    error: null,
    permissionDenied: false,
    locationUncertain: false,
    gpsActive: 'bg' as const,
    lastFixAtMs: row.fixAtMs,
    lastFixFromBg: opts.fixFromBg ?? false,
    isWatchActive: () => false,
    refresh: jest.fn(),
  });
  const sagajeongKm = haversine(lat, lng, sagajeong.lat, sagajeong.lng);
  mockFindTop.mockReturnValue([
    live,
    { station: sagajeong, distanceKm: sagajeongKm },
  ]);
  mockPos.mockReturnValue(
    opts.noTrain
      ? positionRet(null)
      : positionRet({
          line: '7',
          trains: [
            makeTrain(sagajeong.name, TRAIN_STATUS.ARRIVED, { trainNo: '7001', receivedAtMs: row.nowMs }),
          ],
        }),
  );
  const hook = renderHook(() =>
    useFusedNearestStation(undefined, undefined, undefined, undefined, undefined, undefined, {
      subsurface: false,
      signal: { subsurface: false, stop: undefined, unavailableReason: opts.unavailableReason ?? 'readings' },
    }),
  );
  const dumped = mockPushRaw.mock.calls.map(([e]: [Dumped]) => e);
  return { hook, dumped, sagajeongKm };
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

describe('#3191 PR-2 (1) 게이트 입력 - 실측 행 (집, fix 나이 >= 15s, 정지)', () => {
  it('전제: 사가정은 집에서 ~593m (plan: 593 > 227+200 -> 거리 게이트 탈락)', () => {
    const { sagajeongKm } = run({ fixture: T_21_OCT_HOME, row: T_21_OCT_HOME.rows[0] });
    expect(Math.round(sagajeongKm * 1000)).toBe(593);
  });

  it.each(T_21_OCT_HOME.rows.slice(0, 4).map((r) => [r.slice(0, 8), r] as const))(
    'T %s - L(fix 21:25:25, acc 8)을 계속 써서 사가정 신호를 거부하고 용마산(GPS 측)을 유지한다',
    (_label, row) => {
      const { hook } = run({ fixture: T_21_OCT_HOME, row });
      expect(hook.result.current.result?.station.id).toBe(yongmasan.id);
      expect(hook.result.current.source).not.toBe('position');
    },
  );

  it('T 21:30:30 (L 21:30:15 acc 5, age 15s)', () => {
    const { hook } = run({ fixture: T_21_OCT_HOME, row: T_21_OCT_HOME.rows[4] });
    expect(hook.result.current.result?.station.id).toBe(yongmasan.id);
  });

  it.each(A_18_OCT_HOME.rows.map((r) => [r.slice(0, 8), r] as const))(
    'A %s - L(fix 23:20:48 acc 17)을 계속 써서 용마산 유지',
    (_label, row) => {
      const { hook } = run({ fixture: A_18_OCT_HOME, row });
      expect(hook.result.current.result?.station.id).toBe(yongmasan.id);
    },
  );

  it('gps-stale 대신 gps-stale-held가 적재된다 (프로덕션 측정: held 대 stale 비율)', () => {
    run({ fixture: T_21_OCT_HOME, row: T_21_OCT_HOME.rows[0] });
    const reasons = getCandidateRejectEntries().map((e) => e.reason);
    expect(reasons).toContain('gps-stale-held');
    expect(reasons).not.toContain('gps-stale');
  });

  describe('거부 - hold=false이면 현행(사가정 채택) 그대로', () => {
    const base = { fixture: T_21_OCT_HOME, row: T_21_OCT_HOME.rows[0] } as const;

    it('정확도 44m (F9 지하 복귀 fix)', () => {
      const row = base.row.replace('gps(8m/-)', 'gps(44m/-)');
      const { hook } = run({ ...base, row });
      expect(hook.result.current.result?.station.id).toBe(sagajeong.id);
    });

    it('속도 13.9 m/s (T 오전 L882 터널)', () => {
      const { hook } = run({ ...base, speedMps: 13.9 });
      expect(hook.result.current.result?.station.id).toBe(sagajeong.id);
    });

    it('fix 이후 기압 ΔP 이벤트 (수직 이동 증거)', () => {
      const row = parseRawRow(base.row, base.fixture.header.kstDate);
      const { hook } = run({ ...base, baroEventAtMs: row.fixAtMs + 60_000 });
      expect(hook.result.current.result?.station.id).toBe(sagajeong.id);
    });

    it('G2: 최근접역 거리 64m (지하 승강장 표본, 용마산 64m acc 20) - 승강장에서는 hold하지 않는다', () => {
      const { hook } = run({ ...base, nearestDistanceM: 64 });
      expect(hook.result.current.result?.station.id).toBe(sagajeong.id);
    });

    it('센서 실패 (unavailableReason=sensor)', () => {
      const { hook } = run({ ...base, unavailableReason: 'sensor' });
      expect(hook.result.current.result?.station.id).toBe(sagajeong.id);
    });
  });
});

describe('#3191 PR-2 (3) BG 주입 출처 패스스루', () => {
  it.each([true, false])('gps.lastFixFromBg=%s -> useFusedNearestStation 반환값 그대로 (HomeScreen 업로드 skip 입력)', (fixFromBg) => {
    const { hook } = run({ fixture: T_21_OCT_HOME, row: T_21_OCT_HOME.rows[0], fixFromBg });
    expect(hook.result.current.lastFixFromBg).toBe(fixFromBg);
  });
});

describe('#3191 PR-2 (10) D2(b) - 기압계 관측 가능 정의', () => {
  const base = { fixture: T_21_OCT_HOME, row: T_21_OCT_HOME.rows[0] } as const;

  it('reset 직후(stop verdict baseline 부족, reason=readings)에도 reading이 최근이면 hold 유지', () => {
    // 현행 caller는 unavailableReason===undefined만 허용 -> DebugModal 닫힘/콜드스타트 후 30초 hold 꺼짐.
    const { hook } = run({ ...base, unavailableReason: 'readings' });
    expect(hook.result.current.result?.station.id).toBe(yongmasan.id);
  });

  it('첫 reading 후 30초 미만(콜드스타트 워밍업)이면 hold하지 않는다', () => {
    const { hook } = run({ ...base, baroFirstAgoMs: 20_000 });
    expect(hook.result.current.result?.station.id).toBe(sagajeong.id);
  });

  it('마지막 reading이 30초보다 오래됐으면(기압 공백) hold하지 않는다', () => {
    const { hook } = run({ ...base, baroLastAgoMs: 45_000 });
    expect(hook.result.current.result?.station.id).toBe(sagajeong.id);
  });

  it('reset해도 첫/마지막 reading 추적은 유지된다 (barometerState 불변식)', () => {
    const row = parseRawRow(base.row, base.fixture.header.kstDate);
    jest.setSystemTime(row.nowMs);
    appendBarometerReading({ t: row.nowMs - 600_000, pressureHpa: row.hpa });
    appendBarometerReading({ t: row.nowMs - 1_000, pressureHpa: row.hpa });
    resetBarometerState();
    // run()이 다시 seed하지 않도록 직접 구성하지 않고 결과만 본다: 추적이 살아 있어야 hold.
    const live = { station: yongmasan, distanceKm: 0.227 };
    const { lat, lng } = base.fixture.header;
    mockNearest.mockReturnValue({
      result: live,
      liveResult: live,
      stickyDisplayOnly: null,
      variants: [yongmasan],
      userLocation: { lat, lng },
      speedMps: null,
      accuracyMeters: 8,
      loading: false,
      error: null,
      permissionDenied: false,
      locationUncertain: false,
      gpsActive: 'bg' as const,
      lastFixAtMs: row.fixAtMs,
      lastFixFromBg: false,
      isWatchActive: () => false,
      refresh: jest.fn(),
    });
    mockFindTop.mockReturnValue([live, { station: sagajeong, distanceKm: haversine(lat, lng, sagajeong.lat, sagajeong.lng) }]);
    mockPos.mockReturnValue(
      positionRet({
        line: '7',
        trains: [makeTrain(sagajeong.name, TRAIN_STATUS.ARRIVED, { trainNo: '7001', receivedAtMs: row.nowMs })],
      }),
    );
    const { result } = renderHook(() =>
      useFusedNearestStation(undefined, undefined, undefined, undefined, undefined, undefined, {
        subsurface: false,
        signal: { subsurface: false, stop: undefined, unavailableReason: 'readings' },
      }),
    );
    expect(result.current.result?.station.id).toBe(yongmasan.id);
  });
});

describe('#3191 PR-2 (13) Raw holdBlock / distM 기록', () => {
  it('T 21:27:44 - 통과: holdEligible=true, holdBlock=null, distM=227', () => {
    const { dumped } = run({ fixture: T_21_OCT_HOME, row: T_21_OCT_HOME.rows[0] });
    expect(dumped.length).toBeGreaterThan(0);
    for (const e of dumped) {
      expect(e.holdEligible).toBe(true);
      expect(e.holdBlock).toBeNull();
      expect(e.distM).toBe(227);
    }
  });

  it('W 06:21:02 - 정확도(5m)는 통과, baroEvt 06:21:01이 lookback 안 -> holdBlock=baro-event', () => {
    const rowLine = W_28_OCT.rows[0];
    const row = parseRawRow(rowLine, W_28_OCT.header.kstDate);
    const { dumped } = run({
      fixture: W_28_OCT,
      row: rowLine,
      baroEventAtMs: row.baroEventAtMs,
      baroFirstAgoMs: 120_000,
      nearestDistanceM: 230,
    });
    expect(dumped.length).toBeGreaterThan(0);
    for (const e of dumped) {
      expect(e.holdEligible).toBe(false);
      expect(e.holdBlock).toBe('baro-event');
    }
  });

  it('W 06:26:49 - 지하 용마산 승강장 acc 45 -> holdBlock=accuracy, hold=false (거부)', () => {
    const rowLine = W_28_OCT.rows[1];
    const row = parseRawRow(rowLine, W_28_OCT.header.kstDate);
    const { dumped } = run({
      fixture: W_28_OCT,
      row: rowLine,
      baroEventAtMs: row.baroEventAtMs,
      baroFirstAgoMs: 120_000,
      nearestDistanceM: 64,
    });
    for (const e of dumped) {
      expect(e.holdEligible).toBe(false);
      expect(e.holdBlock).toBe('accuracy');
      expect(e.distM).toBe(64);
    }
  });

  it('W 17:24:06 - 지하 acc 27 (PR-1 술어는 hold=1이었다) -> G2가 막는다: holdBlock=near-station, distM=64 (승강장 표본)', () => {
    const rowLine = W_28_OCT.rows[2];
    const { dumped } = run({
      fixture: W_28_OCT,
      row: rowLine,
      // 5분 전 이벤트(17:19:46)는 lookback(3분 전 fix 17:23:51 - 3분 = 17:20:51)보다 오래돼 기압은 통과한다.
      baroEventAtMs: kstEpochMs('2026-10-28', '17:19:46'),
      baroFirstAgoMs: 1_800_000,
      nearestDistanceM: 64,
    });
    for (const e of dumped) {
      expect(e.holdEligible).toBe(false);
      expect(e.holdBlock).toBe('near-station');
      expect(e.distM).toBe(64);
    }
  });
});
