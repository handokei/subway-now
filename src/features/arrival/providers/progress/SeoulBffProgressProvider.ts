import {
  BACKOFF_BASE_MS,
  BACKOFF_FACTOR,
  BACKOFF_MAX_MS,
  FAILURE_THRESHOLD,
} from '../../../../shared/constants/bffProgressFallback';
import type { BffProgressProvider, BffProgressResponse } from './types';

/**
 * ADR-008 Stage 4 — 기본 BFF progress 구현.
 *
 * - `baseUrl/api/progress/{tripToken}` GET. 인증/스키마 확정은 backend sub-issue.
 * - TTL 캐시: 응답의 `ttlMs` 만큼 trip 단위로 메모리 캐시. 만료 시점에만 재호출.
 * - 게이트 실패는 모두 `null` 반환 — estimator가 Stage 1-3 fallback으로 자연 진행 (회귀 가드).
 *   - 네트워크 실패 / timeout / non-2xx 응답
 *   - 만료 응답: `nowMs - receivedAtMs > ttlMs`
 *   - `confidence === 'low'`
 *
 * ### Backend down 감지 + exponential backoff (#1172)
 *
 * 네트워크/timeout/non-2xx가 `FAILURE_THRESHOLD`회 연속이면 backend down으로 판정한다.
 * down 모드에서는 backoff 만료 전까지 fetch 자체를 건너뛰고 `null`을 반환해 estimator의
 * Stage 1-3 fallback으로 자연 진행 (R-2 / R-9 / B5: 알람 over-fire 방지).
 * backoff 만료 시점에 다시 시도하고, 성공하면 down 모드를 즉시 해제한다.
 * `confidence === 'low'`는 데이터 품질 게이트일 뿐 backend 건강과 무관하므로 실패로 세지 않는다.
 *
 * @see docs/decisions/ADR-008-boarding-progress-estimator.md Stage 4
 */
export class SeoulBffProgressProvider implements BffProgressProvider {
  private readonly cache = new Map<string, BffProgressResponse>();
  private consecutiveFailures = 0;
  private nextRetryAtMs = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = 5000,
  ) {}

  async fetch(tripToken: string, nowMs: number): Promise<BffProgressResponse | null> {
    const cached = this.cache.get(tripToken);
    if (cached && nowMs - cached.receivedAtMs <= cached.ttlMs) {
      return this.gate(cached, nowMs);
    }

    if (this.isInBackoff(nowMs)) {
      // backend down 의심 — backoff 만료 전이면 fetch 생략. estimator는 Stage 1-3 fallback 유지.
      return null;
    }

    const fresh = await this.fetchFromBff(tripToken);
    if (!fresh) {
      // 네트워크/timeout/non-2xx — 실패 카운터 증가, 임계치 초과 시 backoff 스케줄.
      // stale 캐시는 폐기하지 않고 그대로 둔다.
      this.recordFailure(nowMs);
      return null;
    }

    // backend 회복 — down 모드 즉시 해제.
    this.recordSuccess();
    this.cache.set(tripToken, fresh);
    return this.gate(fresh, nowMs);
  }

  /**
   * 신선도/신뢰도 게이트. 회귀 가드: 게이트 실패 시 null 반환 — Stage 1-3 fallback으로 자연 진행.
   */
  private gate(response: BffProgressResponse, nowMs: number): BffProgressResponse | null {
    if (response.confidence === 'low') {
      return null;
    }
    if (nowMs - response.receivedAtMs > response.ttlMs) {
      return null;
    }
    return response;
  }

  private isInBackoff(nowMs: number): boolean {
    return this.consecutiveFailures >= FAILURE_THRESHOLD && nowMs < this.nextRetryAtMs;
  }

  private recordFailure(nowMs: number): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= FAILURE_THRESHOLD) {
      const exponent = this.consecutiveFailures - FAILURE_THRESHOLD;
      const delay = Math.min(BACKOFF_BASE_MS * BACKOFF_FACTOR ** exponent, BACKOFF_MAX_MS);
      this.nextRetryAtMs = nowMs + delay;
    }
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.nextRetryAtMs = 0;
  }

  private async fetchFromBff(tripToken: string): Promise<BffProgressResponse | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const url = `${this.baseUrl}/api/progress/${encodeURIComponent(tripToken)}`;
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        return null;
      }
      return (await response.json()) as BffProgressResponse;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
