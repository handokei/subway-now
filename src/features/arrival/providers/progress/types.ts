/**
 * ADR-008 Stage 4 — BFF가 권위 있게 내려주는 boarding progress 응답.
 *
 * 서버는 1분 cron으로 trip의 `boardingLock`을 평가하고 현재 어디서 다음 어디까지
 * 얼마 남았는지를 lock 단위로 산출한다. 클라는 medium 이상 신뢰도의 신선한 응답만
 * 채택하고, 게이트 실패 시 Stage 1-3 fallback 경로로 자연 진행한다(회귀 가드).
 */
export interface BffProgressResponse {
  /** route segment 내 현재 waypoint (0-indexed). */
  waypointIndex: number;
  /** 다음 waypoint까지 잔여 ms (서버 ETA 기준). */
  remainingHopsMs: number;
  /** 서버가 계산한 신뢰도 — 클라는 medium 이상만 채택. */
  confidence: 'high' | 'medium' | 'low';
  /** 서버 응답 시각 (epoch ms) — Stage 1-3 신선도 계약과 동일 명명. */
  receivedAtMs: number;
  /** 응답 유효 기간 — 만료 시 클라 fallback. */
  ttlMs: number;
}

export interface BffProgressProvider {
  /**
   * trip 식별 토큰(lock과 1:1)으로 서버 progress 조회.
   *
   * - 신선/유효 응답이면 `BffProgressResponse`. 인증/캐싱은 구현체 책임.
   * - 만료/네트워크 실패/timeout/`confidence === 'low'` → `null` 반환 (다음 전략으로 자연 진행).
   *
   * @param tripToken `lock.trainCode + boardingLine`으로 만든 trip 식별자
   * @param nowMs 호출 시각 (epoch ms) — TTL 게이트와 캐시 만료 판단 기준
   */
  fetch(tripToken: string, nowMs: number): Promise<BffProgressResponse | null>;
}
