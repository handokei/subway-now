import { shadowStyle } from '../shadows';

describe('shadowStyle', () => {
  it('라이트: legacy shadow props + elevation', () => {
    expect(shadowStyle('card', false)).toEqual({
      shadowColor: '#003C1E',
      shadowOffset: { width: 0, height: 10 },
      shadowOpacity: 0.14,
      shadowRadius: 15,
      elevation: 4,
    });
  });

  it('다크는 다른 스펙을 쓴다', () => {
    expect(shadowStyle('card', true).shadowColor).toBe('#000000');
    expect(shadowStyle('card', true).shadowOpacity).toBe(0.5);
  });

  it('다크 세그먼트는 반투명 활성 배경이라 그림자를 끈다', () => {
    expect(shadowStyle('segment', true).shadowOpacity).toBe(0);
    expect(shadowStyle('segment', true).elevation).toBe(0);
    expect(shadowStyle('segment', false).shadowOpacity).toBe(0.08);
  });

  it('colorOverride가 shadowColor를 덮는다(ring 후광)', () => {
    expect(shadowStyle('ring', false, '#009D3E').shadowColor).toBe('#009D3E');
  });

  it('모든 kind가 정의된다', () => {
    for (const kind of ['card', 'tabBar', 'floatCard', 'segment', 'ring'] as const) {
      expect(shadowStyle(kind, false).shadowRadius).toBeGreaterThanOrEqual(0);
      expect(shadowStyle(kind, true).shadowRadius).toBeGreaterThanOrEqual(0);
    }
  });
});
