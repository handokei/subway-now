import { describe, expect, it } from 'vitest';
import {
  CRON_READ_CACHE_TTL_SEC,
  KV_MIN_CACHE_TTL_SEC,
  assertCronCacheTtl,
} from '../kvConsistency';

/**
 * #1402 — KV cron read cacheTtl runtime guard.
 *
 * Cloudflare KV는 `cacheTtl < 30`을 런타임에서 throw. 신규 callsite가 0/10 같은 값을 silently
 * 사용해 listTrips/listPending이 abort되는 회귀(#1364/#1381)를 다시 만들지 못하도록 본 모듈이
 * caller 단계에서 명시 실패시킨다.
 */
describe('kvConsistency', () => {
  it('CRON_READ_CACHE_TTL_SEC === KV_MIN_CACHE_TTL_SEC (cron read는 KV 최소 제약과 동일 floor)', () => {
    expect(CRON_READ_CACHE_TTL_SEC).toBe(KV_MIN_CACHE_TTL_SEC);
  });

  it('KV_MIN_CACHE_TTL_SEC === 30 (Cloudflare KV 런타임 floor 박제)', () => {
    expect(KV_MIN_CACHE_TTL_SEC).toBe(30);
  });

  it('assertCronCacheTtl: 30s 통과 (KV 최소값과 동일)', () => {
    expect(() => assertCronCacheTtl(30)).not.toThrow();
  });

  it('assertCronCacheTtl: 60s 통과 (기본 KV cacheTtl)', () => {
    expect(() => assertCronCacheTtl(60)).not.toThrow();
  });

  it('assertCronCacheTtl: 0 throw (#1364 회귀 차단)', () => {
    expect(() => assertCronCacheTtl(0)).toThrow(RangeError);
  });

  it('assertCronCacheTtl: 10 throw (#766/#770 가설 시도값 차단)', () => {
    expect(() => assertCronCacheTtl(10)).toThrow(/cacheTtl >= 30s/);
  });

  it('assertCronCacheTtl: 29 throw (boundary)', () => {
    expect(() => assertCronCacheTtl(29)).toThrow(RangeError);
  });

  it('assertCronCacheTtl: NaN throw (defensive)', () => {
    expect(() => assertCronCacheTtl(Number.NaN)).toThrow(RangeError);
  });

  it('assertCronCacheTtl: -1 throw (defensive)', () => {
    expect(() => assertCronCacheTtl(-1)).toThrow(RangeError);
  });
});
