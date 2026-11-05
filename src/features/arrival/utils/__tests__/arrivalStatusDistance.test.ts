import { parseArrivalDistance } from '../arrivalStatusDistance';

describe('parseArrivalDistance', () => {
  it.each([
    ['[4]번째 전역 (문정)', '4번째 전'],
    ['[1]번째 전역 (홍대입구)', '1번째 전'],
    ['[10]번째 전역', '10번째 전'],
  ])('괄호 거리 패턴 매칭: "%s" → "%s"', (input, expected) => {
    expect(parseArrivalDistance(input)).toBe(expected);
  });

  it.each([
    ['전역 출발', '전역 출발'],
    ['당역 도착', '당역 도착'],
    ['진입', '진입'],
    ['곧 도착', '곧 도착'],
  ])('비매칭 비어있지 않은 메시지는 원본 그대로: "%s"', (input, expected) => {
    expect(parseArrivalDistance(input)).toBe(expected);
  });

  it('빈 문자열은 빈 문자열 그대로 — 호출자가 fallback 결정', () => {
    expect(parseArrivalDistance('')).toBe('');
  });

  it('숫자가 0이면 그대로 "0번째 전" — 가드 없이 통과 (이론상 발생 안하지만 정규화 일관성)', () => {
    expect(parseArrivalDistance('[0]번째 전역')).toBe('0번째 전');
  });
});
