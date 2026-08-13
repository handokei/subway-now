/**
 * Consensus mismatch metric — #2330 (consensus-D, 설계 SSoT #2323 2026-08-13 (3)).
 *
 * 명시 탭이 backend consensus engine이 confirmed한 lockSuggestion(confidence='consensus')과
 * 다른 trainCode를 선택했을 때 발화. 탭이 항상 우선하며(consensus는 lock 승격 금지, UI 표시/floor
 * forward 전용), 본 counter는 그 불일치 빈도를 측정해 향후 consensus engine 정확도 튜닝에 쓰인다.
 *
 * 단순 in-memory counter — `lockCorrectionMetrics.ts`(#1166)와 동일 패턴. logger emit으로
 * 디버그/로컬 분석은 즉시 가능하다(`createLogger('consensusMismatch')`).
 *
 * 동작 변경 없음 — 순수 측정. 호출 실패가 탭 UX를 차단하지 않는다.
 */
import { createLogger } from '../../../shared/utils/logger';

const log = createLogger('consensusMismatch');

interface Counters {
  /** consensus-confirmed 제안과 다른 탭 fire 누적 횟수(앱 lifetime). */
  fired: number;
  /** 마지막 fire 시각(epoch ms). 호출 전 0. */
  lastFiredAtMs: number;
}

const counters: Counters = { fired: 0, lastFiredAtMs: 0 };

/**
 * consensus 제안(A)과 사용자가 실제 탭한 열차(B)가 다를 때 호출. log emit + counter 적재.
 *
 * @param suggestedTrainCode backend consensus engine이 confirmed한 train code (A).
 * @param tappedTrainCode 사용자가 BoardingTrainList에서 실제 탭한 train code (B). A와 같을 수 없다 —
 *   호출자가 mismatch만 호출하도록 가드한다.
 */
export function recordConsensusMismatch(
  suggestedTrainCode: string,
  tappedTrainCode: string,
): void {
  counters.fired += 1;
  counters.lastFiredAtMs = Date.now();
  log.info(
    `consensus mismatch fired suggested=${suggestedTrainCode} tapped=${tappedTrainCode} total=${counters.fired}`,
  );
}

/** 현재 누적 counter 스냅샷. DebugModal/테스트 노출. */
export function getConsensusMismatchMetrics(): Readonly<Counters> {
  return { ...counters };
}

/** 테스트 격리용 reset. production code에서 호출하지 않는다. */
export function resetConsensusMismatchMetrics(): void {
  counters.fired = 0;
  counters.lastFiredAtMs = 0;
}
