/**
 * #3007 PR-A — cron이 "정지 15분 = 종료 제안 시점"을 판정해 D1에 1건 적재한다.
 *
 * 왜 필요한가(실측): 2026-10-15 14:04 트립이 `trip-end {reason:"expired"}`로 **2시간 좀비**로
 * 살면서 KV write 쿼터의 60~72%를 먹었고, 21:17부터 `POST /position` 500 × 63 /
 * `POST /trips` 500 × 9로 backend가 사망했다(#3006, 코드 10048 프로브 확인). 15분 종료 제안이
 * 있었다면 그날 소비가 ~27%로 끝나 사고 자체가 없었다.
 *
 * 조건은 사용자 확정 ②(2026-10-16): **트립 활성 + 이동 없음 15분**(`pausedAt` 무관) —
 * 10/15 두 사례가 모두 pause 미탭 상태였다.
 *
 * 본 PR은 **동작 변경 0**(판정 + D1 적재만). LA content/alert·Swift 버튼은 PR-B,
 * device pause backstop 제거는 PR-C.
 */
import { generateKeyPair, exportPKCS8 } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { resetApnsJwtCache, type ApnsConfig } from '../apns';
import { runScheduled, type ScheduledDeps, type ScheduledStats } from '../scheduled';
import { SeoulArrivalClient } from '../seoul';
import { putTrip } from '../trips';
import { seedSsot, writeSsot, type MotionEvidence } from '../tripPositionSsot';
import {
  END_PROMPT_STATIONARY_MS,
  SSOT_MOTION_WRITE_MIN_INTERVAL_MS,
} from '../motionState';
import type { Env, Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';

const NOW = 1_800_000_000_000;
const APNS_HOSTS = { production: 'api.push.apple.com', sandbox: 'api.sandbox.push.apple.com' };

let apnsConfig: ApnsConfig;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  apnsConfig = {
    keyId: 'K',
    teamId: 'T',
    bundleId: 'com.example.app',
    privateKeyPem: await exportPKCS8(privateKey),
  };
  resetApnsJwtCache();
});

/** trip_events INSERT만 캡처하는 D1 stub. */
function captureEvents(): { db: Env['DB']; inserts: unknown[][] } {
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

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return {
    token: 'endprompt-tok',
    route: { type: 'direct', line: '7', stops: 3 },
    destination: '용마산',
    waypoints: [{ stationName: '중곡', line: '7', kind: 'intermediate' }],
    expiresAt: NOW + 60 * 60_000,
    createdAt: NOW - 30 * 60_000,
    alarmAtEpochMs: NOW - 60_000,
    ...overrides,
  };
}

/** 같은 좌표 샘플을 `spanMs` 구간에 `count`개 깐다(최신이 NOW). */
function stationaryEvidence(count: number, spanMs: number): MotionEvidence[] {
  const spacing = spanMs / (count - 1);
  const out: MotionEvidence[] = [];
  for (let i = count - 1; i >= 0; i--) {
    out.push({
      source: 'device-position',
      ts: NOW - i * spacing,
      signal: { lat: 37.5, lng: 127.0, motion: 'unknown' },
    });
  }
  return out;
}

function makeSeoul(): SeoulArrivalClient {
  return new SeoulArrivalClient({
    apiKey: 'K',
    host: 'h',
    now: () => NOW,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ realtimeArrivalList: [] }), {
        status: 200,
      })) as unknown as typeof fetch,
  });
}

async function runOnce(
  kv: InMemoryKV,
  db: Env['DB'],
): Promise<ScheduledStats> {
  const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
  return runScheduled(makeEnv(kv, db), {
    seoul: makeSeoul(),
    apnsConfig,
    apnsHosts: APNS_HOSTS,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    now: () => NOW,
    generatePushId: () => 'endprompt-push',
  } satisfies ScheduledDeps);
}

function dueEvents(inserts: unknown[][]): Array<Record<string, unknown>> {
  return inserts
    .filter((a) => a[2] === 'end-prompt-due')
    .map((a) => (a[5] ? (JSON.parse(a[5] as string) as Record<string, unknown>) : {}));
}

async function setup(
  evidence: MotionEvidence[],
): Promise<{ kv: InMemoryKV; db: Env['DB']; inserts: unknown[][] }> {
  const kv = new InMemoryKV();
  const trip = makeTrip();
  await putTrip(kv as unknown as KVNamespace, trip);
  const ssot = await seedSsot(kv as unknown as KVNamespace, trip.token, '중곡', {
    expiresAt: trip.expiresAt,
  });
  ssot.motionEvidence = evidence;
  ssot.lastDeviceSyncAt = NOW;
  await writeSsot(kv as unknown as KVNamespace, ssot, { expiresAt: trip.expiresAt });
  const { db, inserts } = captureEvents();
  return { kv, db, inserts };
}

describe('#3007 — cron이 정지 15분 종료 제안 시점을 D1에 적재', () => {
  it('[red] 정지 15분을 방금 넘긴 tick → end-prompt-due 1건', async () => {
    const { kv, db, inserts } = await setup(stationaryEvidence(40, END_PROMPT_STATIONARY_MS));

    await runOnce(kv, db);

    const events = dueEvents(inserts);
    expect(events).toHaveLength(1);
    // 판정 근거를 함께 싣는다 — D1만으로 "왜 due였나"를 재구성할 수 있어야 한다.
    expect(events[0]).toMatchObject({ windowMs: END_PROMPT_STATIONARY_MS });
    expect(typeof events[0].sampleCount).toBe('number');
  });

  it('[거부] 정지가 20분째 이어지면 due 시점이 지났으므로 0건 (중복 제안 금지)', async () => {
    const { kv, db, inserts } = await setup(
      stationaryEvidence(48, END_PROMPT_STATIONARY_MS + 5 * 60_000),
    );

    await runOnce(kv, db);

    expect(dueEvents(inserts)).toHaveLength(0);
  });

  it('[거부] 윈도우 내 변위가 있으면(이동 중) 0건', async () => {
    const moving = stationaryEvidence(40, END_PROMPT_STATIONARY_MS).map((e, i) => ({
      ...e,
      // 샘플마다 ~5m씩 이동 → 윈도우 최대 변위가 임계(10m)를 크게 넘는다.
      signal: { lat: 37.5 + i * 5 * 9e-6, lng: 127.0, motion: 'unknown' },
    }));
    const { kv, db, inserts } = await setup(moving);

    await runOnce(kv, db);

    expect(dueEvents(inserts)).toHaveLength(0);
  });

  it('[거부] evidence가 윈도우를 못 덮으면(최신 5분치만) 0건 — fail-safe', async () => {
    const { kv, db, inserts } = await setup(
      stationaryEvidence(20, 5 * 60_000 - SSOT_MOTION_WRITE_MIN_INTERVAL_MS),
    );

    await runOnce(kv, db);

    expect(dueEvents(inserts)).toHaveLength(0);
  });
});
