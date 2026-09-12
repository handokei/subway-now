import { createDebugBuffer } from '../../../shared/utils/createDebugBuffer';

/**
 * #1540 (S7) — gps-drop 전용 ring buffer. fusionDebugBuffer와 분리해, 저정확도 fix
 * 진단 entry가 fire-related entry(fusion decision / sticky lock / gps-fix)를 점령하지
 * 못하게 한다.
 *
 * 배경(memory `lesson_gps_drop_fusion_buffer_pollution`):
 *  - 2026-06-19 트립 1+2 fusionDebugBuffer 200 cap이 gps-drop entry로 가득 차
 *    freeze 직전 fire 분석에 필요한 fusion decision/sticky 이력이 모두 evicted됨.
 *  - iOS deferred batch가 같은 timestamp의 18+건을 다발로 흘려 dedup gate를 우회.
 *  - "low-accuracy fix도 사후 진단에 필요"라는 #443 주석은 유효하지만 다른 채널과
 *    cap을 공유하면 자기 목적(사후 진단)을 파괴한다.
 *
 * cap=200 (#1881) — 60분 trip 전체 커버. burst dedup(rate-limited)이 push 속도를 이미 제한하므로
 * 200건은 충분한 진단 윈도우를 보장한다. fusionDebugBuffer(500)와 격리된 별 채널이라 메모리 합산
 * 부담도 수용 범위 이내.
 */
export const GPS_DROP_BUFFER_CAPACITY = 200;

export interface GpsDropEntry {
  ts: number;
  lat: number;
  lng: number;
  /** GPS accuracy. null은 측정 불가(invalid)가 아니라 OS가 미제공한 케이스. */
  accuracyMeters: number | null;
  /** isValidGpsSpeedMps 통과한 양수 또는 null(측정 불가/정지). */
  speedMps: number | null;
  /** 예: 'low-accuracy-display' | `rate-limited:${number}`. */
  dropReason: string;
}

const db = createDebugBuffer<GpsDropEntry>(GPS_DROP_BUFFER_CAPACITY);

export function pushGpsDropEntry(entry: GpsDropEntry): void {
  db.push(entry);
}

export function getGpsDropEntries(): readonly GpsDropEntry[] {
  return db.get();
}

export function clearGpsDropEntries(): void {
  db.clear();
}

export function subscribeGpsDrop(listener: () => void): () => void {
  return db.subscribe(listener);
}
