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
 *   4. `subsurface === false` + 두 SSOT 모두 null + barometer-stop hint 미발동 → 'surface'
 *      (#1932 — barometer 명시 지상 신뢰. raw `subsurface === false` 동작 보존).
 *      hint 발동(tripActive + barometerStop=true) 시는 우선 5번으로 흘러 unknown 유지.
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
 * 구간에서 GPS 품질 저하 transition(급락 또는 게이트 통과 fix 30s 부재)이 관측되면 지하 진입
 * 후보로 간주한다. 기존 1~7 판정 로직은 그대로 유지되며 대체되지 않는다 — barometer/SSOT 명시
 * 신호가 있으면 항상 그 결과가 우선한다.
 */

export type Environment = 'surface' | 'underground' | 'unknown';

/** #1860 — inferEnvironment 반환값. label = 환경 라벨, hintReason = 힌트 발동 원인. */
export interface InferEnvironmentResult {
  label: Environment;
  /**
   * 옵션 C barometer-stop 힌트 발동 시 'barometer-stop'. 힌트 없으면 undefined.
   * 발동 조건: tripActive=true + barometerStop=true + subsurface=false + 두 SSOT 없음.
   *
   * #2070 — 'gps-quality-drop': subsurface===undefined + 두 SSOT 무판정 + GPS 품질 저하
   * transition 관측 시 발동.
   */
  hintReason?: 'barometer-stop' | 'gps-quality-drop';
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
   * #2070 — GPS 품질 저하 transition(급락 또는 게이트 통과 fix 30s 부재) 관측 여부.
   * subsurface===undefined + 두 SSOT 무판정 구간에서만 판정에 관여한다(우선순위 8).
   * 미전달이면 false로 간주(기존 동작 보존).
   */
  qualityDegraded?: boolean;
}

export function inferEnvironment(input: InferEnvironmentInput): InferEnvironmentResult {
  const { subsurface, surfaceSSOT, undergroundSSOT, tripActive, barometerStop, qualityDegraded } =
    input;
  if (subsurface === true) return { label: 'underground' };
  if (subsurface === false) {
    if (surfaceSSOT) return { label: 'surface' };
    if (undergroundSSOT) return { label: 'underground' };
    // #1860 — barometer-stop 힌트: tripActive + barometerStop=true + SSOT 없음.
    // 지하상가/매핑 SSID 미합의 정황 — environment 'unknown' + hint 노출.
    if (tripActive && barometerStop === true) {
      return { label: 'unknown', hintReason: 'barometer-stop' };
    }
    // #1932 — barometer 명시 지상 신뢰. cascade tier 2(gpsDerivedFastPath)와의 semantic
    // equivalence 보존: 두 SSOT 비활성이라도 `subsurface === false` raw signal을 surface로 인정.
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
