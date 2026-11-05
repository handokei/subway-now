import { LINE_COLORS, LINE_NAMES } from '../lineColors';

describe('LINE_COLORS', () => {
  it('1호선 색상은 #0052A4이다', () => {
    expect(LINE_COLORS['1']).toBe('#0052A4');
  });

  it('2호선 색상은 #009D3E이다', () => {
    expect(LINE_COLORS['2']).toBe('#009D3E');
  });

  it('모든 호선 색상이 # 으로 시작하는 16진수 형식이다', () => {
    Object.values(LINE_COLORS).forEach((color) => {
      expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    });
  });
});

describe('LINE_NAMES', () => {
  it('1호선 이름은 "1호선"이다', () => {
    expect(LINE_NAMES['1']).toBe('1호선');
  });

  it('공항철도 이름은 "공항철도"이다', () => {
    expect(LINE_NAMES['airport']).toBe('공항철도');
  });

  it('모든 호선에 이름이 있다', () => {
    const names = Object.values(LINE_NAMES);
    expect(names).toHaveLength(Object.keys(LINE_COLORS).length);
    names.forEach((name) => {
      expect(typeof name).toBe('string');
      expect(name.length).toBeGreaterThan(0);
    });
  });

  it('정의되지 않은 호선 키는 undefined를 반환한다', () => {
    expect(LINE_NAMES['unknown' as never]).toBeUndefined();
  });

  it('정의되지 않은 키의 디스크립터는 undefined를 반환한다', () => {
    expect(Object.getOwnPropertyDescriptor(LINE_NAMES, 'unknown' as never)).toBeUndefined();
  });
});
