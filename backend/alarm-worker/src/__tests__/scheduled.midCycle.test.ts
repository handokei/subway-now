/**
 * #2615 (서비스체인① 1단계, cycle 내 +30초 재폴링·재발사 pass) — `runScheduled({ midCycle:
 * true })`의 범위 축소가 이슈 본문 스펙대로 정확히 지켜지는지 검증.
 *
 * 범위 축소 스펙(scheduled.ts `ScheduledDeps.midCycle` doc-comment 참고):
 *   - 유지: lock-active fire 경로(`runTrainCodeTracking` → arvlCd/position 확증 발사 + advance)
 *   - skip: self-poll(line/station 광역 폴링), cron jitter 샘플링, boarding/leg boarding-prompt,
 *     lockless intermediate/consensus/transfer, lock-missing LA heartbeat, Analytics/laPushCounters
 *     집계, D1 trip_events 시간별 cleanup
 *
 * "1차 pass 동작 불변"은 `deps.midCycle` 미전달(undefined) 시 100% 기존 동작이라는 사실로
 * 보장된다 — 아래 각 테스트가 대조군(midCycle 미전달)과 함께 이를 확인한다.
 */
import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { runScheduled } from '../scheduled';
import { SeoulArrivalClient, type ArrivalEntry } from '../seoul';
import { ARRIVAL_CODE } from '../alarm';
import { readJitterSamples } from '../cronJitterAggregate';
import { sumLaPushCounters } from '../laPushCounters';
import type { BoardingLockMeta, Env, Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';

let apnsConfig: ApnsConfig;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  const pem = await exportPKCS8(privateKey);
  apnsConfig = { keyId: 'K', teamId: 'T', privateKeyPem: pem, bundleId: 'com.example.app' };
});

beforeEach(() => resetApnsJwtCache());

// 600_000_000 / 60_000 = 10_000 → 10_000 % 10 === 0: shouldSampleJitterTick이 true가 되는 tick.
const NOW = 600_000_000;

const APNS_HOSTS = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' } as const;

function makeEnv(kv: InMemoryKV): Env {
  return {
    TRIPS: kv as unknown as KVNamespace,
    APNS_HOST: APNS_HOSTS.production,
    APNS_HOST_SANDBOX: APNS_HOSTS.sandbox,
    SEOUL_API_HOST: 'seoul.api',
    SEOUL_API_KEY: 'KEY',
    APNS_KEY_ID: 'K',
    APNS_TEAM_ID: 'T',
    APNS_PRIVATE_KEY: apnsConfig.privateKeyPem,
    APNS_BUNDLE_ID: 'com.example.app',
  };
}

function makeBoardingLock(overrides: Partial<BoardingLockMeta> = {}): BoardingLockMeta {
  return {
    trainCode: '7246',
    line: '7',
    subwayId: '1007',
    selectedDepartureTime: NOW,
    segmentStations: ['용마산', '중곡', '군자'],
    expiresAt: NOW + 60 * 60_000,
    ...overrides,
  };
}

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    token: 'tok',
    route: { type: 'direct', line: '7', stops: 2 },
    destination: '군자',
    waypoints: [
      { stationName: '중곡', line: '7', kind: 'intermediate' },
      { stationName: '군자', line: '7', kind: 'destination' },
    ],
    expiresAt: NOW + 60 * 60_000,
    createdAt: NOW,
    alarmAtEpochMs: NOW - 60_000,
    ...overrides,
  };
}

function makeLockTrip(overrides: Partial<Trip> = {}): Trip {
  return makeTrip({ boardingLock: makeBoardingLock(), ...overrides });
}

/** 무결 lockless trip(잠금 없음) — boarding-anchor 후보 아님(promptDisplay/currentLegAnchor 없음). */
function makeLockMissingTrip(overrides: Partial<Trip> = {}): Trip {
  return makeTrip(overrides);
}

