import { describe, expect, it, vi } from 'vitest';
import {
  ARVLCD_FIRE_ONCE_KEY_PREFIX,
  ARVLCD_FIRE_ONCE_TTL_SEC,
  arvlCdFireOnceKey,
  checkArvlCdFireOnce,
  isSimpleArchEnabled,
  stampArvlCdFireOnce,
} from '../arvlcdFireOnceTtl';
import { ARCH_FLAG_KV_KEY } from '../archFlag';
import type { Env } from '../types';
import { InMemoryKV } from './inMemoryKv';

function makeEnvWithKv(kv: InMemoryKV): Env {
  return { TRIPS: kv as unknown as KVNamespace } as Env;
}

const NOW = 1_700_000_000_000;
const TOKEN = 'trip-tok-1';
const STATION = '어린이대공원';
const CYCLE = 0;

describe('ARVLCD_FIRE_ONCE_TTL_SEC (#1985)', () => {
  it('is 300s (5 min) — physical train cannot revisit station within 5 min', () => {
    expect(ARVLCD_FIRE_ONCE_TTL_SEC).toBe(5 * 60);
  });
});

describe('ARVLCD_FIRE_ONCE_KEY_PREFIX (#1985)', () => {
  it('is "fireOnce:" — isolated namespace from arvlcd-fire: legacy dedup', () => {
    expect(ARVLCD_FIRE_ONCE_KEY_PREFIX).toBe('fireOnce:');
  });
});

describe('arvlCdFireOnceKey (#1985)', () => {
  it('formats key as fireOnce:{token}:{station}:{cycle}', () => {
    expect(arvlCdFireOnceKey(TOKEN, STATION, CYCLE)).toBe(
      `fireOnce:${TOKEN}:${STATION}:${CYCLE}`,
    );
  });

  it('different tokens produce different keys — cross-trip leak 차단', () => {
    expect(arvlCdFireOnceKey('trip-a', STATION, CYCLE)).not.toBe(
      arvlCdFireOnceKey('trip-b', STATION, CYCLE),
    );
  });

  it('different stations produce different keys — 같은 trip 다른 역 각각 fire', () => {
    expect(arvlCdFireOnceKey(TOKEN, '어린이대공원', CYCLE)).not.toBe(
      arvlCdFireOnceKey(TOKEN, '건대입구', CYCLE),
    );
  });

  it('different cycles produce different keys — 미래-확장 slot 동작 확인', () => {
    expect(arvlCdFireOnceKey(TOKEN, STATION, 0)).not.toBe(
      arvlCdFireOnceKey(TOKEN, STATION, 1),
    );
  });
});

describe('checkArvlCdFireOnce (#1985)', () => {
  it('returns false when key is absent (첫 관측 fire 진행 가능)', async () => {
    const kv = new InMemoryKV();
    const result = await checkArvlCdFireOnce(
      kv as unknown as KVNamespace,
      TOKEN,
      STATION,
      CYCLE,
    );
    expect(result).toBe(false);
  });

  it('returns true when key is present (같은 cycle 이내 재관측 → skip)', async () => {
    const kv = new InMemoryKV();
    await kv.put(arvlCdFireOnceKey(TOKEN, STATION, CYCLE), String(NOW));
    const result = await checkArvlCdFireOnce(
      kv as unknown as KVNamespace,
      TOKEN,
      STATION,
      CYCLE,
    );
    expect(result).toBe(true);
  });

  it('cross-trip isolation — trip A stamp 는 trip B check 에 영향 X', async () => {
    const kv = new InMemoryKV();
    await kv.put(arvlCdFireOnceKey('trip-a', STATION, CYCLE), String(NOW));
    const bResult = await checkArvlCdFireOnce(
      kv as unknown as KVNamespace,
      'trip-b',
      STATION,
      CYCLE,
    );
    expect(bResult).toBe(false);
  });

  it('cross-station isolation — station A stamp 는 station B check 에 영향 X', async () => {
    const kv = new InMemoryKV();
    await kv.put(arvlCdFireOnceKey(TOKEN, '어린이대공원', CYCLE), String(NOW));
    const bResult = await checkArvlCdFireOnce(
      kv as unknown as KVNamespace,
      TOKEN,
      '건대입구',
      CYCLE,
    );
    expect(bResult).toBe(false);
  });
});

describe('stampArvlCdFireOnce (#1985)', () => {
  it('writes value=now with 5-min TTL', async () => {
    const kv = new InMemoryKV();
    await stampArvlCdFireOnce(
      kv as unknown as KVNamespace,
      TOKEN,
      STATION,
      CYCLE,
      NOW,
    );
    const entry = kv.store.get(arvlCdFireOnceKey(TOKEN, STATION, CYCLE));
    expect(entry).toBeDefined();
    expect(entry?.value).toBe(String(NOW));
    // expirationTtl 300s → expiresAt = Date.now() + 300_000 (InMemoryKV 는 Date.now()로 stamp)
    expect(entry?.expiresAt).toBeGreaterThan(Date.now());
    expect(entry?.expiresAt).toBeLessThanOrEqual(Date.now() + 300_000 + 100);
  });

  it('after stamp, checkArvlCdFireOnce returns true (round-trip)', async () => {
    const kv = new InMemoryKV();
    expect(
      await checkArvlCdFireOnce(kv as unknown as KVNamespace, TOKEN, STATION, CYCLE),
    ).toBe(false);
    await stampArvlCdFireOnce(kv as unknown as KVNamespace, TOKEN, STATION, CYCLE, NOW);
    expect(
      await checkArvlCdFireOnce(kv as unknown as KVNamespace, TOKEN, STATION, CYCLE),
    ).toBe(true);
  });

  it('TTL 만료 후 check 는 false (naturally expires)', async () => {
    // InMemoryKV 의 만료는 Date.now() 기준 — vi.useFakeTimers 로 시간 진행.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      const kv = new InMemoryKV();
      await stampArvlCdFireOnce(kv as unknown as KVNamespace, TOKEN, STATION, CYCLE, NOW);
      // 5분 초과 진행
      vi.setSystemTime(NOW + ARVLCD_FIRE_ONCE_TTL_SEC * 1000 + 1);
      expect(
        await checkArvlCdFireOnce(kv as unknown as KVNamespace, TOKEN, STATION, CYCLE),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('isSimpleArchEnabled (#2201 real getArchFlag(env.TRIPS) wire)', () => {
  it('returns false — KV 미설정 default (getArchFlag default off)', async () => {
    const kv = new InMemoryKV();
    expect(await isSimpleArchEnabled(makeEnvWithKv(kv))).toBe(false);
  });

  it('returns true — remote KV flag="on"', async () => {
    const kv = new InMemoryKV();
    await kv.put(ARCH_FLAG_KV_KEY, 'on');
    expect(await isSimpleArchEnabled(makeEnvWithKv(kv))).toBe(true);
  });

  it('returns false — remote KV flag="off"', async () => {
    const kv = new InMemoryKV();
    await kv.put(ARCH_FLAG_KV_KEY, 'off');
    expect(await isSimpleArchEnabled(makeEnvWithKv(kv))).toBe(false);
  });
});
