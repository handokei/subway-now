import type { ArrivalProvider } from './types';
import { SeoulOpenApiProvider } from './arrival/SeoulOpenApiProvider';
import { BffArrivalProvider } from './arrival/BffArrivalProvider';

export function createArrivalProvider(): ArrivalProvider {
  const useBff = process.env.EXPO_PUBLIC_USE_BFF === 'true';
  const bffUrl = process.env.EXPO_PUBLIC_BFF_URL;

  if (useBff && bffUrl) {
    return new BffArrivalProvider(bffUrl);
  }

  return new SeoulOpenApiProvider();
}
