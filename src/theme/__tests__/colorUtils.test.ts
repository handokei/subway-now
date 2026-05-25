import { withAlpha } from '../colorUtils';

describe('withAlpha', () => {
  it('#RRGGBB hex를 rgba 문자열로 변환', () => {
    expect(withAlpha('#22c55e', 0.13)).toBe('rgba(34, 197, 94, 0.13)');
  });

  it('대문자 hex도 처리', () => {
    expect(withAlpha('#FF9F43', 0.5)).toBe('rgba(255, 159, 67, 0.5)');
  });

  it('hex 외 포맷(rgba)은 원본 그대로 반환 — 시각적 회귀 방지', () => {
    expect(withAlpha('rgba(0,0,0,0.4)', 0.5)).toBe('rgba(0,0,0,0.4)');
  });

  it('shorthand hex(#abc)는 미지원 → 원본 반환', () => {
    expect(withAlpha('#abc', 0.5)).toBe('#abc');
  });

  it('alpha=0 / alpha=1 모두 표현', () => {
    expect(withAlpha('#000000', 0)).toBe('rgba(0, 0, 0, 0)');
    expect(withAlpha('#ffffff', 1)).toBe('rgba(255, 255, 255, 1)');
  });
});
