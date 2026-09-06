import { MockBffProgressProvider } from '../MockBffProgressProvider';
import type { BffProgressResponse } from '../types';

describe('MockBffProgressProvider', () => {
  it('주입된 응답이 없으면 null을 반환한다 (기본값)', async () => {
    const provider = new MockBffProgressProvider();
    const result = await provider.fetch('any-token', 0);
    expect(result).toBeNull();
  });

  it('respond로 주입한 응답을 그대로 반환한다', async () => {
    const provider = new MockBffProgressProvider();
    const response: BffProgressResponse = {
      waypointIndex: 4,
      remainingHopsMs: 15_000,
      confidence: 'medium',
      receivedAtMs: 1_000,
      ttlMs: 60_000,
    };
    provider.respond(response);

    const result = await provider.fetch('any-token', 9_999);

    expect(result).toBe(response);
  });

  it('respond(null)로 응답을 비울 수 있다', async () => {
    const provider = new MockBffProgressProvider();
    provider.respond({
      waypointIndex: 0,
      remainingHopsMs: 0,
      confidence: 'high',
      receivedAtMs: 0,
      ttlMs: 0,
    });
    provider.respond(null);

    const result = await provider.fetch('any-token', 0);

    expect(result).toBeNull();
  });
});
