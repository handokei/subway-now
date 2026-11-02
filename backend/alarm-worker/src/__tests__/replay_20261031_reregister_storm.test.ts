/**
 * #2308 PR-2 — 2026-10-31 09:55~09:59 트립(토큰 해시 b00dd879, 용마산 -> 논현 7호선, lock 7077) whole-trip replay.
 *
 * 사고: cron이 강남구청을 소비한 직후 같은 세션 재등록(POST /trips)이 KV에서 낡은 trip을 읽어 그대로 다시 써서
 * cron이 강남구청을 4번 소비했고(D1 prepare-alarm 1915/1921/1926/1929), 열차가 09:57:13에 학동에 도착했는데
 * 학동 매역 알림은 열차가 논현에 진입한 뒤(09:59:46)에야 나갔다. ADR-042 결정 1("늦어도 다음 역 도착 전") 위반.
 *
 * 입력은 불변 실측 — `fixtures/replay_20261031_reregister_storm/`:
 *   - caps/*.json : R2 seoul-capture 5 cycle (09:55:45~09:59:45, R2 원문과 byte 동일).
 *     (계획이 적은 23 cycle 중 09:55:45 이전 cycle은 키 목록 admin endpoint가 ADMIN_TOKEN을 요구해 확보하지 못했다.
 *      재생은 D1 1912(09:55:40 head=강남구청) 상태에서 시작하므로 이 5 cycle로 충분하다.)
 *   - events.json : D1 trip_events 1861~1940 원문. 재등록(trip-register) 시각과 incoming waypoints(route-signature-mismatch
 *     incomingSig)를 여기서 그대로 가져온다. 통과시키려 조정 금지.
 * KV 엣지 캐시 지연은 CacheLagKV(읽기 cacheTtl = 지연)로 모델링하고, 모델 한계는 PR 본문에 적었다
 * (09:58:57 재등록은 운영에서 신선히 읽었다 — 균일 지연 모델은 이를 낡게 읽을 수 있다. 그래서 red 단언은 "학동 > 09:57:45 tick").
 *
 * assert는 실제로 나간 APNs 요청(종류·tick·횟수) 기준이다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env, Trip, Waypoint } from '../types';
import { sleepAlarmCollapseId } from '../collapseId';
import { waypointSignatureKey } from '../trips';
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
import { attachDb, latestTrip, makeLagKv, primeReplayKv } from './helpers/progressAuthorityReplay';
import { firedStationOccurrences } from './helpers/pushAssertions';
import { useApnsHarness } from './helpers/sleepAlarmHarness';

useApnsHarness();

const DIR = 'replay_20261031_reregister_storm';
const TOKEN = 'replay-2308-1031';
const HOUR_MS = 60 * 60_000;
/** D1 1912(09:55:40) — 재생 시작 상태 직전. 이 시각 이후의 재등록만 주입한다(1913 09:55:43 포함). */
const REGISTER_FROM_MS = 1793408140000;
/** 학동 도착(R2 캡처 1793408265543, sttus=1, recptn 09:57:13)을 볼 수 있는 첫 cron tick = 3번째 cycle. */
const ARRIVAL_TICK_INDEX = 2;
const STORM_STATIONS = { head: '강남구청', next: '학동', destination: '논현' } as const;

const rows = loadD1Events(DIR, 'events.json');
const rowOf = (id: number) => {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`D1 행 ${id}이 fixture에 없다`);
  return row;
};
/** D1 1877(09:43:28)의 existingSig = 군자 head 시점 전체 잔여 노선. lock 부착(09:41)에서 소비된 중곡을 앞에 더하면 원본 노선. */
const FULL_ROUTE_NAMES = ['중곡', ...parseRouteSig(routeSigOf(rowOf(1877), 'existingSig')).map((w) => w.stationName)];
/** D1 1912(09:55:40) existingSig = 재생 시작 시점 backend 진행분 = [강남구청, 학동, 논현]. */
const seedWaypoints = (): Waypoint[] =>
  parseRouteSig(routeSigOf(rowOf(1912), 'existingSig')).map((w) => ({ ...w, hopIndex: FULL_ROUTE_NAMES.indexOf(w.stationName) }));
