/**
 * #1926 (A+F+G3 통합) — `position-train` 채택 전 4-signal consensus + station progression 가드.
 *
 * 6/27 trip evidence 2건:
 *   - 13:40:08 BoardingLock 자동 활성화 — `useBoardingLockController` autoLock fast path가
 *     `pickAutoTrainCodeFromArrivals` 단일 후보 + `allowedLines` 통과만으로 `createLock` 발사.
 *   - 15:49:35 fusion `pt=강남` jump — `useFusedNearestStation` `positionTrainResult` useMemo가
 *     lockless trip에서 distance gate(0.6km)만으로 채택.
 *
 * 동일 root: lockless trip에서 `position-train` 신호가 **다른 신호 합의 없이 단독 채택**.
 *
 * 본 helper는 두 caller가 공유하는 pure function. unit test로 4-signal 조합을 8가지 verify 가능.
 *
 * 정합성:
 * - `boardingLock` 활성 = 사용자 명시 의향 신호로 간주 → 기존 path 보존(consensus skip).
 * - lockless = device-side 자체 신호 합의 필수 — false positive 차단(ADR-014 첫 줄, X9/X10 acceptance).
 * - GPS는 의사결정에 미사용 — barometer / accelerometer / cellular 3 signal로만 판단
 *   (`memory/feedback_no_gps_for_decision.md`).
 * - station progression check ±1 hop — lockless에서 station 2 hop+ jump는 cascade 회귀
 *   (X10 acceptance: fusion picker output ≠ input).
 *
 * 참조:
 * - `memory/feedback_device_self_contained_fusion.md` — backend/GPS/WiFi 다 죽어도 device 보장.
 * - `memory/feedback_user_intent_equal_protection.md` — lock 활성 = 사용자 명시 의향.
 * - `docs/adr/ADR-015-multi-signal-consensus-gate.md` §3 — GPS reject in underground.
 */

import type { BoardingLock } from '../../../shared/types/boardingLock';
import type { NearestStationResult, Station } from '../../../shared/types/station';
import type { AccelerometerPattern } from './accelerometerFingerprint';
import type { CellularEnvironmentVote } from './cellularTech';

/**
 * 4-signal consensus 입력 신호 묶음. caller 양쪽이 동일 shape으로 전달.
 *
 * - `barometerSubsurface` — `true=지하`, `false=지상`, `null|undefined=미확정(warmup/미지원)`.
 * - `accelerometerPattern` — `'automotive' | 'walking' | 'stationary' | 'unknown' | null`.
 * - `cellularEnvironmentVote` — `'surface' | 'surface-weak' | 'underground' | 'unknown'`.
 */
export interface PositionTrainConsensusSignals {
  barometerSubsurface: boolean | null | undefined;
  accelerometerPattern: AccelerometerPattern | null;
  cellularEnvironmentVote: CellularEnvironmentVote | null;
}

/**
 * `position-train` 신호 채택 여부.
 *
 * - `boardingLock != null` → 기존 path 보존(lock 자체가 사용자 명시 의향 signal). return true.
 * - lockless 시 4-signal consensus 적용:
 *   1) `barometerSubsurface === true` (지하 확정) → return false.
 *      GPS dead zone에서 `position-train`의 station-progress가 GPS 좌표에 의존하므로 신뢰 X
 *      (ADR-015 §3 "GPS reject in underground").
 *   2) `accelerometerPattern !== 'automotive'` (정차/도보/미확정) → return false.
 *      탑승 중이 아니면 `position-train` 채택 의미가 없다 (false positive 차단).
 *   3) `cellularEnvironmentVote === 'surface'` (지상 확정) → return true.
 *      barometer false-negative 보강 — surface 확정 시 채택 허용.
 *   4) 그 외 (cellular 'surface-weak' / 'underground' / 'unknown' / null / undefined) → return false.
 *      환경 ambiguity = 보수적으로 채택 보류(false positive 우선 차단, ADR-014 첫 줄).
 */
export function requiresPositionTrainConsensus(
  signals: PositionTrainConsensusSignals,
  boardingLock: BoardingLock | null,
): boolean {
  if (boardingLock != null) return true;
  const { barometerSubsurface, accelerometerPattern, cellularEnvironmentVote } = signals;
  if (barometerSubsurface === true) return false;
  if (accelerometerPattern !== 'automotive') return false;
  if (cellularEnvironmentVote === 'surface') return true;
  return false;
}

/**
 * station progression check — 직전 cascade result 기준 ±1 hop 범위 내인지 검사.
 *
 * - `prevCascadeResult == null` (첫 cycle) → return true (면제).
 * - `arcStations`에서 둘 다 찾을 수 없는 경우(cross-line 환승, arc 밖) → return true (면제).
 * - 그 외: `|candidateIdx - prevIdx| <= 1` 이면 return true.
 *
 * ±1 hop 허용 = 정차/통과 정상 케이스. 2 hop+ jump는 X10 위반(fusion picker output ≠ input).
 */
export function checkStationProgression(
  candidateStationId: string,
  prevCascadeResult: NearestStationResult | null,
  arcStations: readonly Station[],
): boolean {
  if (prevCascadeResult == null) return true;
  const prevIdx = arcStations.findIndex((s) => s.id === prevCascadeResult.station.id);
  const candidateIdx = arcStations.findIndex((s) => s.id === candidateStationId);
  if (prevIdx === -1 || candidateIdx === -1) return true;
  return Math.abs(candidateIdx - prevIdx) <= 1;
}
