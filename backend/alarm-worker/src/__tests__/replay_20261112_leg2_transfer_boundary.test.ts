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
import { parseReplayFixture } from '../replayFixture';
import type { Env, Trip } from '../types';
import { attachDb, latestTrip } from './helpers/progressAuthorityReplay';
import { createDeviceReplayer, loadD1Events, makeTripEventSink, parseRouteSig, routeSigOf, stubReplayFetch } from './helpers/replay20261019';
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
  } as unknown as Trip;
}

async function replay() {
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
  const heads: Array<{ tick: number; at: string; head: string | undefined; anchor: Trip['currentLegAnchor'] }> = [];
  let kvRef: KVNamespace | undefined;
  const result = await runCaptureReplay({
    fixture: { ...fixture, cycleStartsMs: fixture.cycleStartsMs.filter((c) => c + 1000 >= FROM_MS) },
    seedTrips: [trip],
    apns: 'capture',
    beforeTick: async ({ tick, env, kv, pushes }) => {
      kvRef = kv;
      const snapshot = latestTrip(kv, TOKEN);
      heads.push({ tick, at: kst(tick), head: snapshot?.waypoints[0]?.stationName, anchor: snapshot?.currentLegAnchor });
      attachDb(env as Env, db);
      stub.setNow(tick);
      await replayer.beforeTick({ tick, env: env as Env, pushes });
    },
  });
  const final = latestTrip(kvRef as KVNamespace, TOKEN);
  return { result, events, heads, final };
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
