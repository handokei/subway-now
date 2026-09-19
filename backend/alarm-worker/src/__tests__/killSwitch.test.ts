import { describe, expect, it } from 'vitest';
import {
  getKillSwitch,
  isKillSwitchKey,
  isKillSwitchValue,
  KILL_SWITCH_DEFAULT,
  setKillSwitch,
} from '../killSwitch';
import { InMemoryKV } from './inMemoryKv';

describe('killSwitch (#1967 Ff-1)', () => {
  describe('isKillSwitchKey', () => {
    it('accepts lockless_intermediate', () => {
      expect(isKillSwitchKey('lockless_intermediate')).toBe(true);
    });

    it('rejects unknown keys', () => {
      expect(isKillSwitchKey('unknown_gate')).toBe(false);
      expect(isKillSwitchKey('')).toBe(false);
    });

    it('rejects non-string values', () => {
      expect(isKillSwitchKey(null)).toBe(false);
      expect(isKillSwitchKey(undefined)).toBe(false);
      expect(isKillSwitchKey(1)).toBe(false);
      expect(isKillSwitchKey({})).toBe(false);
    });
  });

  describe('isKillSwitchValue', () => {
    it('accepts true / false strings', () => {
      expect(isKillSwitchValue('true')).toBe(true);
      expect(isKillSwitchValue('false')).toBe(true);
    });

    it('rejects other strings', () => {
      expect(isKillSwitchValue('on')).toBe(false);
      expect(isKillSwitchValue('TRUE')).toBe(false);
      expect(isKillSwitchValue('')).toBe(false);
    });

    it('rejects non-string values', () => {
      expect(isKillSwitchValue(null)).toBe(false);
      expect(isKillSwitchValue(undefined)).toBe(false);
      expect(isKillSwitchValue(true)).toBe(false);
      expect(isKillSwitchValue({})).toBe(false);
    });
  });

  describe('getKillSwitch', () => {
    it('returns default when kv is undefined (개발 환경 호환)', async () => {
      expect(await getKillSwitch(undefined, 'lockless_intermediate')).toBe(KILL_SWITCH_DEFAULT);
    });

    it('returns default when key is not set (dormant)', async () => {
      const kv = new InMemoryKV() as unknown as KVNamespace;
      expect(await getKillSwitch(kv, 'lockless_intermediate')).toBe('false');
    });

    it('returns "true" when kv is set to true', async () => {
      const kv = new InMemoryKV() as unknown as KVNamespace;
      await setKillSwitch(kv, 'lockless_intermediate', 'true');
      expect(await getKillSwitch(kv, 'lockless_intermediate')).toBe('true');
    });

    it('returns "false" when kv is set to false', async () => {
      const kv = new InMemoryKV() as unknown as KVNamespace;
      await setKillSwitch(kv, 'lockless_intermediate', 'true');
      await setKillSwitch(kv, 'lockless_intermediate', 'false');
      expect(await getKillSwitch(kv, 'lockless_intermediate')).toBe('false');
    });

    it('falls back to default when kv has invalid value (오타 방어)', async () => {
      const kv = new InMemoryKV() as unknown as KVNamespace;
      await kv.put('kill-switch:lockless-intermediate', 'on');
      expect(await getKillSwitch(kv, 'lockless_intermediate')).toBe(KILL_SWITCH_DEFAULT);
    });

    it('reads with cron cacheTtl convention (>= 30s) — invalid ttl would throw via KV mock', async () => {
      // #1423 — InMemoryKV.get이 cacheTtl < 30을 throw. getKillSwitch가 정책값(30s)을 넘겨
      // throw 없이 통과하는 것으로 컨벤션 준수를 검증한다.
      const kv = new InMemoryKV() as unknown as KVNamespace;
      await expect(getKillSwitch(kv, 'lockless_intermediate')).resolves.toBe('false');
    });
  });

  describe('setKillSwitch', () => {
    it('writes "true" to KV', async () => {
      const kv = new InMemoryKV() as unknown as KVNamespace;
      await setKillSwitch(kv, 'lockless_intermediate', 'true');
      expect(await kv.get('kill-switch:lockless-intermediate')).toBe('true');
    });

    it('writes "false" to KV', async () => {
      const kv = new InMemoryKV() as unknown as KVNamespace;
      await setKillSwitch(kv, 'lockless_intermediate', 'true');
      await setKillSwitch(kv, 'lockless_intermediate', 'false');
      expect(await kv.get('kill-switch:lockless-intermediate')).toBe('false');
    });

    it('throws on invalid value (잘못된 KV 상태 진입 차단)', async () => {
      const kv = new InMemoryKV() as unknown as KVNamespace;
      await expect(
        setKillSwitch(kv, 'lockless_intermediate', 'on' as unknown as 'true'),
      ).rejects.toThrow(/invalid value/);
      expect(await kv.get('kill-switch:lockless-intermediate')).toBeNull();
    });
  });

  describe('constants', () => {
    it('default is false', () => {
      expect(KILL_SWITCH_DEFAULT).toBe('false');
    });
  });
});
