/**
 * #1111: analyze-station-distances 헬퍼 함수 테스트.
 * main()은 fs/console 부수효과라 헬퍼만 검증.
 */
const { haversineMeters, percentile } = require('../analyze-station-distances');

describe('haversineMeters', () => {
  it('동일 좌표는 0', () => {
    expect(haversineMeters(37.5, 127.0, 37.5, 127.0)).toBe(0);
  });

  it('서울역 인근 ~1km 좌표쌍은 ~1000m', () => {
    // 위도 0.009도 ≈ 1km
    const d = haversineMeters(37.5, 127.0, 37.509, 127.0);
    expect(d).toBeGreaterThan(990);
    expect(d).toBeLessThan(1010);
  });

  it('대칭성 — (A,B) === (B,A)', () => {
    const a = haversineMeters(37.5, 127.0, 37.55, 127.05);
    const b = haversineMeters(37.55, 127.05, 37.5, 127.0);
    expect(a).toBeCloseTo(b, 6);
  });
});

describe('percentile', () => {
  it('빈 배열은 0', () => {
    expect(percentile([], 0.5)).toBe(0);
  });

  it('정렬된 배열의 중간값', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
  });

  it('p90 (floor((n-1)*p) 인덱스)', () => {
    // n=10, p=0.9 → floor(9*0.9)=floor(8.1)=8 → arr[8]=9.
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
  });

  it('p0은 최소값', () => {
    expect(percentile([10, 20, 30], 0)).toBe(10);
  });
});
