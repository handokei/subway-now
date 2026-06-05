import type { ArrivalProvider } from './types';
import { SeoulOpenApiProvider } from './SeoulOpenApiProvider';
import { BffArrivalProvider } from './BffArrivalProvider';

export function createArrivalProvider(): ArrivalProvider {
  const useBff = process.env.EXPO_PUBLIC_USE_BFF === 'true';
  const bffUrl = process.env.EXPO_PUBLIC_BFF_URL;

  if (useBff && bffUrl) {
    return new BffArrivalProvider(bffUrl);
  }

  return new SeoulOpenApiProvider();
}
