/**
 * #3057 (2026-10-19 사용자 결정) — 탑승 프롬프트(알림+LA 배너)는 **도착 확정 때만** 발사한다.
 *
 * 사용자 결정 verbatim: "탑승여부이니까 배너로 도착확정시에만 프롬프트가 올 수 있도록 하자.
 * 알림 프롬프트도 마찬가지고". 배경(10/18 라이드): 프롬프트가 열차보다 최대 ~2.5분 일찍 와서,
 * 사용자가 탑승 후 탭한 시점엔 열차가 이미 DEPARTED -> resolver 탈락(#3056) -> PENDING lock.
 *
 * "도착 확정" = anchor 역 기준
 *   1. arrival 피드 arvlCd in {1 도착, 2 출발}  (0 진입 / 3 전역출발 / 4 / 5 / 99는 확정 아님)
 *   2. realtimePosition(self-poll) trainSttus in {1 ARRIVED, 2 DEPARTED(신선창 내)} at anchor
 *   3. arvlCd 관측 불가(null) -> 기존 fallback-unobservable 발사 유지 (ADR-010 miss 동급 보호)
 *
 * 이 파일은 스펙(이슈 본문)만 보고 작성한 red 테스트다 — 구현 코드를 보고 기대값을 맞추지 않았다.
 *
 * ## replay fixture (실측, 불변 — 통과시키려 조정 금지)
 * `capture_20261018_2325_yongmasan_departed_7325.json` — 10/18 23:25 7호선 실캡처.
 * 7325(신풍행, 하행) trainSttus=2(DEPARTED) at 용마산, recptn 23:25:07 (cycle 시작 23:25:45 기준 38s).
 * 캡처에 용마산 arrivals 조회는 없다(arrival 피드 無) -> position만이 도착 확정 근거.
 */
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { buildReplayFixture, type ReplayFixture } from '../replayFixture';
import { parseSeoulCaptureCycle } from '../replayFixture';
import { maybeFireLegBoardingPrompt, type ScheduledDeps, type ScheduledStats } from '../scheduled';
import { SeoulArrivalClient, type ArrivalEntry, type PositionEntry } from '../seoul';
import { writeSelfPollPosition } from '../selfPollPosition';
import type { Env, Trip } from '../types';
import { makeCaptureFetch } from './helpers/replayHarness';
import { InMemoryKV } from './inMemoryKv';

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'capture_20261018_2325_yongmasan_departed_7325.json');
const APNS_HOSTS = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' } as const;

let apnsConfig: ApnsConfig;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  apnsConfig = {
    keyId: 'K',
    teamId: 'T',
    privateKeyPem: await exportPKCS8(privateKey),
    bundleId: 'com.example.app',
  };
});

beforeEach(() => resetApnsJwtCache());

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
  } as unknown as Env;
}

function makeStats(): ScheduledStats {
  return {
    legBoardingPromptFired: 0,
    legBoardingPromptBlocked: 0,
    legBoardingPromptSkippedWalking: 0,
    legBoardingPromptSkippedNoOptIn: 0,
    silentPushFiredByKind: { boardingPrompt: 0 },
    promptDirectionUnknownBlocked: 0,
    envCorrected: 0,
    errors: 0,
  } as unknown as ScheduledStats;
}

/** leg-2 trip — anchor 용마산(7호선), 다음 waypoint 중곡(군자방면, 7325의 진행 방향). */
function makeTrip(token: string, now: number): Trip {
  return {
    token,
    createdAt: now - 20 * 60_000,
    expiresAt: now + 60 * 60_000,
    waypoints: [{ stationName: '중곡', line: '7', kind: 'destination' }],
    apnsEnv: 'production',
    registeredAt: now,
    currentLegAnchor: { boardingStation: '용마산', line: '7' },
    promptOptIn: true,
  } as unknown as Trip;
}

