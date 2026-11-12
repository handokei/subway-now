/**
 * #3350 — 2026-11-12 17:22~17:41 트립(토큰 해시 b00dd879, 뚝섬(2) -> 건대입구 환승 -> 용마산(7), 취침) whole-trip replay.
 *
 * 사고: leg-1(2호선)에서 lock이 한 번도 안 생긴(D1 lock 이벤트 0, 2호선 열차 2336이 피드에 부재) lockless 트립이 건대입구에 도착해
 * `sync-received 건대입구`(17:25:31)를 보냈지만 `advance-held requested:2 cappedTo:0`(K5 #2926 PR-A)로 환승 waypoint가 소비되지 않았다.
 * 결과: head가 끝까지 성수에 남고(currentLegAnchor 없음) leg-2 평가(`maybeFireLegBoardingPrompt`)가 `!currentLegAnchor`로 return — 7호선 탑승 기회 0.
 * 사용자 결정(11/12): "leg-1에서는 못했어도 leg-2는 제대로 진행할 수 있어야 한다" — lock 없음=알림 없음 정책은 유지하되 환승 경계만 소비한다.
 *
 * 입력은 불변 실측 — `fixtures/replay_20261112_leg2_transfer_boundary/`:
 *   - capture.fixture.json : `scripts/fixtureFromTrip.mjs --token-hash b00dd879`가 R2 seoul-capture 19 cycle(17:22:46~)을 병합한 원문.
 *   - events.json : D1 trip_events 2408~2425 원문. sync-received·trip-register를 원래 시각 순서대로 주입한다(createDeviceReplayer).
 * 통과시키려 조정 금지. 합성 입력은 없다(motion 시리즈 없음 — D1 position-kv-sample hasAccel=false 와 일치).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { MID_CYCLE_OFFSET_MS } from '../cronConstants';
import { parseReplayFixture, type ReplayFixture } from '../replayFixture';
import type { Env, Trip } from '../types';
import { attachDb, latestTrip } from './helpers/progressAuthorityReplay';
import { createDeviceReplayer, loadD1Events, postBoardingConfirmAt, makeTripEventSink, parseRouteSig, routeSigOf, stubReplayFetch } from './helpers/replay20261019';
import { runCaptureReplay } from './helpers/replayHarness';
import { useApnsHarness } from './helpers/sleepAlarmHarness';

useApnsHarness();
afterEach(() => vi.unstubAllGlobals());

const DIR = 'replay_20261112_leg2_transfer_boundary';
let tokenSeq = 0;
/** `advance-held` D1 dedup이 isolate 메모리(token 해시 키)라 replay마다 token을 달리한다. */
let TOKEN = '';
const KST_OFFSET_MS = 9 * 3600_000;
const kst = (ms: number) => new Date(ms + KST_OFFSET_MS).toISOString().slice(11, 19);

