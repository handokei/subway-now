/**
 * #3055 / #3300 옵션 D PR-3b — 10/19 저녁 취침 트립(D1 trip_metrics id=168, token_hash b00dd879) 재등록 주입 replay.
 *
 * 실측(불변): `fixtures/replay_20261019_sleep_regression/events_168.json`
 *   1153 18:10:22 boarding-confirm-result lockState=leg2 (사용자 탭 -> lock)
 *   1152 18:10:22 trip-register(같은 세션 재등록) — 1149 / 1156 / 1158 / 1160 도 재등록(18:09:49~18:11:44)
 *   1154 18:10:45 · 1161 18:11:45 leg-resolve-attempt (lock이 **없을 때만** 도는 lockless resolver)
 *   1163 18:11:50 trip-end endPath=lockless-destination-waypoints-exhausted (실도착 18:17:34보다 5분40초 조기)
 * 해제 이벤트 없이 leg-2 lock이 사라졌다(plan §0.1). 재등록의 same-session carry(`carriedBoardingLock`)가 KV 60s 캐시의
 * 낡은 existing을 읽어 lock을 undefined로 만드는 가설(#3084 결론과 병기 — **추정**)을 CacheLagKV로 재현한다.
 *
 * 추정 입력(D1에 없음, `확정` 아님): 재등록 payload에 boardingLock이 실리지 않았다. incoming waypoints는 D1
 * route-signature-mismatch.incomingSig에서 그대로 가져온다(createDeviceReplayer register 옵션).
 *
 * 기대:
 *  - flag off: D1과 같은 증상(탭 이후 lockless resolver 재개 + 조기 destination 종료).
 *  - lock@1: 셀이 lock을 권위로 들고 있어 탭 이후 lockless resolver가 돌지 않고 조기 종료가 없다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, PositionPoint } from '../types';
import { attachDb, makeLagKv, primeReplayKv } from './helpers/progressAuthorityReplay';
import { makeLockCellReplayEnv, type LockCellFlag } from './helpers/lockCellReplayEnv';
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
import { useApnsHarness } from './helpers/sleepAlarmHarness';

useApnsHarness();

const DIR = 'replay_20261019_sleep_regression';
const TOKEN = 'replay-20261019-lock-cell';
const MOTION_SAMPLE_INTERVAL_MS = 30_000;
/** D1 1149(18:09:49) — 첫 재등록. 이 시각 이후의 trip-register 5행을 주입한다. */
const REGISTER_FROM_MS = 1792400989089;
const EARLY_END_PATH = 'lockless-destination-waypoints-exhausted';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function replay(flag: LockCellFlag) {
  const fixture = loadCapsFixture(DIR);
  const d1 = loadD1Events(DIR, 'events_168.json');
  const metrics = loadTripMetricsRow(DIR, 168);
  const firstMismatch = d1.find((e) => e.kind === 'route-signature-mismatch');
  if (!firstMismatch) throw new Error('fixture 전제 실패 — route-signature-mismatch 행 없음');
  const seedWaypoints = parseRouteSig(routeSigOf(firstMismatch, 'existingSig'));
  const transfer = seedWaypoints.find((w) => w.kind === 'transfer');
  if (!transfer) throw new Error('fixture 전제 실패 — transfer 없음');
  const leg2Line = seedWaypoints[seedWaypoints.indexOf(transfer) + 1].line;
  const seedTrip = buildTransferSeedTrip({
    token: TOKEN,
    waypoints: seedWaypoints,
    originStationName: metrics.origin_station as string,
    now: fixture.window.fromMs,
    overrides: { sleepModeEnabled: true, infoModeEnabled: true, activityPushToken: 'ab'.repeat(32), activityState: 'live' },
  });
  const firstTransferSync = d1.find((e) => e.kind === 'sync-received' && e.station === transfer.stationName);
  const seriesStart = (firstTransferSync as { ts: number }).ts;
  const motionSeries: PositionPoint[] = [];
  for (let ts = seriesStart; ts <= fixture.window.toMs; ts += MOTION_SAMPLE_INTERVAL_MS) {
    motionSeries.push({ lat: 37.5, lng: 127.0, accuracy: 20, ts, motion: 'automotive' });
  }
  const { db, events } = makeTripEventSink();
  const stub = stubReplayFetch(fixture);
  const cells = makeLockCellReplayEnv(flag);
  const replayer = createDeviceReplayer({
    rows: d1,
    token: TOKEN,
    stub,
    tapBody: (tapIndex, pushes) => {
      const base = { station: transfer.stationName, line: leg2Line };
      if (tapIndex < 2) return base;
      const prompt = pushes
        .map((p) => p.body.body as Record<string, unknown> | undefined)
        .find((p) => p?.kind === 'boarding-prompt' && p?.line === leg2Line && Array.isArray(p?.candidateTrains));
      if (!prompt) throw new Error('3번째 탭 시점에 leg-2 프롬프트 push가 없다 — 사슬 단절');
      return { ...base, trainCode: prompt.trainCode as string };
    },
    // 추정 입력: 재등록 payload에 boardingLock 없음(D1에 payload 없음).
    register: {
      fromMs: REGISTER_FROM_MS,
      body: {
        destination: seedTrip.destination,
        route: seedTrip.route,
        createdAt: seedTrip.createdAt,
        infoModeEnabled: true,
        sleepModeEnabled: true,
      },
    },
  });
  // seed trip은 지연 창 밖(과거)에 쓴다(10/31 storm replay와 같은 방식).
  vi.setSystemTime(fixture.window.fromMs - 10 * 60_000);
  const result = await runCaptureReplay({
    locklessAdvanceLegacy: true,
    fixture,
    seedTrips: [seedTrip],
    apns: 'capture',
    twoPass: true,
    makeKv: makeLagKv,
    seedPositionSeries: { [TOKEN]: motionSeries },
    beforeTick: async ({ tick, tickIndex, env, kv, pushes }) => {
      if (tickIndex === 0) {
        await primeReplayKv(kv, tick, { token: TOKEN });
        await cells.install(env as Env, kv);
      }
      attachDb(env as Env, db);
      stub.setNow(tick);
      await replayer.beforeTick({ tick, env: env as Env, pushes });
      vi.setSystemTime(tick);
    },
  });
  return { events, result, taps: replayer.taps, registers: replayer.registers };
}

