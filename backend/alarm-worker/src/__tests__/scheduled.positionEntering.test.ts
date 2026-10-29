/**
 * #3223 — 매역 알림을 열차 위치(realtimePosition) 진입(trainSttus 0) 시점에 1회 발사.
 *
 * 스펙(이슈 #3223 + plan v2/v2.1, 결정 U1~U3): 발사 시점만 앞당긴다.
 *  - intermediate 매역만(transfer/destination 은 현행 도착 시점 유지, U1)
 *  - 번호 변경역(2호선 성수)은 진입 트리거 제외(U3)
 *  - advance(waypoint shift)·취침 알람·준비 진동은 도착 확정 그대로(U2) — 진입 발사는 trip/SSoT를 mutate하지 않는다
 *  - 역당 1회 — `stationPassedFiredKey` 공용 dedup, 진입 창을 건너뛰면 도착 시점에 1회 폴백
 *  - KV 쓰기는 dedup 키 1건뿐(순증 0, v2-3)
 */
import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { RENUMBER_LINE, RENUMBER_STATION } from '../renumberSuccessor';
import {
  estimateBoardingLockArrival,
  isEnteringTarget,
  runMidCycleFireOnly,
  runScheduled,
  stationPassedFiredKey,
  type MidCycleTripSnapshot,
  type ScheduledDeps,
} from '../scheduled';
import { SeoulArrivalClient, type PositionEntry } from '../seoul';
import { putTrip } from '../trips';
import type { BoardingLockMeta, Env, Trip, Waypoint } from '../types';
import { InMemoryKV } from './inMemoryKv';

let apnsConfig: ApnsConfig;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  apnsConfig = { keyId: 'K', teamId: 'T', privateKeyPem: await exportPKCS8(privateKey), bundleId: 'com.example.app' };
});
beforeEach(() => resetApnsJwtCache());

const KST_OFFSET_MS = 9 * 3600_000;
const T0 = Date.UTC(2026, 9, 27, 21, 30, 40); // 2026-10-28 06:30:40 KST
const TICK_MS = 60_000;
const APNS_HOSTS = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' } as const;
const TOKEN = 'entering-tok';

const SEGMENT = ['용마산', '중곡', '군자(능동)', '어린이대공원(세종대)', '건대입구'];
const STATUS = { ENTERING: '0', ARRIVED: '1', DEPARTED: '2' } as const;

function kstStamp(ms: number): string {
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}

function lockOf(overrides: Partial<BoardingLockMeta> = {}): BoardingLockMeta {
  return {
    trainCode: '7035',
    line: '7',
    subwayId: '1007',
    selectedDepartureTime: T0,
    segmentStations: SEGMENT,
    expiresAt: T0 + 3600_000,
    ...overrides,
  };
}

function tripOf(waypoints: Waypoint[], overrides: Partial<Trip> = {}): Trip {
  return {
    token: TOKEN,
    route: { type: 'direct', line: '7', stops: waypoints.length },
    destination: waypoints[waypoints.length - 1].stationName,
    waypoints,
    expiresAt: T0 + 3600_000,
    createdAt: T0 - 60_000,
    alarmAtEpochMs: T0 - 60_000,
    infoModeEnabled: true,
    boardingLock: lockOf(),
    ...overrides,
  };
}

const GUNJA: Waypoint = { stationName: '군자(능동)', line: '7', kind: 'intermediate' };
const AEDAE: Waypoint = { stationName: '어린이대공원(세종대)', line: '7', kind: 'intermediate' };
const GEONDAE_TRANSFER: Waypoint = { stationName: '건대입구', line: '7', kind: 'transfer' };
const GEONDAE_DEST: Waypoint = { stationName: '건대입구', line: '7', kind: 'destination' };

interface RawPosition {
  stationName: string;
  sttus: (typeof STATUS)[keyof typeof STATUS];
  trainCode?: string;
  line?: string;
}

