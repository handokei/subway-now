/**
 * #3100 선행 — 실측 트립 168/171/173 위에서 "1역 전 알람"이 지금 언제·어디서 발사되는지 고정한다.
 * 프로덕션 코드 diff 0. 입력은 불변 실측(통과시키려 조정 금지):
 *   - `fixtures/replay_20261019_sleep_regression/` (트립 168, 취침)
 *   - `fixtures/replay_20261020_sleep_171/`       (트립 171, 취침)
 *   - `fixtures/replay_20261021_trip173/`         (트립 173, 비취침 = 준비 알람)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCaptureReplay, type CapturedPush } from './helpers/replayHarness';
import {
  buildTransferSeedTrip,
  createDeviceReplayer,
  loadCapsFixture,
  loadD1Events,
  loadTripMetricsRow,
  makeTripEventSink,
  parseRouteSig,
  routeSigOf,
  stubReplayFetch,
} from './helpers/replay20261019';
import {
  SLEEP_ALARM_MAX_STOPS_BEFORE,
  SLEEP_ALARM_MIN_STOPS_BEFORE,
  type SleepAlarmConfig,
} from '../../../../src/shared/constants/sleepAlarm';
import { TRAIN_STATUS } from '../alarm';
import { getTrip } from '../trips';
import { useApnsHarness } from './helpers/sleepAlarmHarness';
import { lockActiveTrip, syncObserved } from './helpers/sleepAlarmSyncHttp';
import type { Env, PositionPoint, Waypoint } from '../types';

afterEach(() => vi.unstubAllGlobals());
useApnsHarness();

type Body = Record<string, unknown>;

/** 1역 전 알람 = 취침(`alarm-<tok>-<역>`) 또는 준비(`prepare-<tok>-<역>`) alert (sound alarm.wav). 반환 = collapse-id. */
function alarmCollapseId(body: Body, collapseId?: string): string | null {
  const aps = body.aps as { sound?: string } | undefined;
  if (aps?.sound !== 'alarm.wav') return null;
  return /^(?:alarm|prepare)-/.test(collapseId ?? '') ? (collapseId as string) : null;
}

/** cron tick별 1역 전 알람 시각. target = collapse-id 접미(`-<역명>`)로 판정한다(token에 `-`가 있어 파싱하지 않는다). */
function cronAlarms(cycles: { simNowMs: number; pushes: CapturedPush[] }[], station: string): number[] {
  const out: number[] = [];
  for (const c of cycles) {
    for (const p of c.pushes) {
      const id = alarmCollapseId(p.body, p.headers.collapseId);
      if (id?.endsWith(`-${station}`)) out.push(c.simNowMs);
    }
  }
  return out;
}

/** 캡처(R2)에서 열차가 (역, trainSttus 집합)에 처음 관측된 시각. */
function firstSightingMs(
  fixture: { entries: { kind: string; body: string; tMs: number }[] },
  trainCode: string,
  station: string,
  statuses?: number[],
): number | undefined {
  for (const e of fixture.entries) {
    if (e.kind !== 'position' || !e.body.startsWith('{')) continue;
    const list = (JSON.parse(e.body) as { realtimePositionList: { trainNo: string; statnNm: string; trainSttus: string }[] })
      .realtimePositionList;
    const hit = list.some(
      (q) => q.trainNo === trainCode && q.statnNm === station && (statuses === undefined || statuses.includes(Number(q.trainSttus))),
    );
    if (hit) return e.tMs;
  }
  return undefined;
}

const promptPayload = (push: CapturedPush) => {
  const payload = push.body.body as Body | undefined;
  return payload?.kind === 'boarding-prompt' ? payload : undefined;
};

/** #3100 PR-1 — 설정 주입: 취침 ON + 설정만 seed한다(caps·D1은 불변 실측). */
interface ReplayOpts {
  sleepAlarm?: SleepAlarmConfig;
}
const sleepOverrides = (opts: ReplayOpts) =>
  opts.sleepAlarm ? { sleepModeEnabled: true, sleepAlarm: opts.sleepAlarm } : {};

