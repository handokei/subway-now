/**
 * #823 — 최신 가속도 요약값을 모듈 ambient state로 보관 (BG task 공유용).
 *
 * useAccelerometer hook이 갱신하고, backgroundLocationTask가 position upload 시점에 latest를
 * snapshot으로 첨부한다. motionActivity 모듈의 ambient state 패턴(getCurrentMotionStationary)을
 * 따른다 — BG task는 React 컨텍스트가 없어 직접 모듈 함수 호출로 sync.
 *
 * 정책:
 *   - latest 1건만 보관. backend는 이미 KV ring buffer로 누적하므로 클라이언트 ring은 불필요.
 *   - 외부에서 stale 검사는 `endTs`로 호출자가 직접 처리 (이 모듈은 단순 컨테이너).
 */

import type { AccelSummary } from './accelMotion';

let latestSummary: AccelSummary | null = null;

/**
 * useAccelerometer가 1초마다 새 요약값을 적재.
 * null로 설정해 명시적 reset도 가능 (hook unmount 시).
 */
export function setLatestAccelSummary(summary: AccelSummary | null): void {
  latestSummary = summary;
}

/**
 * BG task가 송신 직전 latest snapshot 조회. 없거나 unmount된 상태면 null.
 */
export function getLatestAccelSummary(): AccelSummary | null {
  return latestSummary;
}