const rows = loadD1Events(DIR, 'events.json');
const rowOf = (id: number) => {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`D1 행 ${id}이 fixture에 없다`);
  return row;
};
const fixture = parseReplayFixture(JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', DIR, 'capture.fixture.json'), 'utf-8')));

/** D1 2415 existingSig = backend가 17:23:49에 가진 전체 노선(성수 -> 건대입구 환승 -> 어린이대공원 -> 군자 -> 중곡 -> 용마산). */
const ROUTE = parseRouteSig(routeSigOf(rowOf(2415), 'existingSig')).map((w, hopIndex) => ({ ...w, hopIndex }));
const TRANSFER = ROUTE.find((w) => w.kind === 'transfer')!;
const LEG2 = ROUTE.filter((w) => w.line === '7');
const TRANSFER_SYNC = rowOf(2418); // sync-received 건대입구 17:25:31
const INTERMEDIATE_SYNC = rowOf(2413); // sync-received 성수 17:23:33
const FROM_MS = INTERMEDIATE_SYNC.ts - 1000;

function seedTrip(): Trip {
  const transferIndex = ROUTE.findIndex((w) => w.kind === 'transfer');
  const destination = ROUTE[ROUTE.length - 1];
  return {
    token: TOKEN,
    route: {
      type: 'transfer',
      transferName: TRANSFER.stationName,
      fromLine: TRANSFER.line,
      toLine: LEG2[0].line,
      stopsToTransfer: transferIndex + 1,
      stopsFromTransfer: ROUTE.length - transferIndex - 1,
    },
    destination: destination.stationName,
    waypoints: ROUTE.map((w) => ({ ...w })),
    routeWaypoints: ROUTE.map((w) => ({ ...w })),
    originStationName: '뚝섬',
    createdAt: rowOf(2408).ts,
    alarmAtEpochMs: FROM_MS,
    expiresAt: FROM_MS + 3 * 60 * 60_000,
    infoModeEnabled: true,
    sleepModeEnabled: true,
    consecutiveEtaMissing: 0,
    // 실측: 17:25:31 hop-end-prompt가 la-boarding-start(path hop-end-prompt, status 200)로 나갔다 = push-to-start 대상 기기.
    laClient: { split: true },
    boardingPushToStartToken: 'p2s-token',
  } as unknown as Trip;
}

/** 실측 R2: 7호선 상행(장암행) 7254가 건대입구에 17:30:06 도착(sts 1) -> 어린이대공원 17:33:08 -> 군자 17:35:24. 이 열차를 leg-2 실열차로 선택한다. */
const LEG2_TRAIN = '7254';
const TAP_FROM_MS = 1794472250000; // 2026-11-12 17:30:50 KST — 7254 건대입구 관측이 담긴 17:30:46 cycle 직후

type Tap = 'prompt-tap' | 'list-tap';

async function replay(opts: { tap?: Tap; midFixture?: ReplayFixture } = {}) {
  TOKEN = `replay-3350-${(tokenSeq += 1)}`;
  const trip = seedTrip();
  const { db, events } = makeTripEventSink();
  const stub = stubReplayFetch(fixture);
  const replayer = createDeviceReplayer({
    rows: rows.filter((r) => r.ts >= FROM_MS),
    token: TOKEN,
    stub,
    tapBody: () => ({ station: TRANSFER.stationName, line: '7' }),
    mergeSyncByTs: true,
    register: {
      fromMs: FROM_MS,
      body: {
        destination: trip.destination,
        route: trip.route,
        createdAt: trip.createdAt,
        infoModeEnabled: true,
        sleepModeEnabled: true,
      },
    },
  });
  let tapped = false;
  const tapResponses: unknown[] = [];
  const heads: Array<{ tick: number; at: string; head: string | undefined; anchor: Trip['currentLegAnchor']; lockTrain: string | undefined }> = [];
  let kvRef: KVNamespace | undefined;
  const result = await runCaptureReplay({
    fixture: { ...fixture, cycleStartsMs: fixture.cycleStartsMs.filter((c) => c + 1000 >= FROM_MS) },
    seedTrips: [trip],
    apns: 'capture',
    ...(opts.midFixture ? { twoPass: true, midFixture: opts.midFixture } : {}),
    beforeTick: async ({ tick, env, kv, pushes }) => {
      kvRef = kv;
      const snapshot = latestTrip(kv, TOKEN);
      heads.push({ tick, at: kst(tick), head: snapshot?.waypoints[0]?.stationName, anchor: snapshot?.currentLegAnchor, lockTrain: snapshot?.boardingLock?.trainCode });
      attachDb(env as Env, db);
      stub.setNow(tick);
      await replayer.beforeTick({ tick, env: env as Env, pushes });
      if (opts.tap && !tapped && tick >= TAP_FROM_MS) {
        tapped = true;
        const spy = vi.spyOn(Date, 'now').mockReturnValue(tick);
        try {
          if (opts.tap === 'prompt-tap') {
            // 프롬프트 탭 = boarding-confirm(실열차 코드 동봉).
            const res = await postBoardingConfirmAt(tick, env as Env, TOKEN, { station: TRANSFER.stationName, line: '7', trainCode: LEG2_TRAIN });
            tapResponses.push(await res.json());
          } else {
            // 목록 탭 = sync explicitTap(trainCode + boardingLine).
            const res = await app.fetch(
              new Request('http://example.com/boarding-lock/sync', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ token: TOKEN, observedStationName: TRANSFER.stationName, observedAtMs: tick, accuracy: 20, trainCode: LEG2_TRAIN, boardingLine: '7' }),
              }),
              env as Env,
            );
            tapResponses.push(await res.json());
          }
        } finally {
          spy.mockRestore();
        }
      }
    },
  });
  const final = latestTrip(kvRef as KVNamespace, TOKEN);
  return { result, events, heads, final, tapResponses };
}

