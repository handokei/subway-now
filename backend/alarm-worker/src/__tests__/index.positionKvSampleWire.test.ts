/**
 * #3006 PR-0 — POST /position KV write 샘플 계측(`position-kv-sample`) 배선.
 *
 * 스펙(이슈 #3006 코멘트 §4 PR-0)만으로 쓴 테스트다. 관측 전용이므로 핵심 제약은 둘:
 *  1. meta.stages는 **실제로 시도된 KV put의 key prefix**와 일치한다(spy가 정답).
 *  2. 계측이 KV 접근(get/put/delete/list)을 **하나도 추가하지 않는다** — D1 쓰기만.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index';
import type { Env } from '../types';
import { InMemoryKV } from './inMemoryKv';

const NOW = Date.UTC(2026, 9, 23, 3, 0, 0);
const TOKEN = 'tok-sample';
const SAMPLE_KIND = 'position-kv-sample';
const PROBE_KV_KEY = 'scheduled:last-heartbeat';

interface Insert {
  sql: string;
  args: unknown[];
}

function makeDb(opts: { throwAll?: boolean; count?: number } = {}) {
  const inserts: Insert[] = [];
  let prepares = 0;
  const db = {
    prepare: (sql: string) => {
      prepares += 1;
      if (opts.throwAll) throw new Error('d1 down');
      return {
        bind: (...args: unknown[]) => ({
          run: async () => {
            inserts.push({ sql, args });
            return { success: true, meta: { last_row_id: 1 } };
          },
          first: async () => ({ n: opts.count ?? 0 }),
        }),
        first: async () => ({ n: opts.count ?? 0 }),
        run: async () => ({ success: true }),
      };
    },
  } as unknown as D1Database;
  return { db, inserts, prepareCount: () => prepares };
}

function makeEnv(kv: InMemoryKV, db?: D1Database): Env {
  return {
    TRIPS: kv as unknown as Env['TRIPS'],
    DB: db,
    APNS_HOST: 'h',
    APNS_HOST_SANDBOX: 'h',
    SEOUL_API_HOST: 'h',
    SEOUL_API_KEY: 'k',
    APNS_KEY_ID: 'k',
    APNS_TEAM_ID: 't',
    APNS_PRIVATE_KEY: 'p',
    APNS_BUNDLE_ID: 'b',
  };
}

function makeCtx() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, pending };
}

/** `randomUnit()`(crypto.getRandomValues 기반)이 unit(0~1)을 반환하도록 고정. */
function mockRandom(unit: number): void {
  vi.spyOn(crypto, 'getRandomValues').mockImplementation(((arr: Uint32Array) => {
    arr[0] = Math.floor(unit * 2 ** 32);
    return arr;
  }) as typeof crypto.getRandomValues);
}

const ACCEL = {
  startTs: NOW - 5000,
  endTs: NOW,
  count: 10,
  ax: 0,
  ay: 0,
  az: 1,
  magnitudeMean: 1,
  magnitudeStd: 0.1,
  magnitudePeak: 1.2,
};

function positionBody(extra: Record<string, unknown> = {}) {
  return {
    token: TOKEN,
    lat: 37.5,
    lng: 127.0,
    accuracy: 10,
    ts: NOW - 2500,
    motion: 'walking',
    ...extra,
  };
}

async function seedTrip(
  kv: InMemoryKV,
  opts: { lock?: boolean; consecutiveEtaMissing?: number } = {},
) {
  const trip = {
    token: TOKEN,
    route: { type: 'direct', line: '2', stops: 3 },
    destination: 'dst',
    waypoints: [
      { stationName: '강남', line: '2', kind: 'intermediate' },
      { stationName: '역삼', line: '2', kind: 'destination' },
    ],
    // 잔여 5분 < 30분 임계 → /position이 trip put(TTL 연장)을 한다.
    expiresAt: NOW + 5 * 60_000,
    alarmAtEpochMs: 0,
    ...(opts.lock ? { boardingLock: { expiresAt: NOW + 3_600_000 } } : {}),
    ...(opts.consecutiveEtaMissing ? { consecutiveEtaMissing: opts.consecutiveEtaMissing } : {}),
  };
  await kv.put(`trip:${TOKEN}`, JSON.stringify(trip));
}

