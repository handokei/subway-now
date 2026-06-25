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
 *   4. `subsurface === false` + tripActive + barometerStop — 두 SSOT 없음 → hint 부여.
 *   5. `subsurface === undefined` + 둘 다 활성 → 'unknown' (hybrid).
 *   6. 둘 다 활성 + barometer 미확정 → 'unknown'.
 *   7. 둘 다 null → 'unknown'.
 *
 * #1872 — barometer-stop hint (옵션 C):
 *   "이미 지하" 사용자는 앱 cold start 시 dP ≈ 0 → subsurface 고착.
 *   tripActive=true + barometerStop=true 조합이 감지되면 hintReason을 반환해 downstream에서
 *   보완 신호로 활용할 수 있게 한다. Environment 자체는 'unknown' — 단독 강제 판정 금지.
 */

export type Environment = 'surface' | 'underground' | 'unknown';

/** barometer-stop hint reason. 향후 hint 종류 추가 시 union 확장. */
export type EnvironmentHintReason = 'barometer-stop';

export interface InferEnvironmentInput {
  /** barometer `subsurface` 신호. undefined = warmup / 미지원. */
  subsurface: boolean | undefined;
  /** `surfaceSSOTConsensus`가 합의했으면 true. */
  surfaceSSOT: boolean;
  /** `undergroundSSOTConsensus`가 합의했으면 true. */
  undergroundSSOT: boolean;
  /**
   * #1872 — trip 활성 여부. false positive 차단 gate.
   * tripActive=false이면 barometerStop 힌트 발동 안 됨.
   * optional: 기존 호출자 backward-compat.
   */
  tripActive?: boolean;
  /**
   * #1872 — `evaluateBarometerStop` 결과 (stop.detected).
   * undefined = warmup / reading 부족. false = 이동 중.
   * optional: 기존 호출자 backward-compat.
   */
  barometerStop?: boolean | undefined;
}

export interface InferEnvironmentResult {
  environment: Environment;
  /**
   * #1872 — 힌트 이유. barometer-stop 분기 진입 시에만 설정.
   * undefined = 힌트 없음 (일반 경로).
   */
  hintReason?: EnvironmentHintReason;
}

export function inferEnvironment(input: InferEnvironmentInput): InferEnvironmentResult {
  const { subsurface, surfaceSSOT, undergroundSSOT, tripActive, barometerStop } = input;

  if (subsurface === true) return { environment: 'underground' };

  if (subsurface === false) {
    if (surfaceSSOT) return { environment: 'surface' };
    if (undergroundSSOT) return { environment: 'underground' };
    // #1872 — barometer-stop hint: tripActive + barometerStop 조합.
    // false positive 차단: tripActive 필수 (lockless cold start 환경에서만 발동).
    if (tripActive && barometerStop === true) {
      return { environment: 'unknown', hintReason: 'barometer-stop' };
    }
    return { environment: 'unknown' };
  }

  // subsurface === undefined (warmup / 미지원) — SSOT 신호로만 판단.
  if (surfaceSSOT && !undergroundSSOT) return { environment: 'surface' };
  if (undergroundSSOT && !surfaceSSOT) return { environment: 'underground' };
  return { environment: 'unknown' };
}
