/**
 * #3055 / #3300 옵션 D PR-3b — cron × 사용자 행위 교차 (plan §4 PR-3b red, §9 "보호는 PR-3b 활성화부터").
 *
 * tick 시작 스냅샷(overlay)을 들고 있는 cron이, 그 사이 일어난 사용자 부착(confirm/sync/LA 탭)을 모른 채
 *  (A) origin 탑승 질문을 발사하거나 (B) lock을 해제하면 안 된다. 입력은 11/02 아침 실측 fixture
 * (`fixtures/originPrompt/capture_20261102_morning_yongmasan_b00dd879.fixture.json`, R2 seoul-capture 16 cycle) 위에서
 * "tick 시작 후 사용자 부착"만 합성으로 주입한다(주입 시점은 DO 요청 훅 — 읽기와 쓰기 사이).
 *
 *  - A: 대조군(promptOptIn)이 06:28:46 tick에 질문을 발사하는 것이 baseline. overlay 직후 사용자가 lock을 붙이면
 *       발사 직전 fresh 확인(GET /lock 1회)이 이를 보고 발사하지 않는다. revert-red: fresh 확인 제거 시 발사된다.
 *  - B: lock 노선이 현재 head 노선과 다른 stale lock을 cron이 `releaseAuto{stale-line}`로 푼다. 그 op가 DO에 닿기 직전
 *       사용자가 새 lock을 붙이면 rev 불일치로 conflict -> 사용자 lock 유지 + `lock-op-conflict` 행.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchCells, runLockOp } from '../tripDoCells';
import type { BoardingLockMeta, Env, Trip } from '../types';
import { interceptTripDo, makeLockCellReplayEnv, type LockCellFlag } from './helpers/lockCellReplayEnv';
import { boardingPromptsOf, kstOf, loadRide20261102Fixture, ride20261102RegisteredAt } from './helpers/originPromptReplay';
import { attachDb } from './helpers/progressAuthorityReplay';
import { runCaptureReplay } from './helpers/replayHarness';
import { makeRide20261102MorningTrip } from './helpers/ride20261102MorningTrips';
import { makeTripEventSink } from './helpers/replay20261019';

const TOKEN = 'cron-cell-cross-1102';
const HOUR_MS = 60 * 60_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

const userLock = (now: number): BoardingLockMeta => ({
  trainCode: '7999',
  line: '7',
  subwayId: '1007',
  selectedDepartureTime: now,
  segmentStations: ['용마산', '중곡', '군자(능동)', '어린이대공원(세종대)', '건대입구'],
  expiresAt: now + HOUR_MS,
});

interface RunOpts {
  flag: LockCellFlag;
  seed: (registeredAt: number) => Trip;
  /** 이 tick(simNow)의 첫 DO 요청 조건이 맞으면 `inject`가 실행된다. */
  inject?: { atTick: (tick: number, index: number) => boolean; when: (path: string, opType?: string) => boolean };
}

async function run(opts: RunOpts) {
  const fixture = loadRide20261102Fixture();
  const { db, events } = makeTripEventSink();
  const cells = makeLockCellReplayEnv(opts.flag);
  let armed = false;
  let injected = false;
  let kvRef: KVNamespace | undefined;
  let currentTick = 0;
  /** 주입이 일어난 tick의 **직후**(다음 tick 시작 직전) 셀 — 이후 tick의 정상 추적/해제와 분리해서 본다. */
  let afterInjection: Awaited<ReturnType<typeof fetchCells>> | undefined;
  const rawEnv = (): Pick<Env, 'TRIPS' | 'TRIP_DO'> => ({ TRIPS: kvRef as KVNamespace, TRIP_DO: cells.doNs.ns });
  const wrapped = interceptTripDo(cells.doNs.ns, {
    after: async ({ path, body }) => {
      if (armed && !injected && opts.inject?.when(path, body?.op?.type) === true && path === '/cells') {
        injected = true;
        await runLockOp(
          rawEnv(),
          TOKEN,
          { type: 'attachIfNone', source: 'confirm', authority: 'user', expectedRev: 0, lock: userLock(currentTick) },
          currentTick,
        );
      }
    },
    before: async ({ path, body }) => {
      if (armed && !injected && opts.inject?.when(path, body?.op?.type) === true && path === '/lock/op') {
        injected = true;
        const { lock } = await fetchCells(rawEnv(), TOKEN);
        await runLockOp(
          rawEnv(),
          TOKEN,
          {
            type: 'userBoarded',
            source: 'confirm',
            expectedRev: lock?.rev ?? 0,
            releaseFirst: true,
            lock: userLock(currentTick),
          },
          currentTick,
        );
      }
    },
  });
  const result = await runCaptureReplay({
    fixture,
    seedTrips: [opts.seed(ride20261102RegisteredAt(fixture))],
    apns: 'capture',
    beforeTick: async ({ tick, tickIndex, env, kv }) => {
      kvRef = kv;
      if (injected && afterInjection === undefined) afterInjection = await fetchCells(rawEnv(), TOKEN);
      currentTick = tick;
      vi.setSystemTime(tick);
      attachDb(env as Env, db);
      if (tickIndex === 0) await cells.install(env as Env, kv, wrapped);
      armed = opts.inject?.atTick(tick, tickIndex) === true;
    },
  });
  const finalCells = kvRef ? await fetchCells(rawEnv(), TOKEN) : null;
  return { result, events, finalCells, injected, afterInjection };
}

