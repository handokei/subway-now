import type { BffProgressProvider, BffProgressResponse } from './types';

/**
 * 개발/테스트용 mock progress provider.
 *
 * - 인자 없이 생성하면 `null` 반환 (서버 미수신 시나리오) — Stage 4 회귀 가드 점검에 사용.
 * - 응답을 주입하면 호출자가 준 `nowMs`를 `receivedAtMs`로 채워 항상 신선한 high-confidence
 *   응답을 흉내낸다. 테스트가 만료/low/실패 시나리오를 만들고 싶다면 직접 응답을 구성하거나
 *   `respond(null)`을 호출한다.
 *
 * @see docs/decisions/ADR-008-boarding-progress-estimator.md Stage 4
 */
export class MockBffProgressProvider implements BffProgressProvider {
  private next: BffProgressResponse | null = null;

  respond(response: BffProgressResponse | null): void {
    this.next = response;
  }

  async fetch(_tripToken: string, _nowMs: number): Promise<BffProgressResponse | null> {
    return this.next;
  }
}
