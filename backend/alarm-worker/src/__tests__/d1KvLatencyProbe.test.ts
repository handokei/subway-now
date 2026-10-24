/**
 * #3168 — D1 vs KV 지연 실측 프로브 (관측 전용).
 * 스펙: cron 시간당 1회 / HTTP 1-in-20 + 일 100건 cap / KV put 0 / 프로브 실패는 흡수.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  PROBE_HTTP_DAILY_CAP,
  PROBE_HTTP_SAMPLE_RATE,
  fetchCronColo,
  isCronProbeTick,
  recordLatencyProbe,
  runHttpProbe,
  scheduleCronProbe,
} from '../d1KvLatencyProbe';

interface Calls {
  sql: string[];
  binds: unknown[][];
}

/** SQL 텍스트로 분기하는 mock D1. count = 오늘 http 행 수(cap 판정용). */
function makeDb(opts: { count?: number; throwOn?: 'prepare' | 'insert' | 'select' } = {}) {
  const calls: Calls = { sql: [], binds: [] };
  const prepare = vi.fn((sql: string) => {
    if (opts.throwOn === 'prepare') throw new Error('d1 down');
    const index = calls.sql.length;
    calls.sql.push(sql);
    calls.binds.push([]);
    const stmt = {
      bind: (...args: unknown[]) => {
        calls.binds[index] = args;
        return stmt;
      },
      first: async () => {
        if (opts.throwOn === 'select') throw new Error('d1 select down');
        return sql.includes('COUNT') ? { n: opts.count ?? 0 } : { id: 1 };
      },
      run: async () => {
        if (opts.throwOn === 'insert') throw new Error('d1 write down');
        return { success: true, meta: { last_row_id: 7 } };
      },
    };
    return stmt;
  });
  return { db: { prepare } as unknown as D1Database, calls, prepare };
}

function makeKv(getImpl: () => Promise<string | null> = async () => 'x') {
  return { get: vi.fn(getImpl), put: vi.fn(), delete: vi.fn(), list: vi.fn() };
}

const HOUR0 = Date.UTC(2026, 9, 22, 5, 0, 0);

describe('isCronProbeTick — 시간당 1회', () => {
  it('UTC 분==0 tick만 true', () => {
    expect(isCronProbeTick(HOUR0)).toBe(true);
    expect(isCronProbeTick(HOUR0 + 60_000)).toBe(false);
    expect(isCronProbeTick(HOUR0 + 59 * 60_000)).toBe(false);
  });
  it('60개 연속 tick 중 정확히 1개', () => {
    const fires = Array.from({ length: 60 }, (_, i) => isCronProbeTick(HOUR0 + i * 60_000));
    expect(fires.filter(Boolean)).toHaveLength(1);
  });
});

describe('recordLatencyProbe', () => {
  it('D1 read 1회 + KV get(옵션 없음) 1회 + 행 INSERT, KV put 0', async () => {
    const { db, calls } = makeDb();
    const kv = makeKv();
    await recordLatencyProbe({ DB: db, TRIPS: kv as unknown as KVNamespace }, 'http', 'ICN');
    expect(kv.get).toHaveBeenCalledTimes(1);
    expect(kv.get.mock.calls[0]).toHaveLength(1); // cacheTtl 옵션 없음(cold-ish)
    expect(kv.put).not.toHaveBeenCalled();
    expect(kv.delete).not.toHaveBeenCalled();
    const insert = calls.sql.findIndex((s) => /INSERT INTO latency_probe/.test(s));
    expect(insert).toBeGreaterThanOrEqual(0);
    const row = calls.binds[insert];
    expect(row[1]).toBe('http');
    expect(row[2]).toBe('ICN');
    expect(typeof row[3]).toBe('number'); // d1_read_ms
    expect(typeof row[4]).toBe('number'); // kv_get_ms
  });

  it('D1 write 시간은 INSERT 후 같은 행 UPDATE로 채운다', async () => {
    const { db, calls } = makeDb();
    await recordLatencyProbe({ DB: db, TRIPS: makeKv() as unknown as KVNamespace }, 'cron', 'NRT');
    const update = calls.sql.findIndex((s) => /UPDATE latency_probe SET d1_write_ms/.test(s));
    expect(update).toBeGreaterThanOrEqual(0);
    expect(calls.binds[update][1]).toBe(7); // last_row_id
  });

  it('D1 throw — 흡수(reject 없음), KV put 0', async () => {
    for (const throwOn of ['prepare', 'insert', 'select'] as const) {
      const { db } = makeDb({ throwOn });
      const kv = makeKv();
      await expect(
        recordLatencyProbe({ DB: db, TRIPS: kv as unknown as KVNamespace }, 'cron', 'X'),
      ).resolves.toBeUndefined();
      expect(kv.put).not.toHaveBeenCalled();
    }
  });

  it('KV get throw — 흡수', async () => {
    const { db } = makeDb();
    const kv = makeKv(async () => {
      throw new Error('kv down');
    });
    await expect(
      recordLatencyProbe({ DB: db, TRIPS: kv as unknown as KVNamespace }, 'cron', 'X'),
    ).resolves.toBeUndefined();
  });

  it('DB 미바인딩 — no-op', async () => {
    const kv = makeKv();
    await recordLatencyProbe({ TRIPS: kv as unknown as KVNamespace }, 'cron', 'X');
    expect(kv.get).not.toHaveBeenCalled();
  });
});

