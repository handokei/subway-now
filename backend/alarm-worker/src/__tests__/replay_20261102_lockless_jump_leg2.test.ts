/**
 * #2308 PR-2 — 2026-11-02 19:44~20:02 트립(토큰 해시 b00dd879, 뚝섬 -> 건대입구 환승 -> 용마산, leg-2 lock 7320) whole-trip replay.
 *
 * 사고(두 겹): leg-2 lock(19:54:57)이 붙기 전에
 *   ⓐ lockless cron이 어린이대공원을 소비해 head를 군자로 당겼고(D1 1984 prepare-alarm `no-lock`, 19:49:45),
 *   ⓑ 같은 세션 재등록(19:50:18)이 lockless progress를 hopIndex로 적용해 군자를 건너뛰었다(D1 1985 head 군자 -> 1987 head 중곡,
 *      그 사이 cron·sync 행 없음. device waypoints에는 hopIndex가 없어 backend `validateTrip`이 배열 위치로 다시 매기기 때문).
 *   그래서 lock 7320의 segmentStations·waypoints에 어린이대공원·군자가 없었고, 열차 7320이 두 역에 도착했는데(R2:
 *   19:55:53 어대 / 19:57:54 군자) 매역 알림이 0건이었다(D1 1996~2020 사이 cron-fire-attempt 0행). ADR-042 결정 1 위반.
 *
 * 입력은 불변 실측 — `fixtures/replay_20261102_lockless_jump_leg2/`:
 *   - caps/*.json : R2 seoul-capture 18 cycle (19:44:45~20:01:45, R2 원문과 byte 동일).
 *   - events.json : D1 trip_events 1956~2021 원문. 재등록(trip-register)·동기화(sync-received)·탑승 탭(boarding-confirm-result)을
 *     원래 시각 순서대로 주입한다(createDeviceReplayer). 통과시키려 조정 금지.
 * 재생 시작 상태는 D1 1982(19:49:28)의 backend 진행분(head 어린이대공원)이다. leg-1(2호선 lock 3368)·환승(건대입구) 구간은
 * 이 사고의 기전 밖이라 재생하지 않는다.
 *
 * 합성 입력(정직 표기): R2에는 device motion이 없다. lockless 소비(D1 1984)가 일어났다는 사실이 motion 게이트 통과(walking/automotive)를
 * 증명하므로, 환승 도보 중(19:46:40~19:49:40) walking, 승강장 대기 중(19:50:10~19:55:10) stationary 시리즈를 합성했다.
 * (stationary 구간은 실제로 19:50~19:54:57 사이 lockless 소비가 D1에 0건이라는 사실과 일치한다.)
 *
 * assert는 실제로 나간 APNs 요청(종류·tick·횟수) 기준이다.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env, PositionPoint, Trip, Waypoint } from '../types';
import { runCaptureReplay } from './helpers/replayHarness';
import {
  createDeviceReplayer,
  loadCapsFixture,
  loadD1Events,
  makeTripEventSink,
  parseRouteSig,
  routeSigOf,
  stubReplayFetch,
} from './helpers/replay20261019';
import type { TripProgress } from '../progress';
import { attachDb, latestProgress, latestTrip } from './helpers/progressAuthorityReplay';
import { firedStationOccurrences } from './helpers/pushAssertions';
import { useApnsHarness } from './helpers/sleepAlarmHarness';

useApnsHarness();
afterEach(() => vi.unstubAllGlobals());

const DIR = 'replay_20261102_lockless_jump_leg2';
const TOKEN = 'replay-2308-1102';
/** D1 1982(19:49:28) 이후 행부터 주입한다(재생 시작 = 19:49:45 tick 직전). 1983 register(19:49:29)가 첫 주입. */
const REPLAY_FROM_MS = 1793616568000;
const KST_OFFSET_MS = 9 * 3600_000;

const rows = loadD1Events(DIR, 'events.json');
const rowOf = (id: number) => {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`D1 행 ${id}이 fixture에 없다`);
  return row;
};
const kst = (ms: number) => new Date(ms + KST_OFFSET_MS).toISOString().slice(11, 19);

/** 세션 노선 원본 = D1 1956 existingSig(전체) — hopIndex는 backend가 원본 순서로 stamp한 값. */
const ROUTE = parseRouteSig(routeSigOf(rowOf(1956), 'existingSig')).map((w, hopIndex) => ({ ...w, hopIndex }));
/** 재생 시작 시점 backend 진행분 = D1 1982(19:49:28) existingSig. hopIndex는 원본 위치. */
const progressNow: Waypoint[] = parseRouteSig(routeSigOf(rowOf(1982), 'existingSig')).map((w) => ({
  ...w,
  hopIndex: ROUTE.findIndex((r) => r.stationName === w.stationName),
}));
/** lockless cron이 19:49:45에 어린이대공원을 소비한 뒤의 head (D1 1984 -> 1985 existing head 군자). */
const HEAD_AFTER_LOCKLESS = progressNow[1].stationName;
const TRANSFER = ROUTE.find((w) => w.kind === 'transfer') as Waypoint;
/** 탑승역(건대입구) 다음부터 도착까지 7호선 전 구간 = lock 7320이 가져야 할 segment. */
const LEG2_SEGMENT = [TRANSFER.stationName, ...ROUTE.filter((w) => w.line === '7').map((w) => w.stationName)];

