import { describe, expect, it } from 'vitest';
import {
  ARCH_FLAG_DEFAULT,
  ARCH_FLAG_KV_KEY,
  getArchFlag,
  isArchFlagValue,
  setArchFlag,
} from '../archFlag';
import { InMemoryKV } from './inMemoryKv';

describe('archFlag (Phase 0, ADR-022 / #1982)', () => {
  describe('isArchFlagValue', () => {
    it('accepts on / off', () => {
      expect(isArchFlagValue('on')).toBe(true);
      expect(isArchFlagValue('off')).toBe(true);
    });

    it('rejects other strings', () => {
      expect(isArchFlagValue('true')).toBe(false);
      expect(isArchFlagValue('ON')).toBe(false);
      expect(isArchFlagValue('')).toBe(false);
    });

    it('rejects non-string values', () => {
      expect(isArchFlagValue(null)).toBe(false);
      expect(isArchFlagValue(undefined)).toBe(false);
      expect(isArchFlagValue(1)).toBe(false);
      expect(isArchFlagValue({})).toBe(false);
    });
  });

  describe('getArchFlag', () => {
    it('returns default when kv is undefined (개발 환경 호환)', async () => {
      expect(await getArchFlag(undefined)).toBe(ARCH_FLAG_DEFAULT);
    });

    it('returns default when key is not set (dormant)', async () => {
      const kv = new InMemoryKV() as unknown as KVNamespace;
      expect(await getArchFlag(kv)).toBe('off');
    });

    it('returns "on" when kv is set to on', async () => {
      const kv = new InMemoryKV() as unknown as KVNamespace;
      await kv.put(ARCH_FLAG_KV_KEY, 'on');
      expect(await getArchFlag(kv)).toBe('on');
    });

    it('returns "off" when kv is set to off', async () => {
      const kv = new InMemoryKV() as unknown as KVNamespace;
      await kv.put(ARCH_FLAG_KV_KEY, 'off');
      expect(await getArchFlag(kv)).toBe('off');
    });

    it('falls back to default when kv has invalid value (오타 방어)', async () => {
      const kv = new InMemoryKV() as unknown as KVNamespace;
      await kv.put(ARCH_FLAG_KV_KEY, 'true');
      expect(await getArchFlag(kv)).toBe(ARCH_FLAG_DEFAULT);
    });
  });

  describe('setArchFlag', () => {
    it('writes "on" to KV', async () => {
      const kv = new InMemoryKV() as unknown as KVNamespace;
      await setArchFlag(kv, 'on');
      expect(await kv.get(ARCH_FLAG_KV_KEY)).toBe('on');
    });

    it('writes "off" to KV', async () => {
      const kv = new InMemoryKV() as unknown as KVNamespace;
      await setArchFlag(kv, 'on');
      await setArchFlag(kv, 'off');
      expect(await kv.get(ARCH_FLAG_KV_KEY)).toBe('off');
    });

    it('throws on invalid value (잘못된 KV 상태 진입 차단)', async () => {
      const kv = new InMemoryKV() as unknown as KVNamespace;
      // TypeScript 는 컴파일 타임에 막지만, 운영자가 raw HTTP body 로 임의 값을
      // 넣는 경로에서 방어가 필요.
      await expect(
        setArchFlag(kv, 'true' as unknown as 'on'),
      ).rejects.toThrow(/invalid value/);
      // 실패 후 KV 는 write 되지 않아야 한다.
      expect(await kv.get(ARCH_FLAG_KV_KEY)).toBeNull();
    });
  });

  describe('constants', () => {
    it('default is off', () => {
      expect(ARCH_FLAG_DEFAULT).toBe('off');
    });

    it('key matches ADR-022 명시 값', () => {
      expect(ARCH_FLAG_KV_KEY).toBe('arch:simple-arrival-v1');
    });
  });
});
