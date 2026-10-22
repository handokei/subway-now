/**
 * v8 PR-T — 2026-10-21 06:18~06:34 트립 173(용마산 7 -> 건대입구 환승 -> 2호선 뚝섬) whole-trip replay.
 * "173 replay 무변경" 거부 테스트용 baseline (계획 v8 §8). 프로덕션 코드 diff 0.
 * 입력은 불변 실측 — `fixtures/replay_20261021_trip173/`:
 *   - caps/*.json : R2 seoul-capture 16 cycle (06:18:46~06:33:45, 06:31:45 cycle 누락은 실측 그대로)
 *   - events_173.json : D1 trip_events 46행 (token_hash b00dd879, ts 1792531080270~1792532045916)
 *   - trip_metrics_173.json : D1 trip_metrics id=173
 * 통과시키려 조정 금지.
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
import { getTrip } from '../trips';
import type { Env, Waypoint } from '../types';

const FIXTURE_DIR = 'replay_20261021_trip173';
const TOKEN = 'replay-20261021-trip173';

afterEach(() => vi.unstubAllGlobals());

function promptPayload(push: CapturedPush): Record<string, unknown> | undefined {
  const payload = push.body.body as Record<string, unknown> | undefined;
  return payload?.kind === 'boarding-prompt' ? payload : undefined;
}

async function replay173() {
  const fixture = loadCapsFixture(FIXTURE_DIR);
  const d1 = loadD1Events(FIXTURE_DIR, 'events_173.json');
  const metrics = loadTripMetricsRow(FIXTURE_DIR, 173, 'trip_metrics_173.json');
  const firstMismatch = d1.find((e) => e.kind === 'route-signature-mismatch');
  if (!firstMismatch) throw new Error('fixture 전제 실패 — route-signature-mismatch 행 없음');
  const seedWaypoints: Waypoint[] = parseRouteSig(routeSigOf(firstMismatch, 'incomingSig'));
  const transfer = seedWaypoints.find((w) => w.kind === 'transfer') as Waypoint;
  const leg2Line = seedWaypoints[seedWaypoints.indexOf(transfer) + 1].line;
  const leg1Line = transfer.line;

  const seedTrip = buildTransferSeedTrip({
    token: TOKEN,
    waypoints: seedWaypoints,
    originStationName: metrics.origin_station as string,
    now: fixture.window.fromMs,
    overrides: { infoModeEnabled: true, activityPushToken: 'ab'.repeat(32), activityState: 'live' },
  });

  const { db, events } = makeTripEventSink();
  const stub = stubReplayFetch(fixture);
  const replayer = createDeviceReplayer({
    rows: d1,
    token: TOKEN,
    stub,
    // 추정 입력: 탭 body의 trainCode는 D1/R2에 없다. D1 `trainCodeSource=body`(두 탭 모두)에 맞춰 각 탭이
    // **해당 노선 프롬프트가 실제로 실은 열차**(재생 중 backend가 발사한 push payload)를 돌려보낸다.
    tapBody: (tapIndex, pushes) => {
      const tapLine = tapIndex === 0 ? leg1Line : leg2Line;
      const station = tapIndex === 0 ? (metrics.origin_station as string) : transfer.stationName;
      const prompt = pushes.map(promptPayload).find((p) => p?.line === tapLine && Array.isArray(p?.candidateTrains));
      if (!prompt) throw new Error(`탭 ${tapIndex} 시점에 ${tapLine}호선 프롬프트 push가 없다 — 사슬 단절`);
      return { station, line: tapLine, trainCode: prompt.trainCode as string };
    },
    mergeSyncByTs: true,
  });

  const tickStates: { tick: number; lockTrainCode?: string; candidates?: readonly string[] }[] = [];
  const result = await runCaptureReplay({
    fixture,
    seedTrips: [seedTrip],
    apns: 'capture',
    twoPass: true,
    beforeTick: async ({ tick, env, kv, pushes }) => {
      (env as unknown as { DB: D1Database }).DB = db;
      stub.setNow(tick);
      const before = await getTrip(kv, TOKEN);
      tickStates.push({ tick, candidates: before?.recentPromptCandidates?.trainCodes });
      await replayer.beforeTick({ tick, env: env as Env, pushes });
    },
  });
  return { fixture, d1, events, result, tickStates, replayer };
}

function d1Meta(row: { meta: string | null }): Record<string, unknown> {
  return JSON.parse(row.meta ?? '{}') as Record<string, unknown>;
}

describe('v8 PR-T 트립 173 replay — 현행 코드 baseline ("173 무변경" 거부 테스트용)', () => {
  it('D1 oracle: leg-1 탭(06:20:57)·leg-2 탭(06:30:55)은 body trainCode, leg-2 프롬프트(06:30:46)는 position-confirmed 발사', async () => {
    const r = await replay173();
    const taps = r.d1.filter((e) => e.kind === 'boarding-confirm-result');
    expect(taps.map(d1Meta).slice(0, 2)).toEqual([
      { lockState: 'leg1', anchorSource: 'promptDisplay', trainCodeSource: 'body' },
      { lockState: 'leg2', anchorSource: 'currentLegAnchor', trainCodeSource: 'body' },
    ]);
    const fired = r.d1.find((e) => e.kind === 'leg-boarding-prompt' && d1Meta(e).outcome === 'fired');
    expect(d1Meta(fired as { meta: string }).gateDecision).toBe('position-confirmed');
    // 계획 §8의 전제 확인: leg-1 프롬프트 발사 D1 행은 없다(origin 프롬프트는 device 덤프에만 있다).
    expect(r.d1.filter((e) => e.kind === 'leg-boarding-prompt' && d1Meta(e).leg === 'origin')).toEqual([]);
  });

  it('두 탭 모두 D1과 같은 라벨로 수락된다 — leg1(body) / leg2(currentLegAnchor, body)', async () => {
    const r = await replay173();
    expect(r.replayer.taps.map((t) => t.status)).toEqual([200, 200]);
    expect(r.replayer.taps.map((t) => t.response.lockState)).toEqual(['leg1', 'leg2']);
    const results = r.events.filter((e) => e.kind === 'boarding-confirm-result').map((e) => e.meta);
    expect(results[1]).toMatchObject({ lockState: 'leg2', anchorSource: 'currentLegAnchor', trainCodeSource: 'body' });
    // 재생 탭 body는 프롬프트 payload 열차다 -> 응답이 같은 열차로 resolve.
    for (const tap of r.replayer.taps) {
      expect(tap.response.resolvedTrainCode).toBe(tap.sent.trainCode);
    }
  });

  it('[D2-C 전제 판정] 각 탭 직전 tick에 trip.recentPromptCandidates가 stamp돼 있고 탭 trainCode를 포함한다 (leg-1 06:20:57 포함)', async () => {
    const r = await replay173();
    // 탭 직후 첫 tick 시작 시점의 stamp(탭은 그 tick 직전에 주입되므로 stamp는 탭 이전 발사의 산물).
    for (const tap of r.replayer.taps) {
      const nextTick = r.tickStates.find((s) => s.tick > tap.at);
      expect(nextTick?.candidates).toBeDefined();
      expect(nextTick?.candidates).toContain(tap.sent.trainCode);
    }
    // leg-1: 재생이 발사한 origin 프롬프트(cron)가 탭 이전에 실제 존재했다.
    const [leg1Tap] = r.replayer.taps;
    const originPrompt = r.result.cycles.find((c) => c.simNowMs < leg1Tap.at && c.pushes.some((p) => promptPayload(p)?.line === '7'));
    expect(originPrompt).toBeDefined();
  });

  it('leg-2 프롬프트는 D1 발사 시각(06:30:46)과 같은 cron tick에서 1회 발사된다', async () => {
    const r = await replay173();
    const fired = r.d1.find((e) => e.kind === 'leg-boarding-prompt' && d1Meta(e).outcome === 'fired');
    const cycles = r.result.cycles.filter((c) => c.pushes.some((p) => promptPayload(p)?.line === '2'));
    expect(cycles).toHaveLength(1);
    expect(Math.abs(cycles[0].simNowMs - (fired as { ts: number }).ts)).toBeLessThan(5_000);
  });
});

// #3140 — lock 없는 트립은 알림 없음. 06:28:00~06:30:55 = leg-1 lock이 환승에서 풀렸고 leg-2 lock은
// 아직 없는 구간(탭 06:30:55). 이 구간에는 준비 알람·취침 알람·lockless 매역 "통과" push가 없어야 한다.
// 같은 재생에서 lock 활성 중(06:25:46) 준비 알람은 그대로 1회 발사된다(거부 케이스: lock 활성 불변).
describe('#3140 트립 173 — lock 없는 구간 알림 0 / lock 활성 준비 알람 불변', () => {
  const KST_OFFSET_MS = 9 * 60 * 60_000;
  const kstMs = (hms: string) => Date.parse(`2026-10-21T${hms}+09:00`) - 0 * KST_OFFSET_MS;
  const WINDOW = { from: kstMs('06:28:00'), to: kstMs('06:30:55') };
  const isAlarmSound = (p: CapturedPush) => (p.body.aps as { sound?: string } | undefined)?.sound === 'alarm.wav';
  const isStationPassed = (p: CapturedPush) =>
    (p.body.data as { kind?: string } | undefined)?.kind === 'intermediate' ||
    (p.body.aps as { alert?: { title?: string } } | undefined)?.alert?.title?.endsWith('역 도착') === true;

  it('06:28:00~06:30:55 — 준비/취침 알람(alarm.wav)·lockless 매역 push 0건', async () => {
    const r = await replay173();
    const inWindow = r.result.cycles.filter((c) => c.simNowMs >= WINDOW.from && c.simNowMs <= WINDOW.to);
    expect(inWindow.length).toBeGreaterThan(0);
    const offending = inWindow.flatMap((c) => c.pushes).filter((p) => isAlarmSound(p) || isStationPassed(p));
    expect(offending).toEqual([]);
  });

  it('lock 활성 중 준비 알람은 불변 — 건대입구 환승 임박(alarm.wav) 06:25:46 1회', async () => {
    const r = await replay173();
    const alarms = r.result.cycles.filter((c) => c.pushes.some(isAlarmSound));
    expect(alarms.map((c) => c.simNowMs)).toEqual([expect.any(Number)]);
    expect(Math.abs(alarms[0].simNowMs - kstMs('06:25:46'))).toBeLessThan(5_000);
  });
});

// #3144 (v8 D2·D3) — 거부 테스트: 프롬프트 응답 lock(leg1 06:20:57, leg2 06:30:55)은 D2·D3 후에도 붙는다.
describe('v8 D2·D3 트립 173 replay — 응답 유래 lock은 무변경으로 부착된다', () => {
  it('leg-1·leg-2 응답 lock이 붙고, lock-attached는 confirm 2건 + 응답 lock 파생 vanish-swap뿐이다 (register/cron/sync 무프롬프트 부착 0)', async () => {
    const r = await replay173();
    expect(r.replayer.taps.map((t) => t.response.lockState)).toEqual(['leg1', 'leg2']);
    for (const tap of r.replayer.taps) {
      expect(tap.response.resolvedTrainCode).toBe(tap.sent.trainCode);
    }
    const attached = r.events.filter((e) => e.kind === 'lock-attached');
    // 실측 173에는 응답 lock 이후 열차 번호 변경(vanish-swap) 교체 2회가 있다 — 응답 유래 lock의 파생이다.
    const paths = attached.map((e) => e.meta.path);
    expect(paths.filter((p) => p === 'confirm')).toHaveLength(2);
    expect(paths.filter((p) => p !== 'confirm' && p !== 'vanish-swap')).toEqual([]);
    expect(attached.every((e) => e.meta.hasResponseMarker === true)).toBe(true);
    expect(r.events.filter((e) => e.kind === 'promotion-rejected-uncorroborated')).toEqual([]);
  });
});
