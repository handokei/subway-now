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
 *   4. `subsurface === false` + SSOT 없음 + tripActive=true + barometerStop=true → 'unknown' + hintReason (옵션 C).
 *   5. `subsurface === undefined` + 둘 다 활성 → 'unknown' (hybrid).
 *   6. 둘 다 활성 + barometer 미확정 → 'unknown'.
 *   7. 둘 다 null → 'unknown'.
 */

export type Environment = 'surface' | 'underground' | 'unknown';

export interface InferEnvironmentInput {
  /** barometer `subsurface` 신호. undefined = warmup / 미지원. */
  subsurface: boolean | undefined;
  /** `surfaceSSOTConsensus`가 합의했으면 true. */
  surfaceSSOT: boolean;
  /** `undergroundSSOTConsensus`가 합의했으면 true. */
  undergroundSSOT: boolean;
  /**
   * #1860 — 옵션 C barometer-stop 힌트 게이트.
   * trip 활성 중일 때만 힌트 발동 (cold start lockless 환경에서만 의미 있음).
   * 미전달(undefined)이면 힌트 비활성 — 기존 동작 유지.
   */
  tripActive?: boolean;
  /**
   * #1860 — 옵션 C barometer-stop 힌트 신호.
   * `evaluateBarometerStop` detected 결과. true = 30s 윈도우 |dP| 임계 이하(정차 패턴).
   * undefined = warmup / reading 부족. false = 이동 중.
   */
  barometerStop?: boolean | undefined;
}

/**
 * #1860 — inferEnvironment 반환 래퍼.
 *
 * `label`: 기존 Environment 값 ('surface' / 'underground' / 'unknown').
 * `hintReason`: 옵션 C 힌트가 발동됐을 때의 원인. label='unknown'이더라도 힌트가 있으면
 *   "이미 지하일 가능성" 신호로 DebugModal에 노출한다. 없으면 undefined.
 */
export interface InferEnvironmentResult {
  label: Environment;
  /** #1860 — 힌트 발동 원인. 기존 label은 변경 없이 원인만 추가. */
  hintReason?: 'barometer-stop';
}

export function inferEnvironment(input: InferEnvironmentInput): InferEnvironmentResult {
  const { subsurface, surfaceSSOT, undergroundSSOT, tripActive, barometerStop } = input;
  if (subsurface === true) return { label: 'underground' };
  if (subsurface === false) {
    if (surfaceSSOT) return { label: 'surface' };
    if (undergroundSSOT) return { label: 'underground' };
    // #1860 옵션 C — 이미 지하 + trip 활성 + barometer 정차 패턴 힌트.
    // label='unknown' 유지 (false positive 방지). hintReason으로 DebugModal에 노출.
    if (tripActive === true && barometerStop === true) {
      return { label: 'unknown', hintReason: 'barometer-stop' };
    }
    return { label: 'unknown' };
  }
  // subsurface === undefined (warmup / 미지원) — SSOT 신호로만 판단.
  if (surfaceSSOT && !undergroundSSOT) return { label: 'surface' };
  if (undergroundSSOT && !surfaceSSOT) return { label: 'underground' };
  return { label: 'unknown' };
}