function makeSeoul(arrivals: () => readonly ArrivalEntry[], positions: () => readonly PositionEntry[] = () => []): SeoulArrivalClient {
  return {
    stats: { callCount: 0, cacheSize: 0, httpErrorCount: 0 },
    async fetchArrivals(stationName: string): Promise<ArrivalEntry[]> {
      return stationName === '용마산' ? [...arrivals()] : [];
    },
    async fetchPositions(): Promise<PositionEntry[]> {
      return [...positions()];
    },
  } as unknown as SeoulArrivalClient;
}

function arrival(trainCode: string, arvlCd: number | null, isUp = false): ArrivalEntry {
  return {
    destination: '신풍',
    arrivalSeconds: 60,
    trainCode,
    isUp,
    subwayNm: '지하철7호선',
    subwayId: '1007',
    arvlCd,
  } as unknown as ArrivalEntry;
}

function position(trainCode: string, over: Partial<PositionEntry> & { now: number }): PositionEntry {
  const { now, ...rest } = over;
  return {
    trainCode,
    stationName: '용마산',
    trainSttus: 1,
    isUp: false,
    recptnMs: now - 10_000,
    ...rest,
  };
}

interface RunResult {
  stats: ScheduledStats;
  log: ReturnType<typeof vi.fn>;
  pushFetch: ReturnType<typeof vi.fn>;
  trip: Trip;
}

/** self-poll KV에 positions를 stamp한 뒤 leg-2 프롬프트 평가를 1 cycle 실행. */
async function runOneCycle(inputs: {
  now: number;
  arrivals?: readonly ArrivalEntry[];
  selfPollPositions?: readonly PositionEntry[];
  token?: string;
}): Promise<RunResult> {
  const { now, arrivals = [], selfPollPositions, token = 'trip-3057' } = inputs;
  const kv = new InMemoryKV(() => now);
  const env = makeEnv(kv);
  if (selfPollPositions) await writeSelfPollPosition(kv as unknown as KVNamespace, '7', [...selfPollPositions], now);
  const trip = makeTrip(token, now);
  const stats = makeStats();
  const log = vi.fn();
  const pushFetch = vi.fn(async () => new Response('', { status: 200 }));
  const deps = {
    apnsConfig,
    apnsHosts: APNS_HOSTS,
    fetchImpl: pushFetch as unknown as typeof fetch,
    seoul: makeSeoul(() => arrivals),
    archFlag: 'off',
  } as unknown as ScheduledDeps;
  await maybeFireLegBoardingPrompt(trip, env, deps, stats, now, log, () => 'push-1');
  return { stats, log, pushFetch, trip };
}

const NOW = 1_792_333_550_000;

describe('#3057 red 1/2 — arrival 피드의 진입(0)/전역출발(3)/전역도착(5)은 도착 확정이 아니다', () => {
  it.each([
    [0, '진입'],
    [3, '전역출발'],
    [4, '전역진입'],
    [5, '전역도착'],
    [99, '운행중'],
  ])('arvlCd=%i(%s)만 관측되면 발사하지 않는다(suppressed-not-imminent)', async (arvlCd) => {
    const { stats, pushFetch, log } = await runOneCycle({ now: NOW, arrivals: [arrival('T1', arvlCd)] });
    expect(stats.legBoardingPromptFired).toBe(0);
    expect(pushFetch).not.toHaveBeenCalled();
    const blocked = log.mock.calls.filter(([m]) => String(m) === 'leg-boarding-prompt: gate blocked');
    expect(blocked.length).toBe(1);
    expect((blocked[0][1] as { reason?: string }).reason).toBe('suppressed-not-imminent');
  });

  it.each([
    [1, '도착'],
    [2, '출발'],
  ])('green 유지: arvlCd=%i(%s)는 도착 확정이라 발사한다', async (arvlCd) => {
    const { stats, pushFetch } = await runOneCycle({ now: NOW, arrivals: [arrival('T1', arvlCd)] });
    expect(stats.legBoardingPromptFired).toBe(1);
    expect(pushFetch).toHaveBeenCalledTimes(1);
  });

  it('green 유지: arvlCd 관측 불가(null)는 fallback-unobservable로 발사한다(ADR-010 equal-protection)', async () => {
    const { stats, log } = await runOneCycle({ now: NOW, arrivals: [arrival('T1', null)] });
    expect(stats.legBoardingPromptFired).toBe(1);
    const fired = log.mock.calls.filter(([m]) => String(m).endsWith(': fired'));
    expect((fired[0][1] as { gateDecision?: string }).gateDecision).toBe('fallback-unobservable');
  });
});

