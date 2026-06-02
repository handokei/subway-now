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

  async list(options?: { prefix?: string; cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor: string;
  }> {
    const prefix = options?.prefix ?? '';
    const keys = [...this.store.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((name) => ({ name }));
    return { keys, list_complete: true, cursor: '' };
  }
}