/** lock 7077 segment = 탑승역(용마산, D1 1865 lock-attached station) + 부착 시점 잔여 노선 전체. */
const SEGMENT_STATIONS = [rowOf(1865).station as string, ...FULL_ROUTE_NAMES];

const fixture = loadCapsFixture(DIR);

function seedTrip(overrides: Partial<Trip> = {}): Trip {
  const now = fixture.window.fromMs;
  const waypoints = seedWaypoints();
  return {
    token: TOKEN,
    route: { type: 'direct', line: '7', stops: FULL_ROUTE_NAMES.length } as Trip['route'],
    destination: STORM_STATIONS.destination,
    originStationName: SEGMENT_STATIONS[0],
    waypoints,
    routeWaypoints: FULL_ROUTE_NAMES.map((stationName, hopIndex) => ({
      stationName,
      line: '7',
      kind: stationName === STORM_STATIONS.destination ? 'destination' : 'intermediate',
      hopIndex,
    })),
    boardingLock: {
      trainCode: '7077',
      line: '7',
      subwayId: '1007',
      selectedDepartureTime: now - 14 * 60_000,
      segmentStations: SEGMENT_STATIONS,
      expiresAt: now + HOUR_MS,
    },
    expiresAt: now + 3 * HOUR_MS,
    createdAt: now - 18 * 60_000,
    alarmAtEpochMs: now,
    infoModeEnabled: true,
    consecutiveEtaMissing: 0,
    ...overrides,
  } as Trip;
}

interface StormOpts {
  /** 재등록 payload에 lock을 싣는가(10/31 payload의 lock 실림 여부는 D1에 기록이 없어 두 변형을 모두 돌린다). */
  registerCarriesLock: boolean;
  sleep?: boolean;
  /** 재등록 주입을 끈다(대조군 — "재등록이 LA push를 늘리지 않음" 등식의 기준). */
  noRegisters?: boolean;
  laLive?: boolean;
}

