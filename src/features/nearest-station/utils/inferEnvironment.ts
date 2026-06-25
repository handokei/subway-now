/**
 * 환경(지상/지하/미확정) 추정. hybrid 모드 — 명시 분류 단계 없이 신호 가용성으로 추정.
 *
 * #1418 — Tier 1 cascade를 위한 환경 라벨 산출. DebugModal 표시용이 주 용도이며 fusion
 * cascade의 게이트는 두 SSOT(`surfaceSSOT`/`undergroundSSOT`)의 활성 여부로 직접 분기한다.
 *
 * 우선순위:
 *   1. `subsurface === true` 명시 → 'underground' (barometer 확정).
 *   2. `subsurface === false` 명시 + surfaceSSOT 활성 → 'surface'.
 *   3. `subsurface === false` + undergroundSSOT 활성 → 'underground' (지하상가/매핑 SSID).
 *   4. `subsurface === undefined` + 둘 다 활성 → 'unknown' (hybrid).
 *   5. 둘 다 활성 + barometer 미확정 → 'unknown'.
 *   6. 둘 다 null → 'unknown'.
 *
 * #1860 — hintReason 'barometer-stop': tripActive + barometerStop=true + subsurface=false
 * + 두 SSOT 없음 조합. DebugModal environment 라인에 함께 노출.
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
    if (tripActive && barometerStop === true) {
      return { label: 'unknown', hintReason: 'barometer-stop' };
    }
    return { label: 'unknown' };
  }
  // subsurface === undefined (warmup / 미지원) — SSOT 신호로만 판단.
  if (surfaceSSOT && !undergroundSSOT) return { label: 'surface' };
  if (undergroundSSOT && !surfaceSSOT) return { label: 'underground' };
  return { label: 'unknown' };
}
