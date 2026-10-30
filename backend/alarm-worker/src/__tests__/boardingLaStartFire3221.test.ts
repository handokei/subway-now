/**
 * #3221 PR-3 — 발사 지점별 경계: end-prompt due start / hop-end start 실패 시 소리 유지 / 죽은 token 정리.
 * (실측 사슬 acceptance는 `replay_20261028_trip179_boarding_la_start.test.ts`. 이 파일은 그 replay가 못 타는 분기 —
 * 15분 정지 종료 제안은 trip 179 창에 없고, APNs 실패는 replay 하네스가 항상 200이다.)
 * 엣지 케이스는 구현 후 작성(test-after) — PR 본문에 명시.
 */
import { exportPKCS8, generateKeyPair } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { t } from '../i18n';
import { createEmptyScheduledStats, maybeFireHopEndPrompt, runScheduled, type ScheduledDeps } from '../scheduled';
import { SeoulArrivalClient } from '../seoul';
import { seedSsot, writeSsot, type MotionEvidence } from '../tripPositionSsot';
import { END_PROMPT_STATIONARY_MS } from '../motionState';
import { getTrip, putTrip } from '../trips';
import type { Env, Trip, Waypoint } from '../types';
import { InMemoryKV } from './inMemoryKv';

const NOW = 1_800_000_000_000;
const HOSTS = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' };
const START_TOKEN = 'pts-token-xyz';
const SPLIT = { split: true, boardingStart: 'push-to-start' } as const;

let apnsConfig: ApnsConfig;
beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  apnsConfig = { keyId: 'K', teamId: 'T', bundleId: 'com.example.app', privateKeyPem: await exportPKCS8(privateKey) };
});
beforeEach(() => resetApnsJwtCache());

function captureDb(): { db: Env['DB']; inserts: unknown[][] } {
  const inserts: unknown[][] = [];
  const run = vi.fn().mockResolvedValue({ success: true });
  const prepare = vi.fn().mockImplementation((sql: string) => ({
    bind: (...args: unknown[]) => {
      if (sql.includes('trip_events')) inserts.push(args);
      return { run };
    },
  }));
  return { db: { prepare } as unknown as Env['DB'], inserts };
}

function makeEnv(kv: InMemoryKV, db: Env['DB']): Env {
  return {
    TRIPS: kv as unknown as KVNamespace,
    DB: db,
    APNS_HOST: HOSTS.production,
    APNS_HOST_SANDBOX: HOSTS.sandbox,
    SEOUL_API_HOST: 'seoul.api',
    SEOUL_API_KEY: 'KEY',
    APNS_KEY_ID: 'K',
    APNS_TEAM_ID: 'T',
    APNS_PRIVATE_KEY: apnsConfig.privateKeyPem,
    APNS_BUNDLE_ID: 'com.example.app',
  };
}

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    token: 'firetok-3221',
    route: { type: 'direct', line: '7', stops: 3 },
    destination: '용마산',
    waypoints: [{ stationName: '중곡', line: '7', kind: 'intermediate' }],
    expiresAt: NOW + 3_600_000,
    createdAt: NOW - 30 * 60_000,
    alarmAtEpochMs: NOW - 60_000,
    apnsEnv: 'production',
    promptOptIn: true,
    laClient: SPLIT,
    boardingPushToStartToken: START_TOKEN,
    ...overrides,
  };
}

interface Sent {
  url: string;
  aps: Record<string, unknown>;
  body: Record<string, unknown>;
}

/** START_TOKEN 대상은 `startStatus`, 그 외는 200. 모든 호출을 기록한다. */
function makeFetch(startStatus: number, startReason?: string) {
  const sent: Sent[] = [];
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    sent.push({ url: String(url), aps: (body.aps ?? {}) as Record<string, unknown>, body });
    if (String(url).endsWith(`/${START_TOKEN}`) && startStatus !== 200) {
      return new Response(JSON.stringify({ reason: startReason }), { status: startStatus });
    }
    return new Response('', { status: 200 });
  });
  return { sent, impl: impl as unknown as typeof fetch };
}

const startsOf = (sent: Sent[]) => sent.filter((s) => s.aps.event === 'start');

function stationaryEvidence(count: number, spanMs: number): MotionEvidence[] {
  const spacing = spanMs / (count - 1);
  return Array.from({ length: count }, (_, k) => count - 1 - k).map((i) => ({
    source: 'device-position' as const,
    ts: NOW - i * spacing,
    signal: { lat: 37.5, lng: 127.0, motion: 'unknown' as const },
  }));
}

async function runDueTick(tripOverrides: Partial<Trip>, fetchImpl: typeof fetch) {
  const kv = new InMemoryKV();
  const trip = makeTrip(tripOverrides);
  await putTrip(kv as unknown as KVNamespace, trip);
  const ssot = await seedSsot(kv as unknown as KVNamespace, trip.token, '중곡', { expiresAt: trip.expiresAt });
  ssot.motionEvidence = stationaryEvidence(40, END_PROMPT_STATIONARY_MS);
  ssot.lastDeviceSyncAt = NOW;
  await writeSsot(kv as unknown as KVNamespace, ssot, { expiresAt: trip.expiresAt });
  const { db, inserts } = captureDb();
  await runScheduled(makeEnv(kv, db), {
    seoul: new SeoulArrivalClient({
      apiKey: 'K',
      host: 'h',
      now: () => NOW,
      fetchImpl: (async () => new Response(JSON.stringify({ realtimeArrivalList: [] }), { status: 200 })) as unknown as typeof fetch,
    }),
    apnsConfig,
    apnsHosts: HOSTS,
    fetchImpl,
    now: () => NOW,
    generatePushId: () => 'push-id',
  } satisfies ScheduledDeps);
  return { kv, trip, inserts };
}

