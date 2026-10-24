/**
 * #3155 — 트립 171(2026-10-20 06:24~06:44, 용마산 7 -> 건대입구 환승 -> 2호선 뚝섬) whole-trip replay.
 *
 * 사고: 사용자는 2011을 탔고(건대입구 06:36:28 출발), 출발 2초 뒤(06:36:30) 목록 첫 행은 다음 열차 3013이었다.
 * 목록이 "접근 중" 열차만 보여 출발한 2011이 사라졌기 때문이다. 이 replay는 fixture(R2 seoul-capture 18 cycle,
 * D1 trip_events)를 **불변 그대로** 현행 cron(runScheduled)에 통과시켜, backend가 건대입구 출발을 기록하고
 * (1) GET이 2011을 출발 목록으로 내주며 (2) 그 코드를 수동 탭(sync)으로 보내면 2011이 lock되고
 * (3) 앵커에서 한 번도 못 본 코드는 계속 거부됨을 증명한다.
 *
 * 시간 주의(정직): 실측 position 갱신 주기상 06:36:45 cycle의 2011은 건대입구 sts=1(rcv 06:35:18)이고 출발(sts=2,
 * rcv 06:36:28)은 06:37:45 cycle에서야 backend에 보인다. 즉 backend가 출발을 알게 되는 가장 이른 tick은
 * 06:37:45이고 탭(06:36:30)은 그보다 75초 앞선다 — 이 테스트는 그 첫 tick 이후 시점을 검증한다.
 *
 * 입력은 `fixtures/replay_20261020_sleep_171/` — 통과시키려 조정 금지.
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
import app from '../index';
import { getTrip, putTrip } from '../trips';
import { readSelfPollPosition } from '../selfPollPosition';
import type { Env, Waypoint } from '../types';

const FIXTURE_DIR = 'replay_20261020_sleep_171';
const TOKEN = 'replay-20261020-sleep-171';
/** 06:37:45 cycle(2011 출발이 처음 보이는 cron) 이후 첫 tick = 06:38:45 KST 부근 — cap 파일명 1792445865343 다음. */
const FIRST_TICK_AFTER_DEPARTURE_SEEN = 1792445865343 + 30_000;
/** 2011의 건대입구 출발 실측 수신 시각(rcv 2026-10-20 06:36:28 KST). */
const DEPARTED_AT_KST_0636_28 = Date.UTC(2026, 9, 19, 21, 36, 28);

afterEach(() => vi.unstubAllGlobals());

interface Observation {
  tick: number;
  departedCodes: string[];
  getBody: { station: string; line: string; departed: Array<{ trainCode: string; departedAt: number; currentStation: string | null }> } | null;
  syncLock: Record<string, string | undefined>;
}

/** 06:38:45 cap(2011 성수 sts=1) 다음 tick. */
const FIRST_TICK_AFTER_2011_AT_SEONGSU = 1792445925192 + 30_000;

interface TapResult {
  headBefore: string[];
  headAfter: string[];
  lock: string | undefined;
  hasResponseMarker: boolean;
  eventsBeforeTap: number;
}

