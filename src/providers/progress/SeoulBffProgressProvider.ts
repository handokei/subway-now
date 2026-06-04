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
 * @see docs/decisions/ADR-008-boarding-progress-estimator.md Stage 4
 */
export class SeoulBffProgressProvider implements BffProgressProvider {
  private readonly cache = new Map<string, BffProgressResponse>();

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = 5000,
  ) {}

  async fetch(tripToken: string, nowMs: number): Promise<BffProgressResponse | null> {
    const cached = this.cache.get(tripToken);
    if (cached && nowMs - cached.receivedAtMs <= cached.ttlMs) {
      return this.gate(cached, nowMs);
    }

    const fresh = await this.fetchFromBff(tripToken);
    if (!fresh) {
      // 네트워크/timeout/non-2xx — stale 캐시는 폐기하지 않고 그대로 둔다.
      // 다음 호출이 만료된 캐시를 다시 만나도 게이트가 null을 반환하므로 안전.
      return null;
    }

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
