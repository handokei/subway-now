import { beforeEach, describe, expect, it } from 'vitest';
import {
  ackPending,
  buildAlarmKey,
  getPending,
  getReceivedStamp,
  listPending,
  pendingKey,
  PENDING_TTL_SEC,
  putPending,
  receivedKey,
  RECEIVED_TTL_SEC,
  removePending,
  stampReceived,
  type PendingPush,
} from '../pendingPushes';

import { InMemoryKV } from './inMemoryKv';

function makeEntry(overrides: Partial<PendingPush> = {}): PendingPush {
  return {
    pushId: 'push-1',
    token: 'devicetoken-hex',
    alarmKey: 'early:강남',
    sentAt: 1_700_000_000_000,
    stationName: '강남',
    kind: 'destination',
    phase: 'early',
    etaSeconds: 60,
    apnsEnv: 'sandbox',
    ...overrides,
  };
}

describe('pendingPushes (#566 P2a)', () => {
  let kv: InMemoryKV;
  beforeEach(() => {
    kv = new InMemoryKV();
  });

  it('pendingKey: pending: 접두어를 붙인다', () => {
    expect(pendingKey('abc-def')).toBe('pending:abc-def');
  });

  it('buildAlarmKey: 디바이스 alarmKey와 동일한 ${phase}:${stationName} 형식', () => {
    expect(buildAlarmKey('강남', 'early')).toBe('early:강남');
    expect(buildAlarmKey('시청', 'imminent')).toBe('imminent:시청');
  });

  describe('putPending', () => {
    it('KV에 pending:<pushId> 키로 저장하고 TTL을 60초로 둔다', async () => {
      const entry = makeEntry({ pushId: 'p1' });
      await putPending(kv as unknown as KVNamespace, entry);
      const raw = kv.store.get('pending:p1');
      expect(raw).toBeDefined();
      expect(JSON.parse(raw!.value)).toEqual(entry);
      expect(raw!.expiresAt).toBeDefined();
      // TTL 정확히 60초 ± 1초 허용 (Date.now 시점 차이).
      expect(raw!.expiresAt! - Date.now()).toBeGreaterThan((PENDING_TTL_SEC - 1) * 1000);
      expect(raw!.expiresAt! - Date.now()).toBeLessThanOrEqual(PENDING_TTL_SEC * 1000);
    });

    it('PENDING_TTL_SEC가 60초로 노출된다', () => {
      expect(PENDING_TTL_SEC).toBe(60);
    });

    it('kv === undefined면 graceful no-op (throw 없음)', async () => {
      await expect(putPending(undefined, makeEntry())).resolves.toBeUndefined();
    });
  });

  describe('getPending', () => {
    it('저장된 entry를 그대로 반환', async () => {
      const entry = makeEntry({ pushId: 'p1' });
      await putPending(kv as unknown as KVNamespace, entry);
      const loaded = await getPending(kv as unknown as KVNamespace, 'p1');
      expect(loaded).toEqual(entry);
    });

    it('미존재 키는 null', async () => {
      expect(await getPending(kv as unknown as KVNamespace, 'missing')).toBeNull();
    });

    it('손상된 JSON은 null', async () => {
      await kv.put('pending:bad', 'not-json');
      expect(await getPending(kv as unknown as KVNamespace, 'bad')).toBeNull();
    });

    it('kv === undefined면 graceful null', async () => {
      expect(await getPending(undefined, 'p1')).toBeNull();
    });
  });

  describe('listPending / removePending (#572 P2c)', () => {
    it('listPending: prefix scan으로 모든 pending entry를 yield', async () => {
      await putPending(kv as unknown as KVNamespace, makeEntry({ pushId: 'a' }));
      await putPending(kv as unknown as KVNamespace, makeEntry({ pushId: 'b' }));
      await kv.put('other:c', 'unrelated');
      const out: string[] = [];
      for await (const entry of listPending(kv as unknown as KVNamespace)) {
        out.push(entry.pushId);
      }
      expect(out.sort((a, b) => a.localeCompare(b))).toEqual(['a', 'b']);
    });

    it('listPending: kv === undefined면 빈 generator', async () => {
      const out: string[] = [];
      for await (const e of listPending(undefined)) out.push(e.pushId);
      expect(out).toEqual([]);
    });

    it('listPending: 손상된 JSON entry는 skip', async () => {
      await putPending(kv as unknown as KVNamespace, makeEntry({ pushId: 'good' }));
      await kv.put(pendingKey('bad'), 'not-json{');
      const out: string[] = [];
      for await (const e of listPending(kv as unknown as KVNamespace)) out.push(e.pushId);
      expect(out).toEqual(['good']);
    });

    it('removePending: 무조건 삭제 (token 인증 없음)', async () => {
      await putPending(kv as unknown as KVNamespace, makeEntry({ pushId: 'p1' }));
      await removePending(kv as unknown as KVNamespace, 'p1');
      expect(kv.store.has(pendingKey('p1'))).toBe(false);
    });

    it('removePending: kv === undefined면 no-op', async () => {
      await expect(removePending(undefined, 'p1')).resolves.toBeUndefined();
    });
  });

  describe('ackPending', () => {
    it('token 매칭 시 entry 삭제하고 deleted=true', async () => {
      await putPending(
        kv as unknown as KVNamespace,
        makeEntry({ pushId: 'p1', token: 'devicetoken-hex' }),
      );
      const result = await ackPending(kv as unknown as KVNamespace, 'p1', 'devicetoken-hex');
      expect(result).toEqual({ deleted: true });
      expect(kv.store.has('pending:p1')).toBe(false);
    });

    it('token 불일치면 삭제하지 않고 reason=token-mismatch', async () => {
      await putPending(
        kv as unknown as KVNamespace,
        makeEntry({ pushId: 'p1', token: 'real-token' }),
      );
      const result = await ackPending(kv as unknown as KVNamespace, 'p1', 'attacker-token');
      expect(result).toEqual({ deleted: false, reason: 'token-mismatch' });
      expect(kv.store.has('pending:p1')).toBe(true);
    });

    it('미존재 키는 reason=not-found (idempotent)', async () => {
      const result = await ackPending(kv as unknown as KVNamespace, 'missing', 'tok');
      expect(result).toEqual({ deleted: false, reason: 'not-found' });
    });

    it('kv === undefined면 reason=not-found 반환', async () => {
      expect(await ackPending(undefined, 'p1', 'tok')).toEqual({
        deleted: false,
        reason: 'not-found',
      });
    });
  });

  describe('stampReceived / getReceivedStamp (#1370 L5)', () => {
    it('receivedKey: received: 접두어를 붙인다', () => {
      expect(receivedKey('abc-def')).toBe('received:abc-def');
    });

    it('RECEIVED_TTL_SEC = 3600 (1시간)', () => {
      expect(RECEIVED_TTL_SEC).toBe(60 * 60);
    });

    it('token 매칭 시 stamp 적재 + pending entry는 보존 + stamped=true', async () => {
      await putPending(
        kv as unknown as KVNamespace,
        makeEntry({ pushId: 'p1', token: 'devicetoken-hex', stationName: '강남', phase: 'early' }),
      );
      const result = await stampReceived(
        kv as unknown as KVNamespace,
        'p1',
        'devicetoken-hex',
        1_700_000_001_000,
      );
      expect(result).toEqual({ stamped: true });
      expect(kv.store.has('pending:p1')).toBe(true);
      const entry = kv.store.get('received:p1');
      expect(entry).toBeDefined();
      const parsed = JSON.parse(entry!.value) as { pushId: string; receivedAt: number; stationName: string; phase: string };
      expect(parsed.pushId).toBe('p1');
      expect(parsed.receivedAt).toBe(1_700_000_001_000);
      expect(parsed.stationName).toBe('강남');
      expect(parsed.phase).toBe('early');
    });

    it('token 불일치면 stamp 미적재 + reason=token-mismatch', async () => {
      await putPending(
        kv as unknown as KVNamespace,
        makeEntry({ pushId: 'p1', token: 'real-token' }),
      );
      const result = await stampReceived(
        kv as unknown as KVNamespace,
        'p1',
        'attacker',
        Date.now(),
      );
      expect(result).toEqual({ stamped: false, reason: 'token-mismatch' });
      expect(kv.store.has('received:p1')).toBe(false);
    });

    it('미존재 pushId는 reason=not-found', async () => {
      const result = await stampReceived(
        kv as unknown as KVNamespace,
        'missing',
        'tok',
        Date.now(),
      );
      expect(result).toEqual({ stamped: false, reason: 'not-found' });
    });

    it('kv === undefined면 reason=not-found', async () => {
      expect(await stampReceived(undefined, 'p1', 'tok', Date.now())).toEqual({
        stamped: false,
        reason: 'not-found',
      });
    });

    it('getReceivedStamp: stamp 존재 시 parsed entry 반환', async () => {
      await putPending(
        kv as unknown as KVNamespace,
        makeEntry({ pushId: 'p1', token: 'tok', stationName: '시청', phase: 'imminent' }),
      );
      await stampReceived(kv as unknown as KVNamespace, 'p1', 'tok', 1_700_000_500_000);
      const stamp = await getReceivedStamp(kv as unknown as KVNamespace, 'p1');
      expect(stamp).toEqual({
        pushId: 'p1',
        receivedAt: 1_700_000_500_000,
        stationName: '시청',
        phase: 'imminent',
      });
    });

    it('getReceivedStamp: stamp 없으면 null', async () => {
      expect(await getReceivedStamp(kv as unknown as KVNamespace, 'missing')).toBeNull();
    });

    it('getReceivedStamp: 손상된 JSON은 null', async () => {
      await kv.put('received:p1', '{broken');
      expect(await getReceivedStamp(kv as unknown as KVNamespace, 'p1')).toBeNull();
    });

    it('getReceivedStamp: kv === undefined면 null', async () => {
      expect(await getReceivedStamp(undefined, 'p1')).toBeNull();
    });
  });
});
