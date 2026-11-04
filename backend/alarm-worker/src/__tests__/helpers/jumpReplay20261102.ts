/**
 * #2308 / #3055 PR-4b — 11/02 lockless 점프 + leg-2 lock(`replay_20261102_lockless_jump_leg2`) 재생 공용 helper.
 * 원 테스트와 진행 셀 테스트(`replay_20261102_progress_cell.test.ts`)가 같은 재생을 쓴다. 입력은 불변 실측 —
 * `fixtures/replay_20261102_lockless_jump_leg2/`(caps 18 cycle, D1 events 1956~2021). 통과시키려 조정 금지.
 * `cells`가 지정되면 TripDO fake를 바인딩한다.
 */
import type { Env, PositionPoint, Trip, Waypoint } from '../../types';
import { runCaptureReplay } from './replayHarness';
import {
  createDeviceReplayer,
  loadCapsFixture,
  loadD1Events,
  makeTripEventSink,
  parseRouteSig,
  routeSigOf,
  stubReplayFetch,
} from './replay20261019';
import type { TripProgress } from '../../progress';
import { attachDb, latestProgress, latestTrip } from './progressAuthorityReplay';
import { makeLockCellReplayEnv, type LockCellFlag } from './lockCellReplayEnv';
import { firedStationOccurrences } from './pushAssertions';

export const DIR = 'replay_20261102_lockless_jump_leg2';
export const TOKEN = 'replay-2308-1102';
/** D1 1982(19:49:28) 이후 행부터 주입한다(재생 시작 = 19:49:45 tick 직전). 1983 register(19:49:29)가 첫 주입. */
export const REPLAY_FROM_MS = 1793616568000;
export const KST_OFFSET_MS = 9 * 3600_000;

export const rows = loadD1Events(DIR, 'events.json');
const rowOf = (id: number) => {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`D1 행 ${id}이 fixture에 없다`);
  return row;
};
export const kst = (ms: number) => new Date(ms + KST_OFFSET_MS).toISOString().slice(11, 19);

/** 세션 노선 원본 = D1 1956 existingSig(전체) — hopIndex는 backend가 원본 순서로 stamp한 값. */
export const ROUTE = parseRouteSig(routeSigOf(rowOf(1956), 'existingSig')).map((w, hopIndex) => ({ ...w, hopIndex }));
/** 재생 시작 시점 backend 진행분 = D1 1982(19:49:28) existingSig. hopIndex는 원본 위치. */
const progressNow: Waypoint[] = parseRouteSig(routeSigOf(rowOf(1982), 'existingSig')).map((w) => ({
  ...w,
  hopIndex: ROUTE.findIndex((r) => r.stationName === w.stationName),
}));
/** lockless cron이 19:49:45에 어린이대공원을 소비한 뒤의 head (D1 1984 -> 1985 existing head 군자). */
export const HEAD_AFTER_LOCKLESS = progressNow[1].stationName;
export const TRANSFER = ROUTE.find((w) => w.kind === 'transfer') as Waypoint;
/** 탑승역(건대입구) 다음부터 도착까지 7호선 전 구간 = lock 7320이 가져야 할 segment. */
export const LEG2_SEGMENT = [TRANSFER.stationName, ...ROUTE.filter((w) => w.line === '7').map((w) => w.stationName)];

export const fixture = loadCapsFixture(DIR);

function motionSeries(): PositionPoint[] {
  const point = (ts: number, motion: PositionPoint['motion']): PositionPoint => ({
    ts,
    motion,
    lat: 37.540373,
    lng: 127.069191,
    accuracy: 20,
  });
  const walking = Array.from({ length: 7 }, (_, i) => point(1793616400000 + i * 30_000, 'walking'));
  const waiting = Array.from({ length: 11 }, (_, i) => point(1793616610000 + i * 30_000, 'stationary'));
  return [...walking, ...waiting];
}

