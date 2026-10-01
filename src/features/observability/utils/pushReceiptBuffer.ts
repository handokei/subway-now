import { createDebugBuffer } from '../../../shared/utils/createDebugBuffer';
import type { PushReceiptDetail } from './rawSignalBuffer';

/**
 * #2861 (T1) — push-receipt 전용 ring buffer.
 *
 * root: `logPushReceipt`(pushReceiptLog.ts)가 fusion cycle(30초마다 push)과 **공유**하는
 * `rawSignalBuffer`(cap=300, FIFO)에 함께 적재했다. 긴 트립(60분+)은 cycle entry만으로 300
 * cap을 넘겨, 트립 초반에 기록된 push-receipt(예: 어대·군자)가 뒤 cycle entry에 밀려 증발한다 —
 * `computeWholeChainLines`(DebugModal.tsx)는 receipt 없는 역을 행에서 **생략**(N으로도 안 남음)해
 * Whole Chain 패널이 "그 역에서 끊겼다"가 아니라 "그 역이 아예 없었다"는 거짓 진단을 유발했다
 * (2026-10-01 trace).
 *
 * fix: push-receipt을 cycle/enter/exit과 cap을 공유하지 않는 독립 채널로 분리(gpsDropBuffer와
 * 동일 패턴 — #1540 lesson_gps_drop_fusion_buffer_pollution 재발 방지 구조 재사용). in-memory
 * 전용(영속화 없음) — cold-restart 사이 receipt 유실은 기존 rawSignalBuffer 공유 당시에도 없던
 * 보장이라 신규 결함이 아니다.
 *
 * cap=60 — 환승 포함 최장 트립 waypoint 수(~40개)의 1.5배 여유.
 */
export const PUSH_RECEIPT_BUFFER_CAPACITY = 60;

export interface PushReceiptBufferEntry {
  ts: number;
  corrId: string | null;
  detail: PushReceiptDetail;
}

const db = createDebugBuffer<PushReceiptBufferEntry>(PUSH_RECEIPT_BUFFER_CAPACITY);

export function pushPushReceiptEntry(entry: PushReceiptBufferEntry): void {
  db.push(entry);
}

export function getPushReceiptEntries(): readonly PushReceiptBufferEntry[] {
  return db.get();
}

export function clearPushReceiptEntries(): void {
  db.clear();
}

export function subscribePushReceipt(listener: () => void): () => void {
  return db.subscribe(listener);
}
