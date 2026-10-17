export class TtlCache<K, V> {
  private map = new Map<K, { data: V; timestamp: number }>();

  constructor(private ttlMs: number) {}

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp >= this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return entry.data;
  }

  set(key: K, value: V): void {
    this.map.set(key, { data: value, timestamp: Date.now() });
  }

  clear(): void {
    this.map.clear();
  }
}