function seoulAt(now: number, positions: RawPosition[]): SeoulArrivalClient {
  return new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: () => now,
    fetchImpl: (async (url: string) => {
      if (!String(url).includes('/realtimePosition/')) {
        return new Response('{"realtimeArrivalList":[]}', { status: 200 });
      }
      const list = positions.map((p) => ({
        subwayId: '1007',
        subwayNm: '7호선',
        statnNm: p.stationName,
        trainNo: p.trainCode ?? '7035',
        recptnDt: kstStamp(now - 20_000),
        updnLine: '1',
        trainSttus: p.sttus,
        statnTnm: '석남',
        directAt: '0',
      }));
      return new Response(JSON.stringify({ realtimePositionList: list }), { status: 200 });
    }) as unknown as typeof fetch,
  });
}

function pos(stationName: string, sttus: RawPosition['sttus'], trainCode = '7035'): PositionEntry {
  return { trainCode, stationName, trainSttus: Number(sttus), isUp: false, recptnMs: T0 - 20_000 };
}

describe('isEnteringTarget — 순수 판정', () => {
  const lock = lockOf();

  it('목표역에서 진입(0)이면 true', () => {
    expect(isEnteringTarget(pos('군자(능동)', STATUS.ENTERING), '군자(능동)', lock)).toBe(true);
  });

  it('도착(1)·출발(2)은 진입이 아니다 — 도착은 기존 arrived 경로 소관', () => {
    expect(isEnteringTarget(pos('군자(능동)', STATUS.ARRIVED), '군자(능동)', lock)).toBe(false);
    expect(isEnteringTarget(pos('군자(능동)', STATUS.DEPARTED), '군자(능동)', lock)).toBe(false);
  });

  it('진입이지만 목표역이 아니면 false (직전 역 진입은 목표역 진입이 아니다)', () => {
    expect(isEnteringTarget(pos('중곡', STATUS.ENTERING), '군자(능동)', lock)).toBe(false);
  });

  it('목표역이 lock segment 밖이면 false', () => {
    expect(isEnteringTarget(pos('성수', STATUS.ENTERING), '성수', lock)).toBe(false);
  });

  it('번호 변경역(데이터 meta.renumberStation)은 진입 트리거 제외 — 451초 일찍 울리는 성수 3047 방지(U3)', () => {
    const renumberLock = lockOf({ line: RENUMBER_LINE, segmentStations: ['건대입구', RENUMBER_STATION, '뚝섬'] });
    expect(isEnteringTarget(pos(RENUMBER_STATION, STATUS.ENTERING), RENUMBER_STATION, renumberLock)).toBe(false);
    // 같은 데이터의 다른 역은 진입 트리거 허용 — 하드코딩 제외가 아니라 번호 변경역 데이터 주도 제외임을 고정.
    expect(isEnteringTarget(pos('건대입구', STATUS.ENTERING), '건대입구', renumberLock)).toBe(true);
  });
});

describe('estimateBoardingLockArrival — entering 신호', () => {
  const deps = (positions: RawPosition[]) => ({ seoul: seoulAt(T0, positions) }) as unknown as ScheduledDeps;

  it('position 진입(0) + arrivals 없음 → arrived:false, entering:true', async () => {
    const estimate = await estimateBoardingLockArrival(deps([{ stationName: '군자(능동)', sttus: STATUS.ENTERING }]), lockOf(), GUNJA, T0);
    expect(estimate).toMatchObject({ arrived: false, entering: true });
  });

  it('직전 역 진입 · 도착 · 목표역 멀리 → entering 없음', async () => {
    for (const position of [
      { stationName: '중곡', sttus: STATUS.ENTERING },
      { stationName: '용마산', sttus: STATUS.ARRIVED },
    ] as RawPosition[]) {
      const estimate = await estimateBoardingLockArrival(deps([position]), lockOf(), GUNJA, T0);
      expect(estimate).toMatchObject({ arrived: false });
      expect(estimate).not.toHaveProperty('entering');
    }
    const arrivedAtTarget = await estimateBoardingLockArrival(deps([{ stationName: '군자(능동)', sttus: STATUS.ARRIVED }]), lockOf(), GUNJA, T0);
    expect(arrivedAtTarget).toMatchObject({ arrived: true });
    expect(arrivedAtTarget).not.toHaveProperty('entering');
  });
});