describe('#3057 red 3 — position(self-poll) trainSttus 도착 확정 배선', () => {
  it('arrival 피드가 비어도 anchor 역의 trainSttus=1(ARRIVED) fresh position이 있으면 발사한다', async () => {
    const { stats, pushFetch, log } = await runOneCycle({
      now: NOW,
      arrivals: [],
      selfPollPositions: [position('P1', { now: NOW, trainSttus: 1 })],
    });
    expect(stats.legBoardingPromptFired).toBe(1);
    expect(pushFetch).toHaveBeenCalledTimes(1);
    const fired = log.mock.calls.filter(([m]) => String(m).endsWith(': fired'));
    expect((fired[0][1] as { gateDecision?: string }).gateDecision).toBe('position-confirmed');
  });

  it('arrival 피드가 전역출발(3)만 말해도 position이 anchor 역 도착을 확정하면 발사한다', async () => {
    const { stats, log } = await runOneCycle({
      now: NOW,
      arrivals: [arrival('P1', 3)],
      selfPollPositions: [position('P1', { now: NOW, trainSttus: 2 })],
    });
    expect(stats.legBoardingPromptFired).toBe(1);
    const fired = log.mock.calls.filter(([m]) => String(m).endsWith(': fired'));
    expect((fired[0][1] as { gateDecision?: string }).gateDecision).toBe('position-confirmed');
  });

  it('발사 payload의 lock 대상 열차는 position이 확정한 열차다(candidateTrains에 포함)', async () => {
    const { pushFetch } = await runOneCycle({
      now: NOW,
      arrivals: [],
      selfPollPositions: [position('P1', { now: NOW, trainSttus: 2 })],
    });
    const [, init] = pushFetch.mock.calls[0] as unknown as [string, { body: string }];
    const body = JSON.parse(init.body) as { body?: { trainCode?: string; candidateTrains?: { trainCode: string }[] } };
    expect(body.body?.trainCode).toBe('P1');
    expect(body.body?.candidateTrains?.map((c) => c.trainCode)).toContain('P1');
  });

  it('거부 ⓔ: 신선창 밖의 stale DEPARTED는 도착 확정이 아니다', async () => {
    const { stats, pushFetch } = await runOneCycle({
      now: NOW,
      arrivals: [],
      selfPollPositions: [position('P1', { now: NOW, trainSttus: 2, recptnMs: NOW - 10 * 60_000 })],
    });
    expect(stats.legBoardingPromptFired).toBe(0);
    expect(pushFetch).not.toHaveBeenCalled();
  });

  it('거부: 진입(trainSttus=0) position은 도착 확정이 아니다', async () => {
    const { stats } = await runOneCycle({
      now: NOW,
      arrivals: [arrival('P1', 3)],
      selfPollPositions: [position('P1', { now: NOW, trainSttus: 0 })],
    });
    expect(stats.legBoardingPromptFired).toBe(0);
  });

  it('거부: anchor가 아닌 다른 역의 position은 확정이 아니다', async () => {
    const { stats } = await runOneCycle({
      now: NOW,
      arrivals: [arrival('P1', 3)],
      selfPollPositions: [position('P1', { now: NOW, trainSttus: 1, stationName: '중곡' })],
    });
    expect(stats.legBoardingPromptFired).toBe(0);
  });

  it('거부: 반대 방향 열차의 position은 확정이 아니다(10/9 반대 방향 lock 계열)', async () => {
    const { stats } = await runOneCycle({
      now: NOW,
      arrivals: [arrival('P1', 3)],
      selfPollPositions: [position('P1', { now: NOW, trainSttus: 1, isUp: true })],
    });
    expect(stats.legBoardingPromptFired).toBe(0);
  });
});