describe('#3350 11/12 lockless leg-1 뒤 환승역 — leg-2 경계로 전환 (b00dd879)', () => {
  it('전제: 실측 D1 — 건대입구 sync가 advance-held(requested 2 -> 0)였고 leg-2 이벤트·currentLegAnchor는 0이었다', () => {
    const held = rowOf(2419);
    expect(held.kind).toBe('advance-held');
    expect(JSON.parse(held.meta as string)).toEqual({ requested: 2, cappedTo: 0 });
    expect(TRANSFER_SYNC.station).toBe(TRANSFER.stationName);
  });

  it('★건대입구 sync 이후 head=어린이대공원(leg-2 첫 역), currentLegAnchor={건대입구,7}', async () => {
    const r = await replay();
    expect(r.final?.waypoints.map((w) => w.stationName)).toEqual(LEG2.map((w) => w.stationName));
    expect(r.final?.currentLegAnchor).toEqual({ boardingStation: TRANSFER.stationName, line: '7' });
  });

  it('거부: 환승 전 intermediate(성수) 관측(17:23:33)은 전진 0 — 17:25:31 이전 tick은 head 성수·anchor 없음 유지', async () => {
    const r = await replay();
    const before = r.heads.filter((h) => h.at < kst(TRANSFER_SYNC.ts));
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((h) => h.head === ROUTE[0].stationName && h.anchor === undefined)).toBe(true);
    const heldRows = r.events.filter((e) => e.kind === 'advance-held');
    expect(heldRows.map((e) => e.station)).toContain(ROUTE[0].stationName);
  });

  it('거부: 환승 관측은 환승 waypoint까지만 — 그 너머(leg-2 intermediate) 소비 없음(#3083 가짜 진행 금지)', async () => {
    const r = await replay();
    // tick 스냅샷은 그 tick의 sync 주입 **전** 값이라, sync 이후 값은 sync ts를 지난 첫 tick의 다음부터다.
    const firstTickAfterSync = r.heads.findIndex((h) => h.tick >= TRANSFER_SYNC.ts);
    const after = r.heads.slice(firstTickAfterSync + 1);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((h) => h.head === LEG2[0].stationName)).toBe(true);
  });

  it('이후 cron이 7호선 leg-boarding-prompt를 평가하고 그 outcome이 D1에 기록된다(SSoT 없이)', async () => {
    const r = await replay();
    const leg2Rows = r.events.filter((e) => e.kind === 'leg-boarding-prompt' && e.meta.leg !== 'origin' && e.line === '7');
    expect(leg2Rows.length).toBeGreaterThan(0);
    expect(leg2Rows.map((e) => e.meta.outcome)).not.toContain('no-anchor');
  });
});

describe('#3350 leg-2 lock 3경로 (leg-1 lockless 뒤) — b00dd879 실열차 7254', () => {
  const leg2Stations = LEG2.filter((w) => w.kind === 'intermediate').map((w) => w.stationName);

  it('LA 버튼 칸: leg-2 탑승 프롬프트와 함께 la-boarding-start(path boarding-prompt, 7호선)가 나간다', async () => {
    const r = await replay();
    const starts = r.events.filter((e) => e.kind === 'la-boarding-start' && e.meta.path === 'boarding-prompt' && e.line === '7');
    expect(starts.length).toBeGreaterThan(0);
    expect(starts[0].meta).toMatchObject({ phase: 'pre-boarding', ok: true });
  });

  it.each<[string, Tap]>([
    ['프롬프트 탭(boarding-confirm)', 'prompt-tap'],
    ['목록 탭(sync explicitTap)', 'list-tap'],
  ])('%s: 7호선 실열차 7254 lock 생성 -> 이후 cron에서 stale-line release 없이 유지 -> 매역 발사 진입', async (_label, tap) => {
    const r = await replay({ tap });
    expect(r.events.filter((e) => e.kind === 'lock-attached' && e.meta.trainCode === LEG2_TRAIN)).toHaveLength(1);
    // (b) tap 이후 snapshot이 있는 모든 tick에서 lock 열차가 7254로 유지된다(stale-line release/재부착 없음).
    // 스냅샷은 tick의 탭 주입 전 값이라 탭 tick 자체는 제외(첫 tick >= TAP_FROM_MS 다음부터).
    const tapTickIdx = r.heads.findIndex((h) => h.tick >= TAP_FROM_MS);
    const afterTap = r.heads.slice(tapTickIdx + 1).filter((h) => h.head !== undefined);
    expect(afterTap.length).toBeGreaterThan(0);
    expect(afterTap.every((h) => h.lockTrain === LEG2_TRAIN)).toBe(true);
    expect(r.events.filter((e) => e.kind === 'lock-released')).toEqual([]);
    // (c) 매역 발사 경로 진입: lock 이후 leg-2 intermediate에 대한 cron-fire-attempt가 기록된다.
    const attempts = r.events.filter((e) => e.kind === 'cron-fire-attempt' && e.station !== null && leg2Stations.includes(e.station));
    expect(attempts.length).toBeGreaterThan(0);
  });
});