/** KV put을 기록하는 InMemoryKV + D1 trip_events 가로채기. */
function makeWorld() {
  const kv = new InMemoryKV(() => T0);
  const putKeys: string[] = [];
  const realPut = kv.put.bind(kv);
  vi.spyOn(kv, 'put').mockImplementation(((key: string, value: string, opts?: unknown) => {
    putKeys.push(key);
    return realPut(key, value, opts as never);
  }) as never);
  const events: { kind: string; station: string | null; meta: Record<string, unknown> }[] = [];
  const db = {
    prepare: () => ({
      bind: (...args: unknown[]) => {
        events.push({
          kind: args[2] as string,
          station: args[3] as string | null,
          meta: args[5] ? (JSON.parse(args[5] as string) as Record<string, unknown>) : {},
        });
        return { run: async () => ({ success: true }), first: async () => null };
      },
    }),
  } as unknown as D1Database;
  const env = {
    TRIPS: kv as unknown as KVNamespace,
    APNS_HOST: APNS_HOSTS.production,
    APNS_HOST_SANDBOX: APNS_HOSTS.sandbox,
    SEOUL_API_HOST: 'seoul.api',
    SEOUL_API_KEY: 'KEY',
    APNS_KEY_ID: 'K',
    APNS_TEAM_ID: 'T',
    APNS_PRIVATE_KEY: apnsConfig.privateKeyPem,
    APNS_BUNDLE_ID: 'com.example.app',
    DB: db,
  } as unknown as Env;
  const pushes: Array<{ at: number; collapseId?: string }> = [];
  let tick = 0;
  return {
    kv,
    env,
    events,
    pushes,
    putKeys,
    async seed(trip: Trip) {
      await putTrip(kv as unknown as KVNamespace, trip);
    },
    async trip(): Promise<Trip> {
      return JSON.parse((await kv.get(`trip:${TOKEN}`)) as string) as Trip;
    },
    /** cron tick 1회 — positions 주입. 반환: 이 tick에서 새로 생긴 이벤트·put 키. */
    async runTick(positions: RawPosition[]) {
      const now = T0 + tick * TICK_MS;
      tick += 1;
      const before = { events: events.length, puts: putKeys.length, pushes: pushes.length };
      const apnsFetch = (async (_url: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        pushes.push({ at: now, collapseId: headers['apns-collapse-id'] });
        return new Response('', { status: 200 });
      }) as unknown as typeof fetch;
      await runScheduled(env, {
        seoul: seoulAt(now, positions),
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: apnsFetch,
        now: () => now,
        generatePushId: () => `push-${now}`,
        archFlag: 'off',
      });
      return {
        now,
        events: events.slice(before.events),
        puts: putKeys.slice(before.puts),
        pushes: pushes.slice(before.pushes),
      };
    },
  };
}

const sent = (events: ReturnType<typeof makeWorld>['events'], station: string) =>
  events.filter((e) => e.kind === 'cron-fire-attempt' && e.station === station && e.meta.outcome === 'sent');

