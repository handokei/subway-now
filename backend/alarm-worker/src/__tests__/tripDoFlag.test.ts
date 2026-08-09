import { describe, expect, it } from 'vitest';
import {
  TRIP_DO_FLAG_DEFAULT,
  TRIP_DO_FLAG_KV_KEY,
  getTripDoFlag,
  isTripDoFlagValue,
  setTripDoFlag,
} from '../tripDoFlag';
import { InMemoryKV } from './inMemoryKv';

describe('tripDoFlag (Phase 1, ADR-031 / #2264)', () => {
  describe('isTripDoFlagValue', () => {
    it('accepts on / off', () => {
      expect(isTripDoFlagValue('on')).toBe(true);
      expect(isTripDoFlagValue('off')).toBe(true);
    });

    it('rejects other strings', () => {
      expect(isTripDoFlagValue('true')).toBe(false);
      expect(isTripDoFlagValue('ON')).toBe(false);
      expect(isTripDoFlagValue('')).toBe(false);
    });

    it('rejects non-string values', () => {
      expect(isTripDoFlagValue(null)).toBe(false);
      expect(isTripDoFlagValue(undefined)).toBe(false);
      expect(isTripDoFlagValue(1)).toBe(false);
      expect(isTripDoFlagValue({})).toBe(false);
    });
  });

  describe('getTripDoFlag', () => {
    it('returns default when kv is undefined (개발 환경 호환)', async () => {
      expect(await getTripDoFlag(undefined)).toBe(TRIP_DO_FLAG_DEFAULT);
    });

    it('returns default when key is not set (dormant)', async () => {
      const kv = new InMemoryKV() as unknown as KVNamespace;
      expect(await getTripDoFlag(kv)).toBe('off');
    });

    it('returns "on" when kv is set to on', async () => {
      const kv = new InMemoryKV() as unknown as KVNamespace;
      await kv.put(TRIP_DO_FLAG_KV_KEY, 'on');
      expect(await getTripDoFlag(kv)).toBe('on');
    });

    it('returns "off" when kv is set to off', async () => {
      const kv = new InMemoryKV() as unknown as KVNamespace;
      await kv.put(TRIP_DO_FLAG_KV_KEY, 'off');
      expect(await getTripDoFlag(kv)).toBe('off');
    });

    it('normalizes typo/invalid stored value to default', async () => {
      const kv = new InMemoryKV() as unknown as KVNamespace;
      await kv.put(TRIP_DO_FLAG_KV_KEY, 'ON');
      expect(await getTripDoFlag(kv)).toBe('off');
    });
  });

  describe('setTripDoFlag', () => {
    it('writes valid value', async () => {
      const kv = new InMemoryKV() as unknown as KVNamespace;
      await setTripDoFlag(kv, 'on');
      expect(await getTripDoFlag(kv)).toBe('on');
    });

    it('throws on invalid value without writing', async () => {
      const kv = new InMemoryKV() as unknown as KVNamespace;
      await expect(
        setTripDoFlag(kv, 'invalid' as unknown as 'on' | 'off'),
      ).rejects.toThrow('tripDoFlag: invalid value invalid');
      expect(await getTripDoFlag(kv)).toBe(TRIP_DO_FLAG_DEFAULT);
    });
  });
});