describe('#3057 red 4 — 10/18 23:25 용마산 7325 DEPARTED 실캡처 replay', () => {
  function loadFixture(): ReplayFixture {
    const raw = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));
    return buildReplayFixture([parseSeoulCaptureCycle(raw)]);
  }

  it('캡처된 realtimePosition(7호선)을 실 파서로 self-poll에 stamp하면 7325 DEPARTED 확정으로 발사하고 lock 대상은 7325다', async () => {
    const fixture = loadFixture();
    const tick = fixture.entries.find((e) => e.kind === 'position' && e.target === '7호선')?.tMs;
    if (tick === undefined) throw new Error('fixture 전제 실패 — 7호선 position 캡처 없음');
    const seoul = new SeoulArrivalClient({
      apiKey: 'KEY',
      host: 'seoul.api',
      now: () => tick,
      fetchImpl: makeCaptureFetch(fixture, () => tick, { ceilingMs: tick + 1 }),
    });
    const positions = await seoul.fetchPositions('7');
    const target = positions.find((p) => p.trainCode === '7325');
    // 전제 고정 — 실측 그대로(7325는 용마산에서 trainSttus=2).
    expect(target?.stationName).toBe('용마산');
    expect(target?.trainSttus).toBe(2);

    const { stats, pushFetch, log } = await runOneCycle({
      now: tick,
      arrivals: [], // 캡처에 용마산 arrivals 조회가 없다 — position이 유일한 확정 근거
      selfPollPositions: positions,
      token: 'trip-20261018-yongmasan',
    });
    expect(stats.legBoardingPromptFired).toBe(1);
    const fired = log.mock.calls.filter(([m]) => String(m).endsWith(': fired'));
    expect((fired[0][1] as { gateDecision?: string }).gateDecision).toBe('position-confirmed');
    const [, init] = pushFetch.mock.calls[0] as unknown as [string, { body: string }];
    const body = JSON.parse(init.body) as { body?: { trainCode?: string } };
    expect(body.body?.trainCode).toBe('7325');
  });
});

describe('#3057 — self-poll KV 장애는 position 확정 없음으로 degrade(arrival 피드 판정 단독)', () => {
  it('KV get이 throw해도 발사 평가는 중단되지 않고 arvlCd=1 도착 확정으로 발사한다', async () => {
    const kv = new InMemoryKV(() => NOW);
    const realGet = kv.get.bind(kv);
    (kv as unknown as { get: (key: string, ...rest: unknown[]) => Promise<unknown> }).get = async (key, ...rest) => {
      if (key.startsWith('realtime-position:')) throw new Error('kv down');
      return (realGet as (k: string, ...r: unknown[]) => Promise<unknown>)(key, ...rest);
    };
    const trip = makeTrip('trip-kv-down', NOW);
    const stats = makeStats();
    const pushFetch = vi.fn(async () => new Response('', { status: 200 }));
    const deps = {
      apnsConfig,
      apnsHosts: APNS_HOSTS,
      fetchImpl: pushFetch as unknown as typeof fetch,
      seoul: makeSeoul(() => [arrival('T1', 1)]),
      archFlag: 'off',
    } as unknown as ScheduledDeps;
    await maybeFireLegBoardingPrompt(trip, makeEnv(kv), deps, stats, NOW, vi.fn(), () => 'push-kv');
    expect(stats.legBoardingPromptFired).toBe(1);
  });
});
