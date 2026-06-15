/**
 * Estimator 전략 결과를 in-memory ring buffer에 보관 (#1025).
 * DebugModal의 "Estimator State" 섹션이 구독해 마지막 채택 전략을 표시한다.
 */
import type { StationProgressStrategy } from './stationProgressEstimator';
import { createDebugBuffer } from '../../../shared/utils/createDebugBuffer';
import { registerDebugBuffer } from '../../../shared/utils/debugBufferRegistry';
import { formatLineTime } from '../../../shared/utils/formatTime';

export const ESTIMATOR_DEBUG_BUFFER_CAPACITY = 50;

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

/** #1348 — estimator 엔트리 한 줄 텍스트 포맷. share dump / UI 양쪽 SSOT. */
export function formatEstimatorLine(entry: EstimatorDebugEntry): string {
  const time = formatLineTime(entry.ts);
  const strategy = entry.strategy ?? 'none';
  const station = entry.stationName
    ? `${entry.stationName}(${entry.stationLine ?? '-'})`
    : '-';
  const idx = entry.arcIndex != null ? `idx=${entry.arcIndex}` : 'idx=-';
  return `${time} | ${strategy} | ${station} ${idx}`;
}

// #1348 — share dump SSOT 등록. module import 시점에 한 번 호출돼 자동 enumerate.
registerDebugBuffer({
  key: 'Estimator State',
  dumpLines: () => getEstimatorEntries().map(formatEstimatorLine),
});
