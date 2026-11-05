import { describe, expect, it } from 'vitest';
import {
  TRIP_DO_FLAG_DEFAULT,
  TRIP_DO_FLAG_KV_KEY,
  createTripDoFlagReader,
  formatTripDoFlag,
  getTripDoFlag,
  parseTripDoFlag,
  setTripDoFlag,
} from '../tripDoFlag';
import { InMemoryKV } from './inMemoryKv';

const OFF = { stage: 'off', epoch: 0 };

describe('tripDoFlag (ADR-031 / #2264, 단계형 확장 #3300 PR-2)', () => {
  describe('parseTripDoFlag', () => {
    it('off → off', () => {
      expect(parseTripDoFlag('off')).toEqual(OFF);
    });

    it('legacy on / 오타 / 잘못된 값 → off', () => {
      const invalid = ['on', 'ON', '', 'lock', 'lock@', 'lock@-1', 'lock@1.5', 'bogus@3', 'lock@3x', 'lock@@3', null, undefined, 3];
      for (const raw of invalid) expect(parseTripDoFlag(raw)).toEqual(OFF);
    });

    it('단계@epoch 파싱', () => {
      expect(parseTripDoFlag('lock@3')).toEqual({ stage: 'lock', epoch: 3 });
      expect(parseTripDoFlag('progress@12')).toEqual({ stage: 'progress', epoch: 12 });
      expect(parseTripDoFlag('full@0')).toEqual({ stage: 'full', epoch: 0 });
    });
  });

  describe('formatTripDoFlag', () => {
    it('round-trip', () => {
      expect(formatTripDoFlag({ stage: 'lock', epoch: 3 })).toBe('lock@3');
      expect(formatTripDoFlag({ stage: 'off', epoch: 7 })).toBe('off');
      expect(parseTripDoFlag(formatTripDoFlag({ stage: 'full', epoch: 9 }))).toEqual({ stage: 'full', epoch: 9 });
    });
  });

  describe('getTripDoFlag', () => {
    it('kv undefined → default', async () => {
      expect(await getTripDoFlag(undefined)).toEqual(TRIP_DO_FLAG_DEFAULT);
    });

    it('미설정 → off', async () => {
      const kv = new InMemoryKV() as unknown as KVNamespace;
      expect(await getTripDoFlag(kv)).toEqual(OFF);
    });

    it('단계 값 / legacy on / 오타', async () => {
      const kv = new InMemoryKV() as unknown as KVNamespace;
      await kv.put(TRIP_DO_FLAG_KV_KEY, 'lock@3');
      expect(await getTripDoFlag(kv)).toEqual({ stage: 'lock', epoch: 3 });
      await kv.put(TRIP_DO_FLAG_KV_KEY, 'on');
      expect(await getTripDoFlag(kv)).toEqual(OFF);
      await kv.put(TRIP_DO_FLAG_KV_KEY, 'ON');
      expect(await getTripDoFlag(kv)).toEqual(OFF);
    });
  });

  describe('setTripDoFlag', () => {
    it('유효 값 write', async () => {
      const kv = new InMemoryKV() as unknown as KVNamespace;
      await setTripDoFlag(kv, 'progress@2');
      expect(await kv.get(TRIP_DO_FLAG_KV_KEY)).toBe('progress@2');
      await setTripDoFlag(kv, 'off');
      expect(await getTripDoFlag(kv)).toEqual(OFF);
    });

    it('legacy on / 잘못된 값은 write 없이 throw', async () => {
      const kv = new InMemoryKV() as unknown as KVNamespace;
      await expect(setTripDoFlag(kv, 'on')).rejects.toThrow('tripDoFlag: invalid value on');
      await expect(setTripDoFlag(kv, 'lock@x')).rejects.toThrow('tripDoFlag: invalid value lock@x');
      expect(await kv.get(TRIP_DO_FLAG_KV_KEY)).toBeNull();
    });
  });

  describe('createTripDoFlagReader (요청/tick당 KV 1회)', () => {
    it('여러 번 호출해도 KV는 1회만 읽는다', async () => {
      const inner = new InMemoryKV() as unknown as KVNamespace;
      await inner.put(TRIP_DO_FLAG_KV_KEY, 'lock@4');
      let reads = 0;
      const kv = {
        get: async (key: string) => {
          reads += 1;
          return inner.get(key);
        },
      } as unknown as KVNamespace;
      const read = createTripDoFlagReader(kv);
      const [a, b] = await Promise.all([read(), read()]);
      const c = await read();
      expect(reads).toBe(1);
      for (const flag of [a, b, c]) expect(flag).toEqual({ stage: 'lock', epoch: 4 });
    });

    it('KV 실패는 off로 fail-closed', async () => {
      const kv = {
        get: async () => {
          throw new Error('kv down');
        },
      } as unknown as KVNamespace;
      expect(await createTripDoFlagReader(kv)()).toEqual(OFF);
    });

    it('kv 미바인딩이면 off', async () => {
      expect(await createTripDoFlagReader(undefined)()).toEqual(OFF);
    });
  });
});
