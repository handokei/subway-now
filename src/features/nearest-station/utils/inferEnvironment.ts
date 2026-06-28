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
 *   8. `subsurface === undefined` + 둘 다 활성/모두 null → 'unknown'.
 *
 * #1860 — hintReason 'barometer-stop': tripActive + barometerStop=true + subsurface=false
 * + 두 SSOT 없음 조합. DebugModal environment 라인에 함께 노출.
 *
 * #1932 — 우선순위 4가 추가됨. `subsurface === false` raw signal 신뢰가 회복돼 cascade tier 2
 * (gpsDerivedFastPath)가 SSOT 비활성 환경에서도 진입 가능 — 기존 `barometerSubsurface === false`
 * gate와 semantic equivalence 보존.
 */

export type Environment = 'surface' | 'underground' | 'unknown';

/** #1860 — inferEnvironment 반환값. label = 환경 라벨, hintReason = 힌트 발동 원인. */
export interface InferEnvironmentResult {
  label: Environment;
  /**
   * 옵션 C barometer-stop 힌트 발동 시 'barometer-stop'. 힌트 없으면 undefined.
   * 발동 조건: tripActive=true + barometerStop=true + subsurface=false + 두 SSOT 없음.
   */
  hintReason?: 'barometer-stop';
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
}

export function inferEnvironment(input: InferEnvironmentInput): InferEnvironmentResult {
  const { subsurface, surfaceSSOT, undergroundSSOT, tripActive, barometerStop } = input;
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
  return { label: 'unknown' };
}
