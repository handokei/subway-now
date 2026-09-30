import { describe, expect, it } from 'vitest';
import {
  BOARDING_PROMPT_FIRE_ONCE_KEY_PREFIX,
  BOARDING_PROMPT_FIRE_ONCE_TTL_SEC,
  boardingPromptFireOnceKey,
  checkBoardingPromptFireOnce,
  isBoardingPromptFireOnceBlocked,
  stampBoardingPromptFireOnce,
} from '../boardingPromptFireOnce';
import type { Env } from '../types';
import { InMemoryKV } from './inMemoryKv';

function makeEnvWithKv(kv: InMemoryKV): Env {
  return { TRIPS: kv as unknown as KVNamespace } as Env;
}

const NOW = 1_700_000_000_000;
const TOKEN = 'trip-tok-1';
const STATION = '건대입구';

describe('BOARDING_PROMPT_FIRE_ONCE_TTL_SEC (#2838)', () => {
  it('is 300s (5 min) — MIN_FIRE_INTERVAL_MS(boardingPrompt.ts)와 정합', () => {
    expect(BOARDING_PROMPT_FIRE_ONCE_TTL_SEC).toBe(5 * 60);
  });
});

describe('BOARDING_PROMPT_FIRE_ONCE_KEY_PREFIX (#2838)', () => {
  it('is "promptFireOnce:" — arvlCdFireOnceKey(fireOnce:)와 namespace 격리', () => {
    expect(BOARDING_PROMPT_FIRE_ONCE_KEY_PREFIX).toBe('promptFireOnce:');
  });
});

describe('boardingPromptFireOnceKey (#2838)', () => {
  it('formats key as promptFireOnce:{token}:{anchorKey}', () => {
    expect(boardingPromptFireOnceKey(TOKEN, STATION)).toBe(
      `promptFireOnce:${TOKEN}:${STATION}`,
    );
  });

  it('different tokens produce different keys — cross-trip leak 차단', () => {
    expect(boardingPromptFireOnceKey('trip-a', STATION)).not.toBe(
      boardingPromptFireOnceKey('trip-b', STATION),
    );
  });

  it('different anchor(station)는 다른 키 — leg-1/leg-2가 서로 다른 역이면 각각 독립 fire', () => {
    expect(boardingPromptFireOnceKey(TOKEN, '건대입구')).not.toBe(
      boardingPromptFireOnceKey(TOKEN, '뚝섬'),
    );
  });
});

describe('checkBoardingPromptFireOnce / stampBoardingPromptFireOnce (#2838)', () => {
  it('key 부재 시 false(발사 진행 가능)', async () => {
    const kv = new InMemoryKV();
    expect(
      await checkBoardingPromptFireOnce(kv as unknown as KVNamespace, TOKEN, STATION, NOW),
    ).toBe(false);
  });

  it('stamp 직후(경과 0ms) round-trip true', async () => {
    const kv = new InMemoryKV();
    await stampBoardingPromptFireOnce(kv as unknown as KVNamespace, TOKEN, STATION, NOW);
    expect(
      await checkBoardingPromptFireOnce(kv as unknown as KVNamespace, TOKEN, STATION, NOW),
    ).toBe(true);
  });

  it('stamp는 value=now, KV expirationTtl 5분(스토리지 cleanup 백스톱)으로 write', async () => {
    const kv = new InMemoryKV();
    await stampBoardingPromptFireOnce(kv as unknown as KVNamespace, TOKEN, STATION, NOW);
    const entry = kv.store.get(boardingPromptFireOnceKey(TOKEN, STATION));
    expect(entry?.value).toBe(String(NOW));
    expect(entry?.expiresAt).toBeGreaterThan(Date.now());
    expect(entry?.expiresAt).toBeLessThanOrEqual(Date.now() + 300_000 + 100);
  });

  // #2838 (evidence_20260804_replay.test.ts 회귀 방지) — 판정은 KV expirationTtl(wall-clock)이
  // 아니라 stamp된 value와 caller now의 직접 비교로 한다. 그렇지 않으면 5분 간격으로 서로 다른
  // 열차가 정당하게 반복 발사되는 기존 정책(evaluateBoardingPromptRepeatGate와 동일 기준)이
  // fire-once key에 의해 부당하게 차단된다.
  it('caller now 기준 5분 미경과 → true(차단)', async () => {
    const kv = new InMemoryKV();
    await stampBoardingPromptFireOnce(kv as unknown as KVNamespace, TOKEN, STATION, NOW);
    expect(
      await checkBoardingPromptFireOnce(
        kv as unknown as KVNamespace,
        TOKEN,
        STATION,
        NOW + BOARDING_PROMPT_FIRE_ONCE_TTL_SEC * 1000 - 1,
      ),
    ).toBe(true);
  });

  it('caller now 기준 정확히 5분 경과(repeat gate와 동일 boundary) → false(허용)', async () => {
    const kv = new InMemoryKV();
    await stampBoardingPromptFireOnce(kv as unknown as KVNamespace, TOKEN, STATION, NOW);
    expect(
      await checkBoardingPromptFireOnce(
        kv as unknown as KVNamespace,
        TOKEN,
        STATION,
        NOW + BOARDING_PROMPT_FIRE_ONCE_TTL_SEC * 1000,
      ),
    ).toBe(false);
  });

  it('손상된 value(숫자 아님)는 보수적으로 미발사(false)로 간주', async () => {
    const kv = new InMemoryKV();
    await kv.put(boardingPromptFireOnceKey(TOKEN, STATION), 'not-a-number');
    expect(
      await checkBoardingPromptFireOnce(kv as unknown as KVNamespace, TOKEN, STATION, NOW),
    ).toBe(false);
  });

  it('cross-station isolation — 다른 station stamp는 이 station check에 영향 X', async () => {
    const kv = new InMemoryKV();
    await stampBoardingPromptFireOnce(kv as unknown as KVNamespace, TOKEN, '뚝섬', NOW);
    expect(
      await checkBoardingPromptFireOnce(kv as unknown as KVNamespace, TOKEN, STATION, NOW),
    ).toBe(false);
  });
});

describe('isBoardingPromptFireOnceBlocked (#2838)', () => {
  it('env.TRIPS KV를 직접 조회 — stamp 없으면 false', async () => {
    const kv = new InMemoryKV();
    expect(await isBoardingPromptFireOnceBlocked(makeEnvWithKv(kv), TOKEN, STATION, NOW)).toBe(
      false,
    );
  });

  it('env.TRIPS KV에 신선한 stamp 있으면 true', async () => {
    const kv = new InMemoryKV();
    await stampBoardingPromptFireOnce(kv as unknown as KVNamespace, TOKEN, STATION, NOW);
    expect(await isBoardingPromptFireOnceBlocked(makeEnvWithKv(kv), TOKEN, STATION, NOW)).toBe(
      true,
    );
  });
});