describe('runScheduled 메인 pass — intermediate 매역 진입 발사', () => {
  it('진입(0) tick: 매역 push 1건, D1 path=position-entering, waypoint 불변(advance 0), 취침·준비 알람 0', async () => {
    const world = makeWorld();
    await world.seed(tripOf([GUNJA, AEDAE, GEONDAE_TRANSFER]));
    const tick = await world.runTick([{ stationName: '군자(능동)', sttus: STATUS.ENTERING }]);

    const rows = sent(tick.events, '군자(능동)');
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toMatchObject({ waypointKind: 'station-passed', path: 'position-entering' });
    expect(tick.pushes.filter((p) => (p.collapseId ?? '').startsWith('station-'))).toHaveLength(1);
    expect((await world.trip()).waypoints.map((w) => w.stationName)).toEqual(['군자(능동)', '어린이대공원(세종대)', '건대입구']);
    expect(tick.events.filter((e) => e.kind === 'prepare-alarm' && e.meta.outcome === 'fired')).toEqual([]);
    expect(tick.pushes.filter((p) => (p.collapseId ?? '').startsWith('prepare-'))).toEqual([]);
  });

  it('진입 발사 뒤 같은 역 도착 tick: advance 하되 매역 push 재발사 0 (dedup)', async () => {
    const world = makeWorld();
    await world.seed(tripOf([GUNJA, AEDAE, GEONDAE_TRANSFER]));
    await world.runTick([{ stationName: '군자(능동)', sttus: STATUS.ENTERING }]);
    const arrived = await world.runTick([{ stationName: '군자(능동)', sttus: STATUS.ARRIVED }]);

    expect(sent(arrived.events, '군자(능동)')).toEqual([]);
    expect(arrived.pushes.filter((p) => (p.collapseId ?? '').startsWith('station-'))).toEqual([]);
    expect((await world.trip()).waypoints.map((w) => w.stationName)).toEqual(['어린이대공원(세종대)', '건대입구']);
  });

  it('진입이 연속 2 tick 보여도 발사는 1회 (중복 발사 0)', async () => {
    const world = makeWorld();
    await world.seed(tripOf([GUNJA, AEDAE, GEONDAE_TRANSFER]));
    const first = await world.runTick([{ stationName: '군자(능동)', sttus: STATUS.ENTERING }]);
    const second = await world.runTick([{ stationName: '군자(능동)', sttus: STATUS.ENTERING }]);
    expect(sent(first.events, '군자(능동)')).toHaveLength(1);
    expect(sent(second.events, '군자(능동)')).toEqual([]);
  });

  it('진입 창을 건너뛰면(첫 관측이 도착) 도착 시점에 1회 폴백 — 진입 경로 표식 없음', async () => {
    const world = makeWorld();
    await world.seed(tripOf([GUNJA, AEDAE, GEONDAE_TRANSFER]));
    const tick = await world.runTick([{ stationName: '군자(능동)', sttus: STATUS.ARRIVED }]);
    const rows = sent(tick.events, '군자(능동)');
    expect(rows).toHaveLength(1);
    expect(rows[0].meta.path).not.toBe('position-entering');
  });

  it('KV 쓰기: 진입 tick은 같은 조건의 비발사 tick 대비 dedup 키 1건만 추가 (순증 0)', async () => {
    const entering = makeWorld();
    await entering.seed(tripOf([GUNJA, AEDAE, GEONDAE_TRANSFER]));
    const enteringTick = await entering.runTick([{ stationName: '군자(능동)', sttus: STATUS.ENTERING }]);

    const control = makeWorld();
    await control.seed(tripOf([GUNJA, AEDAE, GEONDAE_TRANSFER]));
    // 통제군: 열차가 아직 직전 역에서 출발(2) — 어떤 발사 조건도 아니다.
    const controlTick = await control.runTick([{ stationName: '중곡', sttus: STATUS.DEPARTED }]);

    const extra = [...enteringTick.puts];
    for (const key of controlTick.puts) {
      const idx = extra.indexOf(key);
      if (idx >= 0) extra.splice(idx, 1);
    }
    expect(extra).toEqual([stationPassedFiredKey(TOKEN, '7035', '군자(능동)')]);
  });

  it('거부 — 번호 변경역(성수) 진입은 발사하지 않는다 (도착 시점 유지, U3)', async () => {
    const world = makeWorld();
    const waypoint: Waypoint = { stationName: RENUMBER_STATION, line: RENUMBER_LINE, kind: 'intermediate' };
    await world.seed(
      tripOf([waypoint, { stationName: '뚝섬', line: RENUMBER_LINE, kind: 'destination' }], {
        boardingLock: lockOf({ line: RENUMBER_LINE, subwayId: '1002', segmentStations: ['건대입구', RENUMBER_STATION, '뚝섬'] }),
      }),
    );
    const tick = await world.runTick([{ stationName: RENUMBER_STATION, sttus: STATUS.ENTERING }]);
    expect(sent(tick.events, RENUMBER_STATION)).toEqual([]);
  });

  it('거부 — transfer waypoint 진입은 발사하지 않는다 (U1)', async () => {
    const world = makeWorld();
    await world.seed(tripOf([GEONDAE_TRANSFER, { stationName: '성수', line: '2', kind: 'destination' }]));
    const tick = await world.runTick([{ stationName: '건대입구', sttus: STATUS.ENTERING }]);
    expect(tick.events.filter((e) => e.kind === 'cron-fire-attempt' && e.meta.outcome === 'sent')).toEqual([]);
    expect(tick.pushes.filter((p) => (p.collapseId ?? '').startsWith('station-'))).toEqual([]);
    expect((await world.trip()).waypoints).toHaveLength(2);
  });

  it('거부 — destination waypoint 진입은 발사하지 않는다 (U1)', async () => {
    const world = makeWorld();
    await world.seed(tripOf([GEONDAE_DEST]));
    const tick = await world.runTick([{ stationName: '건대입구', sttus: STATUS.ENTERING }]);
    expect(tick.events.filter((e) => e.kind === 'cron-fire-attempt' && e.meta.outcome === 'sent')).toEqual([]);
    expect(tick.pushes.filter((p) => (p.collapseId ?? '').startsWith('station-'))).toEqual([]);
  });

  it('거부 — 취침 모드 intermediate 는 진입 발사도 무음 skip (isSleepMutedStationNotif 공유)', async () => {
    const world = makeWorld();
    await world.seed(tripOf([GUNJA, AEDAE, GEONDAE_TRANSFER], { sleepModeEnabled: true }));
    const tick = await world.runTick([{ stationName: '군자(능동)', sttus: STATUS.ENTERING }]);
    expect(sent(tick.events, '군자(능동)')).toEqual([]);
  });
});

