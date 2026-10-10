import AsyncStorage from '@react-native-async-storage/async-storage';
import { PUSH_RECEIPT_BUFFER_KEY } from '../../../shared/constants/storageKeys';
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
 * 동일 패턴 — #1540 lesson_gps_drop_fusion_buffer_pollution 재발 방지 구조 재사용).
 *
 * AsyncStorage 영속 필수(audit-sides 자가점검으로 추가) — `logPushReceipt`는 BG headless JS
 * 컨텍스트(silentPushTask.ts)에서도 호출된다. BG 프로세스는 FG(DebugModal이 mount되는 앱
 * 본체) 와 별도 JS 인스턴스라, in-memory 전용이면 BG가 적재한 receipt가 FG에 전혀 전달되지
 * 않는다 — `rawSignalBuffer`가 원래 갖고 있던 "BG→FG 영속 전달" 보장을 독립 채널로 분리하며
 * 빠뜨리면 편측 결함이 된다. `rawSignalBuffer.ts`와 동일 패턴(hydrate 1회 + throttled write).
 *
 * cap=60 — 환승 포함 최장 트립 waypoint 수(~40개)의 1.5배 여유.
 */
export const PUSH_RECEIPT_BUFFER_CAPACITY = 60;
export const PUSH_RECEIPT_WRITE_THROTTLE_MS = 1000;

export interface PushReceiptBufferEntry {
  ts: number;
  corrId: string | null;
  detail: PushReceiptDetail;
}

const db = createDebugBuffer<PushReceiptBufferEntry>(PUSH_RECEIPT_BUFFER_CAPACITY);

let writeTimer: ReturnType<typeof setTimeout> | null = null;
let hydrated = false;

function scheduleWrite(): void {
  if (writeTimer !== null) {
    clearTimeout(writeTimer);
  }
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void flushNow();
  }, PUSH_RECEIPT_WRITE_THROTTLE_MS);
}

async function flushNow(): Promise<void> {
  try {
    const entries = db.get();
    await AsyncStorage.setItem(PUSH_RECEIPT_BUFFER_KEY, JSON.stringify(entries));
  } catch {
    // graceful — 다음 push 시 재시도.
  }
}

/** entry push + throttled write(BG→FG 전달 보장). */
export function pushPushReceiptEntry(entry: PushReceiptBufferEntry): void {
  db.push(entry);
  scheduleWrite();
}

export function getPushReceiptEntries(): readonly PushReceiptBufferEntry[] {
  return db.get();
}

/** buffer + 영속 데이터 모두 클리어. */
export function clearPushReceiptEntries(): void {
  db.clear();
  if (writeTimer !== null) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  AsyncStorage.removeItem(PUSH_RECEIPT_BUFFER_KEY).catch(() => {
    // graceful — 다음 write가 덮어씀.
  });
}

export function subscribePushReceipt(listener: () => void): () => void {
  return db.subscribe(listener);
}

/**
 * Boot 시 1회 호출(app/_layout.tsx, hydrateRawSignalBuffer와 동일 사이트). AsyncStorage에서
 * buffer 복원 — BG 프로세스가 앱 재개/재시작 사이에 적재한 receipt를 FG가 읽을 수 있게 한다.
 * 키 부재 / 손상 JSON / 비배열 모두 graceful no-op. 멱등 — 두 번째 호출은 무시한다(테스트에서
 * 명시 reset 필요 시 __resetPushReceiptForTests__).
 */
export async function hydratePushReceiptBuffer(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = await AsyncStorage.getItem(PUSH_RECEIPT_BUFFER_KEY);
    if (raw === null) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const item of parsed) {
      if (item && typeof item === 'object') {
        db.push(item as PushReceiptBufferEntry);
      }
    }
  } catch {
    // graceful — 손상 JSON 무시, 빈 buffer로 시작.
  }
}

/** 테스트 전용 — hydration latch + timer + in-memory buffer 초기화. */
export function __resetPushReceiptForTests__(): void {
  db.clear();
  if (writeTimer !== null) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  hydrated = false;
}
