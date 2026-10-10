/**
 * Estimator 전략 결과를 in-memory ring buffer에 보관 (#1025).
 * DebugModal의 "Estimator State" 섹션이 구독해 마지막 채택 전략을 표시한다.
 */
import type { StationProgressStrategy } from './stationProgressEstimator';
import { createDebugBuffer } from '../../../shared/utils/createDebugBuffer';

// #1881 — 60분 trip 분량 보존. estimator push 빈도는 낮지만(hop advance 시만) 여유 확보 → 150.
export const ESTIMATOR_DEBUG_BUFFER_CAPACITY = 150;

export interface EstimatorDebugEntry {
  ts: number;
  strategy: StationProgressStrategy | null;
  stationName: string | null;
  stationLine: string | null;
  arcIndex: number | null;
}

const db = createDebugBuffer<EstimatorDebugEntry>(ESTIMATOR_DEBUG_BUFFER_CAPACITY);

export function pushEstimatorEntry(entry: EstimatorDebugEntry): void {
  db.push(entry);
}

export function getEstimatorEntries(): readonly EstimatorDebugEntry[] {
  return db.get();
}

export function clearEstimatorEntries(): void {
  db.clear();
}

export function subscribeEstimatorDebug(cb: () => void): () => void {
  return db.subscribe(cb);
}