async function replay173(opts: ReplayOpts = {}) {
  const dir = 'replay_20261021_trip173';
  const fixture = loadCapsFixture(dir);
  const d1 = loadD1Events(dir, 'events_173.json');
  const metrics = loadTripMetricsRow(dir, 173, 'trip_metrics_173.json');
  const firstMismatch = d1.find((e) => e.kind === 'route-signature-mismatch');
  if (!firstMismatch) throw new Error('fixture 전제 실패');
  const seedWaypoints: Waypoint[] = parseRouteSig(routeSigOf(firstMismatch, 'incomingSig'));
  const transfer = seedWaypoints.find((w) => w.kind === 'transfer') as Waypoint;
  const leg2Line = seedWaypoints[seedWaypoints.indexOf(transfer) + 1].line;
  const leg1Line = transfer.line;
  const token = 'replay-3100-173';
  const seedTrip = buildTransferSeedTrip({
    token,
    waypoints: seedWaypoints,
    originStationName: metrics.origin_station as string,
    now: fixture.window.fromMs,
    overrides: { infoModeEnabled: true, activityPushToken: 'ab'.repeat(32), activityState: 'live', ...sleepOverrides(opts) },
  });
  const { db } = makeTripEventSink();
  const stub = stubReplayFetch(fixture);
  const replayer = createDeviceReplayer({
    rows: d1,
    token,
    stub,
    tapBody: (tapIndex, pushes) => {
      const tapLine = tapIndex === 0 ? leg1Line : leg2Line;
      const station = tapIndex === 0 ? (metrics.origin_station as string) : transfer.stationName;
      const prompt = pushes.map(promptPayload).find((p) => p?.line === tapLine && Array.isArray(p?.candidateTrains));
      if (!prompt) throw new Error('사슬 단절');
      return { station, line: tapLine, trainCode: prompt.trainCode as string };
    },
    mergeSyncByTs: true,
  });
  const result = await runCaptureReplay({
    fixture,
    seedTrips: [seedTrip],
    apns: 'capture',
    twoPass: true,
    beforeTick: async ({ tick, env, pushes }) => {
      (env as unknown as { DB: D1Database }).DB = db;
      stub.setNow(tick);
      await replayer.beforeTick({ tick, env: env as Env, pushes });
    },
  });
  return { fixture, d1, result, seedWaypoints, httpPushes: stub.httpPushes };
}


/** 트립 168 — 원본 replay_20261019_sleep_regression.test.ts 와 동일 재생(추정 입력 포함). */
async function replay168(opts: ReplayOpts = {}) {
  const dir = 'replay_20261019_sleep_regression';
  const token = 'replay-3100-168';
  const fixture = loadCapsFixture(dir);
  const d1 = loadD1Events(dir, 'events_168.json');
  const metrics = loadTripMetricsRow(dir, 168);
  const firstMismatch = d1.find((e) => e.kind === 'route-signature-mismatch');
  if (!firstMismatch) throw new Error('fixture 전제 실패');
  const seedWaypoints = parseRouteSig(routeSigOf(firstMismatch, 'existingSig'));
  const transfer = seedWaypoints.find((w) => w.kind === 'transfer') as Waypoint;
  const leg2Line = seedWaypoints[seedWaypoints.indexOf(transfer) + 1].line;
  const seedTrip = buildTransferSeedTrip({
    token,
    waypoints: seedWaypoints,
    originStationName: metrics.origin_station as string,
    now: fixture.window.fromMs,
    overrides: { sleepModeEnabled: true, infoModeEnabled: true, activityPushToken: 'ab'.repeat(32), activityState: 'live', ...opts },
  });
  const firstTransferSync = d1.find((e) => e.kind === 'sync-received' && e.station === transfer.stationName);
  const motionSeries: PositionPoint[] = [];
  for (let ts = (firstTransferSync as { ts: number }).ts; ts <= fixture.window.toMs; ts += 30_000) {
    motionSeries.push({ lat: 37.5, lng: 127.0, accuracy: 20, ts, motion: 'automotive' });
  }
  const heads: { tick: number; head?: string; left?: number; lock?: string }[] = [];
  const { db, events } = makeTripEventSink();
  const stub = stubReplayFetch(fixture);
  const replayer = createDeviceReplayer({
    rows: d1,
    token,
    stub,
    tapBody: (tapIndex, pushes) => {
      const base = { station: transfer.stationName, line: leg2Line };
      if (tapIndex < 2) return base;
      const prompt = pushes.map(promptPayload).find((p) => p?.line === leg2Line && Array.isArray(p?.candidateTrains));
      if (!prompt) throw new Error('사슬 단절');
      return { ...base, trainCode: prompt.trainCode as string };
    },
  });
  const result = await runCaptureReplay({
    fixture,
    seedTrips: [seedTrip],
    apns: 'capture',
    twoPass: true,
    seedPositionSeries: { [token]: motionSeries },
    beforeTick: async ({ tick, env, kv, pushes }) => {
      (env as unknown as { DB: D1Database }).DB = db;
      stub.setNow(tick);
      await replayer.beforeTick({ tick, env: env as Env, pushes });
      const trip = await getTrip(kv, token);
      heads.push({ tick, head: trip?.waypoints[0]?.stationName, left: trip?.waypoints.length, lock: trip?.boardingLock?.trainCode });
    },
  });
  const leg2Prompt = result.pushes.map(promptPayload).find((p) => p?.line === leg2Line && Array.isArray(p?.candidateTrains));
  const tracked = leg2Prompt?.trainCode as string;
  const penultimate = seedWaypoints[seedWaypoints.length - 2];
  const oneStop = fixture.entries
    .filter((e) => e.kind === 'position')
    .find((e) => {
      const list = (JSON.parse(e.body) as { realtimePositionList: { trainNo: string; statnNm: string; trainSttus: string }[] }).realtimePositionList;
      return list.some(
        (q) => q.trainNo === tracked && q.statnNm === penultimate.stationName && ([TRAIN_STATUS.APPROACHING, TRAIN_STATUS.ARRIVED] as number[]).includes(Number(q.trainSttus)),
      );
    });
  return { heads, fixture, d1, events, result, seedWaypoints, httpPushes: stub.httpPushes, oneStopMs: oneStop?.tMs };
}

