/**
 * Device raw signal dump ring buffer (#1501, ADR-015 §10 P5 / PR-A).
 *
 * useFusedNearestStation 매 cycle, station enter/exit 시점에 push되는 측정 entry.
 * 외부 도구(Metro/Xcode) 없이 사후 재구성하기 위한 채널 — fusionDebugBuffer는 in-memory
 * 전용이라 강제종료 시 소실되는데, 본 buffer는 AsyncStorage로 영속화해 7일 회귀(2026-06-17
 * 용마산 trip)처럼 cold-launch 사이 데이터가 끊기는 사고를 막는다.
 *
 * 정책:
 *  - capacity 120 (cycle ~1Hz × 2분 windowfusion + enter/exit stamps)
 *  - boot 시 1회 hydrate (`hydrateRawSignalBuffer()`)
 *  - push 후 1초 idle throttle write — burst push에서 storage IO 폭주 차단
 *  - 손상 JSON / 키 부재 = 빈 buffer로 시작 (graceful)
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { RAW_SIGNAL_BUFFER_KEY } from '../../../shared/constants/storageKeys';
import { createDebugBuffer } from '../../../shared/utils/createDebugBuffer';
import type { FusionConfidence, FusionSource } from '../../../shared/types/fusion';

export const RAW_SIGNAL_BUFFER_CAPACITY = 120;
export const RAW_SIGNAL_WRITE_THROTTLE_MS = 1000;

export type RawSignalKind = 'cycle' | 'enter' | 'exit';
export type MotionLabel = 'stationary' | 'walking' | 'automotive' | 'unknown';
export type RawSignalDir = 'up' | 'down';

export interface RawSignalGps {
  lat: number;
  lng: number;
  accM: number | null;
  speedMps: number | null;
}

export interface RawSignalEntry {
  ts: number;
  corrId: string | null;
  kind: RawSignalKind;
  gps: RawSignalGps | null;
  motion: MotionLabel | null;
  subsurface: boolean | null;
  arvlCd: number | null;
  line: string | null;
  dir: RawSignalDir | null;
  arcIdx: number | null;
  arcProgress: number | null;
  stationId: string | null;
  source: FusionSource | null;
  confidence: FusionConfidence | null;
}

const db = createDebugBuffer<RawSignalEntry>(RAW_SIGNAL_BUFFER_CAPACITY);

let writeTimer: ReturnType<typeof setTimeout> | null = null;
let hydrated = false;

function scheduleWrite(): void {
  if (writeTimer !== null) {
    clearTimeout(writeTimer);
  }
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void flushNow();
  }, RAW_SIGNAL_WRITE_THROTTLE_MS);
}

async function flushNow(): Promise<void> {
  try {
    const entries = db.get();
    await AsyncStorage.setItem(RAW_SIGNAL_BUFFER_KEY, JSON.stringify(entries));
  } catch {
    // graceful — 다음 push 시 재시도.
  }
}

/** entry push + throttled write. */
export function pushRawSignal(entry: RawSignalEntry): void {
  db.push(entry);
  scheduleWrite();
}

/** 현재 buffer entries (in-memory copy). */
export function getRawSignalEntries(): readonly RawSignalEntry[] {
  return db.get();
}

/** buffer + 영속 데이터 모두 클리어. */
export function clearRawSignalEntries(): void {
  db.clear();
  if (writeTimer !== null) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  AsyncStorage.removeItem(RAW_SIGNAL_BUFFER_KEY).catch(() => {
    // graceful — 다음 write가 덮어씀.
  });
}

/** buffer 변경 구독 (DebugModal 등). */
export function subscribeRawSignal(cb: () => void): () => void {
  return db.subscribe(cb);
}

/**
 * Boot 시 1회 호출. AsyncStorage에서 buffer 복원.
 * 키 부재 / 손상 JSON / 비배열 모두 graceful no-op.
 * 멱등 — 두 번째 호출은 무시한다 (테스트에서 명시 reset 필요 시 __resetForTests__).
 */
export async function hydrateRawSignalBuffer(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = await AsyncStorage.getItem(RAW_SIGNAL_BUFFER_KEY);
    if (raw === null) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const item of parsed) {
      if (item && typeof item === 'object') {
        db.push(item as RawSignalEntry);
      }
    }
  } catch {
    // graceful — 손상 JSON 무시, 빈 buffer로 시작.
  }
}

/** 테스트 전용 — hydration latch + timer 초기화. */
export function __resetRawSignalForTests__(): void {
  db.clear();
  if (writeTimer !== null) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  hydrated = false;
}