async function runReplay(mode: 'observe' | 'tap-2011') {
  const fixture = loadCapsFixture(FIXTURE_DIR);
  const d1 = loadD1Events(FIXTURE_DIR, 'events_171.json');
  const withoutPromoted = d1.filter((r) => !(JSON.parse(r.meta ?? '{}') as { promotedLock?: boolean }).promotedLock);
  const metrics = loadTripMetricsRow(FIXTURE_DIR, 171, 'trip_metrics_171.json');
  const firstMismatch = d1.find((e) => e.kind === 'route-signature-mismatch');
  if (!firstMismatch) throw new Error('fixture 전제 실패 — route-signature-mismatch 행 없음');
  const seedWaypoints: Waypoint[] = parseRouteSig(routeSigOf(firstMismatch, 'existingSig'));
  const seedTrip = buildTransferSeedTrip({
    token: TOKEN,
    waypoints: seedWaypoints,
    originStationName: metrics.origin_station as string,
    now: fixture.window.fromMs,
    overrides: { sleepModeEnabled: true, infoModeEnabled: true, activityPushToken: 'ab'.repeat(32), activityState: 'live' },
  });
  const { db, events } = makeTripEventSink();
  const stub = stubReplayFetch(fixture);
  const replayer = createDeviceReplayer({
    rows: withoutPromoted,
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
        sleepModeEnabled: true,
      },
    },
  });

  let observation: Observation | null = null;
  let tapped: TapResult | null = null;
  await runCaptureReplay({
    fixture,
    seedTrips: [seedTrip],
    apns: 'capture',
    twoPass: true,
    beforeTick: async ({ tick, env, kv, pushes }) => {
      (env as unknown as { DB: D1Database }).DB = db;
      stub.setNow(tick);
      await replayer.beforeTick({ tick, env: env as Env, pushes });
      if (mode === 'tap-2011') {
        // 2011이 성수에 도착(sts=1, cap 06:38:45)한 뒤의 첫 tick에서 목록의 2011을 탭한다.
        if (tapped !== null || tick < FIRST_TICK_AFTER_2011_AT_SEONGSU) return;
        const spy = vi.spyOn(Date, 'now').mockReturnValue(tick);
        try {
          const trip = await getTrip(kv, TOKEN);
          if (!trip) throw new Error('trip 없음');
          await putTrip(kv, {
            ...trip,
            boardingLock: undefined,
            recentPromptCandidates: { trainCodes: ['9999-never'], firedAt: tick - 60_000 },
            legResolveStreak: undefined,
          });
          const headBefore = trip.waypoints.map((w) => w.stationName);
          await app.fetch(
            new Request('http://example.com/boarding-lock/sync', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                token: TOKEN,
                observedStationName: '건대입구',
                observedAtMs: tick,
                accuracy: 20,
                trainCode: '2011',
                boardingLine: '2',
              }),
            }),
            env as Env,
          );
          const after = await getTrip(kv, TOKEN);
          tapped = {
            headBefore,
            headAfter: (after?.waypoints ?? []).map((w) => w.stationName),
            lock: after?.boardingLock?.trainCode,
            hasResponseMarker: after?.boardingResponse !== undefined,
            eventsBeforeTap: events.length,
          };
        } finally {
          spy.mockRestore();
        }
        return;
      }
      if (observation !== null || tick < FIRST_TICK_AFTER_DEPARTURE_SEEN) return;

      const stamp = await readSelfPollPosition(kv, '2');
      const departedCodes = (stamp?.stationLogs?.['건대입구']?.departed ?? []).map((d) => d.trainCode);

      const spy = vi.spyOn(Date, 'now').mockReturnValue(tick);
      let getBody: Observation['getBody'] = null;
      const syncLock: Observation['syncLock'] = {};
      try {
        const res = await app.fetch(new Request(`http://example.com/trips/${TOKEN}/anchor-departures`), env as Env);
        getBody = res.status === 200 ? ((await res.json()) as Observation['getBody']) : null;

        // 프롬프트는 무관한 열차(9999)만 제시했던 상태로 만든 뒤 — 목록 탭만이 근거인 상황 — 각 코드를 sync로 탭한다.
        for (const trainCode of ['2011', '3013', '9999']) {
          const trip = await getTrip(kv, TOKEN);
          if (!trip) throw new Error('trip 없음');
          await putTrip(kv, {
            ...trip,
            boardingLock: undefined,
            recentPromptCandidates: { trainCodes: ['9999-never'], firedAt: tick - 60_000 },
            legResolveStreak: undefined,
          });
          await app.fetch(
            new Request('http://example.com/boarding-lock/sync', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                token: TOKEN,
                observedStationName: '건대입구',
                observedAtMs: tick,
                accuracy: 20,
                trainCode,
                boardingLine: '2',
              }),
            }),
            env as Env,
          );
          syncLock[trainCode] = (await getTrip(kv, TOKEN))?.boardingLock?.trainCode;
        }
      } finally {
        spy.mockRestore();
      }
      observation = { tick, departedCodes, getBody, syncLock };
    },
  });
  return { observation, tapped: tapped as TapResult | null, events };
}

