/**
 * Estimator 전략 결과를 in-memory ring buffer에 보관 (#1025).
 * DebugModal의 "Estimator State" 섹션이 구독해 마지막 채택 전략을 표시한다.
 *
 * fusion debug buffer와 동일 패턴 — 구독자는 pushEstimatorEntry가 호출될 때마다
 * 전달받은 콜백으로 최신 버퍼를 갱신한다.
 */
import type { StationProgressStrategy } from './stationProgressEstimator';

export const ESTIMATOR_DEBUG_BUFFER_CAPACITY = 50;

export interface EstimatorDebugEntry {
  ts: number;
  strategy: StationProgressStrategy | null;
  stationName: string | null;
  stationLine: string | null;
  arcIndex: number | null;
}

let buffer: EstimatorDebugEntry[] = [];
const subscribers: Set<() => void> = new Set();

export function pushEstimatorEntry(entry: EstimatorDebugEntry): void {
  buffer = [...buffer, entry];
  if (buffer.length > ESTIMATOR_DEBUG_BUFFER_CAPACITY) {
    buffer = buffer.slice(buffer.length - ESTIMATOR_DEBUG_BUFFER_CAPACITY);
  }
  for (const cb of subscribers) cb();
}

export function getEstimatorEntries(): readonly EstimatorDebugEntry[] {
  return buffer;
}

export function clearEstimatorEntries(): void {
  buffer = [];
  for (const cb of subscribers) cb();
}

export function subscribeEstimatorDebug(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}
