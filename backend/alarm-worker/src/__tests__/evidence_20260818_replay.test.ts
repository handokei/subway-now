/**
 * 2026-08-18 저녁 실탑승 시나리오 replay test — 조립 체인 재발방지.
 *
 * 목적: 개별 fix PR(#2341/#2342/#2350/#2352/#2355/#2358)이 각자 단위 테스트를 통과해도,
 * 실 시나리오(뚝섬 2호선 출발 → 건대입구 환승 → 7호선 → 용마산 목적지)를 "조립된 체인"으로
 * 재생했을 때도 끝까지 작동하는지 증명한다. 이 파일이 red면 개별 fix가 서로 충돌하거나
 * 조립 지점(scheduled.ts 게이트 순서, seoul.ts subwayId 파생, index.ts autolockcandidate 제거)
 * 어딘가가 깨진 것 — 재발방지 장치.
 *
 * 08-18 저녁 실 shape 재현:
 *  - Seoul arrivals가 subwayNm=null + subwayId만 유효값으로 응답한다(#2355 근본 원인). 이
 *    fixture는 masking을 재현 — subwayNm을 직접 채우지 않고 subwayId만 채워 seoul.ts의
 *    subwayId→line 역파생 경로(parseEntry)를 실제로 태운다.
 *  - 사용자가 뚝섬에서 15분+ 원점 대기(배차 간격) 중이며 근접이 계속 관측된다 — #2358 anchor
 *    갱신(ORIGIN_PROXIMITY_RENEWAL_MS)이 신선도 게이트를 열어둔다.
 *  - 정적 promptGeoContext 스냅샷과 무관하게 `/position` 채널이 이미 근접을 stamp했다면
 *    #2350 게이트가 tooFar로 영구 차단하지 않는다.
 *
 * 체인 3단계 (하나의 시나리오 trip을 단계별로 재생):
 *  (a) boardingPrompt가 3게이트(empty/tooFar/stale) 모두 통과해 발사된다 — candidateTrains>0.
 *  (b) 환승 후 7호선 leg(건대입구→중곡)이 arvlCd 신호로 advance+fire된다.
 *  (c) 목적지(용마산) destination push 발사 시도가 존재한다 — transfer-destination gate에
 *      선점당하지 않는다(#2352 autolockcandidate 제거 무회귀).
 *
 * 동작 원칙: 관측 가능한 결과(stats counter, candidateTrains payload)만 assert한다.
 */

import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { runScheduled, type ScheduledDeps, type ScheduledStats } from '../scheduled';
import { SeoulArrivalClient } from '../seoul';
import { putTrip } from '../trips';
import { seedSsot, writeSsot } from '../tripPositionSsot';
import type { BoardingLockMeta, Env, Trip } from '../types';
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

const NOW = 1_700_000_000_000;
const SIXTEEN_MIN_MS = 16 * 60 * 1000;
const TWENTY_MIN_MS = 20 * 60 * 1000;

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
  };
}

/**
 * #2355 근본 원인 재현 — 실 Seoul API 응답은 subwayNm=null, subwayId만 유효값이다.
 * subwayNm 필드를 아예 채우지 않아 seoul.ts:parseEntry의 subwayId→line 역파생 경로를
 * 강제로 태운다 (masking 제거 무회귀 검증).
 */
function makeMaskedSeoul(
  destination: string,
  trainCode: string,
  subwayId: string,
  arvlCd: number,
): SeoulArrivalClient {
  return new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: () => NOW,
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          realtimeArrivalList: [
            {
              barvlDt: '60',
              recptnDt: '',
              updnLine: '상행',
              trainLineNm: destination,
              btrainNo: trainCode,
              subwayNm: null,
              subwayId,
              arvlCd,
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch,
  });
}

// 뚝섬(2호선) → 건대입구(환승) → 7호선 → 용마산(목적지) — 08-18 저녁 BG 환승 trip 재현.
function makeBoardingLock(overrides: Partial<BoardingLockMeta> = {}): BoardingLockMeta {
  return {
    trainCode: '7246',
    line: '7',
    subwayId: '1007',
    selectedDepartureTime: NOW - 30 * 60_000,
    segmentStations: ['건대입구', '중곡', '용마산'],
    expiresAt: NOW + 60 * 60_000,
    ...overrides,
  };
}

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    token: 'evidence-0818-tok',
    route: { type: 'direct', line: '2', stops: 6 },
    destination: '용마산',
    waypoints: [
      { stationName: '건대입구', line: '2', kind: 'transfer' },
      { stationName: '중곡', line: '7', kind: 'intermediate' },
      { stationName: '용마산', line: '7', kind: 'destination' },
    ],
    expiresAt: NOW + 60 * 60_000,
    createdAt: NOW - TWENTY_MIN_MS,
    alarmAtEpochMs: NOW - 60_000,
    ...overrides,
  };
}

// 9단 게이트 happy path 공용 GPS series — boarding-prompt 게이트 #4(origin 100m 이내)/
// #5(direction cosine ≥ 0.7)/#7(speed ≥ 5 km/h) 통과 설계 (scheduled.test.ts와 동일 패턴).
async function seedHappySeries(kv: InMemoryKV, token: string): Promise<void> {
  const series = [
    { lat: 0, lng: -0.0004, accuracy: 10, ts: NOW - 60_000, motion: 'automotive' },
    { lat: 0, lng: 0.0002, accuracy: 10, ts: NOW - 30_000, motion: 'automotive' },
    { lat: 0, lng: 0.0008, accuracy: 10, ts: NOW, motion: 'automotive' },
  ];
  await kv.put(`pos:${token}`, JSON.stringify(series));
}