async function replayAndObserve(): Promise<Observation | null> {
  return (await runReplay('observe')).observation;
}

describe('#3155 트립 171 replay — 앵커역(건대입구) 출발 열차 목록', () => {
  it('06:37:45 cycle 이후 backend 기록에 2011이 건대입구 출발로 있고, 같은 시점 접근 중이던 3013은 없다', async () => {
    const o = await replayAndObserve();
    expect(o).not.toBeNull();
    expect(o?.departedCodes).toContain('2011');
    expect(o?.departedCodes).not.toContain('3013');
  });

  it('GET anchor-departures가 2011을 실측 출발 시각(06:36:28)과 현재 역(건대입구 출발 직후)과 함께 내준다', async () => {
    const o = await replayAndObserve();
    expect(o?.getBody?.station).toBe('건대입구');
    const row = o?.getBody?.departed.find((d) => d.trainCode === '2011');
    expect(row).toBeDefined();
    expect(row?.departedAt).toBe(DEPARTED_AT_KST_0636_28);
    // 이 시점 stamp(06:37:45 cycle)의 2011 = 건대입구 sts=2(막 출발). 성수 진입은 다음 cycle(06:38:45)에서야 반영된다.
    expect(row?.currentStation).toBe('건대입구');
    expect(o?.getBody?.departed.map((d) => d.trainCode)).not.toContain('3013');
  });

  it('출발 목록의 2011을 탭(sync)하면 2011이 lock된다 — 프롬프트 후보에 없어도', async () => {
    const o = await replayAndObserve();
    expect(o?.syncLock['2011']).toBe('2011');
  });

  // fast-forward — 실측 데이터의 한계(정직): 이 트립에서 2011은 성수에 도착(sts=1)한 상태가 마지막 관측이라
  // "앵커 이후 지난 중간역"이 0개다. 따라서 이 replay는 회귀 가드(건너뛸 것이 없을 때 아무것도 건드리지 않고,
  // 늦은 건대입구·성수 시도가 없고, 다음 알림이 뚝섬)이고, 실제로 건너뛰는 경로는 index.test의 fast-forward describe가 증명한다.
  it('2011이 성수에 도착한 뒤 탭: lock 2011, waypoint는 그대로(head 뚝섬), 이후 건대입구·성수 늦은 시도 0건·첫 매역 시도는 뚝섬', async () => {
    const r = await runReplay('tap-2011');
    expect(r.tapped?.lock).toBe('2011');
    // #3144 D3 — 앵커 관측(#3155) 승격 경로도 수동 목록 탭 = 사용자 행위라 응답 마커를 세운다(3경로 동급).
    expect(r.tapped?.hasResponseMarker).toBe(true);
    expect(r.tapped?.headAfter).toEqual(r.tapped?.headBefore);
    // #3083 PR-1: 탭 전(lockless, 환승 체류 창 안)에는 sync 관측(06:38:45 성수)이 leg-2 waypoint를 소비하지 못한다 —
    // 이전에는 이 lockless sync 소비로 head가 목적지 뚝섬이었다(실측 재생 결과). 지금은 성수가 head로 남는다.
    expect(r.tapped?.headAfter).toEqual(['성수', '뚝섬']);
    const station = r.events
      .slice(r.tapped?.eventsBeforeTap ?? 0)
      .filter((e) => e.kind === 'cron-fire-attempt' && e.station !== null)
      .map((e) => e.station);
    // 재생 창(06:44:45)까지 2011은 뚝섬 전에 피드에서 사라져 매역 시도 자체가 0건일 수 있다 — 시도가 있다면
    // 전부 다음 역(뚝섬)이어야 한다(지난 역에 대한 늦은 시도 금지).
    expect(station.every((s) => s === '뚝섬')).toBe(true);
  });

  it('앵커에서 한 번도 관측되지 않은 코드(9999)는 계속 거부된다', async () => {
    const o = await replayAndObserve();
    expect(o?.syncLock['9999']).toBeUndefined();
  });
});
