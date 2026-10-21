/**
 * "1 end = 1 action" 동기 선점(claim).
 *
 * 같은 트립의 종료가 여러 경로(9h force-end / 일시정지 backstop / backend-gone / self-end …)에서
 * 동시에 감지될 수 있다. 각 경로가 읽기를 통과한 뒤 부작용(종료 알림 등)을 실행하면 둘 다 통과해
 * 이중 실행된다. 모듈 레벨 `Set`의 check-and-set은 JS 단일 스레드에서 `await` 없이 끝나므로
 * 원자적이다 — 먼저 부른 쪽만 true를 받는다.
 *
 * 범위: 한 JS 컨텍스트 안. 프로세스 재시작을 넘는 중복은 종료 알림의 고정 id
 * (`TRIP_ENDED_NOTIFICATION_ID`)가 트레이 1건으로 수렴시키는 2차 방어에 맡긴다.
 */

/** 보관하는 최근 claim 수 — 트립은 한 번에 하나라 작게 유지하고, 오래된 것부터 버린다. */
const MAX_TRACKED_CLAIMS = 32;

const claims = new Set<string>();

/** `key`를 처음 선점하면 true, 이미 선점돼 있으면 false. */
export function claimTripEnd(key: string): boolean {
  if (claims.has(key)) return false;
  claims.add(key);
  if (claims.size > MAX_TRACKED_CLAIMS) {
    // Set은 삽입 순서를 유지하므로 첫 원소가 가장 오래된 claim이다.
    const [oldest] = claims;
    claims.delete(oldest);
  }
  return true;
}

/** 테스트 전용 — claim 상태 초기화. production 호출 금지. */
export function __resetTripEndClaimsForTests__(): void {
  claims.clear();
}
