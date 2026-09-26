/**
 * #921 — 신호 fusion 알고리즘 (B1 첫 PR — pure JS).
 *
 * 목적:
 *   Seam G(#903) dP/dt 단일 신호만으로는 "역 도착 판정" 정확도가 부족하다.
 *   여러 독립 신호를 OR로 결합해 다수결로 판정하면 본질적으로 정확도가 보강된다.
 *
 * 신호 (현재 3개, 추가 시 STATION_DETECTION_SIGNALS만 확장):
 *   - barometer-stop      : 기압계 정차 패턴 감지 (Seam G dP/dt 안정화)
 *   - motion-stationary   : CMMotionActivity stationary
 *   - arvlcd-arrived      : ArrivalRow arvlCd ∈ {ARRIVED(1), ENTERING(0)}
 *
 * 정책 (CLAUDE.md §3 데이터 주도 — 신호 개수 하드코딩 금지):
 *   - signalsAgreed = 입력에서 true인 신호 수
 *   - signalsAvailable = 입력에 boolean으로 제공된(true/false) 신호 수 (undefined 제외)
 *   - 다수결: signalsAgreed >= 2 → detected=true
 *   - confidence:
 *       3개+ → 'high'
 *       2개 → 'medium'
 *       그 외 → 'low' (detected=false)
 *
 *   "2개 이상"이라는 임계는 신호 수와 무관하게 다수결 의미를 유지하려면 신호 수의 절반 이상이
 *   적절하나, 현재는 명시 임계(=2)를 사용한다. 신호가 늘어나면 본 모듈 정책을 재검토한다.
 *
 * 슬라이싱:
 *   본 PR은 pure 함수만. useFusedNearestStation 통합, useBarometer/useMotionActivity wire는
 *   F3(#920) 머지 이후 후속 PR에서 진행.
 */

/**
 * 지원 신호 이름. 새 신호 추가 시 이 배열에만 항목 추가하면 fusion이 그대로 동작한다.
 */
export const STATION_DETECTION_SIGNALS = [
  'barometer-stop',
  'motion-stationary',
  'arvlcd-arrived',
] as const;

export type StationDetectionSignalName = (typeof STATION_DETECTION_SIGNALS)[number];

/**
 * 입력 — 각 신호의 boolean. undefined는 "신호 미제공"(unavailable).
 * 데이터 주도: 모르는 키는 무시된다 (Partial Record).
 */
export type StationDetectionSignalInput = Partial<
  Record<StationDetectionSignalName, boolean>
>;

export type StationDetectionConfidence = 'high' | 'medium' | 'low';

export interface StationDetectionVerdict {
  /** 다수결 합의 결과. signalsAgreed >= AGREEMENT_THRESHOLD. */
  readonly detected: boolean;
  /** 신뢰도 — 합의 신호 수에 따른 정성 라벨. */
  readonly confidence: StationDetectionConfidence;
  /** true로 평가된 신호 수. */
  readonly signalsAgreed: number;
  /** 입력에 boolean으로 제공된 신호 수 (undefined 제외). */
  readonly signalsAvailable: number;
}

/**
 * 다수결 임계. 2개 이상이 동의하면 detected.
 * 신호가 늘어나도 "단일 우연 false positive 차단" 본질은 유지되어 안전한 기본값.
 */
const AGREEMENT_THRESHOLD = 2;

/**
 * confidence 결정 임계 — 신호 개수 하드코딩을 피하기 위해 정렬된 임계 목록으로 표현.
 * 첫 매칭(>=)되는 항목의 label을 사용. high → medium → low 순.
 */
const CONFIDENCE_TIERS: readonly {
  readonly minAgreed: number;
  readonly label: StationDetectionConfidence;
}[] = [
  { minAgreed: 3, label: 'high' },
  { minAgreed: 2, label: 'medium' },
  { minAgreed: 0, label: 'low' },
];

/**
 * CONFIDENCE_TIERS는 minAgreed=0으로 끝나도록 보장한다 → 음수가 아닌 모든 입력에 매칭.
 * (음수는 fuseStationDetectionSignals 호출 경로에서 발생하지 않는다 — 카운터는 0부터 증가.)
 */
function resolveConfidence(signalsAgreed: number): StationDetectionConfidence {
  const tier = CONFIDENCE_TIERS.find((t) => signalsAgreed >= t.minAgreed);
  // CONFIDENCE_TIERS 마지막 항목 minAgreed=0이 가드 — undefined 도달 불가.
  return tier!.label;
}

/**
 * fusion 평가. STATION_DETECTION_SIGNALS만 순회하므로 unknown key는 자동 무시된다.
 */
export function fuseStationDetectionSignals(
  input: StationDetectionSignalInput,
): StationDetectionVerdict {
  let signalsAgreed = 0;
  let signalsAvailable = 0;

  for (const name of STATION_DETECTION_SIGNALS) {
    const value = input[name];
    if (value === undefined) continue;
    signalsAvailable += 1;
    if (value) signalsAgreed += 1;
  }

  const detected = signalsAgreed >= AGREEMENT_THRESHOLD;
  const confidence: StationDetectionConfidence = detected
    ? resolveConfidence(signalsAgreed)
    : 'low';

  return {
    detected,
    confidence,
    signalsAgreed,
    signalsAvailable,
  };
}
