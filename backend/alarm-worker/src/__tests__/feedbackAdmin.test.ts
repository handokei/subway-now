import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../index';
import {
  aggregateFeedbackStats,
  dayStartFromIsoDate,
  FEEDBACK_LIST_DEFAULT_LIMIT,
  FEEDBACK_LIST_MAX_LIMIT,
  feedbackStatsKey,
  getFeedbackStats,
  isoDateUtc,
  listAllFeedbackKeys,
  listFeedback,
  maybeRunDailyFeedbackStats,
  normalizeLimit,
  parseReceivedAtFromKey,
  storeFeedbackStats,
  toCsv,
} from '../feedbackAdmin';
import { storeFeedback } from '../feedback';
import type { Env } from '../types';
import { InMemoryKV } from './inMemoryKv';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    TRIPS: {} as Env['TRIPS'],
    APNS_HOST: 'h',
    APNS_HOST_SANDBOX: 'hs',
    SEOUL_API_HOST: 'h',
    SEOUL_API_KEY: 'k',
    APNS_KEY_ID: 'k',
    APNS_TEAM_ID: 't',
    APNS_PRIVATE_KEY: 'p',
    APNS_BUNDLE_ID: 'b',
    ...overrides,
  };
}

async function get(
  path: string,
  env: Env,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.fetch(
    new Request(`http://example.com${path}`, { method: 'GET', headers }),
    env,
  );
}

function authedEnv(kv: InMemoryKV): Env {
  return makeEnv({ ADMIN_TOKEN: 'secret', FEEDBACK: kv as unknown as KVNamespace });
}

async function authedGet(path: string, kv: InMemoryKV): Promise<Response> {
  return get(path, authedEnv(kv), { authorization: 'Bearer secret' });
}

/**
 * Shared auth/binding gate tests for any /admin/feedback* route.
 * Covers: missing ADMIN_TOKEN (503), mismatched token (401), missing FEEDBACK binding (503).
 * Extracted to avoid duplicated test blocks across describe groups (SonarCloud).
 */
function describeAdminAuthGate(path: string): void {
  it(`${path} returns 503 when ADMIN_TOKEN missing`, async () => {
    const res = await get(path, makeEnv());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'admin_unavailable' });
  });

  it(`${path} returns 401 when token mismatches`, async () => {
    const res = await get(path, makeEnv({ ADMIN_TOKEN: 'secret' }), {
      authorization: 'Bearer nope',
    });
    expect(res.status).toBe(401);
  });

  it(`${path} returns 503 when FEEDBACK binding missing`, async () => {
    const res = await get(path, makeEnv({ ADMIN_TOKEN: 'secret' }), {
      authorization: 'Bearer secret',
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'feedback_unavailable' });
  });
}

async function seed(kv: InMemoryKV, count: number, baseTs = 10_000): Promise<void> {
  for (let i = 0; i < count; i++) {
    await storeFeedback(
      kv as unknown as KVNamespace,
      {
        message: `msg-${i}`,
        context: { platform: i % 2 === 0 ? 'ios' : 'android', appVersion: `1.0.${i}` },
      },
      baseTs + i,
      `id${i.toString().padStart(4, '0')}`,
    );
  }
}

describe('normalizeLimit', () => {
  it('falls back to default for non-positive / non-finite', () => {
    expect(normalizeLimit(0)).toBe(FEEDBACK_LIST_DEFAULT_LIMIT);
    expect(normalizeLimit(-5)).toBe(FEEDBACK_LIST_DEFAULT_LIMIT);
    expect(normalizeLimit(Number.NaN)).toBe(FEEDBACK_LIST_DEFAULT_LIMIT);
    expect(normalizeLimit('hi')).toBe(FEEDBACK_LIST_DEFAULT_LIMIT);
    expect(normalizeLimit(undefined)).toBe(FEEDBACK_LIST_DEFAULT_LIMIT);
  });

  it('clamps to max and floors', () => {
    expect(normalizeLimit(10_000)).toBe(FEEDBACK_LIST_MAX_LIMIT);
    expect(normalizeLimit(3.9)).toBe(3);
  });

  it('returns value within range as-is (floored)', () => {
    expect(normalizeLimit(25)).toBe(25);
  });
});

describe('parseReceivedAtFromKey', () => {
  it('extracts epoch from canonical key', () => {
    expect(parseReceivedAtFromKey('feedback:1234:abcd')).toBe(1234);
  });

  it('returns NaN for malformed key', () => {
    expect(Number.isNaN(parseReceivedAtFromKey('no-colons'))).toBe(true);
    expect(Number.isNaN(parseReceivedAtFromKey('feedback:nope:id'))).toBe(true);
  });
});

