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
 *
 * #920 — 절대값 narrow 함수 추가.
 *   - dP/dt(상대 변화)와 별개로, 깊이별 평균 절대 압력을 비교해 후보 역을 ±2역 narrow.
 *   - F2(wifi) 매칭이 실패한 지하에서 fallback.
 */

import {
  BAROMETER_ABS_TOLERANCE_HPA,
  DEPTH_TO_PRESSURE_HPA_PER_M,
} from '../constants/barometer';
import stationAbsolutePressureData from '../../data/stationAbsolutePressure.json';
import type { LineNumber, Station } from '../types/station';
import {
  evaluateBarometerStop,
  evaluateSubsurfaceEnter,
  pruneStaleReadings,
  type BarometerReading,
  type SubsurfaceVerdict,
} from './barometerSubsurface';

/**
 * 역별 절대 압력 entry. 지하 깊이(m) 기반 — 표준 대기 모델로 압력 환산.
 *
 * 실측 압력값을 직접 보관하지 않는 이유: 지역 기준 압력은 일별 ±5 hPa 변동.
 * surfacePressure를 외부에서 주입받고 깊이만 비교하는 방식이 단순하고 안정적이다
 * (CLAUDE.md §2 단순성). 후속 PR에서 실측 보정이 필요하면 그 때 필드 추가.
 *
 * CLAUDE.md §3 데이터 주도: 새 역 추가 시 코드 수정 없이 JSON 항목만 추가.
 */
export interface StationAbsolutePressureEntry {
  readonly stationId: string;
  readonly stationName: string;
  readonly line: LineNumber;
  readonly depth_m: number;
}

const ABS_PRESSURE_ENTRIES: readonly StationAbsolutePressureEntry[] =
  stationAbsolutePressureData as readonly StationAbsolutePressureEntry[];

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
 * #921 — 현재 시점 기준 정차 패턴 평가 결과를 반환. readings 부족이면 null.
 * useFusedStationDetection이 fusion 신호 'barometer-stop' 입력으로 사용.
 */
export function evaluateLatestStop(now: number): SubsurfaceVerdict | null {
  return evaluateBarometerStop(readings, now);
}

/**
 * Ring buffer 초기화. hook unmount / 권한 거절 / 미지원 디바이스에서 호출.
 */
export function resetBarometerState(): void {
  readings = [];
}

/**
 * #920 — 절대 압력 측정값으로 후보 역을 narrow.
 *
 * @param measuredPressureHpa 단말 기압계 절대값 (hPa).
 * @param surfacePressureHpa 같은 지역 지상 기준 압력 (hPa). 일별 기상 변동을 흡수하기 위해
 *   호출자가 GPS + 날씨/지상 baseline에서 주입한다 (본 PR 외부 — 임시 1013 default 가능).
 * @param candidates 사전 후보 역(예: GPS top-N). 빈 배열이면 빈 결과.
 * @param toleranceHpa 일치 허용 폭. 기본 `BAROMETER_ABS_TOLERANCE_HPA`.
 * @returns 추정 압력이 측정값과 tolerance 안인 후보 역의 부분집합.
 *
 * 정책:
 *   - 후보 안에서만 필터 — F2 실패 시 GPS top-N narrow 용도.
 *   - 환승역(같은 이름 다중 노선)도 깊이가 다르면 다른 entry → 자연스럽게 분리됨.
 *   - 데이터에 없는 stationId는 자동 제외 (점진적 데이터 보강).
 */
export function narrowStationsByPressure(
  measuredPressureHpa: number,
  surfacePressureHpa: number,
  candidates: readonly Station[] = [],
  toleranceHpa: number = BAROMETER_ABS_TOLERANCE_HPA,
): Station[] {
  if (candidates.length === 0) return [];

  const matchedIds = new Set<string>();
  for (const entry of ABS_PRESSURE_ENTRIES) {
    const expected =
      surfacePressureHpa + entry.depth_m * DEPTH_TO_PRESSURE_HPA_PER_M;
    if (Math.abs(measuredPressureHpa - expected) <= toleranceHpa) {
      matchedIds.add(entry.stationId);
    }
  }

  return candidates.filter((s) => matchedIds.has(s.id));
}
