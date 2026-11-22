import { describe, expect, it, vi } from 'vitest';
import { app } from '../index';
import {
  FEEDBACK_DIAGNOSTICS_MAX_BYTES,
  feedbackDiagKey,
  scrubDiagnostics,
  truncateUtf8,
  validateFeedback,
} from '../feedback';
import { listFeedback } from '../feedbackAdmin';
import { listTripEventsByKeyWindow, TRIP_EVENT_RETENTION_MS } from '../tripEventLog';
import {
  COORDINATE_REDACTION_PATTERNS,
  REDACTED_COORDINATE,
  REDACTED_TOKEN,
  TOKEN_HEX_PATTERN,
} from '../../../../src/shared/constants/feedbackRedaction';
import type { Env } from '../types';
import { InMemoryKV } from './inMemoryKv';

// 실기기 덤프 형식 fixture (DebugModal.tsx formatRawSignalLine / GPS 섹션 / Backend Calls).
const HEX64 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const REAL_COORD_LINES = [
  'pos=37.54321,127.05432',
  'lat=37.5445123, lng=127.0567, speed=0 m/s, accuracy=12 m',
  'near 37.5445,127.0567 here',
];
// 실덤프 오탐 후보 — 치환되면 안 된다.
const FALSE_POSITIVE_LINES = [
  'arc=33.53',
  'arc=4636.57',
  'acc=339.39',
  'age=33.375',
  'arc=1128.61',
  'distM=37',
];
const TOKEN_LINES = [
  `GET https://h/trips/${HEX64}/status`,
  `POST https://h/live-activity/${HEX64}`,
  `alarm-${HEX64}-4-1`,
];
const NOW = 1_800_000_000_000;
const TRIP_KEY = 'deadbeef';
const STATION_ID = '1-001';

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

