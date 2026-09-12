import type { ArrivalProvider } from './types';
import { SeoulOpenApiProvider } from './SeoulOpenApiProvider';
import { BffArrivalProvider } from './BffArrivalProvider';
import { CompositeArrivalProvider } from './CompositeArrivalProvider';
import { createKorailArrivalProvider } from './KorailArrivalProvider';

export function createArrivalProvider(): ArrivalProvider {
  const useBff = process.env.EXPO_PUBLIC_USE_BFF === 'true';
  const bffUrl = process.env.EXPO_PUBLIC_BFF_URL;

  const base: ArrivalProvider = useBff && bffUrl
    ? new BffArrivalProvider(bffUrl)
    : new SeoulOpenApiProvider();

  // #1096: 코레일 fallback을 명시 게이트(EXPO_PUBLIC_USE_KORAIL_FALLBACK=true)로 활성화.
  // 미설정 시 기존 동작 그대로 — Composite는 wrapper일 뿐 기본 경로에 영향 없음.
  if (process.env.EXPO_PUBLIC_USE_KORAIL_FALLBACK === 'true') {
    return new CompositeArrivalProvider(createKorailArrivalProvider(), base);
  }

  return base;
}