/** 트립 171 — 원본 replay_20261021_sync_skipped_station_alarm.test.ts 와 동일 재생(register 주입 포함). */
async function replay171(opts: ReplayOpts = {}) {
  const dir = 'replay_20261020_sleep_171';
  const token = 'replay-3100-171';
  const fixture = loadCapsFixture(dir);
  const d1 = loadD1Events(dir, 'events_171.json');
  const metrics = loadTripMetricsRow(dir, 171, 'trip_metrics_171.json');
  const firstMismatch = d1.find((e) => e.kind === 'route-signature-mismatch');
  if (!firstMismatch) throw new Error('fixture 전제 실패');
  const seedWaypoints: Waypoint[] = parseRouteSig(routeSigOf(firstMismatch, 'existingSig'));
  const seedTrip = buildTransferSeedTrip({
    token,
    waypoints: seedWaypoints,
    originStationName: metrics.origin_station as string,
    now: fixture.window.fromMs,
    overrides: { sleepModeEnabled: true, infoModeEnabled: true, activityPushToken: 'ab'.repeat(32), activityState: 'live', ...opts },
  });
  const { db } = makeTripEventSink();
  const stub = stubReplayFetch(fixture);
  const replayer = createDeviceReplayer({
    rows: d1,
    token,
    stub,
    tapBody: () => {
      throw new Error('트립 171 D1에는 boarding-confirm-result 행이 없다');
    },
    mergeSyncByTs: true,
    register: {
      fromMs: fixture.window.fromMs,
      body: {
        destination: metrics.destination_station,
        route: seedTrip.route,
        createdAt: seedTrip.createdAt,
        infoModeEnabled: true,
        sleepModeEnabled: true,
        ...opts,
      },
    },
  });
  const result = await runCaptureReplay({
    fixture,
    seedTrips: [seedTrip],
    apns: 'capture',
    twoPass: true,
    beforeTick: async ({ tick, env, pushes }) => {
      (env as unknown as { DB: D1Database }).DB = db;
      stub.setNow(tick);
      await replayer.beforeTick({ tick, env: env as Env, pushes });
    },
  });
  return { fixture, d1, result, seedWaypoints, httpPushes: stub.httpPushes };
}

