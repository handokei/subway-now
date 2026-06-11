/**
 * In-memory ring buffer factory for debug/measurement channels.
 * push/get/clear/subscribe 패턴을 구현 — fusionDebugBuffer, estimatorDebugBuffer 공통.
 */
export interface DebugBuffer<T> {
  push(entry: T): void;
  get(): readonly T[];
  clear(): void;
  subscribe(cb: () => void): () => void;
}

export function createDebugBuffer<T>(capacity: number): DebugBuffer<T> {
  let buffer: T[] = [];
  const subscribers = new Set<() => void>();

  function notify(): void {
    for (const cb of [...subscribers]) {
      cb();
    }
  }

  return {
    push(entry: T): void {
      buffer = [...buffer, entry];
      if (buffer.length > capacity) {
        buffer = buffer.slice(buffer.length - capacity);
      }
      notify();
    },
    get(): readonly T[] {
      return buffer;
    },
    clear(): void {
      if (buffer.length === 0) return;
      buffer = [];
      notify();
    },
    subscribe(cb: () => void): () => void {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
  };
}