async function post(body: unknown, env: Env): Promise<Response> {
  return app.fetch(
    new Request('http://example.com/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  );
}

describe('공용 스크럽 상수', () => {
  it('치환 토큰 값', () => {
    expect(REDACTED_COORDINATE).toBe('[redacted]');
    expect(REDACTED_TOKEN).toBe('[token]');
    expect(COORDINATE_REDACTION_PATTERNS.length).toBeGreaterThan(0);
    expect('a'.repeat(40).match(TOKEN_HEX_PATTERN)).not.toBeNull();
    expect('a'.repeat(39).match(TOKEN_HEX_PATTERN)).toBeNull();
  });
});

describe('scrubDiagnostics', () => {
  it('실좌표 형식을 [redacted]로 치환하고 건수를 센다', () => {
    const { text, redactedCoordinates } = scrubDiagnostics(REAL_COORD_LINES.join('\n'));
    expect(text).not.toMatch(/37\.5/);
    expect(text).not.toMatch(/127\.0/);
    expect(text).toContain('pos=[redacted]');
    expect(text).toContain('speed=0 m/s');
    expect(redactedCoordinates).toBeGreaterThanOrEqual(4);
  });

  it('문맥 없는 수치(오탐 fixture)는 치환하지 않는다 — 문맥 조건 revert-red', () => {
    const input = FALSE_POSITIVE_LINES.join('\n');
    const { text, redactedCoordinates } = scrubDiagnostics(input);
    expect(text).toBe(input);
    expect(redactedCoordinates).toBe(0);
  });

  it('앞자리 숫자가 붙은 값은 쌍 문맥이어도 치환하지 않는다(단어 경계)', () => {
    const input = 'v 1237.5445,127.0567 / 137.5445,127.0567';
    expect(scrubDiagnostics(input).redactedCoordinates).toBe(0);
  });

  it('40자 이상 hex를 [token]으로 치환, 39자는 유지', () => {
    const { text, redactedTokens } = scrubDiagnostics(
      `${TOKEN_LINES.join('\n')}\nshort=${'a'.repeat(39)}`,
    );
    expect(text).not.toMatch(/[0-9a-f]{40,}/i);
    expect(text).toContain('/trips/[token]/status');
    expect(text).toContain(`short=${'a'.repeat(39)}`);
    expect(redactedTokens).toBe(3);
  });
});

describe('truncateUtf8', () => {
  it('한도 이하는 그대로', () => {
    expect(truncateUtf8('abc', 10)).toEqual({ text: 'abc', truncated: false });
  });
  it('초과 시 앞부분 보존 + 바이트 상한 이하(멀티바이트 경계 안전)', () => {
    const r = truncateUtf8('가나다라마', 7);
    expect(r.truncated).toBe(true);
    expect(new TextEncoder().encode(r.text).length).toBeLessThanOrEqual(7);
    expect(r.text.startsWith('가나')).toBe(true);
    expect(r.text).not.toContain('�');
  });
});

describe('validateFeedback report/diagnostics (하위호환)', () => {
  it('기존 message+context 입력은 이전과 동일한 shape', () => {
    expect(validateFeedback({ message: ' hi ', context: { platform: 'ios' } })).toEqual({
      message: 'hi',
      context: { platform: 'ios' },
    });
  });
  it('유효 report 보존', () => {
    const r = validateFeedback({
      message: 'm',
      report: { category: 'alarm-late', stationId: STATION_ID, tripKey: TRIP_KEY, occurredAt: NOW },
      diagnostics: 'dump',
    });
    expect(r?.report).toEqual({
      category: 'alarm-late',
      stationId: STATION_ID,
      tripKey: TRIP_KEY,
      occurredAt: NOW,
    });
    expect(r?.diagnostics).toBe('dump');
  });
  it('무효 필드는 drop(요청은 유지)', () => {
    const r = validateFeedback({
      message: 'm',
      report: { category: 'nope', stationId: 'no-such-station', tripKey: 'XYZ', occurredAt: 'x' },
      diagnostics: 123,
    });
    expect(r).toEqual({ message: 'm' });
  });
  it('빈 message는 report가 있어도 null(400 계약 유지)', () => {
    expect(validateFeedback({ message: '  ', report: { category: 'other' } })).toBeNull();
  });
});

describe('POST /feedback 진단 첨부', () => {
  function setup(): { kv: InMemoryKV; env: Env } {
    const kv = new InMemoryKV();
    return { kv, env: makeEnv({ FEEDBACK: kv as unknown as KVNamespace }) };
  }

  it('기존 message+context 요청은 201, diag 키·메타 없음', async () => {
    const { kv, env } = setup();
    const res = await post({ message: 'm', context: { platform: 'ios' } }, env);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { key: string; diagnosticsStored?: boolean };
    expect(body.diagnosticsStored).toBeUndefined();
    expect([...kv.store.keys()].some((k) => k.startsWith('feedback-diag:'))).toBe(false);
    const rec = JSON.parse(kv.store.get(body.key)!.value) as Record<string, unknown>;
    expect(rec.diagnostics).toBeUndefined();
  });

  it('칩+report 저장 / diagnostics는 별도 키 + 스크럽 + entry에는 메타만', async () => {
    const { kv, env } = setup();
    const dump = [...REAL_COORD_LINES, ...FALSE_POSITIVE_LINES, ...TOKEN_LINES].join('\n');
    const res = await post(
      {
        message: '[알람 안 옴] 성수',
        report: { category: 'alarm-missing', stationId: STATION_ID, tripKey: TRIP_KEY, occurredAt: NOW },
        diagnostics: dump,
      },
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { key: string; diagnosticsStored: boolean };
    expect(body.diagnosticsStored).toBe(true);
    const entryRaw = kv.store.get(body.key)!.value;
    const entry = JSON.parse(entryRaw) as Record<string, any>;
    expect(entry.report.category).toBe('alarm-missing');
    expect(entry.diagnostics.truncated).toBe(false);
    expect(entry.diagnostics.redactedCoordinates).toBeGreaterThanOrEqual(4);
    expect(entry.diagnostics.redactedTokens).toBe(3);
    expect(entryRaw).not.toContain('arc=33.53'); // dump 본문은 entry에 없다
    const diagEntry = kv.store.get(feedbackDiagKey(body.key))!;
    expect(diagEntry.value).not.toMatch(/3[3-9]\.\d{2,},\s*1[23]\d\./);
    expect(diagEntry.value).not.toMatch(/(lat|lng|pos)=3[3-9]\.|(lat|lng)=127/);
    expect(diagEntry.value).not.toMatch(/[0-9a-f]{40,}/i);
    for (const fp of FALSE_POSITIVE_LINES) expect(diagEntry.value).toContain(fp);
    expect(diagEntry.expiresAt).toBeGreaterThan(Date.now() + 29 * 86_400_000);
  });

  it('600KB diag → 201 + truncated, 저장본 ≤ 512KB', async () => {
    const { kv, env } = setup();
    const res = await post({ message: 'm', diagnostics: 'x'.repeat(600 * 1024) }, env);
    expect(res.status).toBe(201);
    const { key } = (await res.json()) as { key: string };
    const entry = JSON.parse(kv.store.get(key)!.value) as Record<string, any>;
    expect(entry.diagnostics.truncated).toBe(true);
    const stored = kv.store.get(feedbackDiagKey(key))!.value;
    expect(new TextEncoder().encode(stored).length).toBeLessThanOrEqual(
      FEEDBACK_DIAGNOSTICS_MAX_BYTES,
    );
    expect(entry.diagnostics.bytes).toBe(new TextEncoder().encode(stored).length);
  });

  it('diag KV 쓰기 실패 → 201 + diagnosticsStored:false, entry는 저장', async () => {
    const { kv, env } = setup();
    const realPut = kv.put.bind(kv);
    vi.spyOn(kv, 'put').mockImplementation(async (k: string, v: string, o?: any) => {
      if (k.startsWith('feedback-diag:')) throw new Error('kv down');
      return realPut(k, v, o);
    });
    const res = await post({ message: 'm', diagnostics: 'dump' }, env);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { key: string; diagnosticsStored: boolean };
    expect(body.diagnosticsStored).toBe(false);
    const entry = JSON.parse(kv.store.get(body.key)!.value) as Record<string, any>;
    expect(entry.diagnostics.stored).toBe(false);
  });

  it('빈 message는 diagnostics/report가 있어도 400 invalid_payload', async () => {
    const { env } = setup();
    const res = await post({ message: '', report: { category: 'other' }, diagnostics: 'd' }, env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_payload' });
  });
});

describe('listFeedback는 diag를 읽지 않는다', () => {
  it('KV get 대상에 feedback-diag:* 없음, list 항목에 report·meta 노출', async () => {
    const kv = new InMemoryKV();
    const env = makeEnv({ FEEDBACK: kv as unknown as KVNamespace });
    await post({ message: 'm', report: { category: 'other' }, diagnostics: 'dump' }, env);
    const getSpy = vi.spyOn(kv, 'get');
    const { entries } = await listFeedback(kv as unknown as KVNamespace, { limit: 500 });
    expect(entries).toHaveLength(1);
    expect(entries[0].report?.category).toBe('other');
    expect(entries[0].diagnostics?.stored).toBe(true);
    const keys = getSpy.mock.calls.map((c) => c[0]);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.some((k) => k.startsWith('feedback-diag:'))).toBe(false);
    // 읽은 키는 entry 키 형식뿐 — diag 키가 entry 접두로 새도 잡는다.
    expect(keys.every((k) => /^feedback:\d+:[0-9a-f]+$/.test(k))).toBe(true);
    expect(feedbackDiagKey(keys[0])).not.toMatch(/^feedback:/);
  });
});

describe('GET /admin/feedback/:key', () => {
  type Row = {
    ts: number;
    kind: string;
    station: string | null;
    line: string | null;
    meta: string | null;
  };
  function mockDb(rows: Row[] | Error) {
    const all = vi.fn(async () => {
      if (rows instanceof Error) throw rows;
      return { results: rows };
    });
    const bind = vi.fn((..._args: unknown[]) => ({ all }));
    const prepare = vi.fn((_sql: string) => ({ bind }));
    return { db: { prepare } as unknown as D1Database, prepare, bind };
  }
  async function seedAndGet(
    report: Record<string, unknown>,
    db: D1Database | undefined,
  ): Promise<{ res: Response; key: string }> {
    const kv = new InMemoryKV();
    const env = makeEnv({ ADMIN_TOKEN: 's', FEEDBACK: kv as unknown as KVNamespace, DB: db });
    const p = await post({ message: 'm', report, diagnostics: 'dump-body' }, env);
    const { key } = (await p.json()) as { key: string };
    const res = await app.fetch(
      new Request(`http://example.com/admin/feedback/${encodeURIComponent(key)}`, {
        headers: { authorization: 'Bearer s' },
      }),
      env,
    );
    return { res, key };
  }

  it('entry + diagnostics 본문 + trip 요약(7일 이내)', async () => {
    const { db, bind } = mockDb([
      { ts: Date.now() - 1000, kind: 'advance', station: '성수', line: '2', meta: '{"leg":1}' },
    ]);
    const occurredAt = Date.now() - 60_000;
    const { res, key } = await seedAndGet({ category: 'other', tripKey: TRIP_KEY, occurredAt }, db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.key).toBe(key);
    expect(body.entry.message).toBe('m');
    expect(body.diagnostics).toBe('dump-body');
    expect(body.trip.status).toBe('ok');
    expect(body.trip.events[0]).toMatchObject({ kind: 'advance', station: '성수', meta: { leg: 1 } });
    expect(bind).toHaveBeenCalledWith(
      TRIP_KEY,
      occurredAt - 2 * 3600_000,
      occurredAt + 2 * 3600_000,
      expect.any(Number),
    );
  });

  it('meta가 JSON이 아니면 원문 문자열, null이면 null', async () => {
    const { db } = mockDb([
      { ts: 1, kind: 'a', station: null, line: null, meta: 'not-json' },
      { ts: 2, kind: 'b', station: null, line: null, meta: null },
    ]);
    const { res } = await seedAndGet({ tripKey: TRIP_KEY, occurredAt: Date.now() }, db);
    const { trip } = (await res.json()) as any;
    expect(trip.events.map((e: any) => e.meta)).toEqual(['not-json', null]);
  });

  it('7일 초과 → expired(D1 미조회)', async () => {
    const { db, prepare } = mockDb([]);
    const occurredAt = Date.now() - TRIP_EVENT_RETENTION_MS - 60_000;
    const { res } = await seedAndGet({ tripKey: TRIP_KEY, occurredAt }, db);
    expect(((await res.json()) as any).trip).toEqual({ status: 'expired' });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('tripKey 없음 / DB 미바인딩 / D1 오류 → unavailable', async () => {
    const a = await seedAndGet({ category: 'other', occurredAt: Date.now() }, mockDb([]).db);
    expect(((await a.res.json()) as any).trip).toEqual({ status: 'unavailable' });
    const b = await seedAndGet({ tripKey: TRIP_KEY, occurredAt: Date.now() }, undefined);
    expect(((await b.res.json()) as any).trip).toEqual({ status: 'unavailable' });
    const c = await seedAndGet(
      { tripKey: TRIP_KEY, occurredAt: Date.now() },
      mockDb(new Error('d1')).db,
    );
    expect(((await c.res.json()) as any).trip).toEqual({ status: 'unavailable' });
  });

  it('diag 없는 구 entry → diagnostics null', async () => {
    const kv = new InMemoryKV();
    kv.store.set('feedback:5:aa', { value: JSON.stringify({ message: 'old', receivedAt: 5 }) });
    const env = makeEnv({ ADMIN_TOKEN: 's', FEEDBACK: kv as unknown as KVNamespace });
    const res = await app.fetch(
      new Request(`http://example.com/admin/feedback/${encodeURIComponent('feedback:5:aa')}`, {
        headers: { authorization: 'Bearer s' },
      }),
      env,
    );
    const body = (await res.json()) as any;
    expect(body.diagnostics).toBeNull();
    expect(body.trip).toEqual({ status: 'unavailable' });
  });

  it('404 / 400 / 401', async () => {
    const kv = new InMemoryKV();
    const env = makeEnv({ ADMIN_TOKEN: 's', FEEDBACK: kv as unknown as KVNamespace });
    const h = { authorization: 'Bearer s' };
    const nf = await app.fetch(
      new Request(`http://example.com/admin/feedback/${encodeURIComponent('feedback:1:ab')}`, {
        headers: h,
      }),
      env,
    );
    expect(nf.status).toBe(404);
    const bad = await app.fetch(
      new Request('http://example.com/admin/feedback/whatever', { headers: h }),
      env,
    );
    expect(bad.status).toBe(400);
    const un = await app.fetch(new Request('http://example.com/admin/feedback/whatever'), env);
    expect(un.status).toBe(401);
  });

  it('정적 경로(export.csv, stats)가 :key에 가로채이지 않는다', async () => {
    const kv = new InMemoryKV();
    const env = makeEnv({ ADMIN_TOKEN: 's', FEEDBACK: kv as unknown as KVNamespace });
    const h = { authorization: 'Bearer s' };
    const csv = await app.fetch(
      new Request('http://example.com/admin/feedback/export.csv', { headers: h }),
      env,
    );
    expect(csv.headers.get('content-type')).toContain('text/csv');
    const stats = await app.fetch(
      new Request('http://example.com/admin/feedback/stats?date=2026-06-09', { headers: h }),
      env,
    );
    expect(await stats.json()).toEqual({ error: 'stats_not_found' });
  });
});

describe('listTripEventsByKeyWindow', () => {
  it('파라미터 바인딩 + ts 오름차순 SELECT, token_hash 인덱스 컬럼 사용', async () => {
    const all = vi.fn(async () => ({
      results: [{ ts: 1, kind: 'k', station: null, line: null, meta: null }],
    }));
    const bind = vi.fn((..._a: unknown[]) => ({ all }));
    const prepare = vi.fn((_sql: string) => ({ bind }));
    const rows = await listTripEventsByKeyWindow(
      { prepare } as unknown as D1Database,
      TRIP_KEY,
      10,
      20,
      50,
    );
    const sql = prepare.mock.calls[0][0];
    expect(sql).toMatch(/WHERE token_hash = \?/);
    expect(sql).toMatch(/ts >= \? AND ts <= \?/);
    expect(sql).toMatch(/ORDER BY ts ASC/);
    expect(sql).toMatch(/LIMIT \?/);
    expect(bind).toHaveBeenCalledWith(TRIP_KEY, 10, 20, 50);
    expect(rows).toEqual([{ ts: 1, kind: 'k', station: null, line: null, meta: null }]);
  });
  it('D1 오류 → null', async () => {
    const prepare = vi.fn(() => ({
      bind: () => ({
        all: async () => {
          throw new Error('x');
        },
      }),
    }));
    expect(
      await listTripEventsByKeyWindow({ prepare } as unknown as D1Database, TRIP_KEY, 1, 2),
    ).toBeNull();
  });
});