// ── 트립 173 (비취침 = 준비 알람, lock 활성) ────────────────────────────────────────────────
describe('#3100 선행 — 트립 173 실측 replay: 1역 전 알람 (준비 알람)', () => {
  it('leg-1 환승역(건대입구) 알람이 정확히 1회, 추적 열차(7031)가 2역 전 진입 이후 ~ 1역 전 출발 이전에 발사된다', async () => {
    const r = await replay173();
    const transferIdx = r.seedWaypoints.findIndex((w) => w.kind === 'transfer');
    const transfer = r.seedWaypoints[transferIdx].stationName;
    const oneBefore = r.seedWaypoints[transferIdx - 1].stationName;
    const twoBefore = r.seedWaypoints[transferIdx - 2].stationName;
    const fired = cronAlarms(r.result.cycles, transfer);
    expect(fired).toHaveLength(1);
    // 실측 오라클: 열차가 2역 전에 처음 잡힌 뒤, 1역 전을 출발(sts=2)하기 전.
    const lower = firstSightingMs(r.fixture, '7031', twoBefore) as number;
    const upper = firstSightingMs(r.fixture, '7031', oneBefore, [TRAIN_STATUS.DEPARTED]) as number;
    expect(fired[0]).toBeGreaterThanOrEqual(lower);
    expect(fired[0]).toBeLessThanOrEqual(upper);
  });

  it('leg-2 하차역(뚝섬) 알람은 캡처 안에서 0 — 추적 열차(3009)가 캡처 종료까지 1역 전(성수)에 도달하지 않았기 때문(결함 아님)', async () => {
    const r = await replay173();
    const destination = r.seedWaypoints[r.seedWaypoints.length - 1].stationName;
    const oneBefore = r.seedWaypoints[r.seedWaypoints.length - 2].stationName;
    expect(firstSightingMs(r.fixture, '3009', oneBefore)).toBeUndefined();
    expect(cronAlarms(r.result.cycles, destination)).toEqual([]);
  });
});

// ── 트립 171 (취침) ───────────────────────────────────────────────────────────────────────
describe('#3100 선행 — 트립 171 실측 replay: 1역 전 알람 (취침 알람)', () => {
  /** 실측 D1: 06:38:45.151 sync-received(성수). 사용자가 실제 탄 열차(2011)도 같은 순간 성수 도착(캡처 925522). */
  const SYNC_SEONGSU_TS = 1792445925151;

  it('하차역(뚝섬) 취침 알람이 정확히 1회 — sync가 1역 전(성수)을 소비한 06:38:45에 발사 (cron 재진입·register 반복에도 중복 0)', async () => {
    const r = await replay171();
    const destination = r.seedWaypoints[r.seedWaypoints.length - 1].stationName;
    const oneBefore = r.seedWaypoints[r.seedWaypoints.length - 2].stationName;
    const httpAlarms = r.httpPushes.filter((p) => (p.aps as Body | undefined)?.sound === 'alarm.wav');
    expect(httpAlarms).toHaveLength(1);
    const companions = r.httpPushes.filter((p) => (p.data as Body | undefined)?.kind === 'sleep-alarm-companion');
    expect(companions).toHaveLength(1);
    expect(companions[0].data).toMatchObject({ nextStation: destination, originStation: oneBefore, sentAt: SYNC_SEONGSU_TS });
    expect(cronAlarms(r.result.cycles, destination)).toEqual([]);
    // 오라클: 사용자가 실제 탄 열차(2011)가 1역 전(성수)에 도착한 캡처와 1초 이내.
    const userTrainAtOneBefore = firstSightingMs(r.fixture, '2011', oneBefore) as number;
    expect(Math.abs(userTrainAtOneBefore - SYNC_SEONGSU_TS)).toBeLessThan(1_000);
  });

  it('leg-1 환승역(건대입구) 알람은 0 — leg-1 구간은 lock 없음("lock 없음 = 알림 없음", #3140 의도)', async () => {
    const r = await replay171();
    const transfer = r.seedWaypoints.find((w) => w.kind === 'transfer') as Waypoint;
    expect(cronAlarms(r.result.cycles, transfer.stationName)).toEqual([]);
    const transferAlarms = r.httpPushes.filter((p) => {
      const aps = p.aps as { sound?: string; alert?: { body?: string } } | undefined;
      return aps?.sound === 'alarm.wav' && (aps.alert?.body ?? '').includes(transfer.stationName);
    });
    expect(transferAlarms).toEqual([]);
  });
});

