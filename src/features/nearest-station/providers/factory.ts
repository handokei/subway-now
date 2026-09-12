import type { PositionProvider } from './types';
import { SeoulOpenPositionProvider } from './SeoulOpenPositionProvider';

/**
 * Phase 3: realtimePosition Provider. BFF 도입 시 같은 인터페이스로 추가 가능
 * (현재는 직접 호출만). 호출 비용은 useTrainPositions의 모듈 싱글톤 캐시가 호선 단위로 dedup.
 */
export function createPositionProvider(): PositionProvider {
  return new SeoulOpenPositionProvider();
}