function seedTrip(): Trip {
  const eligibleAt = rowOf(1993).ts - 1263; // leg-resolve-attempt 19:53:45 elapsedSinceAnchorMs=1263 -> 도보 게이트 해제 시각
  const transferIndex = ROUTE.findIndex((w) => w.kind === 'transfer');
  const destination = ROUTE[ROUTE.length - 1];
  return {
    token: TOKEN,
    route: {
      type: 'transfer',
      transferName: TRANSFER.stationName,
      fromLine: TRANSFER.line,
      toLine: ROUTE[transferIndex + 1].line,
      stopsToTransfer: transferIndex + 1,
      stopsFromTransfer: ROUTE.length - transferIndex - 1,
    },
    destination: destination.stationName,
    waypoints: progressNow,
    routeWaypoints: ROUTE,
    originStationName: '뚝섬',
    createdAt: REPLAY_FROM_MS - 10 * 60_000,
    alarmAtEpochMs: REPLAY_FROM_MS,
    expiresAt: REPLAY_FROM_MS + 3 * 60 * 60_000,
    infoModeEnabled: true,
    consecutiveEtaMissing: 0,
    currentLegAnchor: { boardingStation: TRANSFER.stationName, line: '7' },
    legBoardingEligibleAt: eligibleAt,
  } as Trip;
}

export async function replayLeg2(opts: { registers: boolean; sleep?: boolean; cells?: LockCellFlag | `progress@${number}` }) {
  const trip = seedTrip();
  const { db, events } = makeTripEventSink();
  const stub = stubReplayFetch(fixture);
  const replayer = createDeviceReplayer({
    rows: opts.registers
      ? rows.filter((r) => r.ts >= REPLAY_FROM_MS)
      : rows.filter((r) => r.ts >= REPLAY_FROM_MS && r.kind !== 'trip-register'),
    token: TOKEN,
    stub,
    // 탑승 탭은 LA 버튼 모양(trainCode 미동봉) — D1 1997 anchorSource=currentLegAnchor outcome=resolved.
    tapBody: () => ({ station: TRANSFER.stationName, line: '7' }),
    mergeSyncByTs: true,
    register: {
      fromMs: REPLAY_FROM_MS,
      body: {
        destination: trip.destination,
        route: trip.route,
        createdAt: trip.createdAt,
        infoModeEnabled: true,
        sleepModeEnabled: opts.sleep === true,
      },
    },
  });
  const cells = opts.cells ? makeLockCellReplayEnv(opts.cells as LockCellFlag) : undefined;
  const headsAfterTick: Array<string | undefined> = [];
  const progressAfterTick: Array<TripProgress | null> = [];
  let kvRef: KVNamespace | undefined;
  const result = await runCaptureReplay({
    locklessAdvanceLegacy: true, // K5 #2926 PR-A: lockless 전진을 전제로 쓰인 구 replay - 구 경로(kill switch legacy) 보호용 고정
    fixture: { ...fixture, cycleStartsMs: fixture.cycleStartsMs.filter((c) => c + 1000 >= REPLAY_FROM_MS) },
    seedTrips: [{ ...trip, ...(opts.sleep ? { sleepModeEnabled: true } : {}) }],
    seedPositionSeries: { [TOKEN]: motionSeries() },
    apns: 'capture',
    beforeTick: async ({ tick, tickIndex, env, kv, pushes }) => {
      kvRef = kv;
      if (tickIndex > 0) {
        headsAfterTick.push(latestTrip(kv, TOKEN)?.waypoints[0]?.stationName);
        progressAfterTick.push(latestProgress(kv, TOKEN));
      }
      if (cells && tickIndex === 0) await cells.install(env as Env, kv);
      attachDb(env as Env, db);
      stub.setNow(tick);
      await replayer.beforeTick({ tick, env: env as Env, pushes });
    },
  });
  if (kvRef) {
    headsAfterTick.push(latestTrip(kvRef, TOKEN)?.waypoints[0]?.stationName);
    progressAfterTick.push(latestProgress(kvRef, TOKEN));
  }
  return { result, events, headsAfterTick, progressAfterTick, taps: replayer.taps, registers: replayer.registers, kv: kvRef as KVNamespace };
}

export type Leg2 = Awaited<ReturnType<typeof replayLeg2>>;
export const tickIndexOf = (r: Leg2, hhmmss: string) => r.result.cycles.findIndex((c) => kst(c.simNowMs).startsWith(hhmmss.slice(0, 7)));
export const alertTicks = (r: Leg2, station: string): string[] =>
  r.result.cycles.flatMap((cycle) =>
    firedStationOccurrences(cycle.pushes)
      .filter((name) => name === station)
      .map(() => kst(cycle.simNowMs)),
  );

/** 열차 7320이 해당 역에 도착한 시각(R2 캡처 recptnDt)을 처음 볼 수 있는 cron tick (캡처 19:55:53 / 19:57:54 -> 다음 정각 tick). */
export const FIRST_TICK_WITH_ARRIVAL: Record<string, string> = { '어린이대공원(세종대)': '19:56:4', '군자(능동)': '19:58:4' };
