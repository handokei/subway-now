/**
 * K5 #2926 PR-A — 2026-11-04 17:12~17:24 트립(뚝섬 -> 건대입구 환승 -> 용마산, leg-2 lock 7252) whole-trip replay.
 *
 * 사고: leg-1 lock(2288)이 하차 응답으로 풀린 뒤(D1 2134) leg-2 열차 선택(lock 7252, D1 2169) 전까지 약 12분 대기 중,
 * lockless cron `runLocklessIntermediate`가 다른 열차(7248 등)의 도착 신호를 따라 head를 어린이대공원 -> 군자 -> 중곡으로
 * 전진시켰다(D1 2138 head 어린이대공원 -> 2145 군자 -> 2166 중곡). 그래서 lock 7252가 붙은 시점 segment에서 앞 역이 이미
 * 소비돼 있었고 군자 매역 알림이 0건이었다(D1 2176 lock-reanchor 어린이대공원 / 2180 어린이대공원 sent / 2195 중곡 sent, 군자 0).
 * 10/21 사용자 결정(memory decision_lock_only_alerts.md:24): lock 없는 여정은 backend가 위치 추적·역 전진·알림을 하지 않는다.
 *
 * 입력:
 *   - `fixtures/replay_20261104_lockless_wait_advance/events.json` : D1 trip_events 2114~2211 원문(불변 실측). 노선(incomingSig),
 *     시각(2138 시작 / 2169 lock-attached)을 여기서 그대로 가져온다. 통과시키려 조정 금지.
 *   - **합성(정직 표기)**: R2 seoul-capture가 이 트립에는 없다. arrivals는 D1 `leg-boarding-prompt.candidateArvlCds`
 *     (예: [99,99] / [4,99] / [5,99] / [1,99] — 7호선 승강장 대기 중 열차가 계속 도착 신호를 내고 있었음)와
 *     D1 2145 "head가 군자로 전진했다"는 사실에 맞춰, 대기 구간 내내 head 역마다 다른 열차 7248이 arvlCd=1(도착)을 내는 것으로
 *     합성했다. lock 부착 후에는 lock 열차 7252가 head 역에 arvlCd=1을 내는 것으로 합성했다. motion은 automotive(전진 게이트 통과용).
 *
 * assert는 실제로 나간 APNs alert(station-passed `data.nextWaypoint`) 기준이다.
 */
import { exportPKCS8, generateKeyPair } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { runScheduled, type ScheduledDeps } from '../scheduled';
import { SeoulArrivalClient } from '../seoul';
import { seedSsot } from '../tripPositionSsot';
import { getTrip, putTrip } from '../trips';
import type { BoardingLockMeta, Env, Trip, Waypoint } from '../types';
import { InMemoryKV } from './inMemoryKv';
import { loadD1Events, makeTripEventSink, parseRouteSig, routeSigOf } from './helpers/replay20261019';

let apnsConfig: ApnsConfig;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  apnsConfig = { keyId: 'K', teamId: 'T', privateKeyPem: await exportPKCS8(privateKey), bundleId: 'com.example.app' };
});
beforeEach(() => resetApnsJwtCache());
afterEach(() => vi.unstubAllGlobals());

const DIR = 'replay_20261104_lockless_wait_advance';
const TOKEN = 'replay-2926-1104';
const TICK_MS = 60_000;
const HOUR_MS = 3_600_000;
const APNS_HOSTS = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' } as const;

const rows = loadD1Events(DIR, 'events.json');
const rowOf = (id: number) => {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`D1 행 ${id}이 fixture에 없다`);
  return row;
};

/** D1 2166 incomingSig = device가 가진 전체 노선(건대입구 환승 -> 어린이대공원 -> 군자 -> 중곡 -> 용마산). */
const FULL_ROUTE = parseRouteSig(routeSigOf(rowOf(2166), 'incomingSig'));
/** 환승 소비 이후 = leg-2 waypoints (D1 2138 시점 head 어린이대공원). */
const LEG2 = FULL_ROUTE.filter((w) => w.kind !== 'transfer');
const TRANSFER = FULL_ROUTE.find((w) => w.kind === 'transfer') as Waypoint;
const MID_STATIONS = LEG2.filter((w) => w.kind === 'intermediate').map((w) => w.stationName);

