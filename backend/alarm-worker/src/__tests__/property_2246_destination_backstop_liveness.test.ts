/**
 * #2246 (ADR-029 Phase 2 / Epic #2234) — liveness property: destination-reached trip은 임의의
 * cron tick 시퀀스(tick 수·간격 임의)에서도 `DESTINATION_REACH_BACKSTOP_MS`(#2230, 15min) 내에
 * 반드시 발사가 정지된다(force-cleanup).
 *
 * 런타임 로직은 미변경 — `scheduled.ts`의 gps-far backstop 분기(line ~3668)가 이미 성립시킨
 * 불변식을 example fixture(`scheduled.test.ts` #2230 describe)가 아니라 **임의 tick 시퀀스**로
 * 재확인해 재파손(2026-08-09 dump에서 관측된 9h 무기한 잔존류 회귀)을 CI에서 차단한다.
 *
 * hand-rolled seeded PRNG(mulberry32)로 N회 반복 — 새 의존(fast-check) 추가 회피(Simplicity).
 * 재현성을 위해 시드 고정.
 *
 * 시나리오: gps-far cross-check가 매 tick 지속되는 destination trip.
 *   - tick1 (offset 0): anchor(`destinationImminentFirstAt`)가 최초 stamp됨 — 정지되지 않는다.
 *   - 임의 개수(0~4)의 중간 tick: anchor로부터 경과 시간이 backstop 미만 — trip 보존, force-cleanup 0건.
 *   - 최종 tick: 경과 시간이 backstop 이상 — force-cleanup 1건, trip이 KV에서 삭제된다.
 *
 * 테스트 harness(InMemoryKV / makeEnv / trip fixture 형태)는 `scheduled.test.ts`의
 * `#2230 destination-reached short backstop` describe와 동일 패턴을 재사용한다(중복 로직 없음 —
 * 파일이 분리돼 직접 import는 불가하므로 최소 형태로 재현).
 */
import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import {
  DESTINATION_REACH_BACKSTOP_MS,
  runScheduled,
  type ScheduledDeps,
} from '../scheduled';
import { SeoulArrivalClient } from '../seoul';
import { putTrip } from '../trips';
import type { Env, Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';

let apnsConfig: ApnsConfig;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  const pem = await exportPKCS8(privateKey);
  apnsConfig = {
    keyId: 'K',
    teamId: 'T',
    privateKeyPem: pem,
    bundleId: 'com.example.app',
  };
});

beforeEach(() => resetApnsJwtCache());

const APNS_HOSTS = {
  production: 'api.push.apple.com',
  sandbox: 'api.sandbox.push.apple.com',
} as const;

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
    PENDING_PUSHES: undefined,
  };
}

/** 합정(line 2) destination trip — `scheduled.test.ts` #2230 fixture와 동일 shape. */
function makeDestinationTrip(token: string, baseNow: number): Trip {
  return {
    token,
    route: { type: 'direct', line: '2', stops: 1 },
    destination: '2-038', // 합정 station id (stations.json)
    waypoints: [{ stationName: '합정', line: '2', kind: 'destination' }],
    // #2230 property 대상 — trip 창(최대 backstop + 여유)이 만료/lifecycle 문턱에 걸리지 않도록
    // baseNow 기준으로 넉넉히 설정. lifecycle silence(6h)/force-end(9h) 문턱과 무관한 범위(<20min).
    expiresAt: baseNow + 24 * 60 * 60_000,
    createdAt: baseNow,
    alarmAtEpochMs: baseNow - 60_000, // 이미 폴링 윈도우 진입 상태 — 매 tick 스캔 대상.
    activityPushToken: 'la-token',
    activityState: 'live',
    apnsEnv: 'sandbox',
    boardingLock: {
      trainCode: 'T',
      line: '2',
      subwayId: '1002',
      selectedDepartureTime: baseNow,
      segmentStations: ['홍대입구', '합정'],
      expiresAt: baseNow + 24 * 60 * 60_000,
    },
  };
}

function makeArrivedSeoul(nowGetter: () => number): SeoulArrivalClient {
  return new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: nowGetter,
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          realtimeArrivalList: [
            {
              barvlDt: '0',
              recptnDt: '',
              updnLine: '내선',
              trainLineNm: '합정',
              btrainNo: 'T',
              subwayNm: '지하철2호선',
              arvlCd: 1, // ARRIVED → advance → destination cleanup 분기 진입
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch,
  });
}

