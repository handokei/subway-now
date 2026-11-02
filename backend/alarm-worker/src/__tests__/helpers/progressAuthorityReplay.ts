/**
 * #2308 — "진행 위치 단일 작성자" whole-trip replay 공용 helper.
 *
 * 두 replay(`replay_20261031_reregister_storm`, `replay_20261102_lockless_jump_leg2`)가 공유한다:
 *   - KV 엣지 캐시 지연(`CacheLagKV`, 읽기의 cacheTtl이 곧 지연: 미지정 60s / cron 30s) — 같은 세션 재등록이
 *     cron 직전 쓰기를 못 보고 낡은 trip을 읽는 실제 창을 재현한다(`trips.ts` getTrip / `progress.ts` getProgress).
 *   - 운영 archFlag(on) — `route-signature-mismatch` 분기와 self-progress 판정은 flag on에서만 돈다.
 *   - 재생 시계: 재등록은 D1 실측 ts로 `Date.now`를 고정해 주입(createDeviceReplayer), cron은 tick으로 고정.
 * 프로덕션 코드는 건드리지 않는다.
 */
import { vi } from 'vitest';
import { ARCH_FLAG_KV_KEY } from '../../archFlag';
import { progressKey, type TripProgress } from '../../progress';
import { tripKey } from '../../trips';
import type { Env, Trip } from '../../types';
import { CacheLagKV } from './cacheLagKv';
import type { InMemoryKV } from '../inMemoryKv';

/** KV 기본 cacheTtl(미지정 읽기) = 60s. */
export const KV_DEFAULT_CACHE_TTL_SEC = 60;

/** 엣지 캐시 지연을 읽기의 cacheTtl로 모델링하는 KV 팩토리(`runCaptureReplay({ makeKv })`). */
export const makeLagKv = (clocks: {
  now: () => number;
  prefixClocks: ReadonlyArray<{ prefix: string; now: () => number }>;
}): InMemoryKV =>
  new CacheLagKV(0, {
    byCacheTtl: { defaultTtlSec: KV_DEFAULT_CACHE_TTL_SEC, laggedPrefixes: ['trip:', 'progress:'] },
    now: clocks.now,
    prefixClocks: clocks.prefixClocks,
  });

/** replay 시작 직전 상태 주입: 운영 archFlag on + (옵션) seed progress. 지연 창 밖의 시각에 써서 첫 tick부터 보이게 한다. */
export async function primeReplayKv(
  kv: KVNamespace,
  tick: number,
  opts: { token: string; progress?: TripProgress },
): Promise<void> {
  vi.setSystemTime(tick - 5 * 60_000);
  await kv.put(ARCH_FLAG_KV_KEY, 'on');
  if (opts.progress) {
    await kv.put(progressKey(opts.token), JSON.stringify(opts.progress), { expirationTtl: 3 * 60 * 60 });
  }
  vi.setSystemTime(tick);
}

/** 가장 최신 trip(지연 없음) — 외부 관찰용. */
export function latestTrip(kv: KVNamespace, token: string): Trip | null {
  const raw = (kv as unknown as InMemoryKV).store.get(tripKey(token))?.value;
  return raw === undefined ? null : (JSON.parse(raw) as Trip);
}

/** 가장 최신 progress(지연 없음) — 외부 관찰용. */
export function latestProgress(kv: KVNamespace, token: string): TripProgress | null {
  const raw = (kv as unknown as InMemoryKV).store.get(progressKey(token))?.value;
  return raw === undefined ? null : (JSON.parse(raw) as TripProgress);
}

/** 재생 env에 D1 sink를 붙인다(createDeviceReplayer 패턴). */
export function attachDb(env: Env, db: D1Database): void {
  (env as unknown as { DB: D1Database }).DB = db;
}
