import { beforeEach, describe, expect, it } from 'vitest';
import { PUSH_ACTIVITY_TTL_SEC, readPushActivityRecent, stampPushActivity } from '../cronIdleGate';
import { InMemoryKV } from './inMemoryKv';

describe('cronIdleGate (#2073 Issue A)', () => {
  let kv: InMemoryKV;
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    kv = new InMemoryKV();
  });

  describe('readPushActivityRecent', () => {
    it('returns false when no marker was ever stamped', async () => {
      expect(await readPushActivityRecent(kv as unknown as KVNamespace)).toBe(false);
    });

    it('returns true right after stampPushActivity', async () => {
      await stampPushActivity(kv as unknown as KVNamespace, NOW);
      expect(await readPushActivityRecent(kv as unknown as KVNamespace)).toBe(true);
    });

    it('returns false after marker TTL naturally expires', async () => {
      await stampPushActivity(kv as unknown as KVNamespace, NOW);
      const entry = kv.store.get('cron:push-activity');
      expect(entry?.expiresAt).toBeGreaterThan(Date.now());
      expect(entry?.expiresAt).toBeLessThanOrEqual(Date.now() + PUSH_ACTIVITY_TTL_SEC * 1000);
      // simulate expiry by directly deleting (InMemoryKV expires based on wall clock, not `now` param).
      kv.store.delete('cron:push-activity');
      expect(await readPushActivityRecent(kv as unknown as KVNamespace)).toBe(false);
    });

    it('returns false when kv is undefined', async () => {
      expect(await readPushActivityRecent(undefined)).toBe(false);
    });

    it('returns true (conservative — 활동 있을 수 있음으로 오판 방지) when kv.get throws', async () => {
      const throwingKv = {
        get: async () => {
          throw new Error('kv down');
        },
      } as unknown as KVNamespace;
      expect(await readPushActivityRecent(throwingKv)).toBe(true);
    });
  });

  describe('stampPushActivity', () => {
    it('graceful no-op when kv is undefined', async () => {
      await expect(stampPushActivity(undefined, NOW)).resolves.toBeUndefined();
    });

    it('graceful when kv.put throws', async () => {
      const throwingKv = {
        put: async () => {
          throw new Error('kv down');
        },
      } as unknown as KVNamespace;
      await expect(stampPushActivity(throwingKv, NOW)).resolves.toBeUndefined();
    });

    it('re-stamping keeps the marker alive (readPushActivityRecent still true)', async () => {
      await stampPushActivity(kv as unknown as KVNamespace, NOW);
      await stampPushActivity(kv as unknown as KVNamespace, NOW + 60_000);
      expect(await readPushActivityRecent(kv as unknown as KVNamespace)).toBe(true);
    });
  });
});
