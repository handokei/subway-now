import { haversine } from '../haversine';

describe('haversine', () => {
  it('같은 좌표는 0km를 반환한다', () => {
    expect(haversine(37.5, 127.0, 37.5, 127.0)).toBe(0);
  });

  it('서울역 ↔ 강남역 거리가 약 7~9km 범위 안에 있다', () => {
    // 서울역: 37.5547, 126.9723 / 강남역: 37.4979, 127.0276
    const dist = haversine(37.5547, 126.9723, 37.4979, 127.0276);
    expect(dist).toBeGreaterThan(7);
    expect(dist).toBeLessThan(9);
  });

  it('거리는 항상 0 이상이다', () => {
    const dist = haversine(37.1, 126.5, 37.9, 127.5);
    expect(dist).toBeGreaterThanOrEqual(0);
  });

  it('a→b 와 b→a 의 거리는 동일하다 (대칭성)', () => {
    const d1 = haversine(37.5, 127.0, 37.6, 127.1);
    const d2 = haversine(37.6, 127.1, 37.5, 127.0);
    expect(d1).toBeCloseTo(d2, 10);
  });

  it('위도 1도 차이는 약 111km이다', () => {
    const dist = haversine(37.0, 127.0, 38.0, 127.0);
    expect(dist).toBeGreaterThan(110);
    expect(dist).toBeLessThan(112);
  });
});