// ── 트립 168 (취침) ───────────────────────────────────────────────────────────────────────
describe('#3100 선행 — 트립 168 실측 replay: 1역 전 알람 (취침 알람)', () => {
  // #3083 PR-1 — 가짜 전진 소멸의 직접 귀결로 갱신: 이전 단언(`head=하차역, left=1` + "lockless 구간에 1역 전이 head였던
  // tick 존재")은 체류 중 sync 가짜 전진이 1역 전을 lock 이전에 소비했다는 결함 고정이었다.
  it('[#3083] lock(7268) 부착 시점에 leg-2 waypoint가 하나도 소비되지 않았고, lockless 구간 어느 tick도 1역 전·하차역이 head가 아니다', async () => {
    const r = await replay168();
    const destination = r.seedWaypoints[r.seedWaypoints.length - 1].stationName;
    const oneBefore = r.seedWaypoints[r.seedWaypoints.length - 2].stationName;
    const firstLocked = r.heads.find((h) => h.lock !== undefined);
    const leg2Start = r.seedWaypoints.findIndex((w) => w.kind === 'transfer') + 1;
    expect(firstLocked).toMatchObject({
      head: r.seedWaypoints[leg2Start].stationName,
      left: r.seedWaypoints.length - leg2Start,
    });
    const lockless = r.heads.filter((h) => h.lock === undefined);
    expect(lockless.some((h) => h.head === oneBefore || h.head === destination)).toBe(false);
  });

  it('1역 전 도달(18:14:47) 이전에는 하차 알람이 발사되지 않는다 (조기 발사 0, #3140)', async () => {
    const r = await replay168();
    const destination = r.seedWaypoints[r.seedWaypoints.length - 1].stationName;
    const early = cronAlarms(r.result.cycles, destination).filter((at) => at < (r.oneStopMs as number) - 60_000);
    expect(early).toEqual([]);
  });

  // #3100 선행 — 1역 전 결함: lockless 가짜 전진(#3083)이 lock 부착 전에 1역 전 waypoint를 소비 -> 이후 lock이 붙어도 하차 알람 영구 미발사.
  // #3083 PR-1로 sync 가짜 전진이 사라져 통과로 바뀜 — `.fails` 제거.
  it('하차역 취침 알람이 추적 열차의 1역 전 도달(18:14:47) 전후 1 cron 주기 안에 정확히 1회 발사된다', async () => {
    const r = await replay168();
    const destination = r.seedWaypoints[r.seedWaypoints.length - 1].stationName;
    const fired = cronAlarms(r.result.cycles, destination);
    expect(fired).toHaveLength(1);
    // 틱 그리드 기준: 1역 전 도달이 캡처된 이후 첫 cron tick에서 발사된다(±60s 느슨한 창 대신 정확한 tick).
    const firstTickAtOrAfter = r.result.cycles
      .map((c) => c.simNowMs)
      .find((t) => t >= (r.oneStopMs as number)) as number;
    expect(fired[0]).toBe(firstTickAtOrAfter);
  });
});

// ── #3100 PR-1 — 실측 트립 위에 "N역 전부터" 설정 주입 (caps·D1 불변, 설정 필드만 seed) ─────────────
const range = (from: number, to: number): number[] => Array.from({ length: Math.max(to - from + 1, 0) }, (_, i) => from + i);
const EVERY_MAX: SleepAlarmConfig = { mode: 'every', stops: [SLEEP_ALARM_MAX_STOPS_BEFORE] };

/** `alarm-[s{N}-]<token>-<역>` 취침 알람의 (시각, 남은 정거장). 접미사 없음 = 기본 칸. */
function cronSleepAlarmRemainings(cycles: { simNowMs: number; pushes: CapturedPush[] }[], station: string) {
  const out: { at: number; remaining: number }[] = [];
  for (const c of cycles) {
    for (const p of c.pushes) {
      const id = alarmCollapseId(p.body, p.headers.collapseId);
      const m = id?.match(/^alarm-(?:s(\d+)-)?/);
      if (id?.endsWith(`-${station}`) && m) {
        out.push({ at: c.simNowMs, remaining: m[1] === undefined ? SLEEP_ALARM_MIN_STOPS_BEFORE : Number(m[1]) });
      }
    }
  }
  return out;
}

