import type { CongestionProvider } from './types';
import { MockCongestionProvider } from './MockCongestionProvider';

/**
 * 혼잡도 provider factory.
 *
 * #1097 P0-A PoC: 현재는 항상 MockCongestionProvider 반환. 후속 PR에서
 * `EXPO_PUBLIC_SEOUL_DATA_API_KEY` 존재 여부로 SeoulOdCongestionProvider로 분기 예정.
 */
export function createCongestionProvider(): CongestionProvider {
  return new MockCongestionProvider();
}