const START_MS = rowOf(2138).ts; // lockless 대기 시작 (head 어린이대공원 확인 시각)
const LOCK_MS = rowOf(2169).ts; // lock 7252 부착
/** 대기 구간 tick 수 = START ~ LOCK 사이 분 단위 (D1 실측 17:12~17:24 -> 12 tick). */
const WAIT_TICKS = Math.floor((LOCK_MS - START_MS) / TICK_MS);
const LOCK_TRAIN = '7252';
const OTHER_TRAIN = '7248';

function makeEnv(kv: InMemoryKV, db: D1Database): Env {
  return {
    TRIPS: kv as unknown as KVNamespace,
    DB: db,
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

/** station-aware Seoul mock — 중간역 질의에는 지정 열차가 arvlCd=1(도착). 그 외 역은 빈 응답. */
function seoulWith(trainOf: () => string, now: () => number): SeoulArrivalClient {
  const stations = new Set(MID_STATIONS.map((s) => encodeURIComponent(s.replace(/\(.*\)$/, ''))));
  return new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now,
    fetchImpl: (async (url: string) => {
      if (url.includes('/realtimePosition/')) return new Response(JSON.stringify({ realtimePositionList: [] }), { status: 200 });
      const hit = [...stations].some((s) => url.includes(s));
      return new Response(
        JSON.stringify({
          realtimeArrivalList: hit
            ? [
                {
                  barvlDt: '0',
                  recptnDt: '',
                  updnLine: '상행',
                  trainLineNm: '장암행',
                  btrainNo: trainOf(),
                  subwayNm: '지하철7호선',
                  arvlCd: '1',
                },
              ]
            : [],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch,
  });
}

function lockFor(now: number): BoardingLockMeta {
  return {
    trainCode: LOCK_TRAIN,
    line: '7',
    subwayId: '1007',
    selectedDepartureTime: now,
    segmentStations: [TRANSFER.stationName, ...LEG2.map((w) => w.stationName)],
    expiresAt: now + HOUR_MS,
  };
}

function seedTrip(): Trip {
  return {
    token: TOKEN,
    route: {
      type: 'transfer',
      transferName: TRANSFER.stationName,
      fromLine: TRANSFER.line,
      toLine: LEG2[0].line,
      stopsToTransfer: 1,
      stopsFromTransfer: LEG2.length,
    } as unknown as Trip['route'],
    destination: LEG2[LEG2.length - 1].stationName,
    waypoints: LEG2.map((w) => ({ ...w })),
    routeWaypoints: FULL_ROUTE.map((w, hopIndex) => ({ ...w, hopIndex })),
    originStationName: '뚝섬',
    createdAt: START_MS - 5 * 60_000, // K5 #2926 PR-B: lockless 시한 종료(예상 소요 x1.5 + 15분) 창 안에 두려 최근 등록으로 둔다 - 이 테스트의 관심사는 시한이 아니다.
    alarmAtEpochMs: START_MS,
    expiresAt: START_MS + 3 * HOUR_MS,
    infoModeEnabled: true,
    consecutiveEtaMissing: 0,
    promptOptIn: true,
    // lock 경로가 환승 소비 시 찍은 앵커(D1 2130 transfer-advance path=lock-active advanced -> hop-end 2133).
    currentLegAnchor: { boardingStation: TRANSFER.stationName, line: LEG2[0].line },
    legBoardingEligibleAt: START_MS - 60_000,
  } as Trip;
}

async function seedMotion(kv: InMemoryKV, now: number) {
  const point = (ts: number, lng: number) => ({ lat: 0, lng, accuracy: 10, ts, motion: 'automotive' });
  await kv.put(`pos:${TOKEN}`, JSON.stringify([point(now - 40_000, 0), point(now - 20_000, 0.0002), point(now, 0.0004)]));
}

interface Run {
  /** tick 직후 head 역명. */
  headsAfterTick: Array<string | undefined>;
  /** 실제로 나간 station-passed alert의 (tick index, 역) 목록. */
  fired: Array<{ tick: number; station: string }>;
  lockTick: number;
  events: ReturnType<typeof makeTripEventSink>['events'];
}

async function replay(opts: { legacy: boolean; lockTicks?: number }): Promise<Run> {
  const kv = new InMemoryKV(() => START_MS);
  const sink = makeTripEventSink();
  const env = makeEnv(kv, sink.db);
  const sent: Array<{ tick: number; station: string }> = [];
  let tick = 0;
  let nowMs = START_MS;
  let lockAttached = false;
  const fetchImpl = (async (_url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
    if (init?.headers?.['apns-push-type'] === 'alert') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { data?: { nextWaypoint?: string } };
      const station = body.data?.nextWaypoint;
      if (typeof station === 'string') sent.push({ tick, station });
    }
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;
  await putTrip(kv as unknown as KVNamespace, seedTrip());
  // intermediate-route 라벨은 SSoT가 있어야 기록된다(/position이 만든 SSoT 대용).
  await seedSsot(kv as unknown as KVNamespace, TOKEN, MID_STATIONS[0], { expiresAt: START_MS + 3 * HOUR_MS, userIntentDeclared: true });
  const heads: Array<string | undefined> = [];
  const total = WAIT_TICKS + (opts.lockTicks ?? MID_STATIONS.length + 2);
  for (tick = 0; tick < total; tick++) {
    nowMs = START_MS + tick * TICK_MS;
    if (tick === WAIT_TICKS) {
      // 사용자 행동(열차 선택) -> lock 부착. 이 시점 backend가 가진 trip에 lock만 얹는다(D1 2169 lock-attached, 7252).
      const trip = (await getTrip(kv as unknown as KVNamespace, TOKEN)) as Trip;
      await putTrip(kv as unknown as KVNamespace, { ...trip, boardingLock: lockFor(nowMs), boardingCommitted: undefined });
      lockAttached = true;
    }
    await seedMotion(kv, nowMs);
    const deps: ScheduledDeps = {
      seoul: seoulWith(() => (lockAttached ? LOCK_TRAIN : OTHER_TRAIN), () => nowMs),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl,
      now: () => nowMs,
      generatePushId: () => `p-${tick}`,
      db: sink.db,
      ...(opts.legacy ? { killSwitchLocklessAdvanceLegacy: true } : {}),
    };
    await runScheduled(env, deps);
    heads.push(((await getTrip(kv as unknown as KVNamespace, TOKEN)) as Trip | null)?.waypoints[0]?.stationName);
  }
  return { headsAfterTick: heads, fired: sent, lockTick: WAIT_TICKS, events: sink.events };
}

describe('K5 #2926 11/04 lockless 대기 중 head 전진 -> lock 후 군자 매역 알림 누락 — leg-2 lock 7252', () => {
  it('대기 구간(17:12~17:24): 다른 열차 도착 신호에도 head는 어린이대공원 고정 (전진 0)', async () => {
    const r = await replay({ legacy: false });
    expect(r.headsAfterTick.slice(0, r.lockTick)).toEqual(Array(r.lockTick).fill(MID_STATIONS[0]));
  });

  it('대기 구간 내내 알림 0건 (lock 없음 = 알림 없음)', async () => {
    const r = await replay({ legacy: false });
    expect(r.fired.filter((f) => f.tick < r.lockTick)).toEqual([]);
  });

  it('lock 7252 부착 후 segment 중간역(어린이대공원·군자·중곡) station-passed 각 정확히 1회, 순서대로', async () => {
    const r = await replay({ legacy: false });
    const after = r.fired.filter((f) => f.tick >= r.lockTick);
    expect(after.map((f) => f.station)).toEqual(MID_STATIONS);
  });

  it('revert-red: kill switch legacy=on(구 동작)이면 대기 중 head가 전진해 lock 직전엔 이미 목적지까지 소비돼 있다', async () => {
    // 주의: 운영의 군자 알림 0건은 이 전진 + 같은 세션 재등록 폭주(D1 2167~2201, 이 모델에 없음)의 합작이다.
    // 이 replay에서 legacy의 증상은 lock 부착 전 head 소비까지이며, lock-reanchor가 head를 되돌려 3역 알림은 나간다.
    const r = await replay({ legacy: true });
    expect(r.headsAfterTick[0]).not.toBe(MID_STATIONS[0]);
    expect(r.headsAfterTick[r.lockTick - 1]).toBe(LEG2[LEG2.length - 1].stationName);
  });

  it('hold 라벨: D1 intermediate-route branch=lockless-hold 기록 (lockless 아님)', async () => {
    const r = await replay({ legacy: false });
    const branches = r.events.filter((e) => e.kind === 'intermediate-route').map((e) => e.meta.branch);
    expect(branches).toContain('lockless-hold');
    expect(branches).not.toContain('lockless');
  });
});