describe('runHttpProbe — 샘플링 + 일 cap', () => {
  const NOW = Date.UTC(2026, 9, 22, 3, 0, 0);

  it('샘플링 미당첨(random >= rate) — D1/KV 접근 0', async () => {
    const { db, prepare } = makeDb();
    const kv = makeKv();
    await runHttpProbe(
      { DB: db, TRIPS: kv as unknown as KVNamespace },
      'ICN',
      NOW,
      PROBE_HTTP_SAMPLE_RATE,
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(kv.get).not.toHaveBeenCalled();
  });

  it('당첨 + 오늘 http 행 < cap — 1행 적재', async () => {
    const { db, calls } = makeDb({ count: PROBE_HTTP_DAILY_CAP - 1 });
    await runHttpProbe({ DB: db, TRIPS: makeKv() as unknown as KVNamespace }, 'ICN', NOW, 0);
    expect(calls.sql.filter((s) => /INSERT INTO latency_probe/.test(s))).toHaveLength(1);
  });

  it('당첨 + 오늘 http 행 >= cap — 적재 0, KV 접근 0', async () => {
    const { db, calls } = makeDb({ count: PROBE_HTTP_DAILY_CAP });
    const kv = makeKv();
    await runHttpProbe({ DB: db, TRIPS: kv as unknown as KVNamespace }, 'ICN', NOW, 0);
    expect(calls.sql.some((s) => /COUNT/.test(s))).toBe(true);
    expect(calls.sql.some((s) => /INSERT/.test(s))).toBe(false);
    expect(kv.get).not.toHaveBeenCalled();
  });

  it('cap 카운트는 UTC 일 시작 이후 + source=http만', async () => {
    const { db, calls } = makeDb();
    await runHttpProbe({ DB: db, TRIPS: makeKv() as unknown as KVNamespace }, 'ICN', NOW, 0);
    const i = calls.sql.findIndex((s) => /COUNT/.test(s));
    expect(calls.sql[i]).toMatch(/source\s*=\s*'http'/);
    expect(calls.binds[i]).toContain(Date.UTC(2026, 9, 22));
  });

  it('kill switch off — 아무것도 안 한다', async () => {
    const { db, prepare } = makeDb();
    await runHttpProbe({ DB: db, TRIPS: makeKv() as unknown as KVNamespace }, 'ICN', NOW, 0, false);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('cap 카운트 SELECT가 throw해도 흡수', async () => {
    const { db } = makeDb({ throwOn: 'select' });
    await expect(
      runHttpProbe({ DB: db, TRIPS: makeKv() as unknown as KVNamespace }, 'ICN', NOW, 0),
    ).resolves.toBeUndefined();
  });
});

describe('fetchCronColo', () => {
  it('cdn-cgi/trace의 colo= 파싱', async () => {
    const f = vi.fn(async () => new Response('fl=1\ncolo=NRT\nip=1.1.1.1\n'));
    expect(await fetchCronColo(f as unknown as typeof fetch)).toBe('NRT');
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]).toEqual(['https://www.cloudflare.com/cdn-cgi/trace']);
  });
  it('fetch 실패/colo 없음 — "unknown", reject 없음', async () => {
    const bad = vi.fn(async () => {
      throw new Error('net');
    });
    expect(await fetchCronColo(bad as unknown as typeof fetch)).toBe('unknown');
    const noColo = vi.fn(async () => new Response('fl=1\n'));
    expect(await fetchCronColo(noColo as unknown as typeof fetch)).toBe('unknown');
  });
});

describe('scheduleCronProbe — waitUntil 스케줄', () => {
  function makeCtx() {
    const pending: Promise<unknown>[] = [];
    return {
      ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p) } as unknown as ExecutionContext,
      pending,
    };
  }
  it('정시 tick만 waitUntil 1건', () => {
    const { ctx, pending } = makeCtx();
    const env = { DB: makeDb().db, TRIPS: makeKv() as unknown as KVNamespace };
    scheduleCronProbe(env, ctx, HOUR0 + 60_000);
    expect(pending).toHaveLength(0);
    scheduleCronProbe(env, ctx, HOUR0);
    expect(pending).toHaveLength(1);
  });
  it('kill switch off — 정시여도 스케줄 0', () => {
    const { ctx, pending } = makeCtx();
    scheduleCronProbe(
      { DB: makeDb().db, TRIPS: makeKv() as unknown as KVNamespace },
      ctx,
      HOUR0,
      false,
    );
    expect(pending).toHaveLength(0);
  });
});