describe('#3100 PR-1 — 트립 173 실측 replay + 설정 {매 역, MAX} 주입 (취침 ON)', () => {
  it('leg-1 환승역(건대입구): 남은 칸이 각각 정확히 1회, 시간순으로 줄어들고, 기본 칸은 기본값 발사 시각과 같다', async () => {
    const base = await replay173();
    const transferIdx = base.seedWaypoints.findIndex((w) => w.kind === 'transfer');
    const transfer = base.seedWaypoints[transferIdx].stationName;
    const defaultFiredAt = cronAlarms(base.result.cycles, transfer);
    expect(defaultFiredAt).toHaveLength(1);

    const injected = await replay173({ sleepAlarm: EVERY_MAX });
    const fired = cronSleepAlarmRemainings(injected.result.cycles, transfer);
    // 각 남은 수는 정확히 1회 -> 중복 0
    expect(new Set(fired.map((f) => f.remaining)).size).toBe(fired.length);
    // 시간이 흐를수록 남은 수는 줄어든다
    for (let i = 1; i < fired.length; i++) {
      expect(fired[i].at).toBeGreaterThanOrEqual(fired[i - 1].at);
      expect(fired[i].remaining).toBeLessThan(fired[i - 1].remaining);
    }
    // 기본 칸(1역 전)은 기본값(준비 알람)이 발사하던 바로 그 cron tick
    const oneBefore = fired.find((f) => f.remaining === SLEEP_ALARM_MIN_STOPS_BEFORE);
    expect(oneBefore?.at).toBe(defaultFiredAt[0]);
    // fixture에서 도출한 정확한 기대: 시드 경로의 환승역 앞 중간역 수 m -> 남은 [min(m, MAX) .. MIN] 전부 1회
    const m = transferIdx;
    const expectedRemainings = range(SLEEP_ALARM_MIN_STOPS_BEFORE, Math.min(m, SLEEP_ALARM_MAX_STOPS_BEFORE)).reverse();
    expect(fired.map((f) => f.remaining)).toEqual(expectedRemainings);
  });
});

// #3100 (plan v4.2 (b)) — 회귀 가드: 취침 mute를 intermediate 한정으로 좁혀도(환승·하차 도착 station- 해제)
// 173 실측 취침 ON run에서 intermediate 매역 station- push는 여전히 0이고, alarm-/prepare- 알람 목록은 불변.
// 주의: 173 비취침 base에는 transfer/destination station- push가 0건이라 환승·하차 발사 자체의 실측 오라클은 없다
// (그쪽은 단위 테스트 M1/M2/M3가 담당) — 이 테스트는 "intermediate mute 유지 + 알람 목록 불변" 가드다.
describe('#3100 — 트립 173 실측 replay 취침 ON: intermediate station- = 0, alarm-/prepare- 목록 불변', () => {
  it('intermediate 매역 station- push 0 + alarm-/prepare- (tick, collapse-id) 목록이 변경 전과 동일', async () => {
    const r = await replay173({ sleepAlarm: EVERY_MAX });
    const intermediates = new Set(r.seedWaypoints.filter((w) => w.kind === 'intermediate').map((w) => w.stationName));
    const stationPushes = r.result.cycles.flatMap((c) =>
      c.pushes
        .map((p) => p.headers.collapseId ?? '')
        .filter((id) => id.startsWith('station-'))
        .map((id) => ({ tick: c.simNowMs, id })),
    );
    const intermediateStationPushes = stationPushes.filter(({ id }) =>
      [...intermediates].some((name) => id.endsWith(`-${name}`)),
    );
    expect(intermediateStationPushes).toEqual([]);

    const alarmPushes = r.result.cycles.flatMap((c) =>
      c.pushes
        .map((p) => p.headers.collapseId ?? '')
        .filter((id) => /^(?:alarm|prepare)-/.test(id))
        .map((id) => ({ tick: c.simNowMs, id })),
    );
    // 변경 전(origin/dev 521510a5) 실측 재생 결과 — 불변 기준값.
    expect(alarmPushes).toEqual([
      { tick: 1792531306590, id: 'alarm-s3-replay-3100-173-건대입구' },
      { tick: 1792531426587, id: 'alarm-s2-replay-3100-173-건대입구' },
      { tick: 1792531546525, id: 'alarm-replay-3100-173-건대입구' },
    ]);
  });
});

