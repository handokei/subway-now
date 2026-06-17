import { KV_MIN_CACHE_TTL_SEC } from '../kvConsistency';

/**
 * Cloudflare KVNamespace의 in-memory test double.
 * 여러 테스트 파일이 공유 — 동일 코드 중복으로 Sonar duplication에 잡히지 않게 단일 정의.
 *
 * 의도적으로 KVNamespace 일부 메서드(get/put/delete/list)만 구현 —
 * 실제 KV의 완전한 호환이 아닌, 테스트가 사용하는 표면만 mimic.
 *
 * #1423 — 런타임 제약 시뮬레이션. Cloudflare KV는 `cacheTtl < 30` read를 400으로 throw하지만
 * 과거 본 mock은 옵션을 silently 무시 → spec 위반이 spy/assertion만 통과해 production 회귀로
 * 빠져나갔다 (lesson_test_mock_must_validate_runtime.md). 이제 `get`이 production CF KV와
 * 동일한 메시지로 throw해 테스트 단계에서 잡힌다.
 */
export class InMemoryKV {
  store = new Map<string, { value: string; expiresAt?: number }>();

  /**
   * 실제 KV.get(key, options) 시그니처 호환. #1423 — Cloudflare KV runtime은 `cacheTtl < 30`
   * 을 `Invalid cache_ttl of N. Cache TTL must be at least 30.` 400 throw로 거절한다.
   * 본 mock도 동일하게 throw해야 caller가 production과 같은 실패 모드를 테스트할 수 있다.
   * cacheTtl 미지정(undefined)은 통과 — KV 기본 60s가 적용되는 caller 시나리오.
   */
  async get(key: string, options?: { cacheTtl?: number }): Promise<string | null> {
    if (options?.cacheTtl !== undefined && options.cacheTtl < KV_MIN_CACHE_TTL_SEC) {
      // #1423 — production Cloudflare KV가 던지는 메시지와 동일 포맷.
      throw new Error(
        `KV GET failed: 400 Invalid cache_ttl of ${options.cacheTtl}. Cache TTL must be at least ${KV_MIN_CACHE_TTL_SEC}.`,
      );
    }
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    const expiresAt = options?.expirationTtl
      ? Date.now() + options.expirationTtl * 1000
      : undefined;
    this.store.set(key, { value, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  /**
   * `pageSize`를 인스턴스 필드로 두고 cursor로 잇는 KV 의사 동작.
   * 기본은 `Infinity` → 단일 페이지(기존 호환). 테스트에서 페이지네이션 회귀를 확인할 때만
   * `kv.pageSize = N`으로 작게 설정한다.
   */
  pageSize = Number.POSITIVE_INFINITY;

  async list(options?: { prefix?: string; cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor: string;
  }> {
    const prefix = options?.prefix ?? '';
    const allMatching = [...this.store.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort((a, b) => a.localeCompare(b));
    const startIdx = options?.cursor ? Number.parseInt(options.cursor, 10) : 0;
    const safeStart = Number.isFinite(startIdx) && startIdx >= 0 ? startIdx : 0;
    const endIdx = Number.isFinite(this.pageSize)
      ? Math.min(allMatching.length, safeStart + this.pageSize)
      : allMatching.length;
    const page = allMatching.slice(safeStart, endIdx).map((name) => ({ name }));
    const complete = endIdx >= allMatching.length;
    return {
      keys: page,
      list_complete: complete,
      cursor: complete ? '' : String(endIdx),
    };
  }
}