const promptTrip = (at: number): Trip =>
  makeRide20261102MorningTrip(TOKEN, at, { intent: 'promptOptIn', alarm: 'alarm0' });

describe('#3055 PR-3b — A: tick 시작 후 사용자 부착이 origin 질문 발사를 막는다', () => {
  it('baseline(lock@1, 주입 없음): 대조군은 도착 확정 tick마다 질문을 발사한다 (하네스 전제)', async () => {
    const r = await run({ flag: 'lock@1', seed: promptTrip });
    expect(boardingPromptsOf(r.result).length).toBeGreaterThan(0);
  });

  it('overlay 직후 사용자가 lock을 붙이면 그 tick에는 질문이 나가지 않는다 (fresh lock 확인)', async () => {
    const baseline = await run({ flag: 'lock@1', seed: promptTrip });
    const [firstPrompt] = boardingPromptsOf(baseline.result);
    const firstFireTick = baseline.result.pushes
      .filter((p) => (p.body.body as Record<string, unknown> | undefined)?.kind === 'boarding-prompt')
      .map((p) => p.simNowMs)[0];
    expect(firstPrompt).toBeDefined();

    const r = await run({
      flag: 'lock@1',
      seed: promptTrip,
      inject: { atTick: (tick) => tick === firstFireTick, when: (path) => path === '/cells' },
    });
    expect(r.injected).toBe(true);
    const atTick = r.result.pushes.filter(
      (p) => p.simNowMs === firstFireTick && (p.body.body as Record<string, unknown> | undefined)?.kind === 'boarding-prompt',
    );
    expect(atTick, `질문이 ${kstOf(firstFireTick)} tick에 발사됨`).toEqual([]);
    expect(r.afterInjection?.lock?.lock?.trainCode).toBe('7999');
  });
});

const staleLockTrip = (at: number): Trip => ({
  ...makeRide20261102MorningTrip(TOKEN, at, { intent: 'promptOptIn', alarm: 'alarm0' }),
  // head(중곡 7호선)와 노선이 다른 lock — cron이 stale-line으로 푸는 대상(trips.ts clearStaleBoardingLock 의미).
  boardingLock: {
    trainCode: '2222',
    line: '2',
    subwayId: '1002',
    selectedDepartureTime: at,
    segmentStations: ['성수', '뚝섬'],
    expiresAt: at + HOUR_MS,
  },
});

describe('#3055 PR-3b — B: cron releaseAuto는 사용자 부착 앞에서 conflict로 물러선다', () => {
  it('주입 없음: stale-line lock이 셀에서 풀리고 lock-released{reason,source,rev}가 남는다', async () => {
    const r = await run({ flag: 'lock@1', seed: staleLockTrip });
    expect(r.finalCells?.lock?.lock).toBeUndefined();
    const released = r.events.filter((e) => e.kind === 'lock-released');
    expect(released).toHaveLength(1);
    expect(released[0].meta).toMatchObject({ reason: 'stale-line', source: 'cron' });
    expect(typeof released[0].meta.rev).toBe('number');
    expect(r.events.some((e) => e.kind === 'lock-op-conflict')).toBe(false);
  });

  it('releaseAuto가 DO에 닿기 직전 사용자가 lock을 붙이면 conflict: 사용자 lock 유지 + lock-op-conflict', async () => {
    const r = await run({
      flag: 'lock@1',
      seed: staleLockTrip,
      inject: { atTick: (_tick, index) => index === 0, when: (_path, opType) => opType === 'releaseAuto' },
    });
    expect(r.injected).toBe(true);
    expect(r.afterInjection?.lock?.lock?.trainCode).toBe('7999');
    expect(r.events.filter((e) => e.kind === 'lock-released').filter((e) => e.meta.reason === 'stale-line')).toEqual([]);
    const conflicts = r.events.filter((e) => e.kind === 'lock-op-conflict');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].meta).toEqual({ op: 'releaseAuto', source: 'cron' });
  });

  it('flag off (현행): DO 호출 0 + lock-released/lock-op-conflict 행 없음', async () => {
    const r = await run({ flag: 'off', seed: staleLockTrip });
    expect(r.events.filter((e) => e.kind === 'lock-released' || e.kind === 'lock-op-conflict')).toEqual([]);
    expect(r.finalCells?.lock).toBeNull();
  });
});