describe('listFeedback', () => {
  let kv: InMemoryKV;
  beforeEach(() => {
    kv = new InMemoryKV();
  });

  it('returns empty result on empty KV', async () => {
    expect(await listFeedback(kv as unknown as KVNamespace)).toEqual({
      entries: [],
      nextBefore: null,
    });
  });

  it('returns entries sorted by receivedAt desc', async () => {
    await seed(kv, 3);
    const result = await listFeedback(kv as unknown as KVNamespace);
    expect(result.entries.map((e) => e.receivedAt)).toEqual([10_002, 10_001, 10_000]);
    expect(result.nextBefore).toBeNull();
  });

  it('applies limit and exposes nextBefore', async () => {
    await seed(kv, 5);
    const result = await listFeedback(kv as unknown as KVNamespace, { limit: 2 });
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].receivedAt).toBe(10_004);
    expect(result.entries[1].receivedAt).toBe(10_003);
    expect(result.nextBefore).toBe(10_003);
  });

  it('paginates with before cursor', async () => {
    await seed(kv, 5);
    const result = await listFeedback(kv as unknown as KVNamespace, {
      limit: 2,
      before: 10_003,
    });
    expect(result.entries.map((e) => e.receivedAt)).toEqual([10_002, 10_001]);
    expect(result.nextBefore).toBe(10_001);
  });

  it('nextBefore null when fewer than limit remain', async () => {
    await seed(kv, 3);
    const result = await listFeedback(kv as unknown as KVNamespace, { limit: 10 });
    expect(result.entries).toHaveLength(3);
    expect(result.nextBefore).toBeNull();
  });

  it('skips malformed keys and unparseable values', async () => {
    await seed(kv, 1, 5_000);
    // 손상된 JSON
    await kv.put('feedback:6000:bad1', '{not json');
    // 키 포맷 어긋남(receivedAt 미파싱)
    await kv.put('feedback:bad', JSON.stringify({ message: 'm', receivedAt: 7000 }));
    // record schema 어긋남 — message 누락
    await kv.put('feedback:6001:bad2', JSON.stringify({ receivedAt: 6001 }));
    // record schema 어긋남 — receivedAt 누락
    await kv.put('feedback:6002:bad3', JSON.stringify({ message: 'm' }));
    // record가 객체 아님
    await kv.put('feedback:6003:bad4', JSON.stringify('string'));

    const result = await listFeedback(kv as unknown as KVNamespace);
    expect(result.entries.map((e) => e.message)).toEqual(['msg-0']);
  });

  it('skips keys whose value disappeared mid-list', async () => {
    await seed(kv, 2, 5_000);
    // list에는 잡히지만 get에서 사라진 케이스 모사 — 직접 store에서 삭제
    kv.store.delete('feedback:5001:id0001');
    const result = await listFeedback(kv as unknown as KVNamespace);
    expect(result.entries.map((e) => e.receivedAt)).toEqual([5_000]);
  });

  it('omits context field when record has none', async () => {
    await storeFeedback(kv as unknown as KVNamespace, { message: 'noctx' }, 9_000, 'idx');
    const result = await listFeedback(kv as unknown as KVNamespace);
    expect(result.entries[0]).toEqual({
      key: 'feedback:9000:idx',
      receivedAt: 9_000,
      message: 'noctx',
    });
  });
});

describe('toCsv', () => {
  it('returns header-only row for empty entries', () => {
    expect(toCsv([])).toBe(
      '"key","receivedAt","message","appVersion","platform","locale","deviceModel"\n',
    );
  });

  it('serializes entries with ISO timestamp and context fields', () => {
    const csv = toCsv([
      {
        key: 'feedback:0:aa',
        receivedAt: 0,
        message: 'hello',
        context: {
          appVersion: '1.0.0',
          platform: 'ios',
          locale: 'ko-KR',
          deviceModel: 'iPhone15,2',
        },
      },
    ]);
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(
      '"feedback:0:aa","1970-01-01T00:00:00.000Z","hello","1.0.0","ios","ko-KR","iPhone15,2"',
    );
  });

  it('escapes quotes, commas, and newlines per RFC 4180', () => {
    const csv = toCsv([
      {
        key: 'feedback:1:bb',
        receivedAt: 1,
        message: 'has "quotes", commas,\nand newlines',
      },
    ]);
    expect(csv).toContain('"has ""quotes"", commas,\nand newlines"');
  });

  it('emits empty cells for missing context fields', () => {
    const csv = toCsv([
      {
        key: 'feedback:2:cc',
        receivedAt: 2,
        message: 'partial',
        context: { platform: 'android' },
      },
    ]);
    expect(csv).toContain('"partial","","android","",""');
  });
});

