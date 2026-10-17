/**
 * 환경(지상/지하/미확정) 추정. hybrid 모드 — 명시 분류 단계 없이 신호 가용성으로 추정.
 *
 * #1418 — 환경 라벨 산출. DebugModal 표시용 + #1932(Epic #1927 G2)부터 fusion cascade
 * tier 1/2 게이트로 승격. 호출자(`useFusedNearestStation`)는 본 결과를 환경 변수 직접 참조해
 * cascade 분기에 사용 — 두 SSOT 직접 read하는 SSOT 우회 회귀 차단.
 *
 * 우선순위:
 *   1. `subsurface === true` 명시 → 'underground' (barometer 확정).
 *   2. `subsurface === false` 명시 + surfaceSSOT 활성 → 'surface'.
 *   3. `subsurface === false` + undergroundSSOT 활성 → 'underground' (지하상가/매핑 SSID).
 *   4. `subsurface === false` + 두 SSOT 모두 null + barometer-stop hint 미발동:
 *      4a. GPS 양호(accuracyMeters ≤ 50m, qualityDegraded 아님) → 'surface'
 *          (#1932 — barometer 명시 지상 신뢰. raw `subsurface === false` 동작 보존.
 *          gpsDerivedFastPath와의 semantic equivalence 유지).
 *      4b. GPS garbage(accuracyMeters > 50m 또는 qualityDegraded=true) + lockActive=true →
 *          'underground' (#2468/#1932 회귀 fix — barometer subsurface는 EDGE 감지기라 steady
 *          지하 주행에서 dP≈0 → false. GPS 3km급 오차는 지상일 수 없다 — garbage GPS 하에서
 *          raw subsurface=false 단독으로 'surface' 단정 금지. lock 활성 시 underground로
 *          되돌려 `positionTrainBoardingLockMatch` 재활성 → 지하 device 자율 advance 복구).
 *      4c. GPS garbage + lockActive=false(또는 미전달) → 'unknown' (보수적 — lock 근거 없이
 *          underground 단정하지 않는다. 지상 urban canyon/non-trip 오탐 방지).
 *      hint 발동(tripActive + barometerStop=true) 시는 4보다 먼저 처리 — 우선 5번으로 흘러
 *      unknown 유지.
 *   5. `subsurface === false` + 두 SSOT 모두 null + tripActive + barometerStop=true →
 *      'unknown' (with hint 'barometer-stop'). 지하상가 hint paradigm.
 *   6. `subsurface === undefined` + surfaceSSOT만 활성 → 'surface' (hybrid).
 *   7. `subsurface === undefined` + undergroundSSOT만 활성 → 'underground' (hybrid).
 *   8. `subsurface === undefined` + 둘 다 활성/모두 null + GPS 품질 저하 transition(#2070) →
 *      'underground' (with hint 'gps-quality-drop').
 *   9. 그 외(#8 미해당) → 'unknown'.
 *
 * #1860 — hintReason 'barometer-stop': tripActive + barometerStop=true + subsurface=false
 * + 두 SSOT 없음 조합. DebugModal environment 라인에 함께 노출.
 *
 * #1932 — 우선순위 4가 추가됨. `subsurface === false` raw signal 신뢰가 회복돼 cascade tier 2
 * (gpsDerivedFastPath)가 SSOT 비활성 환경에서도 진입 가능 — 기존 `barometerSubsurface === false`
 * gate와 semantic equivalence 보존.
 *
 * #2070 — 우선순위 8이 추가됨. barometer warmup/미지원(subsurface===undefined) + SSOT 무판정
 * 구간에서 GPS 품질 저하가 관측되면 지하 진입 후보로 간주한다. 기존 1~7 판정 로직은 그대로
 * 유지되며 대체되지 않는다 — barometer/SSOT 명시 신호가 있으면 항상 그 결과가 우선한다.
 *
 * #2076 — GPS 품질 저하 입력(qualityDegraded)은 게이트 통과 fix가 30s 이상 부재(absence)할
 * 때만 true다. accuracy 1회성 급락 단독으로는 true가 되지 않는다 — 지상 urban canyon(고층빌딩
 * multipath)에서의 급락 1회가 지하로 오분류되던 결함(#2076 결함2) 차단.
 *
 * #2468 — 우선순위 4가 4a/4b/4c로 세분화됨(#1932 회귀 fix). GPS accuracy(gpsAccuracyMeters)와
 * lock 활성 여부(lockActive)가 새 입력으로 추가. `GPS_DERIVED_ACCURACY_MAX_M`(50m, 기존
 * gpsDerivedFastPath와 동일 threshold)를 초과하거나 qualityDegraded=true면 GPS를 garbage로
 * 간주 — 이 상태에서는 raw `subsurface === false`가 지상을 증명하지 않는다(barometer는 하강
 * edge만 감지, steady 지하 주행 dP≈0). lock 활성 trip에서만 'underground'로 판정을 뒤집는다
 * (lock 없는 case는 근거 부족 → 'unknown').
 */

import { GPS_DERIVED_ACCURACY_MAX_M } from '../../../shared/constants/realtime';

export type Environment = 'surface' | 'underground' | 'unknown';

