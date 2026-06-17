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
 */

export type Environment = 'surface' | 'underground' | 'unknown';

export interface InferEnvironmentInput {
  /** barometer `subsurface` 신호. undefined = warmup / 미지원. */
  subsurface: boolean | undefined;
  /** `surfaceSSOTConsensus`가 합의했으면 true. */
  surfaceSSOT: boolean;
  /** `undergroundSSOTConsensus`가 합의했으면 true. */
  undergroundSSOT: boolean;
}

export function inferEnvironment(input: InferEnvironmentInput): Environment {
  const { subsurface, surfaceSSOT, undergroundSSOT } = input;
  if (subsurface === true) return 'underground';
  if (subsurface === false) {
    if (surfaceSSOT) return 'surface';
    if (undergroundSSOT) return 'underground';
    return 'unknown';
  }
  // subsurface === undefined (warmup / 미지원) — SSOT 신호로만 판단.
  if (surfaceSSOT && !undergroundSSOT) return 'surface';
  if (undergroundSSOT && !surfaceSSOT) return 'underground';
  return 'unknown';
}
