/**
 * #875 — 기압계 readings → 지하 진입 여부 평가 순수 함수.
 *
 * 정책 (ADR-010 보조 신호):
 *   - 절대 기압값은 지역·날씨에 따라 변동 큼 → **상대 변화량(dP/dt)** 만 신호로 사용.
 *   - 30s 윈도우 dP가 +0.3 hPa 이상이면 "지하 진입 진행 중" 후보로 본다.
 *   - 일시적 노이즈(터널 압력파, 차문 개폐) 방지: 평가는 단일 reading이 아니라
 *     윈도우 양 끝점 비교.
 *
 * 단순성 (CLAUDE.md §2):
 *   - readings 컨테이너는 호출자(useBarometer)가 관리 — 본 모듈은 순수 평가기.
 *   - 정렬·prune도 명시 함수로 분리. 호출자가 명시적으로 호출한다.
 */

import {
  BAROMETER_DPDT_WINDOW_MS,
  BAROMETER_RING_BUFFER_TTL_MS,
  BAROMETER_STOP_DP_THRESHOLD_HPA,
  BAROMETER_SUBSURFACE_DP_THRESHOLD_HPA,
} from '../constants/barometer';

/**
 * 단일 기압 reading. expo-sensors `BarometerMeasurement.pressure`는 hPa 단위.
 */
export interface BarometerReading {
  /** epoch ms — 호출자가 wall-clock으로 stamp. */
  t: number;
  /** 압력값 (hPa, ≈ mbar). */
  pressureHpa: number;
}

/**
 * 평가 결과. 신호 자체는 boolean이지만 후속 게이트/메트릭이 raw delta도 참조하므로 함께 노출.
 */
export interface SubsurfaceVerdict {
  /** dP가 임계 이상으로 상승했는가 (지하 진입 진행 중 후보). */
  detected: boolean;
  /** baseline 대비 latest 압력 변화 (hPa). 음수면 지상 상승. */
  deltaHpa: number;
  /** baseline과 latest 사이 경과 시간 (ms). */
  elapsedMs: number;
}

/**
 * 부동소수 오차 허용: 임계와 정확히 같은 dP에서 깜빡임 방지. hPa 단위에서 1e-9는
 * 센서 정밀도(약 0.01 hPa) 대비 무시 가능.
 */
const FP_EPSILON = 1e-9;

/**
 * readings 중 `now - BAROMETER_RING_BUFFER_TTL_MS`보다 오래된 것을 제거.
 * 원본 배열은 변경하지 않고 새 배열 반환.
 */
export function pruneStaleReadings(
  readings: readonly BarometerReading[],
  now: number,
): BarometerReading[] {
  const cutoff = now - BAROMETER_RING_BUFFER_TTL_MS;
  return readings.filter((r) => r.t >= cutoff);
}

/**
 * 30s 윈도우 dP를 평가해 지하 진입 후보 여부를 반환.
 *
 * baseline 결정 규칙:
 *   - readings 중 `t <= now - BAROMETER_DPDT_WINDOW_MS`를 만족하는 가장 최근 reading.
 *   - 즉 "30s 이전이지만 가장 가까운" reading. 메모리에 더 오래된 데이터가 있어도
 *     윈도우 정의를 정확히 따르기 위해.
 *
 * latest 결정 규칙:
 *   - readings 중 t가 가장 큰 것 (정렬되지 않아도 동작).
 *
 * 평가 불가:
 *   - readings 비어있음 → null
 *   - 윈도우 조건 만족하는 baseline 없음 → null
 *
 * 임계 초과 여부와 무관하게 raw delta는 항상 함께 반환 (메트릭/디버그 사용).
 */
export function evaluateSubsurfaceEnter(
  readings: readonly BarometerReading[],
  now: number,
): SubsurfaceVerdict | null {
  const window = pickDpdtWindow(readings, now);
  if (window === null) return null;
  return {
    detected: window.deltaHpa >= BAROMETER_SUBSURFACE_DP_THRESHOLD_HPA - FP_EPSILON,
    deltaHpa: window.deltaHpa,
    elapsedMs: window.elapsedMs,
  };
}

/**
 * #921 — "정차 패턴" 평가. 30s 윈도우에서 |dP|가 임계 이하면 detected=true.
 *
 * subsurface(상승)와 직교 신호:
 *   - subsurface: dP >= +0.3 (지하 진입 후보)
 *   - stop:       |dP| <= +0.05 (정차 후보)
 *   - 중간 영역(0.05 < |dP| < 0.3): 어느 쪽도 아님 (이동 중/지상 보행).
 *
 * 평가 불가:
 *   - readings 비어있음 → null
 *   - 30s 이전 baseline 없음 → null (sensor warm-up 초기 30s 동안)
 *
 * fusion 입력 변환 규약(useFusedStationDetection):
 *   - verdict.detected=true → signal 'barometer-stop' true
 *   - verdict.detected=false → signal 'barometer-stop' false (명시적 미합의)
 *   - verdict null → signal 미제공 (signalsAvailable 감소)
 */
export function evaluateBarometerStop(
  readings: readonly BarometerReading[],
  now: number,
): SubsurfaceVerdict | null {
  const window = pickDpdtWindow(readings, now);
  if (window === null) return null;
  return {
    detected: Math.abs(window.deltaHpa) <= BAROMETER_STOP_DP_THRESHOLD_HPA + FP_EPSILON,
    deltaHpa: window.deltaHpa,
    elapsedMs: window.elapsedMs,
  };
}

/**
 * 30s 윈도우의 (baseline, latest) 쌍을 결정해 dP와 elapsedMs를 계산.
 * subsurface(상승)과 stop(정지) 평가 공통 전처리 — 임계 분기만 호출자가 담당.
 *
 * baseline 규칙: `t <= now - BAROMETER_DPDT_WINDOW_MS`를 만족하는 readings 중 가장 최근.
 * latest 규칙: readings 중 t가 가장 큰 것.
 */
function pickDpdtWindow(
  readings: readonly BarometerReading[],
  now: number,
): { deltaHpa: number; elapsedMs: number } | null {
  if (readings.length === 0) return null;
  const latest = readings.reduce((acc, r) => (r.t > acc.t ? r : acc));
  const baselineMaxT = now - BAROMETER_DPDT_WINDOW_MS;
  let baseline: BarometerReading | null = null;
  for (const r of readings) {
    if (r.t > baselineMaxT) continue;
    if (baseline === null || r.t > baseline.t) baseline = r;
  }
  if (baseline === null) return null;
  return {
    deltaHpa: latest.pressureHpa - baseline.pressureHpa,
    elapsedMs: latest.t - baseline.t,
  };
}