/** #1860 — inferEnvironment 반환값. label = 환경 라벨, hintReason = 힌트 발동 원인. */
export interface InferEnvironmentResult {
  label: Environment;
  /**
   * 옵션 C barometer-stop 힌트 발동 시 'barometer-stop'. 힌트 없으면 undefined.
   * 발동 조건: tripActive=true + barometerStop=true + subsurface=false + 두 SSOT 없음.
   *
   * #2070 — 'gps-quality-drop': subsurface===undefined + 두 SSOT 무판정 + GPS 품질 저하
   * (#2076 — absence 30s+ 단독. 급락 단독으로는 발동하지 않는다) 관측 시 발동.
   *
   * #2468 — 'gps-garbage-underground': subsurface===false + 두 SSOT null + GPS garbage
   * (accuracy > 50m 또는 qualityDegraded) + lockActive=true 관측 시 발동.
   */
  hintReason?: 'barometer-stop' | 'gps-quality-drop' | 'gps-garbage-underground';
}

export interface InferEnvironmentInput {
  /** barometer `subsurface` 신호. undefined = warmup / 미지원. */
  subsurface: boolean | undefined;
  /** `surfaceSSOTConsensus`가 합의했으면 true. */
  surfaceSSOT: boolean;
  /** `undergroundSSOTConsensus`가 합의했으면 true. */
  undergroundSSOT: boolean;
  /** #1860 — trip 활성 여부. barometer-stop 힌트 발동 전제 조건. */
  tripActive?: boolean;
  /** #1860 — BarometerSignal.stop. barometer-stop 힌트 발동 전제 조건. */
  barometerStop?: boolean;
  /**
   * #2070 — GPS 품질 저하 관측 여부. #2076 — 게이트 통과 fix 30s+ 부재(absence)일 때만 true.
   * 급락 단독으로는 true가 되지 않는다. subsurface===undefined + 두 SSOT 무판정 구간에서만
   * 판정에 관여한다(우선순위 8). 미전달이면 false로 간주(기존 동작 보존).
   */
  qualityDegraded?: boolean;
  /**
   * #2468 — barometer garbage-GPS 판정 입력. GPS fix accuracy(m). null/undefined = fix 없음
   * (garbage 판정 미적용, 기존 동작 보존). `GPS_DERIVED_ACCURACY_MAX_M`(50m) 초과 시 garbage.
   */
  gpsAccuracyMeters?: number | null;
  /**
   * #2468 — 사용자 명시 의향 trip(boardingLock 활성) 여부. GPS garbage 판정 시 'underground'
   * 대 'unknown' 분기 조건 — lock 근거 없이는 underground를 단정하지 않는다.
   */
  lockActive?: boolean;
}

export function inferEnvironment(input: InferEnvironmentInput): InferEnvironmentResult {
  const {
    subsurface,
    surfaceSSOT,
    undergroundSSOT,
    tripActive,
    barometerStop,
    qualityDegraded,
    gpsAccuracyMeters,
    lockActive,
  } = input;
  if (subsurface === true) return { label: 'underground' };
  if (subsurface === false) {
    if (surfaceSSOT) return { label: 'surface' };
    if (undergroundSSOT) return { label: 'underground' };
    // #1860 — barometer-stop 힌트: tripActive + barometerStop=true + SSOT 없음.
    // 지하상가/매핑 SSID 미합의 정황 — environment 'unknown' + hint 노출.
    if (tripActive && barometerStop === true) {
      return { label: 'unknown', hintReason: 'barometer-stop' };
    }
    // #2468 — GPS garbage 하에서는 raw `subsurface === false` 단독으로 'surface' 단정 금지.
    // barometer는 하강 edge만 감지(steady 지하 주행 dP≈0 → false) — GPS accuracy 3km급 오차는
    // 지상 증거가 될 수 없다.
    const gpsGarbage =
      (gpsAccuracyMeters != null && gpsAccuracyMeters > GPS_DERIVED_ACCURACY_MAX_M) ||
      qualityDegraded === true;
    if (gpsGarbage) {
      if (lockActive === true) {
        // lock 활성 trip → underground로 되돌려 positionTrainBoardingLockMatch 재활성.
        return { label: 'underground', hintReason: 'gps-garbage-underground' };
      }
      // lock 없음 → underground 단정 근거 부족, 보수적으로 unknown.
      return { label: 'unknown' };
    }
    // #1932 — barometer 명시 지상 신뢰(GPS 양호 한정). cascade tier 2(gpsDerivedFastPath)와의
    // semantic equivalence 보존: 두 SSOT 비활성이라도 `subsurface === false` raw signal을
    // surface로 인정.
    return { label: 'surface' };
  }
  // subsurface === undefined (warmup / 미지원) — SSOT 신호로만 판단.
  if (surfaceSSOT && !undergroundSSOT) return { label: 'surface' };
  if (undergroundSSOT && !surfaceSSOT) return { label: 'underground' };
  // #2070 — SSOT 무판정(둘 다 활성 또는 둘 다 비활성) 구간 보강. 기존 판정을 대체하지 않고
  // 판정 불가였던 이 구간에만 GPS 품질 저하 transition을 추가 입력으로 반영한다.
  if (qualityDegraded === true) {
    return { label: 'underground', hintReason: 'gps-quality-drop' };
  }
  return { label: 'unknown' };
}