/** 탭 3(D1 1153, 18:10:22) 이후에 기록된 이벤트. */
function eventsAfterThirdTap(events: Awaited<ReturnType<typeof replay>>['events']) {
  const confirmIdx = events.reduce<number[]>((acc, e, i) => (e.kind === 'boarding-confirm-result' ? [...acc, i] : acc), []);
  return events.slice(confirmIdx[2] + 1);
}

describe('#3055 PR-3b — 10/19 재등록 주입 (CacheLagKV, 재등록 payload에 lock 없음 = 추정 입력)', () => {
  it('전제: D1 재등록 행이 전부 200으로 주입되고 탭 3회가 lock을 만든다', async () => {
    const r = await replay('off');
    expect(r.registers.length).toBeGreaterThanOrEqual(5);
    expect(r.registers.every((reg) => reg.status === 200)).toBe(true);
    expect(r.taps.map((t) => t.response.lockState)).toEqual(['leg2', 'leg2', 'leg2']);
  });

  it('flag off (D1 재현 18:10:45 / 18:11:45): 탭 이후 lock이 사라져 lockless resolver가 재개된다', async () => {
    const r = await replay('off');
    const after = eventsAfterThirdTap(r.events);
    expect(after.filter((e) => e.kind === 'leg-resolve-attempt').length).toBeGreaterThanOrEqual(2);
  });

  it('lock@1: 셀이 lock을 유지해 탭 이후 lockless resolver가 돌지 않고 조기 종료가 없다', async () => {
    const r = await replay('lock@1');
    const after = eventsAfterThirdTap(r.events);
    expect(after.filter((e) => e.kind === 'leg-resolve-attempt')).toEqual([]);
    expect(r.events.some((e) => e.kind === 'trip-end' && e.meta.endPath === EARLY_END_PATH)).toBe(false);
  });

  // plan §9 — off 재현이 부분적이면 남은 부분은 it.todo로 유지한다. D1의 existingSig는 `용마산|destination` 단독(진행분이
  // 소비된 상태)이라 seed(전체 route)와 달라 18:11:50 조기 종료(endPath=lockless-destination-waypoints-exhausted)까지는
  // 재현되지 않는다 — 위 두 번째 테스트는 그 앞 단계(lock 소실 -> lockless resolver 재개)까지만 단언한다.
  it.todo(`flag off: D1 1163 18:11:50 trip-end endPath=${EARLY_END_PATH} 재현 (seed existing이 destination 단독인 입력이 필요)`);
});
