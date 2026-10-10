import { describe, expect, it } from 'vitest';
import {
  COOLDOWN_BYPASS_WINDOW_MS,
  DESTINATION_COOLDOWN_BYPASS_MAX,
  tryConsumeCooldownBypass,
} from '../cooldownBypass';
import { InMemoryKV } from './inMemoryKv';

function makeKv(): KVNamespace {
  return new InMemoryKV() as unknown as KVNamespace;
}

describe('#2912 — tryConsumeCooldownBypass (destination-recovery 쿼터)', () => {
  it('첫 호출은 허용되고 count=1을 반환한다', async () => {
    const kv = makeKv();
    const result = await tryConsumeCooldownBypass(kv, 'tok');
    expect(result).toEqual({ allowed: true, count: 1 });
  });

  it(`같은 token으로 ${DESTINATION_COOLDOWN_BYPASS_MAX}회까지는 허용되고, ${DESTINATION_COOLDOWN_BYPASS_MAX + 1}번째는 거부된다 (쿼터 상한)`, async () => {
    const kv = makeKv();
    const now = Date.now();
    for (let i = 1; i <= DESTINATION_COOLDOWN_BYPASS_MAX; i += 1) {
      const result = await tryConsumeCooldownBypass(kv, 'tok', now + i);
      expect(result).toEqual({ allowed: true, count: i });
    }
    const exceeded = await tryConsumeCooldownBypass(kv, 'tok', now + DESTINATION_COOLDOWN_BYPASS_MAX + 1);
    expect(exceeded).toEqual({ allowed: false, count: DESTINATION_COOLDOWN_BYPASS_MAX });
  });

  it('상한 도달 후에는 KV를 쓰지 않는다 (count가 더 증가하지 않음)', async () => {
    const kv = makeKv();
    const now = Date.now();
    for (let i = 1; i <= DESTINATION_COOLDOWN_BYPASS_MAX; i += 1) {
      await tryConsumeCooldownBypass(kv, 'tok', now + i);
    }
    await tryConsumeCooldownBypass(kv, 'tok', now + 100);
    await tryConsumeCooldownBypass(kv, 'tok', now + 200);
    const stillExceeded = await tryConsumeCooldownBypass(kv, 'tok', now + 300);
    expect(stillExceeded).toEqual({ allowed: false, count: DESTINATION_COOLDOWN_BYPASS_MAX });
  });

  it('rolling window가 지나면 count가 리셋되어 다시 허용된다', async () => {
    const kv = makeKv();
    const now = Date.now();
    for (let i = 1; i <= DESTINATION_COOLDOWN_BYPASS_MAX; i += 1) {
      await tryConsumeCooldownBypass(kv, 'tok', now + i);
    }
    const stillBlocked = await tryConsumeCooldownBypass(kv, 'tok', now + COOLDOWN_BYPASS_WINDOW_MS - 1);
    expect(stillBlocked.allowed).toBe(false);

    const afterWindow = await tryConsumeCooldownBypass(kv, 'tok', now + COOLDOWN_BYPASS_WINDOW_MS + 1);
    expect(afterWindow).toEqual({ allowed: true, count: 1 });
  });

  it('다른 token은 독립적으로 쿼터를 가진다', async () => {
    const kv = makeKv();
    const now = Date.now();
    for (let i = 1; i <= DESTINATION_COOLDOWN_BYPASS_MAX; i += 1) {
      await tryConsumeCooldownBypass(kv, 'tok-a', now + i);
    }
    const otherToken = await tryConsumeCooldownBypass(kv, 'tok-b', now + 1);
    expect(otherToken).toEqual({ allowed: true, count: 1 });
  });

  it('손상된 KV 값(JSON parse 실패)은 미존재와 동등하게 처리해 허용한다', async () => {
    const kv = makeKv();
    await (kv as unknown as InMemoryKV).put('cooldownBypass:tok', 'not-json');
    const result = await tryConsumeCooldownBypass(kv, 'tok');
    expect(result).toEqual({ allowed: true, count: 1 });
  });

  it('schema 불일치(count/windowStartedAt 타입 틀림)도 미존재와 동등하게 처리한다', async () => {
    const kv = makeKv();
    await (kv as unknown as InMemoryKV).put('cooldownBypass:tok', JSON.stringify({ count: 'x' }));
    const result = await tryConsumeCooldownBypass(kv, 'tok');
    expect(result).toEqual({ allowed: true, count: 1 });
  });
});
