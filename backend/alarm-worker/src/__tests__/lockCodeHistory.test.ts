import { describe, expect, it } from 'vitest';
import { LOCK_CODE_HISTORY_CAP, appendLockCodeHistory } from '../lockCodeHistory';

/** #3141 — 같은 trip에서 lock trainCode가 교체될 때 옛 코드를 cap 5로 쌓는 순수 헬퍼. */
describe('#3141 appendLockCodeHistory', () => {
  it('이력 없음 -> [old]', () => {
    expect(appendLockCodeHistory(undefined, '3009')).toEqual(['3009']);
  });

  it('기존 이력 뒤에 append(순서 보존)', () => {
    expect(appendLockCodeHistory(['3009'], '3045')).toEqual(['3009', '3045']);
  });

  it('이미 있는 코드는 중복 append 안 함(flapping 방지)', () => {
    expect(appendLockCodeHistory(['3009', '3045'], '3009')).toEqual(['3009', '3045']);
  });

  it('cap 초과 시 가장 오래된 것부터 버린다', () => {
    const full = Array.from({ length: LOCK_CODE_HISTORY_CAP }, (_, i) => `c${i}`);
    const next = appendLockCodeHistory(full, 'new');
    expect(next).toHaveLength(LOCK_CODE_HISTORY_CAP);
    expect(next[next.length - 1]).toBe('new');
    expect(next).not.toContain('c0');
  });

  it('입력 배열을 변이시키지 않는다', () => {
    const src = ['3009'];
    appendLockCodeHistory(src, '3045');
    expect(src).toEqual(['3009']);
  });
});
