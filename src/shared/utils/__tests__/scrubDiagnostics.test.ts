import { scrubDiagnostics } from '../scrubDiagnostics';

const HEX64 = '3f9a1c7be24d5086a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';

describe('scrubDiagnostics (#3366 방어 스크럽 — 서버와 같은 공용 패턴)', () => {
  describe('좌표(문맥 필수)', () => {
    it.each([
      ['pos=37.54321,127.05432', 'pos=[redacted]'],
      ['lat=37.55123, lng=127.05432, speed=1', 'lat=[redacted], lng=[redacted], speed=1'],
      ['위치 37.5012345, 127.0123456 근처', '위치 [redacted] 근처'],
      ['lat=33.2345 lng=126.5678', 'lat=[redacted] lng=[redacted]'],
    ])('%s → 좌표 치환', (input, expected) => {
      expect(scrubDiagnostics(input)).toBe(expected);
    });

    it.each([
      'arc=33.53',
      'arc=4636.57',
      'acc=339.39',
      'age=33.375',
      'arc=1128.61',
      'distM=37',
      'gps(339m/8.5m/s) | arc=33.53 | hpa=1008.2',
      '| acc=33.53 | age=127.375 |',
    ])('오탐 fixture는 그대로: %s', (input) => {
      expect(scrubDiagnostics(input)).toBe(input);
    });

    it('앞자리에 숫자/소수점이 붙은 값은 좌표로 보지 않는다', () => {
      expect(scrubDiagnostics('x=1237.54321,127.05432')).toBe('x=1237.54321,127.05432');
      expect(scrubDiagnostics('x=0.37.54321,127.05432')).toBe('x=0.37.54321,127.05432');
    });
  });

  describe('token(40자 이상 hex)', () => {
    it('64hex → [token]', () => {
      expect(scrubDiagnostics(`GET /trips/${HEX64}/status`)).toBe('GET /trips/[token]/status');
    });

    it('39자 hex는 유지', () => {
      const short = 'a'.repeat(39);
      expect(scrubDiagnostics(short)).toBe(short);
    });
  });

  it('반복 호출해도 동일 결과(전역 정규식 lastIndex 상태 비의존)', () => {
    const input = `pos=37.54321,127.05432 ${HEX64}`;
    expect(scrubDiagnostics(input)).toBe(scrubDiagnostics(input));
    expect(scrubDiagnostics(input)).toBe('pos=[redacted] [token]');
  });
});