/** 신촌 부근 GPS — 합정에서 ~1.3km, 매 tick gps-far cross-check를 트리거. */
function seedFarGps(kv: InMemoryKV, token: string, ts: number): Promise<void> {
  return kv.put(
    `pos:${token}`,
    JSON.stringify([{ lat: 37.5552, lng: 126.9368, accuracy: 15, ts, motion: 'automotive' }]),
  );
}

// mulberry32 — 결정적 시드 PRNG. 순수 함수, 시드만으로 재현.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface TickPlan {
  /** anchor(tick1) 기준 경과 ms — 각각 backstop 미만이 되도록 오름차순 생성. */
  intermediateOffsetsMs: number[];
  /** anchor 기준 backstop 이상이 되는 최종 tick 경과 ms. */
  finalOffsetMs: number;
}

/** 임의 tick 수(0~4)·간격 조합 생성. intermediate는 backstop 미만, final은 backstop 이상. */
function genTickPlan(rng: () => number): TickPlan {
  const intermediateCount = Math.floor(rng() * 5); // 0..4
  const budget = DESTINATION_REACH_BACKSTOP_MS - 1_000; // 엄격히 backstop 미만 유지.
  const fractions = Array.from({ length: intermediateCount }, () => rng()).sort((a, b) => a - b);
  const intermediateOffsetsMs = fractions.map((f) => Math.floor(f * budget));
  const finalOffsetMs = DESTINATION_REACH_BACKSTOP_MS + Math.floor(rng() * 120_000); // backstop ~ +2min.
  return { intermediateOffsetsMs, finalOffsetMs };
}

describe('#2246 property — destination-reached trip은 임의 tick 시퀀스에서도 backstop 내 발사 정지', () => {
  const PROPERTY_ITERATIONS = 20;
  // 시드 값 자체는 임의 — 이슈 번호 기반으로 선택해 재현 시 출처를 알아보기 쉽게만 함.
  const rng = mulberry32(0xd2230);

  for (let i = 0; i < PROPERTY_ITERATIONS; i += 1) {
    const seedNow = 1_700_000_000_000 + Math.floor(rng() * 1_000_000_000);
    const plan = genTickPlan(rng);

    it(`iteration #${i} (baseNow offset seed, ${plan.intermediateOffsetsMs.length} intermediate ticks)`, async () => {
      const kv = new InMemoryKV();
      const token = `prop-backstop-tok-${i}`;
      const trip = makeDestinationTrip(token, seedNow);
      await putTrip(kv as unknown as KVNamespace, trip);

      let simulatedNow = seedNow;
      const seoul = makeArrivedSeoul(() => simulatedNow);
      const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
      const deps: ScheduledDeps = {
        seoul,
        apnsConfig,
        apnsHosts: APNS_HOSTS,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => simulatedNow,
      };

      async function tick(offsetMs: number) {
        simulatedNow = seedNow + offsetMs;
        await seedFarGps(kv, token, simulatedNow - 30_000); // fresh GPS(< 5min stale) every tick.
        return runScheduled(makeEnv(kv), { ...deps, now: () => simulatedNow });
      }

      // tick1 — anchor 최초 stamp. 정지되지 않는다.
      let stats = await tick(0);
      expect(await kv.get(`trip:${token}`)).not.toBeNull();
      expect(stats.destinationBackstopForceEnded).toBe(0);

      // 임의 개수의 중간 tick — anchor로부터 backstop 미만 경과. 계속 보존.
      for (const offset of plan.intermediateOffsetsMs) {
        stats = await tick(offset);
        expect(await kv.get(`trip:${token}`)).not.toBeNull();
        expect(stats.destinationBackstopForceEnded).toBe(0);
      }

      // 최종 tick — anchor로부터 backstop 이상 경과. 반드시 force-cleanup.
      stats = await tick(plan.finalOffsetMs);
      expect(await kv.get(`trip:${token}`)).toBeNull();
      expect(stats.destinationBackstopForceEnded).toBe(1);
    });
  }
});