async function postPosition(env: Env, ctx: ExecutionContext, body: unknown) {
  return app.fetch(
    new Request('http://example.com/position', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
}

const prefixOf = (key: unknown) => String(key).split(':')[0];

function sampleRows(inserts: Insert[]) {
  return inserts
    .filter((i) => /INSERT INTO trip_events/.test(i.sql))
    .filter((i) => i.args[2] === SAMPLE_KIND)
    .map((i) => ({ tokenHash: i.args[0], ts: i.args[1], meta: JSON.parse(String(i.args[5])) }));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('POST /position — position-kv-sample 배선', () => {
  it('trip 없음 + fg: meta.stages가 spy로 잡은 put prefix와 일치, lockState=no-trip', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockRandom(0);
    const kv = new InMemoryKV();
    const putSpy = vi.spyOn(kv, 'put');
    const { db, inserts } = makeDb();
    const { ctx, pending } = makeCtx();
    const res = await postPosition(makeEnv(kv, db), ctx, positionBody({ appState: 'fg' }));
    expect(res.status).toBe(200);
    await Promise.all(pending);

    const rows = sampleRows(inserts);
    expect(rows).toHaveLength(1);
    const { meta } = rows[0];
    expect(meta.stages).toEqual(putSpy.mock.calls.map(([key]) => prefixOf(key)));
    expect(meta.stages).toEqual(expect.arrayContaining(['pos', 'deviceContact']));
    expect(meta.attempted).toBe(meta.stages.length);
    expect(meta).toMatchObject({
      lockState: 'no-trip',
      appState: 'fg',
      headKind: null,
      etaMissing: false,
      hasAccel: false,
      pointLagMs: 2500,
    });
  });

  it('lock trip + accel: stages에 trip/accel prefix, lockState=lock, headKind/etaMissing 채움', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockRandom(0);
    const kv = new InMemoryKV();
    await seedTrip(kv, { lock: true, consecutiveEtaMissing: 2 });
    const putSpy = vi.spyOn(kv, 'put');
    const { db, inserts } = makeDb();
    const { ctx, pending } = makeCtx();
    await postPosition(makeEnv(kv, db), ctx, positionBody({ appState: 'bg', accelSummary: ACCEL }));
    await Promise.all(pending);

    const [{ meta }] = sampleRows(inserts);
    expect(meta.stages).toEqual(putSpy.mock.calls.map(([key]) => prefixOf(key)));
    expect(meta.stages).toEqual(expect.arrayContaining(['pos', 'trip', 'accel']));
    expect(meta.stages).not.toContain('deviceContact');
    expect(meta).toMatchObject({
      lockState: 'lock',
      appState: 'bg',
      headKind: 'intermediate',
      etaMissing: true,
      hasAccel: true,
    });
  });

  it('lock 없는 trip: lockState=lockless', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockRandom(0);
    const kv = new InMemoryKV();
    await seedTrip(kv);
    const { db, inserts } = makeDb();
    const { ctx, pending } = makeCtx();
    await postPosition(makeEnv(kv, db), ctx, positionBody());
    await Promise.all(pending);
    const [{ meta }] = sampleRows(inserts);
    expect(meta.lockState).toBe('lockless');
    expect(meta.appState).toBeNull();
  });

  it('미당첨(random=0.99): D1 접근 0', async () => {
    mockRandom(0.99);
    const kv = new InMemoryKV();
    const { db, prepareCount } = makeDb();
    const { ctx, pending } = makeCtx();
    await postPosition(makeEnv(kv, db), ctx, positionBody());
    await Promise.all(pending);
    expect(prepareCount()).toBe(0);
  });

  it('일 상한(300) 도달: 행 0', async () => {
    mockRandom(0);
    const { db, inserts } = makeDb({ count: 300 });
    const { ctx, pending } = makeCtx();
    await postPosition(makeEnv(new InMemoryKV(), db), ctx, positionBody());
    await Promise.all(pending);
    expect(sampleRows(inserts)).toHaveLength(0);
  });

  it('거부: D1이 전부 throw해도 응답 200 + KV put 수 불변', async () => {
    const run = async (rand: number, throwAll: boolean) => {
      mockRandom(rand);
      const kv = new InMemoryKV();
      await seedTrip(kv, { lock: true });
      const putSpy = vi.spyOn(kv, 'put');
      const { db } = makeDb({ throwAll });
      const { ctx, pending } = makeCtx();
      const res = await postPosition(
        makeEnv(kv, db),
        ctx,
        positionBody({ appState: 'fg', accelSummary: ACCEL }),
      );
      await expect(Promise.all(pending)).resolves.toBeDefined();
      const body = await res.json();
      const puts = putSpy.mock.calls.map(([key]) => prefixOf(key));
      vi.restoreAllMocks();
      return { status: res.status, body, puts };
    };
    const baseline = await run(0.99, false);
    const failing = await run(0, true);
    expect(failing.status).toBe(200);
    expect(failing.body).toEqual(baseline.body);
    expect(failing.puts).toEqual(baseline.puts);
  });

  it('계측이 KV 접근(get/put/delete/list)을 추가하지 않는다 — 당첨 vs 미당첨 동일', async () => {
    const run = async (rand: number) => {
      mockRandom(rand);
      const kv = new InMemoryKV();
      await seedTrip(kv, { lock: true });
      const spies = {
        get: vi.spyOn(kv, 'get'),
        put: vi.spyOn(kv, 'put'),
        delete: vi.spyOn(kv, 'delete'),
        list: vi.spyOn(kv, 'list'),
      };
      const { db } = makeDb();
      const { ctx, pending } = makeCtx();
      await postPosition(makeEnv(kv, db), ctx, positionBody({ appState: 'fg', accelSummary: ACCEL }));
      await Promise.all(pending);
      const counts = Object.fromEntries(
        Object.entries(spies).map(([name, spy]) => [
          name,
          // #3168 지연 프로브(별도 샘플링)의 heartbeat get은 이 계측과 무관 — 제외.
          spy.mock.calls.map(([key]) => String(key)).filter((key) => key !== PROBE_KV_KEY),
        ]),
      );
      vi.restoreAllMocks();
      return counts;
    };
    expect(await run(0)).toEqual(await run(0.99));
  });
});
