/**
 * #3168 — 프로브가 실제 진입점(handler.scheduled / POST /position)에 배선됐는지.
 * 프로브 실패가 응답/cron에 영향 0인지, KV put을 프로브가 추가하지 않는지.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../types';
import { InMemoryKV } from './inMemoryKv';

const runScheduledMock = vi.fn();
vi.mock('../scheduled', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scheduled')>();
  return { ...actual, runScheduled: (...a: unknown[]) => runScheduledMock(...a) };
});

const { handler, app } = await import('../index');

const HOUR0 = Date.UTC(2026, 9, 22, 5, 0, 0);

function makeProbeDb(opts: { throwAll?: boolean; count?: number } = {}) {
  const sql: string[] = [];
  const prepare = vi.fn((s: string) => {
    if (opts.throwAll) throw new Error('d1 down');
    sql.push(s);
    const stmt = {
      bind: () => stmt,
      first: async () => (s.includes('COUNT') ? { n: opts.count ?? 0 } : { id: 1 }),
      run: async () => ({ success: true, meta: { last_row_id: 1 } }),
    };
    return stmt;
  });
  return { db: { prepare } as unknown as D1Database, sql };
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

const controller = (t: number) =>
  ({ scheduledTime: t, cron: '*/1 * * * *', noRetry: () => {} }) as unknown as ScheduledController;

const probeInserts = (sql: string[]) =>
  sql.filter((s) => /INSERT INTO latency_probe/.test(s)).length;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('handler.scheduled — cron 프로브 배선', () => {
  function setup(db?: D1Database) {
    runScheduledMock.mockReset();
    runScheduledMock.mockResolvedValue({
      scanned: 0,
      pendingActivityPossible: false,
      polled: [],
      midCycleSnapshot: [],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('colo=NRT\n')),
    );
    const kv = new InMemoryKV();
    const putSpy = vi.spyOn(kv, 'put');
    return { kv, putSpy, env: makeEnv(kv, db) };
  }

  it('정시 tick — 프로브 1행, 비정시 tick — 0행', async () => {
    const { db, sql } = makeProbeDb();
    const { env } = setup(db);
    const { ctx, pending } = makeCtx();
    await handler.scheduled(controller(HOUR0 + 60_000), env, ctx);
    await Promise.all(pending);
    expect(probeInserts(sql)).toBe(0);
    await handler.scheduled(controller(HOUR0), env, ctx);
    await Promise.all(pending);
    expect(probeInserts(sql)).toBe(1);
  });

  it('프로브가 KV put을 추가하지 않는다(정시 vs 비정시 put 횟수 동일)', async () => {
    const a = setup(makeProbeDb().db);
    const ca = makeCtx();
    await handler.scheduled(controller(HOUR0 + 60_000), a.env, ca.ctx);
    await Promise.all(ca.pending);
    const b = setup(makeProbeDb().db);
    const cb = makeCtx();
    await handler.scheduled(controller(HOUR0), b.env, cb.ctx);
    await Promise.all(cb.pending);
    expect(b.putSpy.mock.calls.length).toBe(a.putSpy.mock.calls.length);
  });

  it('D1 전부 throw — cron 정상 종료', async () => {
    const { db } = makeProbeDb({ throwAll: true });
    const { env } = setup(db);
    const { ctx, pending } = makeCtx();
    await expect(handler.scheduled(controller(HOUR0), env, ctx)).resolves.toBeUndefined();
    await expect(Promise.all(pending)).resolves.toBeDefined();
    expect(runScheduledMock).toHaveBeenCalledTimes(1);
  });
});

describe('POST /position — HTTP 프로브 배선', () => {
  const body = { token: 'tok-probe', lat: 1, lng: 2, accuracy: 5, ts: 1234, motion: 'walking' };
  async function postPosition(env: Env, ctx: ExecutionContext, colo = 'ICN') {
    const req = new Request('http://example.com/position', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    Object.defineProperty(req, 'cf', { value: { colo } });
    return app.fetch(req, env, ctx);
  }

  it('당첨(random=0) — 응답 200 + waitUntil로 프로브 1행', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { db, sql } = makeProbeDb();
    const env = makeEnv(new InMemoryKV(), db);
    const { ctx, pending } = makeCtx();
    const res = await postPosition(env, ctx);
    expect(res.status).toBe(200);
    await Promise.all(pending);
    expect(probeInserts(sql)).toBe(1);
  });

  it('미당첨(random=0.99) — 프로브 0행', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const { db, sql } = makeProbeDb();
    const env = makeEnv(new InMemoryKV(), db);
    const { ctx, pending } = makeCtx();
    await postPosition(env, ctx);
    await Promise.all(pending);
    expect(sql).toEqual([]);
  });

  it('cap 도달 — 프로브 0행', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { db, sql } = makeProbeDb({ count: 100 });
    const env = makeEnv(new InMemoryKV(), db);
    const { ctx, pending } = makeCtx();
    await postPosition(env, ctx);
    await Promise.all(pending);
    expect(probeInserts(sql)).toBe(0);
  });

  it('D1 throw — 응답 200 불변', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { db } = makeProbeDb({ throwAll: true });
    const env = makeEnv(new InMemoryKV(), db);
    const { ctx, pending } = makeCtx();
    const res = await postPosition(env, ctx);
    expect(res.status).toBe(200);
    await expect(Promise.all(pending)).resolves.toBeDefined();
  });

  it('프로브가 KV put을 추가하지 않는다(당첨 vs 미당첨 put 횟수 동일)', async () => {
    const run = async (rand: number) => {
      vi.spyOn(Math, 'random').mockReturnValue(rand);
      const kv = new InMemoryKV();
      const put = vi.spyOn(kv, 'put');
      const env = makeEnv(kv, makeProbeDb().db);
      const { ctx, pending } = makeCtx();
      await postPosition(env, ctx);
      await Promise.all(pending);
      const n = put.mock.calls.length;
      vi.restoreAllMocks();
      return n;
    };
    expect(await run(0)).toBe(await run(0.99));
  });
});
