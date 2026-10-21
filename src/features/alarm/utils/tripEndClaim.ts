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

import { getCurrentTripCorrIdSync } from '../../observability/utils/tripCorrId';
import { getTripStartedAt } from './tripStartStorage';

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

/**
 * 지금 진행 중인 트립의 종료 identity: corrId(1순위) -> `start:<startedAt>` -> null(트립 없음/알 수 없음).
 * corrId·startedAt은 `runTripBoundCleanups`가 지우므로 **cleanup 앞에서** 불러야 한다.
 */
export async function resolveTripEndIdentity(): Promise<string | null> {
  const corrId = getCurrentTripCorrIdSync();
  if (corrId) return corrId;
  const startedAt = await getTripStartedAt().catch(() => null);
  return startedAt === null ? null : `start:${startedAt}`;
}

/** 종료 "행동"(cleanup·sentinel) 선점 키 접두 — 종료 알림 claim(`notifyTripEnded`)과 네임스페이스를 분리한다. */
const ACTION_CLAIM_PREFIX = 'end:';

export interface TripEndActionClaim {
  claimed: boolean;
  /** 종료가 실패했을 때 claim을 풀어 다음 시도가 재시도하게 한다. 미선점/identity 없음이면 no-op. */
  release: () => void;
}

/**
 * 같은 트립의 종료 행동(9h force-end / 일시정지 / backend-gone 자가 종료)을 한 경로만 실행하게 선점한다.
 * identity를 알 수 없으면(종료할 트립이 없음) 조정 대상이 없으므로 claimed=true.
 */
export async function claimTripEndAction(): Promise<TripEndActionClaim> {
  const identity = await resolveTripEndIdentity();
  if (identity === null) return { claimed: true, release: () => undefined };
  const key = `${ACTION_CLAIM_PREFIX}${identity}`;
  const claimed = claimTripEnd(key);
  return {
    claimed,
    release: () => {
      if (claimed) claims.delete(key);
    },
  };
}

/** 테스트 전용 — claim 상태 초기화. production 호출 금지. */
export function __resetTripEndClaimsForTests__(): void {
  claims.clear();
}
