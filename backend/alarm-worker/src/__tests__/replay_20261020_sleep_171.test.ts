/**
 * v8 PR-T — 2026-10-20 06:24~06:45 취침 트립 171(용마산 7 -> 건대입구 환승 -> 2호선 뚝섬) whole-trip replay.
 * 프로덕션 코드 diff 0. 입력은 불변 실측이다 — `fixtures/replay_20261020_sleep_171/`:
 *   - caps/*.json : R2 seoul-capture 18 cycle (06:26:45~06:44:45)
 *   - events_171.json : D1 trip_events 75행 (token_hash b00dd879, ts 1792445078056~1792446303425)
 *   - trip_metrics_171.json : D1 trip_metrics id=171
 *   - dump_excerpt.txt : 기기 덤프 `텍스트-E15753B26F51-1.txt` :827-836 (BoardingLock Lifecycle; 832-836 = 171 구간)
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

const FIXTURE_DIR = 'replay_20261020_sleep_171';
const TOKEN = 'replay-20261020-sleep-171';

afterEach(() => vi.unstubAllGlobals());

interface TickState {
  tick: number;
  lockTrainCode: string | undefined;
}

async function replay171(opts: { withoutPromotedLock?: boolean } = {}) {
  const fixture = loadCapsFixture(FIXTURE_DIR);
  const d1 = loadD1Events(FIXTURE_DIR, 'events_171.json');
  const replayRows = opts.withoutPromotedLock
    ? d1.filter((r) => !(JSON.parse(r.meta ?? '{}') as { promotedLock?: boolean }).promotedLock)
    : d1;
  const metrics = loadTripMetricsRow(FIXTURE_DIR, 171, 'trip_metrics_171.json');
  const firstMismatch = d1.find((e) => e.kind === 'route-signature-mismatch');
  if (!firstMismatch) throw new Error('fixture 전제 실패 — route-signature-mismatch 행 없음');
  const seedWaypoints: Waypoint[] = parseRouteSig(routeSigOf(firstMismatch, 'existingSig'));

  // infoModeEnabled=true seed 근거(합성 아님): 기기 덤프 :836 `06:27:54 | lock-create:user-tap | 7035(7) station=7-015`
  // = 이 트립의 출발 목록 탭. 목록 탭(BoardingTrainList 직접 탭)은 useBoardingLockController.ts:451
  // `setInfoModeEnabled(true)`로 명시 의향을 켜고, register는 그 값을 `infoModeEnabled`로 송신한다
  // (alarmBackend.ts). 따라서 06:27:54 이후 이 트립의 backend trip은 infoModeEnabled=true 이다.
  // sleepModeEnabled=true: 취침 트립(D1 cron-fire-attempt reason=station-notif-sleep).
  const infoModeEnabled = true;
  const seedTrip = buildTransferSeedTrip({
    token: TOKEN,
    waypoints: seedWaypoints,
    originStationName: metrics.origin_station as string,
    now: fixture.window.fromMs,
    overrides: { sleepModeEnabled: true, infoModeEnabled, activityPushToken: 'ab'.repeat(32), activityState: 'live' },
  });

  const { db, events } = makeTripEventSink();
  const stub = stubReplayFetch(fixture);
  const replayer = createDeviceReplayer({
    rows: replayRows,
    token: TOKEN,
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
        infoModeEnabled,
        sleepModeEnabled: true,
      },
    },
  });

  const tickStates: TickState[] = [];
  const result = await runCaptureReplay({
    fixture,
    seedTrips: [seedTrip],
    apns: 'capture',
    twoPass: true,
    beforeTick: async ({ tick, env, kv, pushes }) => {
      (env as unknown as { DB: D1Database }).DB = db;
      stub.setNow(tick);
      await replayer.beforeTick({ tick, env: env as Env, pushes });
      const trip = await getTrip(kv, TOKEN);
      tickStates.push({ tick, lockTrainCode: trip?.boardingLock?.trainCode });
    },
  });
  return { fixture, d1, events, result, tickStates, replayer };
}

function d1Meta(row: { meta: string | null }): Record<string, unknown> {
  return JSON.parse(row.meta ?? '{}') as Record<string, unknown>;
}

function promptPayload(push: CapturedPush): Record<string, unknown> | undefined {
  const payload = push.body.body as Record<string, unknown> | undefined;
  return payload?.kind === 'boarding-prompt' ? payload : undefined;
}

describe('v8 PR-T 트립 171 replay — 현행 코드 자체 검증 (D2-C red/green 기준선)', () => {
  it('D1 oracle: 06:36:36 sync 1요청이 같은 ts의 2행(plain + promotedLock 3013, line 2)을 쓴다 (index.ts:3240-3246 + :3594-3601)', async () => {
    const d1 = loadD1Events(FIXTURE_DIR, 'events_171.json');
    const promoted = d1.find((e) => d1Meta(e).promotedLock === true);
    expect(promoted).toBeDefined();
    expect(d1Meta(promoted as { meta: string })).toEqual({ promotedLock: true, trainCode: '3013', line: '2' });
    const sameTs = d1.filter((e) => e.kind === 'sync-received' && e.ts === (promoted as { ts: number }).ts);
    expect(sameTs).toHaveLength(2);
    // 이 트립에는 boarding-confirm-result(탭 POST) 행이 0건 — 목록 탭은 backend에 sync(trainCode)로만 도달했다.
    expect(d1.filter((e) => e.kind === 'boarding-confirm-result')).toEqual([]);
  });

  it('register 주입: D1 trip-register(stored) 행이 전부 same-session POST /trips로 200 수락된다', async () => {
    const r = await replay171();
    const d1Registers = r.d1.filter(
      (e) => e.kind === 'trip-register' && e.ts >= r.fixture.window.fromMs && d1Meta(e).outcome === 'stored',
    );
    expect(r.replayer.registers.length).toBe(d1Registers.length);
    expect(r.replayer.registers.every((x) => x.status === 200)).toBe(true);
  });

  it('06:36:36 승격: 합쳐진 sync가 3013을 lock으로 승격 -> 그 직후 tick 시작에 boardingLock.trainCode === 3013 (그 전 tick은 lock 없음)', async () => {
    const r = await replay171();
    const promoted = r.d1.find((e) => d1Meta(e).promotedLock === true) as { ts: number };
    const next = r.tickStates.find((s) => s.tick > promoted.ts);
    const prev = [...r.tickStates].reverse().find((s) => s.tick < promoted.ts);
    expect(next?.lockTrainCode).toBe('3013');
    expect(prev?.lockTrainCode).toBeUndefined();
    // 승격 telemetry도 D1과 같다.
    expect(r.events.filter((e) => e.meta.promotedLock === true).map((e) => e.meta)).toEqual([
      { promotedLock: true, trainCode: '3013', line: '2' },
    ]);
  });

  it('06:36:45 tick: lock이 있으므로 2호선 열차 2011에 대한 push는 0건 (실측 D1에도 leg-boarding-prompt 행 없음)', async () => {
    const r = await replay171();
    const promoted = r.d1.find((e) => d1Meta(e).promotedLock === true) as { ts: number };
    const cycle = r.result.cycles.find((c) => c.simNowMs > promoted.ts) as { pushes: CapturedPush[] };
    const mentions2011 = cycle.pushes.filter((p) => JSON.stringify(p.body).includes('"2011"'));
    expect(mentions2011).toEqual([]);
    expect(cycle.pushes.some((p) => promptPayload(p) !== undefined)).toBe(false);
    // 이 tick의 push는 lock 열차(3013)에 대한 reschedule뿐이다 — 오선택 열차에 추적이 붙었다는 증거.
    const reschedule = cycle.pushes.find((p) => p.body.kind === 'reschedule' || (p.body.data as { kind?: string } | undefined)?.kind === 'reschedule');
    expect(JSON.stringify(reschedule?.body)).toContain('3013');
    expect(r.d1.filter((e) => e.kind === 'leg-boarding-prompt')).toEqual([]);
  });

  it('[v7 주장 확인] 06:36:36 승격이 없었다면(lock 부재) 06:36:45 tick에 2011 position-confirmed 프롬프트가 발사된다', async () => {
    const r = await replay171({ withoutPromotedLock: true });
    const promoted = r.d1.find((e) => d1Meta(e).promotedLock === true) as { ts: number };
    const next = r.tickStates.find((s) => s.tick > promoted.ts);
    expect(next?.lockTrainCode).toBeUndefined();
    const cycle = r.result.cycles.find((c) => c.simNowMs > promoted.ts) as { simNowMs: number; pushes: CapturedPush[] };
    const prompts = cycle.pushes.map(promptPayload).filter((p) => p !== undefined);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ line: '2', trainCode: '2011', triggerKind: 'cron' });
    // position-confirmed의 입력: 실측 position 캡처에서 2011이 건대입구 trainSttus=1(도착)이다 — 탑승 열차는 2011.
    const arrived = r.fixture.entries
      .filter((e) => e.kind === 'position' && e.tMs >= cycle.simNowMs - 30_000 && e.tMs <= cycle.simNowMs + 10_000)
      .flatMap((e) => (JSON.parse(e.body) as { realtimePositionList: { trainNo: string; statnNm: string; trainSttus: string }[] }).realtimePositionList)
      .filter((p) => p.trainNo === '2011');
    expect(arrived.map((p) => [p.statnNm, p.trainSttus])).toContainEqual(['건대입구', '1']);
  });
});

// #3144 (3-path parity, ADR-043) — 실측 171 입력 그대로(불변). 수동 목록 탭 sync는 사용자 행위 3경로 중
// 하나이므로 오선택 3013도 다시 lock으로 승격된다(171 root인 오선택 자체는 별도 처리 — 숨기지 않고 있는 그대로 단언).
describe('3-path parity 트립 171 replay — 수동 목록 탭 sync는 3013을 lock하고 응답 마커를 세운다', () => {
  it('06:36:36 sync 3013 승격은 lock-attached(path=sync, hasResponseMarker=true) 1건이며 거부 행은 없다', async () => {
    const r = await replay171();
    const attached = r.events.filter((e) => e.kind === 'lock-attached');
    expect(attached.map((e) => e.meta)).toEqual([
      { path: 'sync', trainCode: '3013', hasResponseMarker: true },
    ]);
    expect(r.events.filter((e) => e.kind === 'promotion-rejected-uncorroborated')).toEqual([]);
  });

  it('승격 외 경로(register/cron)로 붙은 lock은 없다 (lock-attached는 sync 1건뿐)', async () => {
    const r = await replay171();
    expect(r.events.filter((e) => e.kind === 'lock-attached' && e.meta.path !== 'sync')).toEqual([]);
  });
});
