import { resolveTintLine } from '../resolveTintLine';

describe('resolveTintLine', () => {
  it('탑승 lock 노선이 최우선이다', () => {
    expect(resolveTintLine({ boardingLine: '2', approachLine: '3', originLine: '4' })).toBe('2');
  });

  it('lock이 없으면 진행 노선', () => {
    expect(resolveTintLine({ boardingLine: null, approachLine: '3', originLine: '4' })).toBe('3');
  });

  it('진행 노선도 없으면 현재역 노선', () => {
    expect(resolveTintLine({ approachLine: undefined, originLine: '4' })).toBe('4');
  });

  it('모두 없으면 null', () => {
    expect(resolveTintLine({})).toBeNull();
  });
});
