import type { ArrivalProvider, PositionProvider } from './types';
import { SeoulOpenApiProvider } from './arrival/SeoulOpenApiProvider';
import { BffArrivalProvider } from './arrival/BffArrivalProvider';
import { SeoulOpenPositionProvider } from './position/SeoulOpenPositionProvider';

export function createArrivalProvider(): ArrivalProvider {
  const useBff = process.env.EXPO_PUBLIC_USE_BFF === 'true';
  const bffUrl = process.env.EXPO_PUBLIC_BFF_URL;

  if (useBff && bffUrl) {
    return new BffArrivalProvider(bffUrl);
  }

  return new SeoulOpenApiProvider();
}

/**
 * Phase 3: realtimePosition Provider. BFF 도입 시 같은 인터페이스로 추가 가능
 * (현재는 직접 호출만). 호출 비용은 useTrainPositions의 모듈 싱글톤 캐시가 호선 단위로 dedup.
 */
export function createPositionProvider(): PositionProvider {
  return new SeoulOpenPositionProvider();
}