describe('GET /admin/feedback', () => {
  describeAdminAuthGate('/admin/feedback');

  it('returns 401 when Authorization header absent', async () => {
    const res = await get('/admin/feedback', makeEnv({ ADMIN_TOKEN: 'secret' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('returns 401 when scheme is not Bearer', async () => {
    const res = await get('/admin/feedback', makeEnv({ ADMIN_TOKEN: 'secret' }), {
      authorization: 'Basic secret',
    });
    expect(res.status).toBe(401);
  });

  it('returns entries with default limit and nextBefore=null on small dataset', async () => {
    const kv = new InMemoryKV();
    await seed(kv, 2, 100);
    const res = await authedGet('/admin/feedback', kv);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { entries: { receivedAt: number }[]; nextBefore: number | null };
    expect(json.entries.map((e) => e.receivedAt)).toEqual([101, 100]);
    expect(json.nextBefore).toBeNull();
  });

  it('honors limit and before query params', async () => {
    const kv = new InMemoryKV();
    await seed(kv, 5, 200);
    const res = await authedGet('/admin/feedback?limit=2&before=204', kv);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { entries: { receivedAt: number }[]; nextBefore: number | null };
    expect(json.entries.map((e) => e.receivedAt)).toEqual([203, 202]);
    expect(json.nextBefore).toBe(202);
  });

  it('ignores non-numeric query params (falls back to defaults)', async () => {
    const kv = new InMemoryKV();
    await seed(kv, 2, 300);
    const res = await authedGet('/admin/feedback?limit=abc&before=xyz', kv);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { entries: unknown[] };
    expect(json.entries).toHaveLength(2);
  });
});

describe('GET /admin/feedback/export.csv', () => {
  it('returns 401 when token mismatches', async () => {
    const res = await get('/admin/feedback/export.csv', makeEnv({ ADMIN_TOKEN: 'secret' }), {
      authorization: 'Bearer nope',
    });
    expect(res.status).toBe(401);
  });

  it('returns 503 when FEEDBACK binding missing', async () => {
    const res = await get(
      '/admin/feedback/export.csv',
      makeEnv({ ADMIN_TOKEN: 'secret' }),
      { authorization: 'Bearer secret' },
    );
    expect(res.status).toBe(503);
  });

  it('returns 503 when ADMIN_TOKEN missing', async () => {
    const res = await get('/admin/feedback/export.csv', makeEnv());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'admin_unavailable' });
  });

  it('returns header-only CSV when no entries', async () => {
    const kv = new InMemoryKV();
    const res = await authedGet('/admin/feedback/export.csv', kv);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toContain('feedback.csv');
    const body = await res.text();
    expect(body.split('\n')[0]).toContain('"message"');
    expect(body.trim().split('\n')).toHaveLength(1);
  });

  it('serializes entries with header + rows', async () => {
    const kv = new InMemoryKV();
    await seed(kv, 2, 500);
    const res = await authedGet('/admin/feedback/export.csv?limit=10', kv);
    expect(res.status).toBe(200);
    const body = await res.text();
    const lines = body.trim().split('\n');
    expect(lines).toHaveLength(3); // header + 2 entries
    expect(lines[1]).toContain('"msg-1"'); // newest first
    expect(lines[2]).toContain('"msg-0"');
  });
});

describe('listAllFeedbackKeys', () => {
  it('joins paginated KV list pages via cursor (#1080 follow-up)', async () => {
    const kv = new InMemoryKV();
    kv.pageSize = 2;
    await seed(kv, 5, 1_000);
    const keys = await listAllFeedbackKeys(kv as unknown as KVNamespace);
    expect(keys).toHaveLength(5);
  });

  it('listFeedback now returns newest entries even past first KV page', async () => {
    const kv = new InMemoryKV();
    kv.pageSize = 2;
    // 5 entries — pre-fix would only see the lex-asc first 2 keys (oldest), losing newest 3.
    await seed(kv, 5, 1_000);
    const result = await listFeedback(kv as unknown as KVNamespace, { limit: 3 });
    expect(result.entries.map((e) => e.receivedAt)).toEqual([1_004, 1_003, 1_002]);
  });
});

describe('isoDateUtc / dayStartFromIsoDate', () => {
  it('round-trips a UTC midnight epoch', () => {
    const epoch = Date.UTC(2026, 5, 9);
    expect(isoDateUtc(epoch)).toBe('2026-06-09');
    expect(dayStartFromIsoDate('2026-06-09')).toBe(epoch);
  });

  it('rejects malformed dates with NaN', () => {
    expect(Number.isNaN(dayStartFromIsoDate('nope'))).toBe(true);
    expect(Number.isNaN(dayStartFromIsoDate('2026-13-40'))).toBe(true);
    expect(Number.isNaN(dayStartFromIsoDate('2026-6-9'))).toBe(true);
  });
});

describe('aggregateFeedbackStats', () => {
  it('counts entries in [dayStart, dayEnd) by platform/appVersion/locale buckets', async () => {
    const kv = new InMemoryKV();
    const dayStart = Date.UTC(2026, 5, 9);
    // 3 in-range
    await storeFeedback(
      kv as unknown as KVNamespace,
      { message: 'a', context: { platform: 'ios', appVersion: '1.0.0', locale: 'ko-KR' } },
      dayStart + 1_000,
      'a1',
    );
    await storeFeedback(
      kv as unknown as KVNamespace,
      { message: 'b', context: { platform: 'android', appVersion: '1.0.0', locale: 'en-US' } },
      dayStart + 2_000,
      'a2',
    );
    await storeFeedback(
      kv as unknown as KVNamespace,
      { message: 'c' },
      dayStart + 3_000,
      'a3',
    );
    // out-of-range (next day)
    await storeFeedback(
      kv as unknown as KVNamespace,
      { message: 'd', context: { platform: 'ios' } },
      dayStart + 24 * 60 * 60 * 1000,
      'a4',
    );
    // out-of-range (previous day)
    await storeFeedback(
      kv as unknown as KVNamespace,
      { message: 'e', context: { platform: 'ios' } },
      dayStart - 1,
      'a5',
    );

    const stats = await aggregateFeedbackStats(kv as unknown as KVNamespace, dayStart);
    expect(stats.date).toBe('2026-06-09');
    expect(stats.total).toBe(3);
    expect(stats.byPlatform).toEqual({ ios: 1, android: 1, unknown: 1 });
    expect(stats.byAppVersion).toEqual({ '1.0.0': 2, unknown: 1 });
    expect(stats.byLocale).toEqual({ ko: 1, en: 1, unknown: 1 });
  });

  it('skips entries whose stored value disappeared mid-aggregate', async () => {
    const kv = new InMemoryKV();
    const dayStart = Date.UTC(2026, 5, 9);
    await storeFeedback(kv as unknown as KVNamespace, { message: 'keep' }, dayStart + 1, 'k1');
    await storeFeedback(kv as unknown as KVNamespace, { message: 'gone' }, dayStart + 2, 'k2');
    kv.store.delete('feedback:' + (dayStart + 2) + ':k2');
    const stats = await aggregateFeedbackStats(kv as unknown as KVNamespace, dayStart);
    expect(stats.total).toBe(1); // count is from key enumeration
    expect(stats.byPlatform).toEqual({ unknown: 1 });
  });

  it('skips entries with malformed JSON', async () => {
    const kv = new InMemoryKV();
    const dayStart = Date.UTC(2026, 5, 9);
    await kv.put(`feedback:${dayStart + 1}:bad`, '{not json');
    const stats = await aggregateFeedbackStats(kv as unknown as KVNamespace, dayStart);
    expect(stats.total).toBe(1); // counted by key
    expect(stats.byPlatform).toEqual({}); // but no bucket bumped
  });

  it('treats bare locale without dash as its own bucket', async () => {
    const kv = new InMemoryKV();
    const dayStart = Date.UTC(2026, 5, 9);
    await storeFeedback(
      kv as unknown as KVNamespace,
      { message: 'x', context: { locale: 'ja' } },
      dayStart + 1,
      'j1',
    );
    const stats = await aggregateFeedbackStats(kv as unknown as KVNamespace, dayStart);
    expect(stats.byLocale).toEqual({ ja: 1 });
  });
});

describe('storeFeedbackStats / getFeedbackStats', () => {
  it('round-trips stats via stats:YYYY-MM-DD key', async () => {
    const kv = new InMemoryKV();
    const stats = {
      date: '2026-06-09',
      total: 2,
      byPlatform: { ios: 2 },
      byAppVersion: { '1.0.0': 2 },
      byLocale: { ko: 2 },
    };
    await storeFeedbackStats(kv as unknown as KVNamespace, stats);
    expect(await getFeedbackStats(kv as unknown as KVNamespace, '2026-06-09')).toEqual(stats);
  });

  it('returns null when stats key missing', async () => {
    const kv = new InMemoryKV();
    expect(await getFeedbackStats(kv as unknown as KVNamespace, '2026-06-09')).toBeNull();
  });

  it('returns null when stored value is malformed JSON', async () => {
    const kv = new InMemoryKV();
    await kv.put(feedbackStatsKey('2026-06-09'), '{broken');
    expect(await getFeedbackStats(kv as unknown as KVNamespace, '2026-06-09')).toBeNull();
  });
});

describe('maybeRunDailyFeedbackStats', () => {
  const targetDay = Date.UTC(2026, 5, 9);
  const cronTime = Date.UTC(2026, 5, 10, 0, 5); // 00:05 UTC the next day

  it('skips when current UTC hour is not 0', async () => {
    const kv = new InMemoryKV();
    const result = await maybeRunDailyFeedbackStats(
      kv as unknown as KVNamespace,
      Date.UTC(2026, 5, 10, 1, 5),
    );
    expect(result.ran).toBe(false);
  });

  it('skips when current UTC minute is not 5', async () => {
    const kv = new InMemoryKV();
    const result = await maybeRunDailyFeedbackStats(
      kv as unknown as KVNamespace,
      Date.UTC(2026, 5, 10, 0, 6),
    );
    expect(result.ran).toBe(false);
  });

  it('runs at 00:05 UTC and aggregates the previous day', async () => {
    const kv = new InMemoryKV();
    await storeFeedback(
      kv as unknown as KVNamespace,
      { message: 'x', context: { platform: 'ios' } },
      targetDay + 1_000,
      'r1',
    );
    const result = await maybeRunDailyFeedbackStats(kv as unknown as KVNamespace, cronTime);
    expect(result).toEqual({ ran: true, date: '2026-06-09' });
    const stored = await getFeedbackStats(kv as unknown as KVNamespace, '2026-06-09');
    expect(stored?.total).toBe(1);
    expect(stored?.byPlatform).toEqual({ ios: 1 });
  });

  it('is idempotent — second run at same window does not re-aggregate', async () => {
    const kv = new InMemoryKV();
    await storeFeedbackStats(kv as unknown as KVNamespace, {
      date: '2026-06-09',
      total: 99,
      byPlatform: { ios: 99 },
      byAppVersion: {},
      byLocale: {},
    });
    const result = await maybeRunDailyFeedbackStats(kv as unknown as KVNamespace, cronTime);
    expect(result).toEqual({ ran: false, date: '2026-06-09' });
    const stored = await getFeedbackStats(kv as unknown as KVNamespace, '2026-06-09');
    expect(stored?.total).toBe(99); // preserved
  });
});

describe('GET /admin/feedback/stats', () => {
  describeAdminAuthGate('/admin/feedback/stats');

  it('returns 400 for malformed date', async () => {
    const kv = new InMemoryKV();
    const res = await authedGet('/admin/feedback/stats?date=not-a-date', kv);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_date' });
  });

  it('returns 404 when stats for that date not yet stored', async () => {
    const kv = new InMemoryKV();
    const res = await authedGet('/admin/feedback/stats?date=2026-06-09', kv);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'stats_not_found' });
  });

  it('returns stored stats for the requested date', async () => {
    const kv = new InMemoryKV();
    await storeFeedbackStats(kv as unknown as KVNamespace, {
      date: '2026-06-09',
      total: 7,
      byPlatform: { ios: 5, android: 2 },
      byAppVersion: { '1.0.0': 7 },
      byLocale: { ko: 7 },
    });
    const res = await authedGet('/admin/feedback/stats?date=2026-06-09', kv);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { total: number };
    expect(json.total).toBe(7);
  });

  it('defaults date= to yesterday UTC when query omitted', async () => {
    const kv = new InMemoryKV();
    const yesterday = isoDateUtc(Date.now() - 24 * 60 * 60 * 1000);
    await storeFeedbackStats(kv as unknown as KVNamespace, {
      date: yesterday,
      total: 3,
      byPlatform: {},
      byAppVersion: {},
      byLocale: {},
    });
    const res = await authedGet('/admin/feedback/stats', kv);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { date: string; total: number };
    expect(json.date).toBe(yesterday);
    expect(json.total).toBe(3);
  });
});
