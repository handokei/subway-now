import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CRON_READ_CACHE_TTL_SEC } from '../kvConsistency';
import {
  DEVICE_CONTACT_TTL_SEC,
  STAMP_RATE_LIMIT_MS,
  readDeviceContact,
  stampDeviceContact,
} from '../deviceContact';
import { InMemoryKV } from './inMemoryKv';

describe('deviceContact (#2617 fallback implicit ACK)', () => {
  let kv: InMemoryKV;
  const NOW = 1_700_000_000_000;
  const TOKEN_HASH = 'abcd1234';

  beforeEach(() => {
    kv = new InMemoryKV();
  });

  describe('readDeviceContact', () => {
    it('returns null when no stamp was ever written', async () => {
      expect(await readDeviceContact(kv as unknown as KVNamespace, TOKEN_HASH)).toBeNull();
    });

    it('returns the stamped timestamp right after stampDeviceContact', async () => {
      await stampDeviceContact(kv as unknown as KVNamespace, TOKEN_HASH, NOW);
      expect(await readDeviceContact(kv as unknown as KVNamespace, TOKEN_HASH)).toBe(NOW);
    });

    it('returns null after the marker naturally expires (TTL)', async () => {
      await stampDeviceContact(kv as unknown as KVNamespace, TOKEN_HASH, NOW);
      const entry = kv.store.get(`deviceContact:${TOKEN_HASH}`);
      expect(entry?.expiresAt).toBeGreaterThan(Date.now());
      expect(entry?.expiresAt).toBeLessThanOrEqual(Date.now() + DEVICE_CONTACT_TTL_SEC * 1000);
      kv.store.delete(`deviceContact:${TOKEN_HASH}`);
      expect(await readDeviceContact(kv as unknown as KVNamespace, TOKEN_HASH)).toBeNull();
    });

    it('returns null (conservative fallback to existing behavior) when kv.get throws', async () => {
      const throwingKv = {
        get: async () => {
          throw new Error('kv down');
        },
      } as unknown as KVNamespace;
      expect(await readDeviceContact(throwingKv, TOKEN_HASH)).toBeNull();
    });

    it('returns null when the stored value is not a finite number', async () => {
      await kv.put(`deviceContact:${TOKEN_HASH}`, 'not-a-number');
      expect(await readDeviceContact(kv as unknown as KVNamespace, TOKEN_HASH)).toBeNull();
    });

    it('reads with explicit cacheTtl (kvConsistency 컨벤션)', async () => {
      const spy = vi.spyOn(kv, 'get');
      await readDeviceContact(kv as unknown as KVNamespace, TOKEN_HASH);
      expect(spy).toHaveBeenCalledWith(`deviceContact:${TOKEN_HASH}`, {
        cacheTtl: CRON_READ_CACHE_TTL_SEC,
      });
    });

    it('different tokenHash 간 격리 — 서로의 stamp를 읽지 않는다', async () => {
      await stampDeviceContact(kv as unknown as KVNamespace, 'hash-a', NOW);
      expect(await readDeviceContact(kv as unknown as KVNamespace, 'hash-b')).toBeNull();
    });
  });

  describe('stampDeviceContact', () => {
    it('graceful when kv.put throws', async () => {
      const throwingKv = {
        put: async () => {
          throw new Error('kv down');
        },
      } as unknown as KVNamespace;
      await expect(
        stampDeviceContact(throwingKv, TOKEN_HASH, NOW),
      ).resolves.toBeUndefined();
    });

    it('re-stamping after STAMP_RATE_LIMIT_MS updates the timestamp', async () => {
      await stampDeviceContact(kv as unknown as KVNamespace, TOKEN_HASH, NOW);
      await stampDeviceContact(
        kv as unknown as KVNamespace,
        TOKEN_HASH,
        NOW + STAMP_RATE_LIMIT_MS,
      );
      expect(await readDeviceContact(kv as unknown as KVNamespace, TOKEN_HASH)).toBe(
        NOW + STAMP_RATE_LIMIT_MS,
      );
    });

    it('#2617 (코드리뷰 반영) — STAMP_RATE_LIMIT_MS 이내 재호출은 write를 skip한다 (KV quota 보호)', async () => {
      await stampDeviceContact(kv as unknown as KVNamespace, TOKEN_HASH, NOW);
      const putSpy = vi.spyOn(kv, 'put');
      await stampDeviceContact(
        kv as unknown as KVNamespace,
        TOKEN_HASH,
        NOW + STAMP_RATE_LIMIT_MS - 1,
      );
      expect(putSpy).not.toHaveBeenCalled();
      expect(await readDeviceContact(kv as unknown as KVNamespace, TOKEN_HASH)).toBe(NOW);
    });

    it('read 실패(rate-limit 확인 불가) → 보수적으로 "기존 stamp 없음" 취급하고 write를 강행한다', async () => {
      let getCalls = 0;
      const flakyKv = {
        get: async () => {
          getCalls += 1;
          throw new Error('kv read down');
        },
        put: vi.fn().mockResolvedValue(undefined),
      } as unknown as KVNamespace;
      await stampDeviceContact(flakyKv, TOKEN_HASH, NOW);
      expect(getCalls).toBe(1);
      expect((flakyKv as unknown as { put: ReturnType<typeof vi.fn> }).put).toHaveBeenCalledTimes(
        1,
      );
    });
  });
});
