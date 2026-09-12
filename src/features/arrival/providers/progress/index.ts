import type { BffProgressProvider } from './types';
import { SeoulBffProgressProvider } from './SeoulBffProgressProvider';
import { MockBffProgressProvider } from './MockBffProgressProvider';

export type { BffProgressProvider, BffProgressResponse } from './types';
export { SeoulBffProgressProvider } from './SeoulBffProgressProvider';
export { MockBffProgressProvider } from './MockBffProgressProvider';

/**
 * ADR-008 Stage 4 progress provider factory.
 *
 * `EXPO_PUBLIC_USE_BFF=true` + `EXPO_PUBLIC_BFF_URL` 설정 시 BFF 호출. 그 외엔 항상 null을
 * 반환하는 mock — Stage 1-3 fallback이 자연 진행되므로 BFF 미배포 환경에서도 안전.
 */
export function createBffProgressProvider(): BffProgressProvider {
  const useBff = process.env.EXPO_PUBLIC_USE_BFF === 'true';
  const bffUrl = process.env.EXPO_PUBLIC_BFF_URL;

  if (useBff && bffUrl) {
    return new SeoulBffProgressProvider(bffUrl);
  }

  return new MockBffProgressProvider();
}
