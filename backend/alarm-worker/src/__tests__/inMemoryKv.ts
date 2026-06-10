/**
 * Cloudflare KVNamespace의 in-memory test double.
 * 여러 테스트 파일이 공유 — 동일 코드 중복으로 Sonar duplication에 잡히지 않게 단일 정의.
 *
 * 의도적으로 KVNamespace 일부 메서드(get/put/delete/list)만 구현 —
 * 실제 KV의 완전한 호환이 아닌, 테스트가 사용하는 표면만 mimic.
 */
export class InMemoryKV {
  store = new Map<string, { value: string; expiresAt?: number }>();

  /**
   * 실제 KV.get(key, options) 시그니처 호환 — 옵션은 cacheTtl 등 캐시 hint이고
   * in-memory store는 캐싱 자체가 없어 무시한다. #766에서 cron paths가 cacheTtl을 전달하기
   * 시작해 호환 인자가 필요해졌다.
   */
  async get(key: string, _options?: { cacheTtl?: number }): Promise<string | null> {
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
    const allMatching = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort();
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