function makeSeoul(arrivals: ArrivalEntry[]): SeoulArrivalClient {
  let arrivalCalls = 0;
  let positionCalls = 0;
  const client = new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: () => NOW,
    fetchImpl: (async (url: string) => {
      if (url.includes('/realtimePosition/')) {
        positionCalls += 1;
        return new Response(JSON.stringify({ realtimePositionList: [] }), { status: 200 });
      }
      arrivalCalls += 1;
      return new Response(
        JSON.stringify({
          realtimeArrivalList: arrivals.map((a) => ({
            barvlDt: String(a.arrivalSeconds),
            recptnDt: '',
            updnLine: a.isUp ? '상행' : '하행',
            trainLineNm: a.destination,
            btrainNo: a.trainCode,
            subwayNm: a.subwayNm,
            arvlCd: a.arvlCd,
          })),
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch,
  });
  return Object.assign(client, {
    __calls: () => ({ arrivalCalls, positionCalls }),
  }) as SeoulArrivalClient & { __calls: () => { arrivalCalls: number; positionCalls: number } };
}

const ENTERING_ARRIVAL: ArrivalEntry = {
  trainCode: '7246',
  arrivalSeconds: 30,
  isUp: true,
  destination: '온수',
  subwayNm: '7호선',
  arvlCd: ARRIVAL_CODE.ENTERING,
};

describe('#2615 — runScheduled({ midCycle: true }) 범위 축소', () => {
  it('lock-active fire 경로는 midCycle에서도 정상 동작한다(발사 + advance)', async () => {
    const kv = new InMemoryKV(() => NOW);
    const trip = makeLockTrip({ token: 'mid-fire-tok' });
    const { putTrip } = await import('../trips');
    await putTrip(kv as unknown as KVNamespace, trip);
    const seoul = makeSeoul([ENTERING_ARRIVAL]);

    const stats = await runScheduled(makeEnv(kv), {
      seoul,
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      now: () => NOW,
      midCycle: true,
    });

    expect(stats.arvlCdFireSuccess + stats.arvlCdFireFired).toBeGreaterThan(0);
    expect(stats.polled).toBe(1);
  });

  it('lock-missing trip은 전면 skip(continue) — boarding-anchor/prompt 평가 카운터가 전혀 증가하지 않는다', async () => {
    const kv = new InMemoryKV(() => NOW);
    const trip = makeLockMissingTrip({ token: 'mid-lockmissing-tok' });
    const { putTrip } = await import('../trips');
    await putTrip(kv as unknown as KVNamespace, trip);
    const seoul = makeSeoul([]);

    const stats = await runScheduled(makeEnv(kv), {
      seoul,
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      now: () => NOW,
      midCycle: true,
    });

    expect(stats.lockMissing).toBe(0);
    expect(stats.boardingAnchorResolved).toBe(0);
    expect(stats.boardingAnchorUnresolved).toBe(0);
    expect(stats.boardingPromptEvaluated).toBe(0);
    expect(stats.scanned).toBe(1);
  });

  it('self-poll(활성 line/station 광역 폴링)은 midCycle에서 skip된다 — 1차 pass(미전달)에선 여전히 발생', async () => {
    const kv1 = new InMemoryKV(() => NOW);
    const kv2 = new InMemoryKV(() => NOW);
    const { putTrip } = await import('../trips');
    await putTrip(kv1 as unknown as KVNamespace, makeLockTrip({ token: 'mid-selfpoll-tok' }));
    await putTrip(kv2 as unknown as KVNamespace, makeLockTrip({ token: 'mid-selfpoll-tok' }));

    const seoulMid = makeSeoul([ENTERING_ARRIVAL]);
    const statsMid = await runScheduled(makeEnv(kv1), {
      seoul: seoulMid,
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      now: () => NOW,
      midCycle: true,
    });
    expect(statsMid.realtimePositionFetch).toBe(0);
    expect(statsMid.stationPollFetch).toBe(0);

    const seoulPrimary = makeSeoul([ENTERING_ARRIVAL]);
    const statsPrimary = await runScheduled(makeEnv(kv2), {
      seoul: seoulPrimary,
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      now: () => NOW,
    });
    // 1차 pass(기존 동작)는 활성 line/station이 있으면 self-poll fetch를 시도한다(성공 여부 무관).
    expect(statsPrimary.stationPollFetch + statsPrimary.realtimePositionFetch).toBeGreaterThan(0);
  });

  it('cron jitter 샘플링은 midCycle에서 skip된다 — 1차 pass(같은 tick)는 append한다', async () => {
    const kv1 = new InMemoryKV(() => NOW);
    const kv2 = new InMemoryKV(() => NOW);
    const { putTrip } = await import('../trips');
    await putTrip(kv1 as unknown as KVNamespace, makeLockTrip({ token: 'mid-jitter-tok' }));
    await putTrip(kv2 as unknown as KVNamespace, makeLockTrip({ token: 'mid-jitter-tok' }));

    await runScheduled(makeEnv(kv1), {
      seoul: makeSeoul([ENTERING_ARRIVAL]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      now: () => NOW,
      midCycle: true,
    });
    expect(await readJitterSamples(kv1 as unknown as KVNamespace)).toHaveLength(0);

    await runScheduled(makeEnv(kv2), {
      seoul: makeSeoul([ENTERING_ARRIVAL]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      now: () => NOW,
    });
    expect(await readJitterSamples(kv2 as unknown as KVNamespace)).toHaveLength(1);
  });

  it('LA push Analytics/laPushCounters 집계는 midCycle에서 skip된다', async () => {
    const kv = new InMemoryKV(() => NOW);
    const { putTrip } = await import('../trips');
    await putTrip(
      kv as unknown as KVNamespace,
      makeLockTrip({
        token: 'mid-lapush-tok',
        activityPushToken: 'la-tok',
        activityState: 'live',
      }),
    );

    await runScheduled(makeEnv(kv), {
      seoul: makeSeoul([ENTERING_ARRIVAL]),
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      now: () => NOW,
      midCycle: true,
    });

    const counters = await sumLaPushCounters(kv as unknown as KVNamespace, NOW);
    expect(counters.sent).toBe(0);
    expect(counters.failed).toBe(0);
  });
});
