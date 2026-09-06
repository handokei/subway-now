/**
 * #1430 — 환경 분포 측정 인프라. 동작 변경 0: 측정만.
 *
 * Time-based counter — state(`surface` | `underground` | `hybrid` | `unknown` | `unknown_warmup`)별
 * 누적 ms를 적분한다. Tier 1 surface/underground SSOT 합의 활성 여부를 기반으로 호출자가 매 render
 * time tick을 push, snapshot은 dump 시 한 번씩 조회.
 *
 * 환경 결정 정책 (호출자가 결정 후 tick 인자로 전달):
 *   - surfaceSSOTActive && undergroundSSOTActive → 'hybrid'
 *   - surfaceSSOTActive only                     → 'surface'
 *   - undergroundSSOTActive only                 → 'underground'
 *   - 둘 다 미합의 + observedMs < 60s             → 'unknown_warmup' (#1821)
 *   - 둘 다 미합의 + observedMs ≥ 60s             → 'unknown'
 *
 * Transition 정책:
 *   - 동일 state 연속 tick: 누적만, transitions 증가 X.
 *   - 다른 state로 전환: transitions++ (`unknown`/`unknown_warmup` 경유 포함). 단순 정책.
 *
 * 메모리: 모달 인스턴스마다 1개. 관찰자 효과 최소화를 위해 모달이 열려있는 동안만 동작.
 *
 * 의도적으로 React/AsyncStorage 의존 없음 — 순수 클로저 factory.
 */

export type EnvironmentDistributionState =
  | 'surface'
  | 'underground'
  | 'hybrid'
  | 'unknown'
  /**
   * #1821 — trip 시작 후 60s 이내 unknown 구간. "warmup 중"과 "진짜 unknown"을 caller가 구분
   * 가능하게 한다. backend boardingPrompt 게이트가 warmup grace 적용 가능.
   */
  | 'unknown_warmup';

export interface EnvironmentDistributionSnapshot {
  /** state별 누적 ms (snapshot 시점 진행분 포함). */
  readonly totals: Record<EnvironmentDistributionState, number>;
  /** state별 백분율 (0~100, observedMs=0이면 모두 0). */
  readonly percentages: Record<EnvironmentDistributionState, number>;
  /** 지상↔지하 등 환경 전환 누적 횟수. */
  readonly transitions: number;
  /** 누적 관찰 시간 (totals 합). */
  readonly observedMs: number;
}

export interface EnvironmentDistributionCounter {
  /** state 신호를 시간 적분에 반영. 첫 호출은 시각 진입 기록만 (누적 없음). */
  tick(state: EnvironmentDistributionState, nowMs: number): void;
  /** 현재 진행분을 합산해 snapshot 산출 (counter 내부 상태는 변경 안 함). */
  snapshot(nowMs: number): EnvironmentDistributionSnapshot;
}

const ALL_STATES: readonly EnvironmentDistributionState[] = [
  'surface',
  'underground',
  'hybrid',
  'unknown',
  'unknown_warmup',
];

function emptyTotals(): Record<EnvironmentDistributionState, number> {
  return { surface: 0, underground: 0, hybrid: 0, unknown: 0, unknown_warmup: 0 };
}

function computePercentages(
  totals: Record<EnvironmentDistributionState, number>,
  observedMs: number,
): Record<EnvironmentDistributionState, number> {
  if (observedMs <= 0) {
    return emptyTotals();
  }
  const pct = emptyTotals();
  for (const state of ALL_STATES) {
    pct[state] = (totals[state] / observedMs) * 100;
  }
  return pct;
}

export function createEnvironmentDistributionCounter(): EnvironmentDistributionCounter {
  const totals = emptyTotals();
  let currentState: EnvironmentDistributionState | null = null;
  let lastTickMs: number | null = null;
  let transitions = 0;

  function flushAccumulated(nowMs: number): void {
    if (currentState !== null && lastTickMs !== null && nowMs > lastTickMs) {
      totals[currentState] += nowMs - lastTickMs;
    }
  }

  return {
    tick(state, nowMs) {
      // 첫 tick: 시각 진입 기록만 — 누적할 직전 dwell 없음.
      if (currentState === null) {
        currentState = state;
        lastTickMs = nowMs;
        return;
      }
      // 동일 state 연속 tick — 누적만 갱신, transition 증가 X.
      flushAccumulated(nowMs);
      if (state !== currentState) transitions += 1;
      currentState = state;
      lastTickMs = nowMs;
    },
    snapshot(nowMs) {
      // 진행분 포함: 현재 state 누적에 (nowMs - lastTickMs) 추가 후 합산.
      // 내부 totals 자체는 변경하지 않아 같은 시각에 재호출해도 결과 동일.
      const snapshotTotals = emptyTotals();
      for (const state of ALL_STATES) snapshotTotals[state] = totals[state];
      if (currentState !== null && lastTickMs !== null && nowMs > lastTickMs) {
        snapshotTotals[currentState] += nowMs - lastTickMs;
      }
      let observedMs = 0;
      for (const state of ALL_STATES) observedMs += snapshotTotals[state];
      return {
        totals: snapshotTotals,
        percentages: computePercentages(snapshotTotals, observedMs),
        transitions,
        observedMs,
      };
    },
  };
}