async function runOnce(
  kv: InMemoryKV,
  seoul: SeoulArrivalClient,
  fetchImpl: ReturnType<typeof vi.fn>,
): Promise<ScheduledStats> {
  return runScheduled(makeEnv(kv), {
    seoul,
    apnsConfig,
    apnsHosts: APNS_HOSTS,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => NOW,
    generatePushId: () => 'evidence-0818-push',
  } satisfies ScheduledDeps);
}

describe('evidence 2026-08-18 저녁 BG 환승 시나리오 — 조립 체인 replay (#2341/#2342/#2350/#2352/#2355/#2358)', () => {
  it('(a) 뚝섬 출발 boardingPrompt — subwayId 역파생 + 근접 갱신으로 3게이트(empty/tooFar/stale) 통과해 발사', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip({
      token: 'evidence-0818-bp',
      promptGeoContext: {
        origin: { lat: 0, lng: 0 },
        nextStation: { lat: 0, lng: 0.01 },
        direction: 'up',
        // 근접 관측(distance - accuracy = 40m ≤ 150m 마진) → nearOrigin=true.
        originDistanceM: 50,
        originAccuracyM: 10,
      },
      promptDisplay: { originStation: '뚝섬', line: '2' },
      // #2358 — 16분 전 마지막 stamp. 이번 cycle도 nearOrigin=true이므로 anchor가 재stamp돼
      // freshness age=0으로 재계산된다("원점 대기 15분+"에도 SkippedStale 아님).
      originProximityAt: NOW - SIXTEEN_MIN_MS,
    });
    await putTrip(kv as unknown as KVNamespace, trip);
    await seedHappySeries(kv, trip.token);

    // #2355 — subwayNm=null + subwayId='1002'(2호선) masked 응답. matchLine이 subwayId
    // 역파생 없이는 매칭 0건 → boardingPromptSkippedEmpty로 회귀했을 케이스.
    const seoul = makeMaskedSeoul('성수', 'T2', '1002', 0);
    const fetchImpl = vi.fn(async (_url: string, _init?: { body?: string }) => new Response(null, { status: 200 }));

    const stats = await runOnce(kv, seoul, fetchImpl);

    expect(stats.boardingPromptSkippedEmpty).toBe(0);
    expect(stats.boardingPromptSkippedTooFar).toBe(0);
    expect(stats.boardingPromptSkippedStale).toBe(0);
    expect(stats.boardingPromptEvaluated).toBe(1);
    expect(stats.boardingPromptFired).toBe(1);

    // candidateTrains payload — device BoardingTrainList 렌더 입력이 실제로 채워졌는지.
    const call = fetchImpl.mock.calls[0];
    const body = JSON.parse(call[1]?.body ?? '{}') as {
      aps: { alert: unknown };
      data: { candidateTrains?: unknown[] };
    };
    expect(Array.isArray(body.data.candidateTrains)).toBe(true);
    expect((body.data.candidateTrains ?? []).length).toBeGreaterThan(0);
  });

  it('(b) 환승 후 7호선 leg(건대입구→중곡) — subwayId 역파생 arvlCd 신호로 advance+fire', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip({
      token: 'evidence-0818-leg7',
      boardingLock: makeBoardingLock(),
      waypoints: [{ stationName: '중곡', line: '7', kind: 'intermediate' }],
    });
    await putTrip(kv as unknown as KVNamespace, trip);
    const ssot = await seedSsot(kv as unknown as KVNamespace, trip.token, '건대입구', {
      expiresAt: trip.expiresAt,
    });
    await writeSsot(kv as unknown as KVNamespace, ssot, { expiresAt: trip.expiresAt });

    // #2355 — 중곡 도착(arvlCd=1) 신호도 subwayNm masked, subwayId='1007'(7호선)로만 옴.
    const seoul = makeMaskedSeoul('중곡', '7246', '1007', 1);
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));

    const stats = await runOnce(kv, seoul, fetchImpl);

    expect(stats.arvlCdFireFired).toBe(1);
    expect(stats.arvlCdFireSuccess).toBe(1);
  });

  it('(c) 목적지(용마산) destination push 발사 시도가 존재 — transfer-destination gate 선점 없음(#2352 무회귀)', async () => {
    const kv = new InMemoryKV();
    const trip = makeTrip({
      token: 'evidence-0818-dest',
      boardingLock: makeBoardingLock(),
      waypoints: [{ stationName: '용마산', line: '7', kind: 'destination' }],
      passedStations: ['중곡'],
    });
    await putTrip(kv as unknown as KVNamespace, trip);
    const ssot = await seedSsot(kv as unknown as KVNamespace, trip.token, '중곡', {
      expiresAt: trip.expiresAt,
    });
    await writeSsot(kv as unknown as KVNamespace, ssot, { expiresAt: trip.expiresAt });

    const seoul = makeMaskedSeoul('용마산', '7246', '1007', 1);
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));

    const stats = await runOnce(kv, seoul, fetchImpl);

    expect(stats.arvlCdFireFired).toBe(1);
    expect(stats.arvlCdFireSuccess).toBe(1);
    expect(stats.transferDestinationGateBlocked).toBe(0);
  });
});
