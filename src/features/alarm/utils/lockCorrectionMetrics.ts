/**
 * Lock 정정 빈도 metric — #1166 / Epic #1008 C 단기 2번 (B4 round-trip).
 *
 * 낙관적 탭으로 pending(A)이 잡힌 뒤 backend(또는 다른 채널)에서 다른 trainCode(B)로
 * lock이 확정되면 BoardingTrainList가 사용자에게 toast를 노출함과 동시에 본 모듈의
 * `recordLockCorrection`을 호출한다.
 *
 * 단순 in-memory counter — 1주 운영 분포 측정 후 별도 PR에서 backend POST(필요 시)로
 * 승격. logger emit으로 디버그/로컬 분석은 즉시 가능하다(`createLogger('lockCorrection')`).
 *
 * 동작 변경 없음 — 순수 측정. 호출 실패가 toast UX를 차단하지 않는다.
 */
import { createLogger } from '../../../shared/utils/logger';

const log = createLogger('lockCorrection');

interface Counters {
  /** pending→confirmed 정정 fire 누적 횟수(앱 lifetime). */
  fired: number;
  /** 마지막 fire 시각(epoch ms). 호출 전 0. */
  lastFiredAtMs: number;
  /**
   * #2786 리뷰(항목 4) — PENDING sentinel(#2407 fallback lock) → 실 trainCode 승격 누적 횟수.
   * `fired`(사용자가 탭한 A와 backend가 확정한 B가 서로 다른 "정정")와 독립된 채널이다 —
   * 승격은 pendingTrainCode(component)와 lockedTrainCode(store)가 즉시 같은 값으로 수렴해
   * `recordLockCorrection`이 아예 호출되지 않으므로, 이 fix가 프로덕션에서 실제로 발동하는지
   * 확인할 별도 관측 채널이 없었다(Wire-completion #2 V/X 위반).
   */
  promoted: number;
  /** 마지막 승격 시각(epoch ms). 호출 전 0. */
  lastPromotedAtMs: number;
}

const counters: Counters = { fired: 0, lastFiredAtMs: 0, promoted: 0, lastPromotedAtMs: 0 };

/**
 * Pending(A) → 확정(B)으로 정정될 때 호출. log emit + counter 적재.
 *
 * @param pendingTrainCode 사용자가 탭한 시점의 train code (A).
 * @param confirmedTrainCode backend가 실제로 잠근 train code (B). A와 같을 수 없다 —
 *   호출자(BoardingTrainList)가 mismatch만 호출하도록 가드한다.
 */
export function recordLockCorrection(
  pendingTrainCode: string,
  confirmedTrainCode: string,
): void {
  counters.fired += 1;
  counters.lastFiredAtMs = Date.now();
  log.info(
    `lock correction fired pending=${pendingTrainCode} confirmed=${confirmedTrainCode} total=${counters.fired}`,
  );
}

/**
 * #2786 리뷰(항목 4) — PENDING sentinel lock이 실 trainCode로 승격될 때 호출. log emit + counter
 * 적재. `useBoardingLockStore.createLock`(단일 SSOT mutation 지점)이 prev lock이 PENDING이고
 * 새 lock이 실 trainCode면 호출자와 무관하게(수동 탭 / 향후 backend lockSuggestion 승격 경로
 * 모두) 호출한다 — 승격 경로 전체를 한 곳에서 포착한다.
 *
 * @param confirmedTrainCode 승격된(확정) train code.
 */
export function recordPendingLockPromotion(confirmedTrainCode: string): void {
  counters.promoted += 1;
  counters.lastPromotedAtMs = Date.now();
  log.info(
    `pending lock promoted confirmed=${confirmedTrainCode} total=${counters.promoted}`,
  );
}

/** 현재 누적 counter 스냅샷. DebugModal/테스트 노출. */
export function getLockCorrectionMetrics(): Readonly<Counters> {
  return { ...counters };
}

/** 테스트 격리용 reset. production code에서 호출하지 않는다. */
export function resetLockCorrectionMetrics(): void {
  counters.fired = 0;
  counters.lastFiredAtMs = 0;
  counters.promoted = 0;
  counters.lastPromotedAtMs = 0;
}
