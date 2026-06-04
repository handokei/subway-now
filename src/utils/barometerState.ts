/**
 * #875 — 기압계 ring buffer ambient state.
 *
 * useBarometer hook이 sensor reading마다 push → 평가 시점에 readings 전체를 evaluate.
 * BG task가 latest verdict를 snapshot으로 첨부할 수 있도록 ambient 모듈 패턴 사용
 * (accelMotionState와 동형 — CLAUDE.md §3 재사용성).
 *
 * 정책:
 *   - 메모리 ring buffer만 (60s ≤ 60 entry @ 1Hz, 매우 가벼움).
 *   - hook unmount → reset. 영속화 필요 시 후속 sub-issue.
 */

import {
  evaluateSubsurfaceEnter,
  pruneStaleReadings,
  type BarometerReading,
  type SubsurfaceVerdict,
} from './barometerSubsurface';

let readings: BarometerReading[] = [];

/**
 * 새 reading을 추가하고, stale entry를 제거한다.
 * 호출자(useBarometer)가 센서 콜백마다 호출.
 */
export function appendBarometerReading(reading: BarometerReading): void {
  readings = pruneStaleReadings([...readings, reading], reading.t);
}

/**
 * 현재 보관 중인 readings의 readonly 스냅샷. 디버그/테스트용.
 */
export function getBarometerReadings(): readonly BarometerReading[] {
  return readings;
}

/**
 * 현재 시점 기준 dP/dt 평가 결과를 반환. readings 부족이면 null.
 * BG task가 position upload 직전에 호출.
 */
export function evaluateLatestSubsurface(now: number): SubsurfaceVerdict | null {
  return evaluateSubsurfaceEnter(readings, now);
}

/**
 * Ring buffer 초기화. hook unmount / 권한 거절 / 미지원 디바이스에서 호출.
 */
export function resetBarometerState(): void {
  readings = [];
}
