import { KV_MIN_CACHE_TTL_SEC } from '../../kvConsistency';
import { InMemoryKV } from '../inMemoryKv';

interface Version {
  at: number;
  value: string | null;
  expiresAt?: number;
}

/**
 * #3006 — KV 엣지 캐시 지연(`cacheTtl` + 전파) 시뮬레이터.
 *
 * `get`은 `Date.now() - lagMs` 시점의 버전 스냅샷을 돌려주고(그때 삭제돼 있었으면 null,
 * 그 시점 TTL이 만료였으면 null), `put`/`delete`는 즉시 반영한다. 실 KV에서 "방금 지운 키가
 * 최대 cacheTtl(+전파) 동안 옛 값으로 읽히는" 창을 재현해 stale-read 후 write 경로를 테스트한다.
 * 시계는 `Date.now()`라 `vi.useFakeTimers` + `vi.setSystemTime`과 맞물린다.
 */
export class CacheLagKV extends InMemoryKV {
  private readonly history = new Map<string, Version[]>();

  constructor(private readonly lagMs: number) {
    super();
  }

  override async get(key: string, options?: { cacheTtl?: number }): Promise<string | null> {
    if (options?.cacheTtl !== undefined && options.cacheTtl < KV_MIN_CACHE_TTL_SEC) {
      throw new Error(`KV GET failed: 400 Invalid cache_ttl of ${options.cacheTtl}.`);
    }
    const versions = this.history.get(key);
    if (!versions) return super.get(key, options);
    const visibleAt = Date.now() - this.lagMs;
    const visible = [...versions].reverse().find((v) => v.at <= visibleAt);
    if (!visible || visible.value === null) return null;
    if (visible.expiresAt !== undefined && visible.expiresAt < visibleAt) return null;
    return visible.value;
  }

  override async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    await super.put(key, value, options);
    const expiresAt = options?.expirationTtl
      ? Date.now() + options.expirationTtl * 1000
      : undefined;
    this.record(key, { at: Date.now(), value, expiresAt });
  }

  override async delete(key: string): Promise<void> {
    await super.delete(key);
    this.record(key, { at: Date.now(), value: null });
  }

  private record(key: string, version: Version): void {
    const versions = this.history.get(key) ?? [];
    versions.push(version);
    this.history.set(key, versions);
  }
}