async function replayStorm(opts: StormOpts) {
  const trip = seedTrip({
    ...(opts.sleep ? { sleepModeEnabled: true } : {}),
    ...(opts.laLive ? { activityPushToken: 'ab'.repeat(32), activityState: 'live' as const } : {}),
  });
  const { db, events } = makeTripEventSink();
  const stub = stubReplayFetch(fixture);
  const registerBody: Record<string, unknown> = {
    destination: trip.destination,
    route: trip.route,
    createdAt: trip.createdAt,
    infoModeEnabled: true,
    sleepModeEnabled: opts.sleep === true,
    ...(opts.registerCarriesLock ? { boardingLock: trip.boardingLock } : {}),
  };
  const replayer = createDeviceReplayer({
    rows: opts.noRegisters ? [] : rows.filter((r) => r.ts >= REGISTER_FROM_MS),
    token: TOKEN,
    stub,
    tapBody: () => {
      throw new Error('이 구간 D1에는 재생 대상 boarding-confirm이 없다');
    },
    mergeSyncByTs: true,
    register: { fromMs: REGISTER_FROM_MS, body: registerBody },
  });
  // seed trip과 progress는 지연 창 밖(과거)에 쓴다.
  vi.setSystemTime(fixture.window.fromMs - 10 * 60_000);
  const headsAfterTick: Array<string | undefined> = [];
  let kvRef: KVNamespace | undefined;
  const eventCountAtTickStart: number[] = [];
  const result = await runCaptureReplay({
    fixture,
    seedTrips: [trip],
    apns: 'capture',
    makeKv: makeLagKv,
    beforeTick: async ({ tick, tickIndex, env, kv, pushes }) => {
      kvRef = kv;
      if (tickIndex === 0) {
        await primeReplayKv(kv, tick, {
          token: TOKEN,
          // 운영 상태: lock 부착 이후 tick마다 mirror된 progress가 이미 있다(구 형식 — headKey 없음, 배포 직후 상태).
          progress: {
            trainCode: '7077',
            shiftedCount: FULL_ROUTE_NAMES.indexOf(STORM_STATIONS.head),
            headHopIndex: FULL_ROUTE_NAMES.indexOf(STORM_STATIONS.head),
            headKey: waypointSignatureKey(trip.waypoints[0]),
            ttlBasisExpiresAt: trip.expiresAt,
          },
        });
      } else {
        headsAfterTick.push(latestTrip(kv, TOKEN)?.waypoints[0]?.stationName);
      }
      attachDb(env as Env, db);
      eventCountAtTickStart.push(events.length);
      stub.setNow(tick);
      await replayer.beforeTick({ tick, env: env as Env, pushes });
      vi.setSystemTime(tick);
    },
  });
  eventCountAtTickStart.push(events.length);
  if (kvRef) headsAfterTick.push(latestTrip(kvRef, TOKEN)?.waypoints[0]?.stationName);
  return { result, events, eventCountAtTickStart, headsAfterTick, registers: replayer.registers, httpPushes: stub.httpPushes };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const stationAlertTicks = (r: Awaited<ReturnType<typeof replayStorm>>, station: string): number[] =>
  r.result.cycles.flatMap((cycle) =>
    firedStationOccurrences(cycle.pushes)
      .filter((name) => name === station)
      .map(() => cycle.simNowMs),
  );
/** tick별 cron-fire-attempt 행의 station(어떤 outcome이든 그 tick에 그 역을 소비 대상으로 평가했다는 뜻). */
function attemptStationsByTick(r: Awaited<ReturnType<typeof replayStorm>>): string[][] {
  return r.result.cycles.map((_, i) =>
    r.events
      .slice(r.eventCountAtTickStart[i], r.eventCountAtTickStart[i + 1])
      .filter((e) => e.kind === 'cron-fire-attempt')
      .map((e) => e.station as string),
  );
}

describe.each([
  ['재등록에 lock 실음', true],
  ['재등록에 lock 없음', false],
])('#2308 10/31 재등록 폭주 replay — %s', (_label, registerCarriesLock) => {
  it('재등록 주입이 실제로 일어났다 (전제): 09:55:43 이후 trip-register 11행이 전부 200', async () => {
    const r = await replayStorm({ registerCarriesLock });
    const expected = rows.filter(
      (row) => row.kind === 'trip-register' && row.ts >= REGISTER_FROM_MS && row.ts <= r.result.cycles.at(-1)!.simNowMs,
    );
    expect(r.registers).toHaveLength(expected.length);
    expect(r.registers.every((x) => x.status === 200)).toBe(true);
  });

  it('학동 매역 alert push는 09:57:45 tick 이하에서 정확히 1건', async () => {
    const r = await replayStorm({ registerCarriesLock });
    const arrivalTick = r.result.cycles[ARRIVAL_TICK_INDEX].simNowMs;
    const ticks = stationAlertTicks(r, STORM_STATIONS.next);
    expect({ count: ticks.length, withinArrivalTick: ticks.every((t) => t <= arrivalTick) }).toEqual({
      count: 1,
      withinArrivalTick: true,
    });
  });

  it('같은 역을 두 번 소비하지 않는다: 강남구청 평가는 첫 tick 1회뿐, 어떤 역도 2개 tick에 걸쳐 평가되지 않는다', async () => {
    const r = await replayStorm({ registerCarriesLock });
    const byTick = attemptStationsByTick(r);
    expect(byTick[0]).toContain(STORM_STATIONS.head);
    const seenInTicks = new Map<string, number>();
    byTick.forEach((stations) => {
      new Set(stations).forEach((station) => seenInTicks.set(station, (seenInTicks.get(station) ?? 0) + 1));
    });
    expect([...seenInTicks].filter(([, ticks]) => ticks > 1)).toEqual([]);
  });

  it('cron tick 사이에 trip head가 뒤로 가지 않는다 (tick 종료 시점 head가 노선 순서상 단조 비감소)', async () => {
    const r = await replayStorm({ registerCarriesLock });
    const positions = r.headsAfterTick.map((name) => (name === undefined ? FULL_ROUTE_NAMES.length : FULL_ROUTE_NAMES.indexOf(name)));
    const backwards = positions.flatMap((pos, i) => (i > 0 && pos < positions[i - 1] ? [{ tick: i, from: r.headsAfterTick[i - 1], to: r.headsAfterTick[i] }] : []));
    expect(backwards).toEqual([]);
  });

  it('되돌림이 생기면 다음 tick의 cron 맞춤이 앞으로만 복구하고 D1 progress-reconcile 행을 남긴다 (발사 없이)', async () => {
    const r = await replayStorm({ registerCarriesLock });
    const reconciles = r.events.filter((e) => e.kind === 'progress-reconcile');
    expect(reconciles.length).toBeGreaterThan(0);
    for (const row of reconciles) {
      const { fromKey, toKey } = row.meta as { fromKey: string; toKey: string };
      expect(FULL_ROUTE_NAMES.indexOf(toKey.split('|')[0])).toBeGreaterThan(FULL_ROUTE_NAMES.indexOf(fromKey.split('|')[0]));
    }
  });
});

describe('#2308 10/31 — 취침 변형: 학동 도착 tick에 논현 1역 전 알람(alarm.wav)이 정확히 1건', () => {
  it.each([true, false])('재등록에 lock 실음=%s', async (registerCarriesLock) => {
    const r = await replayStorm({ registerCarriesLock, sleep: true });
    const arrivalTick = r.result.cycles[ARRIVAL_TICK_INDEX].simNowMs;
    const alarmId = sleepAlarmCollapseId(TOKEN, STORM_STATIONS.destination);
    const alarms = r.result.cycles.flatMap((cycle) =>
      cycle.pushes.filter((p) => p.headers.collapseId === alarmId).map(() => cycle.simNowMs),
    );
    expect({ count: alarms.length, withinArrivalTick: alarms.every((t) => t <= arrivalTick) }).toEqual({
      count: 1,
      withinArrivalTick: true,
    });
  });
});

describe('#2308 10/31 — KV 비용: 진입 progress 읽기는 같은 tick mirror가 재사용한다', () => {
  it('tick별 재사용 못 한 진입 읽기(progressEntryReadUnused) 기록', async () => {
    const r = await replayStorm({ registerCarriesLock: true });
    expect(r.result.cycles.map((c) => c.stats.progressEntryReadUnused)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('#2308 10/31 — 재등록은 LA push를 늘리지 않는다 (LA 기준값은 cron 자신의 progress 값으로 복원)', () => {
  const laPushCount = (r: Awaited<ReturnType<typeof replayStorm>>) =>
    r.result.pushes.filter((p) => p.headers.pushType === 'liveactivity').length;

  it.each([true, false])('재등록에 lock 실음=%s: LA push 수(재등록 주입) === LA push 수(무주입 대조)', async (registerCarriesLock) => {
    const withRegisters = await replayStorm({ registerCarriesLock, laLive: true });
    const control = await replayStorm({ registerCarriesLock, laLive: true, noRegisters: true });
    expect(control.registers).toEqual([]);
    expect(laPushCount(control)).toBeGreaterThan(0); // 전제: LA push가 실제로 나가는 시나리오
    expect(laPushCount(withRegisters)).toBe(laPushCount(control));
  });
});
