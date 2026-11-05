import { describe, expect, it, vi } from 'vitest';
import {
  POSITION_KV_SAMPLE_DAILY_CAP,
  POSITION_KV_SAMPLE_RATE,
  buildPositionKvSampleMeta,
  classifyLockState,
  createPutRecorder,
  recordPositionKvSample,
  shouldSamplePositionKv,
} from '../positionKvSample';
import type { Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';

const NOW = Date.UTC(2026, 9, 23, 3, 0, 0);

const trip = (extra: Record<string, unknown> = {}): Trip =>
  ({
    token: 't',
    waypoints: [{ stationName: '강남', line: '2', kind: 'transfer' }],
    expiresAt: NOW + 1000,
    ...extra,
  }) as unknown as Trip;

describe('shouldSamplePositionKv', () => {
  it('비율 미만만 당첨, 비활성이면 항상 미당첨', () => {
    expect(shouldSamplePositionKv(0)).toBe(true);
    expect(shouldSamplePositionKv(POSITION_KV_SAMPLE_RATE)).toBe(false);
    expect(shouldSamplePositionKv(0, false)).toBe(false);
  });
});

describe('createPutRecorder', () => {
  it('put key prefix만 기록하고 원본에 그대로 위임, 다른 메서드는 건드리지 않는다', async () => {
    const kv = new InMemoryKV();
    const put = vi.spyOn(kv, 'put');
    const get = vi.spyOn(kv, 'get');
    const rec = createPutRecorder(kv as unknown as KVNamespace);
    await rec.kv.put('pos:abc', 'v', { expirationTtl: 60 });
    await rec.kv.put('ssot:abc', 'v');
    expect(await rec.kv.get('pos:abc')).toBe('v');
    expect(rec.stages()).toEqual(['pos', 'ssot']);
    expect(put).toHaveBeenCalledWith('pos:abc', 'v', { expirationTtl: 60 });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('put이 reject해도 시도로 기록하고 예외를 그대로 전달', async () => {
    const kv = new InMemoryKV();
    vi.spyOn(kv, 'put').mockRejectedValue(new Error('quota'));
    const rec = createPutRecorder(kv as unknown as KVNamespace);
    await expect(rec.kv.put('accel:x', 'v')).rejects.toThrow('quota');
    expect(rec.stages()).toEqual(['accel']);
  });

  it('함수가 아닌 프로퍼티는 그대로 반환', () => {
    const kv = { marker: 7, put: vi.fn() } as unknown as KVNamespace;
    expect((createPutRecorder(kv).kv as unknown as { marker: number }).marker).toBe(7);
  });
});

describe('classifyLockState', () => {
  it('lock / lockless / no-trip / unknown', () => {
    expect(classifyLockState(trip({ boardingLock: { expiresAt: NOW + 1 } }), NOW)).toBe('lock');
    expect(classifyLockState(trip({ boardingLock: { expiresAt: NOW } }), NOW)).toBe('lockless');
    expect(classifyLockState(trip(), NOW)).toBe('lockless');
    expect(classifyLockState(null, NOW)).toBe('no-trip');
    expect(classifyLockState('unknown', NOW)).toBe('unknown');
  });
});

describe('buildPositionKvSampleMeta', () => {
  it('trip 없음: headKind null, etaMissing false', () => {
    expect(
      buildPositionKvSampleMeta({
        stages: ['pos'],
        trip: null,
        appState: undefined,
        hasAccel: false,
        pointTs: NOW - 10,
        now: NOW,
      }),
    ).toEqual({
      stages: ['pos'],
      attempted: 1,
      lockState: 'no-trip',
      appState: null,
      headKind: null,
      etaMissing: false,
      hasAccel: false,
      pointLagMs: 10,
    });
  });

  it('trip 있음: headKind/etaMissing 반영, 빈 waypoints는 null', () => {
    const base = { stages: [], appState: 'fg' as const, hasAccel: true, pointTs: NOW, now: NOW };
    expect(
      buildPositionKvSampleMeta({ ...base, trip: trip({ consecutiveEtaMissing: 3 }) }),
    ).toMatchObject({ headKind: 'transfer', etaMissing: true, appState: 'fg', hasAccel: true });
    expect(
      buildPositionKvSampleMeta({ ...base, trip: trip({ waypoints: [] }) }).headKind,
    ).toBeNull();
    expect(buildPositionKvSampleMeta({ ...base, trip: 'unknown' }).lockState).toBe('unknown');
  });
});

describe('recordPositionKvSample', () => {
  const meta = buildPositionKvSampleMeta({
    stages: ['pos'],
    trip: null,
    appState: 'bg',
    hasAccel: false,
    pointTs: NOW,
    now: NOW,
  });

  function makeDb(first: () => Promise<unknown>) {
    const binds: unknown[][] = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => {
          binds.push([sql, ...args]);
          return { first, run: async () => ({ success: true }) };
        },
      }),
    } as unknown as D1Database;
    return { db, binds };
  }

  it('DB 미바인딩 — no-op', async () => {
    await expect(recordPositionKvSample(undefined, 'h', meta, NOW)).resolves.toBeUndefined();
  });

  it('상한 미만 — COUNT(kind, 당일 시작 ts) 후 1행 INSERT', async () => {
    const { db, binds } = makeDb(async () => ({ n: POSITION_KV_SAMPLE_DAILY_CAP - 1 }));
    await recordPositionKvSample(db, 'h', meta, NOW);
    const dayStart = Date.UTC(2026, 9, 23);
    expect(binds[0].slice(1)).toEqual(['position-kv-sample', dayStart]);
    expect(binds[1][0]).toMatch(/INSERT INTO trip_events/);
    expect(binds[1].slice(1, 4)).toEqual(['h', NOW, 'position-kv-sample']);
  });

  it('COUNT 결과 부재(null) — 0으로 보고 적재', async () => {
    const { db, binds } = makeDb(async () => null);
    await recordPositionKvSample(db, 'h', meta, NOW);
    expect(binds).toHaveLength(2);
  });

  it('상한 도달 — 적재 안 함', async () => {
    const { db, binds } = makeDb(async () => ({ n: POSITION_KV_SAMPLE_DAILY_CAP }));
    await recordPositionKvSample(db, 'h', meta, NOW);
    expect(binds).toHaveLength(1);
  });

  it('COUNT 조회 실패 — 흡수하고 적재 안 함', async () => {
    const { db, binds } = makeDb(async () => {
      throw new Error('d1 down');
    });
    await expect(recordPositionKvSample(db, 'h', meta, NOW)).resolves.toBeUndefined();
    expect(binds).toHaveLength(1);
  });
});