// #3100 PR-2 — sync catch-up(`fireSyncConsumedPrecedingAlarms`)이 설정의 칸 집합을 따른다. 기대는 fixture 시드 경로에서 도출한다:
// 하차역이 속한 leg(마지막 환승 뒤)의 중간역 수 m -> 설정 칸 ∩ [MIN, m]. 171의 leg-2는 성수 하나뿐(m = MIN)이라
// 도출 집합이 기본값과 같다 — 칸 구분이 필요한 비기본 점프는 아래 173 leg-1 HTTP 테스트와 index.sleepAlarmSyncN*.test.ts가 덮는다.
describe('#3100 PR-2 — 트립 171 실측 replay + 설정 {매 역, MAX} 주입: sync catch-up이 시드 경로에서 도출한 칸 집합을 따른다', () => {
  it('하차역(뚝섬) 취침 알람이 도출 집합(남은 수)만큼 정확히 1회씩, 기본 칸은 칸 구분 필드 없음', async () => {
    const r = await replay171({ sleepAlarm: EVERY_MAX });
    const lastTransferIdx = r.seedWaypoints.map((w) => w.kind).lastIndexOf('transfer');
    const legIntermediates = r.seedWaypoints.length - 1 - (lastTransferIdx + 1);
    const expectedRemainings = range(SLEEP_ALARM_MIN_STOPS_BEFORE, Math.min(legIntermediates, SLEEP_ALARM_MAX_STOPS_BEFORE));
    const httpAlarms = r.httpPushes.filter((p) => (p.aps as Body | undefined)?.sound === 'alarm.wav');
    expect(httpAlarms).toHaveLength(expectedRemainings.length);
    const companions = r.httpPushes.filter((p) => (p.data as Body | undefined)?.kind === 'sleep-alarm-companion');
    expect(companions.map((c) => (c.data as Body).remainingStops)).toEqual(
      expectedRemainings.map((remaining) => (remaining === SLEEP_ALARM_MIN_STOPS_BEFORE ? undefined : remaining)),
    );
    for (const c of companions) {
      if ((c.data as Body).remainingStops === undefined) expect(c.data).not.toHaveProperty('remainingStops');
    }
  });
});

// #3100 PR-2 (R2) — 173 leg-1(시드 경로에서 도출)을 HTTP `/boarding-lock/sync` 순수 점프로 소비한다. index.ts 게이트가
// `readSleepAlarmStops` 단일 출처를 쓰는지(헬퍼를 기본값만 반환하도록 바꾸면 이 테스트가 red)를 실측 경로 위에서 고정한다.
describe('#3100 PR-2 — 트립 173 leg-1 경로 + 설정 {매 역, MAX} 주입: HTTP 순수 점프가 칸 집합을 따른다', () => {
  it('점프마다 도출한 남은 수로 정확히 1회(타깃 소비는 0), 칸 구분 필드는 비기본 칸만', async () => {
    const { seedWaypoints } = await replay173({ sleepAlarm: EVERY_MAX });
    const transferIdx = seedWaypoints.findIndex((w) => w.kind === 'transfer');
    const leg1 = seedWaypoints.slice(0, transferIdx + 1);
    const legIntermediates = transferIdx;
    for (const jump of range(SLEEP_ALARM_MIN_STOPS_BEFORE, leg1.length)) {
      const remaining = legIntermediates - jump + SLEEP_ALARM_MIN_STOPS_BEFORE;
      const expected = remaining >= SLEEP_ALARM_MIN_STOPS_BEFORE && remaining <= SLEEP_ALARM_MAX_STOPS_BEFORE ? remaining : undefined;
      const r = await syncObserved(lockActiveTrip(leg1, { sleepAlarm: EVERY_MAX }), leg1[jump - 1].stationName);
      const data = r.companions.map((c) => c.body.data as Body);
      const wireRemaining = expected === SLEEP_ALARM_MIN_STOPS_BEFORE ? undefined : expected;
      expect(data.map((d) => d.remainingStops)).toEqual(expected === undefined ? [] : [wireRemaining]);
      expect(r.alarms).toHaveLength(expected === undefined ? 0 : 1);
    }
  });
});

