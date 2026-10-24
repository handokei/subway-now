import { describe, expect, it } from 'vitest';
import {
  CRON_READ_CACHE_TTL_SEC,
  KV_MIN_CACHE_TTL_SEC,
  assertCronCacheTtl,
  assertKvCacheTtl,
  enforceCacheTtlFloor,
} from '../kvConsistency';

/**
 * #1402 + #1423 — KV cacheTtl runtime guard.
 *
 * Cloudflare KV는 `cacheTtl < 30`을 런타임에서 throw. 신규 callsite가 0/10 같은 값을 silently
 * 사용해 listTrips/listPending이 abort되는 회귀(#1364/#1381)와 `verifyBoardingLockPersisted`
 * 가 sync handler 전체를 실패시키는 회귀(#1423)를 다시 만들지 못하도록 본 모듈이 caller
 * 단계에서 명시 실패시킨다.
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

  // #1423 — `assertKvCacheTtl`은 일반 KV read 경로 (sync handler / POST handler 등) 가드.
  // cron 경로 전용 `assertCronCacheTtl`과 의미가 다르고, undefined를 허용한다 (caller가
  // 옵션을 명시하지 않으면 KV 기본 60s 적용).
  describe('assertKvCacheTtl (#1423)', () => {
    it('undefined 통과 (KV 기본 60s가 caller 단계에서 적용됨)', () => {
      expect(() => assertKvCacheTtl(undefined)).not.toThrow();
    });

    it('30 통과 (boundary, KV 최소 제약)', () => {
      expect(() => assertKvCacheTtl(30)).not.toThrow();
    });

    it('60 통과 (KV 기본값)', () => {
      expect(() => assertKvCacheTtl(60)).not.toThrow();
    });

    it('0 throw (#1423 회귀 차단 — verifyBoardingLockPersisted cacheTtl=0)', () => {
      expect(() => assertKvCacheTtl(0)).toThrow(RangeError);
      expect(() => assertKvCacheTtl(0)).toThrow(/Invalid KV cacheTtl 0/);
    });

    it('15 throw', () => {
      expect(() => assertKvCacheTtl(15)).toThrow(/cacheTtl >= 30s/);
    });

    it('29 throw (boundary)', () => {
      expect(() => assertKvCacheTtl(29)).toThrow(RangeError);
    });

    it('NaN throw (defensive)', () => {
      expect(() => assertKvCacheTtl(Number.NaN)).toThrow(RangeError);
    });

    it('-1 throw (defensive)', () => {
      expect(() => assertKvCacheTtl(-1)).toThrow(RangeError);
    });
  });

  // #1423 — `enforceCacheTtlFloor`는 잘못된 값 차단이 아니라 안전한 값으로 정정 (clamp).
  // sync handler처럼 "가장 작은 안전한 cacheTtl을 원함"을 명시할 때 사용.
  describe('enforceCacheTtlFloor (#1423)', () => {
    it('undefined → floor (30)', () => {
      expect(enforceCacheTtlFloor(undefined)).toBe(KV_MIN_CACHE_TTL_SEC);
    });

    it('0 → floor (30)', () => {
      expect(enforceCacheTtlFloor(0)).toBe(KV_MIN_CACHE_TTL_SEC);
    });

    it('15 → floor (30)', () => {
      expect(enforceCacheTtlFloor(15)).toBe(KV_MIN_CACHE_TTL_SEC);
    });

    it('29 → floor (30, boundary)', () => {
      expect(enforceCacheTtlFloor(29)).toBe(KV_MIN_CACHE_TTL_SEC);
    });

    it('30 → 30 (passthrough)', () => {
      expect(enforceCacheTtlFloor(30)).toBe(30);
    });

    it('60 → 60 (passthrough)', () => {
      expect(enforceCacheTtlFloor(60)).toBe(60);
    });

    it('600 → 600 (passthrough, 큰 값은 그대로)', () => {
      expect(enforceCacheTtlFloor(600)).toBe(600);
    });

    it('NaN → floor (30, defensive)', () => {
      expect(enforceCacheTtlFloor(Number.NaN)).toBe(KV_MIN_CACHE_TTL_SEC);
    });

    it('-1 → floor (30, 음수는 floor로 정정)', () => {
      expect(enforceCacheTtlFloor(-1)).toBe(KV_MIN_CACHE_TTL_SEC);
    });
  });
});