describe('end-prompt due(15분 정지 종료 제안) — split trip은 탑승 LA(phase end-prompt)로 start', () => {
  it('split + token: start 1건(phase end-prompt, 종료 제안 문구), D1 path=end-prompt-due', async () => {
    const { sent, impl } = makeFetch(200);
    const { inserts } = await runDueTick({}, impl);
    const starts = startsOf(sent);
    expect(starts).toHaveLength(1);
    expect(starts[0].url.endsWith(`/${START_TOKEN}`)).toBe(true);
    const strings = t(undefined);
    expect(starts[0].aps['content-state']).toMatchObject({
      phase: 'end-prompt',
      originStation: '중곡',
      title: strings.endPromptTitle,
      body: strings.endPromptBody({ destinationStation: '용마산' }),
    });
    const rows = inserts.filter((a) => a[2] === 'la-boarding-start');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(String(rows[0][5]))).toMatchObject({ path: 'end-prompt-due', phase: 'end-prompt', status: 200, ok: true });
  });

  it('구 클라이언트(laClient 없음)는 start 0건 — 현행', async () => {
    const { sent, impl } = makeFetch(200);
    await runDueTick({ laClient: undefined, boardingPushToStartToken: undefined }, impl);
    expect(startsOf(sent)).toEqual([]);
  });

  it('token만 있고 split이 아니면 start 0건', async () => {
    const { sent, impl } = makeFetch(200);
    await runDueTick({ laClient: undefined }, impl);
    expect(startsOf(sent)).toEqual([]);
  });

  it('start 410: 죽은 token을 trip에서 지워 KV에 반영한다 (다음 질문이 같은 token으로 헛발사하지 않음)', async () => {
    const { impl } = makeFetch(410, 'Unregistered');
    const { kv, trip } = await runDueTick({}, impl);
    const stored = await getTrip(kv as unknown as KVNamespace, trip.token);
    expect(stored?.boardingPushToStartToken).toBeUndefined();
    expect(stored?.laClient).toEqual(SPLIT);
  });
});

describe('hop-end 질문 — start 결과에 따라 일반 알림 소리가 정해진다', () => {
  const transferWaypoint: Waypoint = { stationName: '건대입구', line: '7', kind: 'transfer' };

  async function fireHopEnd(fetchImpl: typeof fetch) {
    const kv = new InMemoryKV();
    const trip = makeTrip({ waypoints: [{ stationName: '성수', line: '2', kind: 'intermediate' }] });
    const { db } = captureDb();
    const deps = {
      seoul: new SeoulArrivalClient({ apiKey: 'K', host: 'h', fetchImpl }),
      apnsConfig,
      apnsHosts: HOSTS,
      fetchImpl,
    } as unknown as ScheduledDeps;
    const stats = createEmptyScheduledStats(NOW);
    await maybeFireHopEndPrompt({
      trip,
      transferWaypoint,
      deps,
      stats,
      now: NOW,
      log: () => undefined,
      generatePushId: () => 'hop-push',
      env: makeEnv(kv, db),
    });
    return { trip, stats };
  }

  it('start 2xx: 일반 질문 알림은 무음(aps.sound 없음), fired stamp', async () => {
    const { sent, impl } = makeFetch(200);
    const { trip, stats } = await fireHopEnd(impl);
    expect(startsOf(sent)).toHaveLength(1);
    const notification = sent.find((s) => s.aps.event === undefined && (s.body.body as Record<string, unknown>)?.hopEndKind === 'disembark');
    expect(notification).toBeDefined();
    expect(notification?.aps.sound).toBeUndefined();
    expect(stats.hopEndPromptFired).toBe(1);
    expect(Object.keys(trip.hopEndPromptState ?? {})).toEqual(['건대입구|2']);
  });

  it('start 실패(500): 일반 알림이 소리를 유지한다 (질문을 놓치지 않는다)', async () => {
    const { sent, impl } = makeFetch(500, 'InternalServerError');
    const { stats } = await fireHopEnd(impl);
    const notification = sent.find((s) => s.aps.event === undefined && (s.body.body as Record<string, unknown>)?.hopEndKind === 'disembark');
    expect(notification?.aps.sound).toBe('default');
    expect(stats.hopEndPromptFired).toBe(1);
  });

  it('start도 알림도 실패하면 fired stamp 없음(다음 cycle 재시도)', async () => {
    const failAll = vi.fn(async () => new Response(JSON.stringify({ reason: 'InternalServerError' }), { status: 500 })) as unknown as typeof fetch;
    const { stats } = await fireHopEnd(failAll);
    expect(stats.hopEndPromptFired).toBe(0);
    expect(stats.errors).toBe(1);
  });
});
