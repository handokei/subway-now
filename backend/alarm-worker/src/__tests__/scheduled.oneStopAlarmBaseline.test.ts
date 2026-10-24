/**
 * #3100 선행 — "1역 전 알람"(취침 `maybeFireSleepAlarm` / 준비 `maybeFirePrepareAlarm`) 현행 동작 baseline.
 * 프로덕션 코드 diff 0. 기대(사용자 지시 2026-10-23): lock 걸린 트립에서 환승역·하차역 각각 **바로 앞 역에서 정확히 1회**,
 * 출발역(=1역 전인 1정거장 leg)에서는 안 울림, lock 없으면 안 울림.
 *
 * 시나리오 번호는 PR 본문 표와 같다:
 *  1 cron 1역 전진(환승 타깃 / 하차 타깃)  2 sync 다역 점프 catch-up(#3160)  3 승격 fast-forward(index.ts)
 *  4 leg-2(환승 후) 1역 전  5 1정거장 leg  6 lock 없음  7 같은 타깃 재평가 중복 0
 * 실측 트립 168/171/173은 `replay_20261023_one_stop_alarm_baseline.test.ts`.
 */
import { exportPKCS8, generateKeyPair } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { prepareAlarmCollapseId, sleepAlarmCollapseId } from '../collapseId';
import app from '../index';
import {
  completeWaypointAdvance,
  createEmptyScheduledStats,
  fireSyncConsumedPrecedingAlarms,
  runScheduled,
  sleepAlarmFireKey,
  type ScheduledDeps,
  type SyncSkippedFireDeps,
} from '../scheduled';
import { SeoulArrivalClient } from '../seoul';
import { putTrip } from '../trips';
import { inferLegDirection } from '../legDirection';
import type { BoardingLockMeta, Env, Trip, Waypoint } from '../types';
import { InMemoryKV } from './inMemoryKv';

let apnsConfig: ApnsConfig;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  apnsConfig = { keyId: 'K', teamId: 'T', privateKeyPem: await exportPKCS8(privateKey), bundleId: 'com.example.app' };
});
beforeEach(() => resetApnsJwtCache());
afterEach(() => vi.unstubAllGlobals());

const NOW = 1_700_000_000_000;
const TICK_MS = 60_000;
const APNS_HOSTS = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' } as const;
const TOKEN = 'onestop-tok';
const TRAIN = '7246';

function makeEnv(kv: InMemoryKV): Env {
  return {
    TRIPS: kv as unknown as KVNamespace,
    APNS_HOST: APNS_HOSTS.production,
    APNS_HOST_SANDBOX: APNS_HOSTS.sandbox,
    SEOUL_API_HOST: 'seoul.api',
    SEOUL_API_KEY: 'KEY',
    APNS_KEY_ID: apnsConfig.keyId,
    APNS_TEAM_ID: apnsConfig.teamId,
    APNS_PRIVATE_KEY: apnsConfig.privateKeyPem,
    APNS_BUNDLE_ID: apnsConfig.bundleId,
  };
}

const wp = (stationName: string, kind: Waypoint['kind'], line = '7'): Waypoint => ({ stationName, line, kind });

function makeLock(segmentStations: string[], line = '7'): BoardingLockMeta {
  return {
    trainCode: TRAIN,
    line,
    subwayId: line === '7' ? '1007' : '1002',
    selectedDepartureTime: NOW,
    segmentStations,
    expiresAt: NOW + 3 * 60 * 60_000,
  };
}

function makeTrip(waypoints: Waypoint[], overrides: Partial<Trip> = {}): Trip {
  const line = waypoints[0].line;
  return {
    token: TOKEN,
    route: { type: 'direct', line, stops: waypoints.length },
    destination: waypoints[waypoints.length - 1].stationName,
    waypoints,
    expiresAt: NOW + 3 * 60 * 60_000,
    createdAt: NOW,
    alarmAtEpochMs: NOW - 60_000,
    sleepModeEnabled: true,
    boardingLock: makeLock(waypoints.map((w) => w.stationName), line),
    ...overrides,
  };
}

