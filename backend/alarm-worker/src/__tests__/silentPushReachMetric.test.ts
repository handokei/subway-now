/**
 * silentPushReachMetric.test.ts — #1958 silent push 5min 윈도우 corrId join 단위 테스트.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryKV } from './inMemoryKv';
import {
  SENT_TTL_SEC,
  SILENT_PUSH_REACH_WINDOW_MS,
  computeSilentPushReachRatio,
  sentKey,
  stampSent,
} from '../silentPushReachMetric';

const NOW = 1_700_000_000_000;

// ──────────────────────────────────────────────────────────────────────────────
// sentKey
// ──────────────────────────────────────────────────────────────────────────────

describe('sentKey', () => {
  it('builds sent:<pushId> key', () => {
    expect(sentKey('abc')).toBe('sent:abc');
  });

  it('empty pushId still prefixed', () => {
    // 실제 caller는 비어 있지 않은 pushId를 전달 — fail-safe 표면만 확인.
    expect(sentKey('')).toBe('sent:');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// stampSent
// ──────────────────────────────────────────────────────────────────────────────

describe('stampSent', () => {
  it('writes sent:<pushId> entry with 5min TTL', async () => {
    const kv = new InMemoryKV();
    const beforePut = Date.now();
    await stampSent(kv as unknown as KVNamespace, { pushId: 'p1', sentAt: NOW });
    const afterPut = Date.now();
    const entry = kv.store.get('sent:p1');
    expect(entry).toBeDefined();
    expect(JSON.parse(entry!.value)).toEqual({ pushId: 'p1', sentAt: NOW });
    expect(entry!.expiresAt).toBeGreaterThanOrEqual(beforePut + SENT_TTL_SEC * 1000 - 100);
    expect(entry!.expiresAt).toBeLessThanOrEqual(afterPut + SENT_TTL_SEC * 1000 + 100);
  });

  it('undefined KV → graceful no-op (no throw, no put)', async () => {
    await expect(stampSent(undefined, { pushId: 'p1', sentAt: NOW })).resolves.toBeUndefined();
  });

  it('KV.put throw → silent swallow (측정 인프라가 본 발사 흐름 차단 X)', async () => {
    const throwingKv = {
      async put(): Promise<void> {
        throw new Error('KV PUT failed: 429 daily write limit');
      },
    } as unknown as KVNamespace;
    await expect(
      stampSent(throwingKv, { pushId: 'p1', sentAt: NOW }),
    ).resolves.toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// computeSilentPushReachRatio
// ──────────────────────────────────────────────────────────────────────────────

describe('computeSilentPushReachRatio', () => {
  it('빈 KV → sent=0 received=0 joined=0 ratio=0', async () => {
    const kv = new InMemoryKV();
    const result = await computeSilentPushReachRatio(kv as unknown as KVNamespace, NOW);
    expect(result.sent).toBe(0);
    expect(result.received).toBe(0);
    expect(result.joined).toBe(0);
    expect(result.ratio).toBe(0);
    expect(result.windowStart).toBe(NOW - SILENT_PUSH_REACH_WINDOW_MS);
    expect(result.windowEnd).toBe(NOW);
  });

  it('5min 윈도우 안 sent 2건 + matching received 2건 → ratio=1', async () => {
    const kv = new InMemoryKV();
    await stampSent(kv as unknown as KVNamespace, { pushId: 'a', sentAt: NOW - 60_000 });
    await stampSent(kv as unknown as KVNamespace, { pushId: 'b', sentAt: NOW - 90_000 });
    kv.store.set('received:a', {
      value: JSON.stringify({ pushId: 'a', receivedAt: NOW - 50_000 }),
    });
    kv.store.set('received:b', {
      value: JSON.stringify({ pushId: 'b', receivedAt: NOW - 80_000 }),
    });
    const result = await computeSilentPushReachRatio(kv as unknown as KVNamespace, NOW);
    expect(result.sent).toBe(2);
    expect(result.received).toBe(2);
    expect(result.joined).toBe(2);
    expect(result.ratio).toBe(1);
  });

  it('5min 윈도우 안 sent 3건 / received 1건 → ratio=1/3', async () => {
    const kv = new InMemoryKV();
    await stampSent(kv as unknown as KVNamespace, { pushId: 'a', sentAt: NOW - 60_000 });
    await stampSent(kv as unknown as KVNamespace, { pushId: 'b', sentAt: NOW - 90_000 });
    await stampSent(kv as unknown as KVNamespace, { pushId: 'c', sentAt: NOW - 120_000 });
    kv.store.set('received:a', {
      value: JSON.stringify({ pushId: 'a', receivedAt: NOW - 50_000 }),
    });
    const result = await computeSilentPushReachRatio(kv as unknown as KVNamespace, NOW);
    expect(result.sent).toBe(3);
    expect(result.received).toBe(1);
    expect(result.joined).toBe(1);
    expect(result.ratio).toBeCloseTo(1 / 3);
  });

  it('sent 윈도우 밖 → 분모/분자에서 제외', async () => {
    const kv = new InMemoryKV();
    // 10min 이전 sent — 윈도우(5min) 밖
    kv.store.set('sent:old', {
      value: JSON.stringify({ pushId: 'old', sentAt: NOW - 10 * 60_000 }),
    });
    // 1min 전 received — 같은 pushId 지만 sent 가 윈도우 밖이라 join 안 됨
    kv.store.set('received:old', {
      value: JSON.stringify({ pushId: 'old', receivedAt: NOW - 60_000 }),
    });
    const result = await computeSilentPushReachRatio(kv as unknown as KVNamespace, NOW);
    expect(result.sent).toBe(0);
    expect(result.received).toBe(0);
    expect(result.ratio).toBe(0);
  });

  it('sent 없이 received만 (legacy / orphan) → 분자/joined에서 제외', async () => {
    const kv = new InMemoryKV();
    kv.store.set('received:orphan', {
      value: JSON.stringify({ pushId: 'orphan', receivedAt: NOW - 30_000 }),
    });
    const result = await computeSilentPushReachRatio(kv as unknown as KVNamespace, NOW);
    expect(result.sent).toBe(0);
    expect(result.received).toBe(0);
    expect(result.joined).toBe(0);
    expect(result.ratio).toBe(0);
  });

  it('malformed sent JSON → skip 후 정상 처리', async () => {
    const kv = new InMemoryKV();
    kv.store.set('sent:bad', { value: '{not-json' });
    kv.store.set('sent:good', {
      value: JSON.stringify({ pushId: 'good', sentAt: NOW - 60_000 }),
    });
    kv.store.set('received:good', {
      value: JSON.stringify({ pushId: 'good', receivedAt: NOW - 50_000 }),
    });
    const result = await computeSilentPushReachRatio(kv as unknown as KVNamespace, NOW);
    expect(result.sent).toBe(1);
    expect(result.received).toBe(1);
    expect(result.ratio).toBe(1);
  });

  it('malformed received JSON → skip 후 정상 처리', async () => {
    const kv = new InMemoryKV();
    await stampSent(kv as unknown as KVNamespace, { pushId: 'p1', sentAt: NOW - 60_000 });
    kv.store.set('received:p1', { value: '{not-json' });
    const result = await computeSilentPushReachRatio(kv as unknown as KVNamespace, NOW);
    expect(result.sent).toBe(1);
    expect(result.received).toBe(0);
    expect(result.ratio).toBe(0);
  });

  it('sent stamp 안 fields 누락 (pushId/sentAt) → skip', async () => {
    const kv = new InMemoryKV();
    kv.store.set('sent:invalid1', { value: JSON.stringify({ sentAt: NOW - 30_000 }) });
    kv.store.set('sent:invalid2', { value: JSON.stringify({ pushId: 'x' }) });
    kv.store.set('sent:invalid3', { value: JSON.stringify({ pushId: '', sentAt: NOW - 30_000 }) });
    kv.store.set('sent:invalid4', {
      value: JSON.stringify({ pushId: 'x', sentAt: Number.NaN }),
    });
    const result = await computeSilentPushReachRatio(kv as unknown as KVNamespace, NOW);
    expect(result.sent).toBe(0);
  });

  it('received stamp 안 fields 누락 (pushId/receivedAt) → skip', async () => {
    const kv = new InMemoryKV();
    await stampSent(kv as unknown as KVNamespace, { pushId: 'p1', sentAt: NOW - 60_000 });
    kv.store.set('received:bad1', { value: JSON.stringify({ receivedAt: NOW - 50_000 }) });
    kv.store.set('received:bad2', { value: JSON.stringify({ pushId: 'p1' }) });
    const result = await computeSilentPushReachRatio(kv as unknown as KVNamespace, NOW);
    expect(result.sent).toBe(1);
    expect(result.received).toBe(0);
  });

  it('빈 raw value (null) → skip', async () => {
    const kv = new InMemoryKV();
    // list에 key는 있지만 get 결과가 null인 케이스를 시뮬레이션할 수 없으므로 만료 entry 모사.
    // expiresAt이 과거인 entry는 InMemoryKV.get이 null을 반환한다.
    kv.store.set('sent:expired', {
      value: JSON.stringify({ pushId: 'expired', sentAt: NOW - 60_000 }),
      expiresAt: NOW - 1000,
    });
    const result = await computeSilentPushReachRatio(kv as unknown as KVNamespace, NOW);
    expect(result.sent).toBe(0);
  });

  it('limit cap — 1000건 sent 적재 시 default limit(500) 내에서만 enumerate', async () => {
    const kv = new InMemoryKV();
    for (let i = 0; i < 700; i += 1) {
      kv.store.set(`sent:p${i}`, {
        value: JSON.stringify({ pushId: `p${i}`, sentAt: NOW - 60_000 - i }),
      });
    }
    // pageSize를 작게 해서 enumeration 의 cursor 경로를 강제로 한 번 더 돌게 한다.
    kv.pageSize = 200;
    const result = await computeSilentPushReachRatio(kv as unknown as KVNamespace, NOW, 500);
    expect(result.sent).toBe(500);
    expect(result.received).toBe(0);
    expect(result.ratio).toBe(0);
  });
});