const fixture = loadCapsFixture(DIR);

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

async function replayLeg2(opts: { registers: boolean; sleep?: boolean }) {
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
  const headsAfterTick: Array<string | undefined> = [];
  const progressAfterTick: Array<TripProgress | null> = [];
  let kvRef: KVNamespace | undefined;
  const result = await runCaptureReplay({
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

type Leg2 = Awaited<ReturnType<typeof replayLeg2>>;
const tickIndexOf = (r: Leg2, hhmmss: string) => r.result.cycles.findIndex((c) => kst(c.simNowMs).startsWith(hhmmss.slice(0, 7)));
const alertTicks = (r: Leg2, station: string): string[] =>
  r.result.cycles.flatMap((cycle) =>
    firedStationOccurrences(cycle.pushes)
      .filter((name) => name === station)
      .map(() => kst(cycle.simNowMs)),
  );

/** 열차 7320이 해당 역에 도착한 시각(R2 캡처 recptnDt)을 처음 볼 수 있는 cron tick (캡처 19:55:53 / 19:57:54 -> 다음 정각 tick). */
const FIRST_TICK_WITH_ARRIVAL: Record<string, string> = { '어린이대공원(세종대)': '19:56:4', '군자(능동)': '19:58:4' };

describe('#2308 11/02 lockless 점프 + lock 전 전진이 lock 트립 역을 지움 — leg-2 lock 7320', () => {
  it.each([
    ['재등록 주입(D1 실측 15회)', true],
    ['재등록 없음(대조)', false],
  ])('%s: 탑승 탭이 열차 7320을 해소해 lock을 붙인다 (사슬 전제)', async (_label, registers) => {
    const r = await replayLeg2({ registers });
    expect(r.taps.map((t) => t.response.resolvedTrainCode)).toEqual(['7320', '7320']);
    expect(latestTrip(r.kv, TOKEN)?.boardingLock?.trainCode).toBe('7320');
  });

  it('lock 전 구간: 재등록(19:50:18)이 군자를 건너뛰지 않는다 — head는 군자 그대로 lock 부착 tick까지 유지', async () => {
    const r = await replayLeg2({ registers: true });
    const lockTick = tickIndexOf(r, '19:54:4');
    expect(r.headsAfterTick.slice(0, lockTick + 1)).toEqual(Array(lockTick + 1).fill('군자(능동)'));
  });

  it.each(Object.entries(FIRST_TICK_WITH_ARRIVAL))(
    '%s 매역 alert push는 열차 도착을 처음 볼 수 있는 tick 이하에서 정확히 1건',
    async (station, tickPrefix) => {
      const r = await replayLeg2({ registers: true });
      const limit = tickIndexOf(r, tickPrefix);
      const ticks = alertTicks(r, station);
      expect({ count: ticks.length, withinLimit: ticks.every((t) => t <= kst(r.result.cycles[limit].simNowMs)) }).toEqual({
        count: 1,
        withinLimit: true,
      });
    },
  );

  it('lock 7320의 segmentStations·waypoints에 탑승역 다음 역(어린이대공원·군자)이 복원된다 (D1 lock-reanchor 정확히 1행)', async () => {
    const r = await replayLeg2({ registers: true });
    const reanchors = r.events.filter((e) => e.kind === 'lock-reanchor');
    expect(reanchors).toHaveLength(1);
    expect(reanchors[0].meta).toMatchObject({ trainCode: '7320' });
    const segment = latestTrip(r.kv, TOKEN)?.boardingLock?.segmentStations ?? [];
    expect(segment).toEqual(LEG2_SEGMENT);
  });

  it('재등록 주입 있음/없음 두 실행의 lock 이후 매역 alert 시퀀스가 같다 (재등록이 발사를 바꾸지 못한다)', async () => {
    const withRegisters = await replayLeg2({ registers: true });
    const control = await replayLeg2({ registers: false });
    const sequence = (r: Leg2) => r.result.cycles.flatMap((c) => firedStationOccurrences(c.pushes).map((name) => `${kst(c.simNowMs)} ${name}`));
    expect(sequence(withRegisters)).toEqual(sequence(control));
  });

  it('lockless progress는 더 이상 쓰이지 않는다 (mirrorLocklessProgress 제거): lockless 전진 직후 progress 키가 없다', async () => {
    const r = await replayLeg2({ registers: false });
    expect(r.headsAfterTick[0]).toBe(HEAD_AFTER_LOCKLESS); // 전제: lockless 전진이 실제로 일어났다
    expect(r.progressAfterTick[0]).toBeNull();
  });

  it('전제: lockless cron은 lock 전에 어린이대공원을 실제로 소비한다 (이 PR이 막는 것은 소비 자체가 아니라 lock 트립으로의 누수)', async () => {
    const r = await replayLeg2({ registers: false });
    expect(r.headsAfterTick[0]).toBe(HEAD_AFTER_LOCKLESS);
  });
});
