import {
  COORDINATE_REDACTION_PATTERNS,
  REDACTED_COORDINATE,
  REDACTED_TOKEN,
  TOKEN_HEX_PATTERN,
} from '../feedbackRedaction';

// g 플래그 정규식은 lastIndex를 공유하므로 replace(항상 0부터)만 사용한다.
function redactCoordinates(input: string): string {
  return COORDINATE_REDACTION_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, REDACTED_COORDINATE),
    input,
  );
}

describe('feedbackRedaction (#3366)', () => {
  it('실좌표 형식(pos= / lat=·lng= / 쌍)은 치환된다', () => {
    expect(redactCoordinates('pos=37.54321,127.05432')).toBe('pos=[redacted]');
    expect(redactCoordinates('lat=37.5445123, lng=127.0')).toBe('lat=[redacted], lng=[redacted]');
    expect(redactCoordinates('near 37.5445,127.0567 here')).toBe('near [redacted] here');
  });

  it('오탐 형식은 불변이다', () => {
    const fp = 'arc=33.53 acc=339.39 age=33.375 arc=1128.61 distM=37 arc=4636.57';
    expect(redactCoordinates(fp)).toBe(fp);
  });

  it('앞자리 숫자가 붙은 쌍은 치환하지 않는다', () => {
    const input = '1237.5445,127.0567';
    expect(redactCoordinates(input)).toBe(input);
  });

  it('같은 패턴을 반복 사용해도 결과가 같다(lastIndex 비공유)', () => {
    const input = 'pos=37.54321,127.05432';
    expect(redactCoordinates(input)).toBe(redactCoordinates(input));
  });

  it('hex 40자 이상은 [token], 39자는 유지', () => {
    const hex64 = 'a1b2c3d4'.repeat(8);
    expect(`/trips/${hex64}/status`.replace(TOKEN_HEX_PATTERN, REDACTED_TOKEN)).toBe(
      '/trips/[token]/status',
    );
    const short = 'a'.repeat(39);
    expect(short.replace(TOKEN_HEX_PATTERN, REDACTED_TOKEN)).toBe(short);
  });
});
