/**
 * apnsToken.ts 단위 테스트 (#2176) — APNs device token 64-hex 불변식 검증.
 */
import { describe, expect, it } from 'vitest';
import { isValidApnsToken } from '../apnsToken';

describe('isValidApnsToken (#2176)', () => {
  it('64자리 소문자 hex는 유효', () => {
    expect(isValidApnsToken('0123456789abcdef'.repeat(4))).toBe(true);
  });

  it('64자리 대문자 hex도 유효(대소문자 무관)', () => {
    expect(isValidApnsToken('0123456789ABCDEF'.repeat(4))).toBe(true);
  });

  it('UUID(rotation된 trip.token)는 무효 — 로테이션 결함의 핵심 증상', () => {
    expect(isValidApnsToken('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
  });

  it('64자보다 짧으면 무효', () => {
    expect(isValidApnsToken('0123456789abcdef')).toBe(false);
  });

  it('64자보다 길면 무효', () => {
    expect(isValidApnsToken(`${'0123456789abcdef'.repeat(4)}ab`)).toBe(false);
  });

  it('hex 아닌 문자가 섞이면 무효', () => {
    expect(isValidApnsToken(`${'0123456789abcdef'.repeat(3)}zzzzzzzzzzzzzzzz`)).toBe(false);
  });

  it('빈 문자열은 무효', () => {
    expect(isValidApnsToken('')).toBe(false);
  });
});