describe('runMidCycleFireOnly — 진입 발사 (mid pass)', () => {
  const snapshotOf = (trip: Trip): MidCycleTripSnapshot => ({ trip, waypoint: trip.waypoints[0], lock: trip.boardingLock! });

  async function runMid(trip: Trip, positions: RawPosition[], world = makeWorld()) {
    const stats = await runMidCycleFireOnly(
      world.env,
      [snapshotOf(trip)],
      { seoul: seoulAt(T0, positions), apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: (async () => new Response('', { status: 200 })) as unknown as typeof fetch },
      T0,
      () => undefined,
      () => 'mid-push',
    );
    return { stats, world };
  }

  it('intermediate 진입 → 1건 발사, D1 midCycle:true + path=position-entering, 같은 키 재실행은 dedup으로 0', async () => {
    const trip = tripOf([GUNJA, AEDAE]);
    const first = await runMid(trip, [{ stationName: '군자(능동)', sttus: STATUS.ENTERING }]);
    expect(first.stats).toEqual({ evaluated: 1, fired: 1, errors: 0 });
    expect(sent(first.world.events, '군자(능동)')[0].meta).toMatchObject({ midCycle: true, path: 'position-entering' });
    expect(await first.world.kv.get(stationPassedFiredKey(TOKEN, '7035', '군자(능동)'))).not.toBeNull();

    const second = await runMid(trip, [{ stationName: '군자(능동)', sttus: STATUS.ARRIVED }], first.world);
    expect(second.stats).toEqual({ evaluated: 1, fired: 0, errors: 0 });
  });

  it('거부 — transfer·destination 진입은 발사 0 (U1)', async () => {
    const transfer = await runMid(tripOf([GEONDAE_TRANSFER, AEDAE]), [{ stationName: '건대입구', sttus: STATUS.ENTERING }]);
    expect(transfer.stats).toEqual({ evaluated: 1, fired: 0, errors: 0 });
    const destination = await runMid(tripOf([GEONDAE_DEST]), [{ stationName: '건대입구', sttus: STATUS.ENTERING }]);
    expect(destination.stats).toEqual({ evaluated: 1, fired: 0, errors: 0 });
  });

  it('거부 — 번호 변경역·취침 intermediate 는 발사 0', async () => {
    const waypoint: Waypoint = { stationName: RENUMBER_STATION, line: RENUMBER_LINE, kind: 'intermediate' };
    const renumber = tripOf([waypoint], {
      boardingLock: lockOf({ line: RENUMBER_LINE, segmentStations: ['건대입구', RENUMBER_STATION, '뚝섬'] }),
    });
    expect((await runMid(renumber, [{ stationName: RENUMBER_STATION, sttus: STATUS.ENTERING }])).stats.fired).toBe(0);
    const sleeping = tripOf([GUNJA, AEDAE], { sleepModeEnabled: true });
    expect((await runMid(sleeping, [{ stationName: '군자(능동)', sttus: STATUS.ENTERING }])).stats.fired).toBe(0);
  });
});