/** 푸시 캡처 fetch — collapse-id(`alarm-`=취침 / `prepare-`=준비) 와 push-type을 기록한다. */
function captureFetch() {
  const calls: { collapseId?: string; pushType?: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (_url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
    const h = init?.headers ?? {};
    calls.push({ collapseId: h['apns-collapse-id'], pushType: h['apns-push-type'], body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

/** 1역 전 알람 alert(취침/준비) collapse-id 목록 — 매역/프롬프트 등 다른 alert는 제외. */
const alarmIds = (calls: { collapseId?: string; pushType?: string }[]) =>
  calls
    .filter((c) => c.pushType === 'alert' && /^(alarm|prepare)-/.test(c.collapseId ?? ''))
    .map((c) => c.collapseId as string);

function seoulWith(waypointStation: string, arvlCd: number, trainCode = TRAIN): SeoulArrivalClient {
  return new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: () => NOW,
    fetchImpl: (async (url: string) => {
      if (url.includes('/realtimePosition/')) return new Response(JSON.stringify({ realtimePositionList: [] }), { status: 200 });
      return new Response(
        JSON.stringify({
          realtimeArrivalList: [
            {
              barvlDt: '0',
              recptnDt: '',
              updnLine: '상행',
              trainLineNm: waypointStation,
              btrainNo: trainCode,
              subwayNm: '지하철7호선',
              arvlCd: String(arvlCd),
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch,
  });
}

/** cron 1 tick: 현재 head waypoint에 lock 열차가 진입(arvlCd=1)했다고 보고 runScheduled를 돌린다. */
async function cronTick(kv: InMemoryKV, fetchImpl: typeof fetch, tickIdx: number, headStation: string, arvlCd = 1) {
  return runScheduled(makeEnv(kv), {
    seoul: seoulWith(headStation, arvlCd),
    apnsConfig,
    apnsHosts: APNS_HOSTS,
    fetchImpl,
    now: () => NOW + tickIdx * TICK_MS,
    generatePushId: () => `p-${tickIdx}`,
  });
}

/** 정상 주행 walk: waypoints 앞에서부터 1 tick당 1역 진입. 각 tick 뒤 알람 누적 개수를 돌려준다. */
async function walkTrip(trip: Trip) {
  const kv = new InMemoryKV(() => NOW);
  const f = captureFetch();
  await putTrip(kv as unknown as KVNamespace, trip);
  const perTick: { station: string; alarmsSoFar: string[] }[] = [];
  for (let i = 0; i < trip.waypoints.length; i++) {
    const { stationName } = trip.waypoints[i];
    await cronTick(kv, f.fetchImpl, i, stationName);
    perTick.push({ station: stationName, alarmsSoFar: alarmIds(f.calls) });
  }
  return { perTick, calls: f.calls };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
describe('#3100 선행 시나리오 1·4 — cron 1역 전진(정상 주행): 타깃 바로 앞 역에서 정확히 1회', () => {
  // 데이터 주도: 환승 타깃 / 하차 타깃(leg-1) / 하차 타깃(leg-2, 환승 후 lock) 모두 같은 규칙.
  const CASES: { name: string; waypoints: Waypoint[]; target: string; line: string }[] = [
    {
      name: '1 leg-1 환승 타깃 (군자 -> 어린이대공원 -> [건대입구])',
      waypoints: [wp('중곡', 'intermediate'), wp('군자', 'intermediate'), wp('어린이대공원', 'intermediate'), wp('건대입구', 'transfer')],
      target: '건대입구',
      line: '7',
    },
    {
      name: '1 하차 타깃 (중곡 -> 군자 -> [어린이대공원])',
      waypoints: [wp('중곡', 'intermediate'), wp('군자', 'intermediate'), wp('어린이대공원', 'destination')],
      target: '어린이대공원',
      line: '7',
    },
    {
      name: '4 leg-2(환승 후) 하차 타깃 (성수 -> [뚝섬])',
      waypoints: [wp('성수', 'intermediate', '2'), wp('뚝섬', 'destination', '2')],
      target: '뚝섬',
      line: '2',
    },
  ];

  for (const c of CASES) {
    for (const sleep of [true, false]) {
      it(`${c.name} / ${sleep ? '취침 알람' : '준비 알람'}: 타깃의 직전 역 tick에서만 1회, 그 전·후 tick에는 0`, async () => {
        const trip = makeTrip(c.waypoints, { sleepModeEnabled: sleep });
        const { perTick } = await walkTrip(trip);
        const expectedId = (sleep ? sleepAlarmCollapseId : prepareAlarmCollapseId)(TOKEN, c.target);
        const preceding = c.waypoints.length - 2;
        perTick.forEach((t, i) => {
          if (i < preceding) expect(t.alarmsSoFar).toEqual([]); // 출발/중간역에서는 안 울린다
          else expect(t.alarmsSoFar).toEqual([expectedId]); // 직전 역 tick에서 1회, 타깃 도착 tick에서도 그대로 1회
        });
      });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe('#3100 선행 시나리오 5 — 1정거장짜리 leg(출발역 = 1역 전): 안 울림 (ADR-024)', () => {
  it('waypoints=[하차역] 하나뿐이면 head(하차역) 진입에도 알람 0', async () => {
    const { calls } = await walkTrip(makeTrip([wp('뚝섬', 'destination', '2')]));
    expect(alarmIds(calls)).toEqual([]);
  });

  it('waypoints=[환승역] 하나뿐이어도 알람 0', async () => {
    const { calls } = await walkTrip(makeTrip([wp('건대입구', 'transfer')]));
    expect(alarmIds(calls)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe('#3100 선행 시나리오 6 — lock 없음: 안 울림 (#3140 "lock 없음 = 알림 없음")', () => {
  const waypoints = [wp('중곡', 'intermediate'), wp('군자', 'intermediate'), wp('어린이대공원', 'destination')];

  it('lockless 트립이 1역 전 waypoint를 완료해도(completeWaypointAdvance) 알람 0', async () => {
    const kv = new InMemoryKV(() => NOW);
    const f = captureFetch();
    const trip = makeTrip(waypoints.slice(1), { boardingLock: undefined });
    const deps = { seoul: seoulWith('군자', 1), apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: f.fetchImpl, now: () => NOW } as ScheduledDeps;
    await completeWaypointAdvance(trip, trip.waypoints[0], makeEnv(kv), deps, createEmptyScheduledStats(NOW), NOW, () => undefined, () => 'p', 'lock-active-destination');
    expect(alarmIds(f.calls)).toEqual([]);
  });

  it('lock 만료(expiresAt <= now)도 lock 없음과 동급 — 알람 0', async () => {
    const kv = new InMemoryKV(() => NOW);
    const f = captureFetch();
    const trip = makeTrip(waypoints.slice(1), { boardingLock: { ...makeLock(['군자', '어린이대공원']), expiresAt: NOW - 1 } });
    const deps = { seoul: seoulWith('군자', 1), apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: f.fetchImpl, now: () => NOW } as ScheduledDeps;
    await completeWaypointAdvance(trip, trip.waypoints[0], makeEnv(kv), deps, createEmptyScheduledStats(NOW), NOW, () => undefined, () => 'p', 'lock-active-destination');
    expect(alarmIds(f.calls)).toEqual([]);
  });

  it('대조(lock 있음): 같은 입력에서 알람 정확히 1회', async () => {
    const kv = new InMemoryKV(() => NOW);
    const f = captureFetch();
    const trip = makeTrip(waypoints.slice(1));
    const deps = { seoul: seoulWith('군자', 1), apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: f.fetchImpl, now: () => NOW } as ScheduledDeps;
    await completeWaypointAdvance(trip, trip.waypoints[0], makeEnv(kv), deps, createEmptyScheduledStats(NOW), NOW, () => undefined, () => 'p', 'lock-active-destination');
    expect(alarmIds(f.calls)).toEqual([sleepAlarmCollapseId(TOKEN, '어린이대공원')]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe('#3100 선행 시나리오 7 — 같은 타깃 재평가: 중복 0', () => {
  const waypoints = [wp('군자', 'intermediate'), wp('어린이대공원', 'destination')];
  const depsFor = (f: ReturnType<typeof captureFetch>) =>
    ({ seoul: seoulWith('군자', 1), apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: f.fetchImpl, now: () => NOW }) as ScheduledDeps;

  it('cron 재진입 — 같은 (직전역, 타깃)을 두 번 완료 평가해도 1회', async () => {
    const kv = new InMemoryKV(() => NOW);
    const f = captureFetch();
    for (let i = 0; i < 2; i++) {
      const trip = makeTrip(waypoints); // 재진입 = 매번 KV 스냅샷 시점의 같은 trip 상태
      await completeWaypointAdvance(trip, trip.waypoints[0], makeEnv(kv), depsFor(f), createEmptyScheduledStats(NOW), NOW + i * 1000, () => undefined, () => `p${i}`, 'lock-active-destination');
    }
    expect(alarmIds(f.calls)).toEqual([sleepAlarmCollapseId(TOKEN, '어린이대공원')]);
  });

  it('cron이 먼저 발사한 뒤 sync catch-up이 같은 쌍을 평가해도 추가 발사 0', async () => {
    const kv = new InMemoryKV(() => NOW);
    const f = captureFetch();
    const trip = makeTrip(waypoints);
    await completeWaypointAdvance(trip, trip.waypoints[0], makeEnv(kv), depsFor(f), createEmptyScheduledStats(NOW), NOW, () => undefined, () => 'p0', 'lock-active-destination');
    await fireSyncConsumedPrecedingAlarms(makeEnv(kv), makeTrip(waypoints), 1, { apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: f.fetchImpl } as SyncSkippedFireDeps, NOW, () => undefined, () => 'p1');
    expect(alarmIds(f.calls)).toEqual([sleepAlarmCollapseId(TOKEN, '어린이대공원')]);
  });

  it('sync가 먼저 발사한 뒤 cron이 같은 쌍을 평가해도 추가 발사 0', async () => {
    const kv = new InMemoryKV(() => NOW);
    const f = captureFetch();
    await fireSyncConsumedPrecedingAlarms(makeEnv(kv), makeTrip(waypoints), 1, { apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: f.fetchImpl } as SyncSkippedFireDeps, NOW, () => undefined, () => 'p1');
    const trip = makeTrip(waypoints);
    await completeWaypointAdvance(trip, trip.waypoints[0], makeEnv(kv), depsFor(f), createEmptyScheduledStats(NOW), NOW, () => undefined, () => 'p0', 'lock-active-destination');
    expect(alarmIds(f.calls)).toEqual([sleepAlarmCollapseId(TOKEN, '어린이대공원')]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe('#3100 선행 시나리오 2 — sync 다역 점프로 1역 전 역이 소비됨: catch-up 1회 (#3157/#3160)', () => {
  const run = async (trip: Trip, shiftedCount: number) => {
    const f = captureFetch();
    await fireSyncConsumedPrecedingAlarms(
      makeEnv(new InMemoryKV(() => NOW)),
      trip,
      shiftedCount,
      { apnsConfig, apnsHosts: APNS_HOSTS, fetchImpl: f.fetchImpl } as SyncSkippedFireDeps,
      NOW,
      () => undefined,
      () => 'p',
    );
    return alarmIds(f.calls);
  };
  const chain = (target: Waypoint) => [wp('중곡', 'intermediate'), wp('군자', 'intermediate'), wp('어린이대공원', 'intermediate'), target];

  it('3역 점프(중곡·군자·어린이대공원 소비) — 환승 타깃: 직전역(어린이대공원) 1회', async () => {
    expect(await run(makeTrip(chain(wp('건대입구', 'transfer'))), 3)).toEqual([sleepAlarmCollapseId(TOKEN, '건대입구')]);
  });

  it('3역 점프 — 하차 타깃: 1회', async () => {
    expect(await run(makeTrip(chain(wp('건대입구', 'destination'))), 3)).toEqual([sleepAlarmCollapseId(TOKEN, '건대입구')]);
  });

  it('2역 점프(타깃 직전역은 남음) — catch-up 0 (남은 직전역은 cron이 발사)', async () => {
    expect(await run(makeTrip(chain(wp('건대입구', 'destination'))), 2)).toEqual([]);
  });

  it('타깃까지 소비(점프 4) — 이미 도착한 쌍이라 0', async () => {
    expect(await run(makeTrip(chain(wp('건대입구', 'destination'))), 4)).toEqual([]);
  });

  it('lock 없음 — 0', async () => {
    expect(await run(makeTrip(chain(wp('건대입구', 'destination')), { boardingLock: undefined }), 3)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// 시나리오 3 — index.ts 승격 분기(planPromotionFastForward). HTTP 레벨: 수동 목록 탭(sync) 승격.
describe('#3100 선행 시나리오 3 — 승격 fast-forward로 1역 전 역이 건너뛰어짐', () => {
  const ROUTE_NOW = 1_800_000_000_000;
  const IS_UP = inferLegDirection('7', '용마산', '중곡') === 'up';
  const NAMES = ['중곡', '군자', '어린이대공원', '건대입구'];
  const TARGET = '건대입구';

  async function tapPromote(
    position: { stationName: string; trainSttus: number },
    sleep = true,
    seed?: (kv: InMemoryKV) => Promise<void>,
  ) {
    const f = captureFetch();
    vi.stubGlobal('fetch', f.fetchImpl);
    const kv = new InMemoryKV();
    const env = makeEnv(kv);
    const now = Date.now();
    const trip: Trip = {
      token: 'ff-alarm-tok',
      route: { type: 'direct', line: '7', stops: 4 } as unknown as Trip['route'],
      destination: TARGET,
      waypoints: NAMES.map((stationName, i) => wp(stationName, i === NAMES.length - 1 ? 'destination' : 'intermediate')),
      expiresAt: ROUTE_NOW + 60 * 60_000,
      createdAt: ROUTE_NOW - 10 * 60_000,
      alarmAtEpochMs: ROUTE_NOW,
      sleepModeEnabled: sleep,
    };
    await kv.put('trip:ff-alarm-tok', JSON.stringify(trip));
    await seed?.(kv);
    await kv.put(
      'realtime-position:7',
      JSON.stringify({
        positions: [{ trainCode: '7039', isUp: IS_UP, recptnMs: now - 5_000, ...position }],
        fetchedAt: now - 5_000,
        stationLogs: { 용마산: { present: [], departed: [{ trainCode: '7039', isUp: IS_UP, departedAt: now - 3 * 60_000 }] } },
      }),
    );
    const res = await app.fetch(
      new Request('http://example.com/boarding-lock/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'ff-alarm-tok', observedStationName: '용마산', observedAtMs: now, accuracy: 20, trainCode: '7039', boardingLine: '7' }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    // sync 알람 catch-up은 응답 이후 waitUntil 체인(ctx 없음 -> floating promise)에서 돈다 — 충분히 흘려보낸다.
    await new Promise((r) => setTimeout(r, 150));
    const stored = JSON.parse((await kv.get('trip:ff-alarm-tok')) as string) as Trip;
    return { stored, alarms: alarmIds(f.calls) };
  }

  it('대조 — 열차가 1역 전(어린이대공원)에 도착(sts=1)해 있으면 1역 전은 head에 남아 cron이 발사한다 (승격 시점 알람 0, 건너뛴 역 = 중곡·군자뿐)', async () => {
    const { stored, alarms } = await tapPromote({ stationName: '어린이대공원', trainSttus: 1 });
    expect(stored.waypoints.map((w) => w.stationName)).toEqual(['어린이대공원', '건대입구']);
    expect(alarms).toEqual([]);
  });

  it('대조 — 열차가 2역 전(군자)을 출발(sts=2)했으면 건너뛴 쌍에 타깃 직전역이 없어 알람 0, head = 1역 전', async () => {
    const { stored, alarms } = await tapPromote({ stationName: '군자', trainSttus: 2 });
    expect(stored.waypoints.map((w) => w.stationName)).toEqual(['어린이대공원', '건대입구']);
    expect(alarms).toEqual([]);
  });

  // #3100 선행 — 1역 전 결함: 승격 fast-forward가 열차가 이미 출발한 1역 전(어린이대공원)을 알람 없이 건너뛴다 -> head=타깃뿐이라 cron도 영구 미발사.
  it('열차가 1역 전(어린이대공원)을 이미 출발(sts=2)한 채 승격되면, 건너뛴 1역 전 대신 타깃(건대입구) 알람이 1회 발사된다', async () => {
    const { stored, alarms } = await tapPromote({ stationName: '어린이대공원', trainSttus: 2 });
    expect(stored.waypoints.map((w) => w.stationName)).toEqual(['건대입구']); // fast-forward 전제(현행 동작)
    expect(alarms).toEqual([sleepAlarmCollapseId('ff-alarm-tok', TARGET)]);
  });

  // #3100 — 거부 케이스: 승격 fast-forward catch-up은 sync catch-up(#3157)과 같은 규칙을 따른다.
  it('거부 — 같은 (token, 타깃) 알람이 이미 발사됐으면 catch-up 0 (dedup 키 그대로, 중복 0)', async () => {
    const { alarms } = await tapPromote({ stationName: '어린이대공원', trainSttus: 2 }, true, async (kv) => {
      await kv.put(sleepAlarmFireKey('ff-alarm-tok', TARGET), '1');
    });
    expect(alarms).toEqual([]);
  });

  it('거부 — 열차가 타깃(건대입구)까지 지났으면 fast-forward 자체가 blockedAt으로 skip 0, 알람 0 (타깃 소비 쌍 대상 아님)', async () => {
    const { stored, alarms } = await tapPromote({ stationName: TARGET, trainSttus: 2 });
    expect(stored.waypoints.map((w) => w.stationName)).toEqual(NAMES);
    expect(alarms).toEqual([]);
  });

  it('취침모드 OFF — sync catch-up과 같은 규칙으로 준비 알람 1회 (취침 알람은 0)', async () => {
    const { alarms } = await tapPromote({ stationName: '어린이대공원', trainSttus: 2 }, false);
    expect(alarms).toEqual([prepareAlarmCollapseId('ff-alarm-tok', TARGET)]);
  });
});
