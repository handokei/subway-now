/**
 * In-memory ring buffer factory for debug/measurement channels.
 * push/get/clear/subscribe 패턴을 구현 — fusionDebugBuffer, estimatorDebugBuffer 공통.
 *
 * 구현: O(1) push circular buffer. 내부적으로 고정 크기 배열 + head index를 들고,
 * push마다 슬롯 1개만 덮어쓴다(이전 구현은 `[...buffer, entry]`로 매 push마다
 * O(n) 배열 복제 + GC 압박). cap=200 buffer가 1초에 수십 번 push되는 진단 채널에서
 * 200 × N copy가 누적돼 freeze 직전 GC pause를 키운 점이 #1540 (S7) RCA였다.
 * get()은 호출 시 1회만 chronological array를 만들어 반환 — push hot path에서 분리한다.
 */
export interface DebugBuffer<T> {
  push(entry: T): void;
  get(): readonly T[];
  clear(): void;
  subscribe(cb: () => void): () => void;
}

export function createDebugBuffer<T>(capacity: number): DebugBuffer<T> {
  // 고정 크기 슬롯. 채워지기 전까지는 undefined이지만, get()에서 length 기반으로 슬라이스해
  // 외부에 노출되지 않는다.
  const slots: Array<T | undefined> = new Array(capacity);
  // 다음 push가 들어갈 슬롯 index(0..capacity-1).
  let head = 0;
  // 현재 보관된 항목 수(0..capacity). capacity에 도달하면 더 늘지 않고 head만 wrap.
  let size = 0;
  const subscribers = new Set<() => void>();

  function notify(): void {
    for (const cb of [...subscribers]) {
      cb();
    }
  }

  return {
    push(entry: T): void {
      slots[head] = entry;
      head = (head + 1) % capacity;
      if (size < capacity) size += 1;
      notify();
    },
    get(): readonly T[] {
      if (size === 0) return [];
      // 가장 오래된 entry의 index. size<capacity면 0부터 채워졌으므로 0,
      // 가득 찼으면 head 위치가 곧 가장 오래된 슬롯.
      const out: T[] = new Array(size);
      const start = size < capacity ? 0 : head;
      for (let i = 0; i < size; i += 1) {
        out[i] = slots[(start + i) % capacity] as T;
      }
      return out;
    },
    clear(): void {
      if (size === 0) return;
      // 슬롯 참조 해제 — GC가 보관된 entry를 회수할 수 있도록.
      for (let i = 0; i < capacity; i += 1) slots[i] = undefined;
      head = 0;
      size = 0;
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