/**
 * #3357 — midCycle(t+30) pass가 보는 Seoul 응답 view.
 *
 * R2 seoul-capture recorder는 1차 pass의 SeoulArrivalClient만 감싼다(index.ts handler.scheduled — `createSeoulCaptureRecorder`;
 * `scheduleMidCyclePass`는 recorder 없는 fresh client). 그래서 capture.fixture.json 엔트리는 전부 cycle 시작 +0.7~3.6s 이내이고
 * t+30 응답은 원천적으로 없다. 가장 가까운 실측 근거는 **다음 cycle의 position 엔트리 행 중 recptnDt <= mid 시각**인 행
 * (Seoul이 그 시각에 이미 발행한 행 = t+30에 조회했다면 보였을 하한)이다. 원본 엔트리는 건드리지 않고 파생 view만 만든다.
 */
const KST_DATETIME = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
function recptnEpochMs(recptnDt: string): number {
  const m = KST_DATETIME.exec(recptnDt);
  if (!m) throw new Error(`recptnDt 형식 이상: ${recptnDt}`);
  const [, y, mo, d, h, mi, se] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, se) - KST_OFFSET_MS;
}
function buildMidCycleView(base: ReplayFixture): ReplayFixture {
  const starts = base.cycleStartsMs;
  const midEntries: ReplayFixture['entries'] = [];
  starts.forEach((start, idx) => {
    const next = starts[idx + 1];
    if (next === undefined) return;
    const midMs = start + MID_CYCLE_OFFSET_MS;
    const inCycle = (tMs: number, from: number, to: number) => tMs >= from && tMs < to;
    for (const entry of base.entries) {
      if (entry.kind === 'position' && inCycle(entry.tMs, next, next + 10_000)) {
        const parsed = JSON.parse(entry.body) as { realtimePositionList?: Array<{ recptnDt: string }> };
        const visible = (parsed.realtimePositionList ?? []).filter((row) => recptnEpochMs(row.recptnDt) <= midMs);
        midEntries.push({ ...entry, tMs: midMs, body: JSON.stringify({ ...parsed, realtimePositionList: visible }) });
      } else if (entry.kind === 'arrival' && inCycle(entry.tMs, start, start + 10_000)) {
        midEntries.push({ ...entry, tMs: midMs });
      }
    }
  });
  return { ...base, entries: [...base.entries, ...midEntries].sort((a, b) => a.tMs - b.tMs) };
}

describe('#3357 목적지(용마산) 취침 알람 — midCycle pass 재현', () => {
  const DESTINATION = ROUTE[ROUTE.length - 1].stationName;
  const destinationAttempts = (events: Awaited<ReturnType<typeof replay>>['events']) =>
    events.filter((e) => e.kind === 'cron-fire-attempt' && e.station === DESTINATION);

  it('전제(실측): 1차 pass만으로는 7254가 용마산 도착 tick에 arvlCd 부재 + SSoT stale(중곡 17:38:46) -> destination 알람 미발사', async () => {
    const r = await replay({ tap: 'list-tap' });
    const attempts = destinationAttempts(r.events);
    expect(attempts.map((e) => e.meta)).toEqual([
      { waypointKind: 'destination', phase: 'imminent', outcome: 'skipped-reason', reason: 'ssot-stale', path: 'vanish-fallback' },
    ]);
  });

  it('★midCycle pass(프로덕션과 같은 runMidCycleFireOnly)를 포함하면 용마산 destination이 sent(midCycle:true)로 나간다', async () => {
    const r = await replay({ tap: 'list-tap', midFixture: buildMidCycleView(fixture) });
    const sent = destinationAttempts(r.events).filter((e) => e.meta.outcome === 'sent');
    expect(sent).toHaveLength(1);
    expect(sent[0].meta).toMatchObject({ waypointKind: 'destination', midCycle: true });
  });

  it('거부: mid view는 recptnDt > t+30 행을 노출하지 않는다(미래 행 누수 금지)', () => {
    const view = buildMidCycleView(fixture);
    const midEntries = view.entries.filter((e) => !fixture.entries.includes(e) && e.kind === 'position');
    expect(midEntries.length).toBeGreaterThan(0);
    for (const entry of midEntries) {
      const rowsOf = (JSON.parse(entry.body) as { realtimePositionList?: Array<{ recptnDt: string }> }).realtimePositionList ?? [];
      expect(rowsOf.every((row) => recptnEpochMs(row.recptnDt) <= entry.tMs)).toBe(true);
    }
  });
});