// #3083 PR-1(#3211) 이후: 환승 체류 중 lockless 가짜 전진이 사라져 leg-2 칸이 lock 이후 실측 도착에 맞춰 정시 발사된다.
describe('#3100 PR-1 — 트립 168 실측 replay + 설정 {매 역, MAX} 주입: #3083 PR-1 이후 가짜 전진 소멸로 leg-2 칸이 lock 후 정시 발사', () => {
  it('하차역 알람이 남은 [3,2,1]로 각 1회, 각 역의 7268 도착 관측 이후·다음 역 도착 관측 이전, lock 부착 이전 발사 0', async () => {
    const { seedWaypoints, fixture, heads, result } = await replay168({ sleepAlarm: EVERY_MAX });
    const destIdx = seedWaypoints.length - 1;
    const destination = seedWaypoints[destIdx].stationName;
    const trainCode = '7268';

    const fired = cronSleepAlarmRemainings(result.cycles, destination);
    expect(fired.map((f) => f.remaining)).toEqual([3, 2, 1]);

    const lockAttachedAt = heads.find((h) => h.lock !== undefined)?.tick as number;
    expect(lockAttachedAt).toBeDefined();

    fired.forEach(({ at, remaining }) => {
      const station = seedWaypoints[destIdx - remaining].stationName;
      const nextStation = seedWaypoints[destIdx - remaining + 1].stationName;
      const arrivedAt = firstSightingMs(fixture, trainCode, station, [TRAIN_STATUS.ARRIVED]) as number;
      expect(arrivedAt).toBeDefined();
      expect(at).toBeGreaterThanOrEqual(arrivedAt);
      expect(at).toBeGreaterThanOrEqual(lockAttachedAt);
      const nextArrivedAt = firstSightingMs(fixture, trainCode, nextStation, [TRAIN_STATUS.ARRIVED]);
      if (nextArrivedAt !== undefined) expect(at).toBeLessThan(nextArrivedAt);
    });
  });
});

// ── #3100 v2 — "선택한 역에서만" 실측 replay: 칸은 타깃당 1회, 남은 수 <= N 이 된 첫 평가에서 ─────────────
const SELECTED_MAX: SleepAlarmConfig = { mode: 'selected', stops: [SLEEP_ALARM_MAX_STOPS_BEFORE] };

describe('#3100 v2 — 트립 171 실측 replay + 설정 {선택, MAX}: 짧은 leg(남은 1)에서 정확히 1회, 기본값 실행과 같은 시각', () => {
  /** 실측 D1: 06:38:45.151 sync-received(성수). */
  const SYNC_SEONGSU_TS = 1792445925151;

  it('하차역(뚝섬) 알람 1회 · 남은 수 MIN(문구에 칸 MAX가 새지 않음) · companion sentAt이 기본값 실행의 companion과 동일(1792445925151)', async () => {
    const base = await replay171();
    const sel = await replay171({ sleepAlarm: SELECTED_MAX });
    const destination = sel.seedWaypoints[sel.seedWaypoints.length - 1].stationName;
    const isCompanion = (p: Body) => (p.data as Body | undefined)?.kind === 'sleep-alarm-companion';
    const baseCompanions = base.httpPushes.filter(isCompanion);
    expect(baseCompanions).toHaveLength(1);

    const alarms = sel.httpPushes.filter((p) => (p.aps as Body | undefined)?.sound === 'alarm.wav');
    expect(alarms).toHaveLength(1);
    const companions = sel.httpPushes.filter(isCompanion);
    expect(companions).toHaveLength(1);
    expect(companions[0].data).toMatchObject({ nextStation: destination, sentAt: (baseCompanions[0].data as Body).sentAt });
    expect((companions[0].data as Body).sentAt).toBe(SYNC_SEONGSU_TS);
    expect(companions[0].data).not.toHaveProperty('remainingStops');
    expect(cronAlarms(sel.result.cycles, destination)).toEqual([]);
  });
});

describe('#3100 v2 — 트립 168 실측 replay + 설정 {선택, MAX}: 긴 leg에서 MAX 칸만 1회, {매 역, MAX}의 MAX 칸과 같은 tick', () => {
  it('하차역 알람이 남은 MAX 하나뿐(2·1역 전에서 재발사 0)이고 시각 = {매 역, MAX} 실행의 남은 MAX 알람 tick', async () => {
    const every = await replay168({ sleepAlarm: EVERY_MAX });
    const sel = await replay168({ sleepAlarm: SELECTED_MAX });
    const destination = sel.seedWaypoints[sel.seedWaypoints.length - 1].stationName;
    const everyMax = cronSleepAlarmRemainings(every.result.cycles, destination).find(
      (f) => f.remaining === SLEEP_ALARM_MAX_STOPS_BEFORE,
    );
    expect(everyMax).toBeDefined();
    expect(cronSleepAlarmRemainings(sel.result.cycles, destination)).toEqual([
      { at: (everyMax as { at: number }).at, remaining: SLEEP_ALARM_MAX_STOPS_BEFORE },
    ]);
  });
});
