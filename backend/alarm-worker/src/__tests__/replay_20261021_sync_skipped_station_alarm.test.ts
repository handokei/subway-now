/**
 * 트립 171(10/20 06:24~06:45, 용마산 7 -> 건대입구 환승 -> 2호선 뚝섬) 취침 알람 유실 replay.
 * 결함: `/boarding-lock/sync`가 06:38:45 성수를 소비(`advance 뚝섬 shiftedCount=1`)하면 cron이 그 역을
 * 다시 볼 수 없어 취침 알람("곧 뚝섬", intermediate 성수 -> destination 뚝섬)이 영구 미발사였다.
 * 입력은 불변 실측(`fixtures/replay_20261020_sleep_171/`) — 통과시키려 조정 금지.
 * 실제 sync(06:38:45) + 실제 same-session register(06:38:50·06:38:57 이후 전부)를 harness가 주입한다
 * (register 미주입 replay는 pendingMarker류 설계를 green으로 위장시킨다 — #2547 동형).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCaptureReplay } from './helpers/replayHarness';
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
const TOKEN = 'replay-20261021-sync-skipped-alarm';
/** 실측 D1: 06:38:45.151 sync-received(성수) -> advance(뚝섬). 06:38:50·06:38:57 이후 register 반복. */
const SYNC_SEONGSU_TS = 1792445925151;
const TARGET = '뚝섬';

afterEach(() => vi.unstubAllGlobals());

async function replay171(opts: { sleep: boolean; withoutPromotedLock?: boolean }) {
  const fixture = loadCapsFixture(FIXTURE_DIR);
  const d1 = loadD1Events(FIXTURE_DIR, 'events_171.json');
  const rows = opts.withoutPromotedLock
    ? d1.filter((r) => !(JSON.parse(r.meta ?? '{}') as { promotedLock?: boolean }).promotedLock)
    : d1;
  const metrics = loadTripMetricsRow(FIXTURE_DIR, 171, 'trip_metrics_171.json');
  const firstMismatch = d1.find((e) => e.kind === 'route-signature-mismatch');
  if (!firstMismatch) throw new Error('fixture 전제 실패 — route-signature-mismatch 행 없음');
  const seedWaypoints: Waypoint[] = parseRouteSig(routeSigOf(firstMismatch, 'existingSig'));
  const seedTrip = buildTransferSeedTrip({
    token: TOKEN,
    waypoints: seedWaypoints,
    originStationName: metrics.origin_station as string,
    now: fixture.window.fromMs,
    overrides: {
      sleepModeEnabled: opts.sleep,
      infoModeEnabled: true,
      activityPushToken: 'ab'.repeat(32),
      activityState: 'live',
    },
  });
  const { db } = makeTripEventSink();
  const stub = stubReplayFetch(fixture);
  const replayer = createDeviceReplayer({
    rows,
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
        infoModeEnabled: true,
        sleepModeEnabled: opts.sleep,
      },
    },
  });
  const headAfter: { tick: number; head: string | undefined; lock: string | undefined }[] = [];
  const result = await runCaptureReplay({
    fixture,
    seedTrips: [seedTrip],
    apns: 'capture',
    twoPass: true,
    beforeTick: async ({ tick, env, kv }) => {
      (env as unknown as { DB: D1Database }).DB = db;
      stub.setNow(tick);
      await replayer.beforeTick({ tick, env: env as Env, pushes: [] });
      const trip = await getTrip(kv, TOKEN);
      headAfter.push({ tick, head: trip?.waypoints[0]?.stationName, lock: trip?.boardingLock?.trainCode });
    },
  });
  return { result, replayer, headAfter, httpPushes: stub.httpPushes };
}

type HttpPush = Record<string, unknown>;

/** sync(HTTP 핸들러)가 보낸 "곧 뚝섬" 알람 alert (취침·준비 공통: sound alarm.wav + 타깃 역명 본문). */
const alarmAlerts = (pushes: readonly HttpPush[]) =>
  pushes.filter((p) => {
    const aps = p.aps as { alert?: { title?: string; body?: string }; sound?: string } | undefined;
    return aps?.sound === 'alarm.wav' && `${aps.alert?.title ?? ''} ${aps.alert?.body ?? ''}`.includes(TARGET);
  });

/** 취침 알람 companion silent push (취침 전용 — 준비 알람은 없음). */
const sleepCompanions = (pushes: readonly HttpPush[]) =>
  pushes.filter((p) => {
    const data = p.data as { kind?: string; nextStation?: string } | undefined;
    return data?.kind === 'sleep-alarm-companion' && data.nextStation === TARGET;
  });

describe('트립 171 — sync가 소비한 직전역(성수)의 취침/준비 알람', () => {
  it('취침: 06:38:45 sync가 성수를 소비해도 "곧 뚝섬" 취침 알람(alert+companion)이 정확히 1번 발사된다 (register 주입 후에도 재발사 0)', async () => {
    const r = await replay171({ sleep: true });
    expect(r.replayer.registers.length).toBeGreaterThan(2); // 06:38:50·57 이후 register 실제 주입
    expect(alarmAlerts(r.httpPushes)).toHaveLength(1);
    const companions = sleepCompanions(r.httpPushes);
    expect(companions).toHaveLength(1);
    expect((companions[0].data as { sentAt: number }).sentAt).toBe(SYNC_SEONGSU_TS);
    // lock 트립은 계속 진행 — sync 직후 head는 뚝섬, lock 3013 유지.
    const after = r.headAfter.find((h) => h.tick > SYNC_SEONGSU_TS);
    expect(after?.head).toBe(TARGET);
    expect(after?.lock).toBe('3013');
  });

  it('비취침: 같은 상황에서 준비 알람(alert)이 정확히 1번, companion은 0', async () => {
    const r = await replay171({ sleep: false });
    expect(alarmAlerts(r.httpPushes)).toHaveLength(1);
    expect(sleepCompanions(r.httpPushes)).toEqual([]);
  });

  it('거부 — lockless(06:36:36 승격 없음): 알람 0 ("lock 없음 = 알림 없음", sync 경로는 lock-active 게이트)', async () => {
    const r = await replay171({ sleep: true, withoutPromotedLock: true });
    expect(alarmAlerts(r.httpPushes)).toEqual([]);
    expect(sleepCompanions(r.httpPushes)).toEqual([]);
  });
});
