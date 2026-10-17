import stations from '../../../../data/stations.json';
import type { Station } from '../../../../shared/types/station';
import { isLineNumber } from '../lineGuard';

describe('isLineNumber', () => {
  it('stations.json에 존재하는 모든 line 코드를 통과시킨다 (데이터 주도)', () => {
    const codes = Array.from(new Set((stations as Station[]).map((s) => s.line)));
    // 가드가 stations.json의 union을 그대로 추종하는지 — 하드코딩한 list가 아닌
    // 실제 데이터에서 도출됨을 보장.
    for (const code of codes) {
      expect(isLineNumber(code)).toBe(true);
    }
    // 최소한 우리가 지원하는 13 노선 이상은 stations.json에 들어있어야 한다.
    expect(codes.length).toBeGreaterThanOrEqual(13);
  });

  it.each([
    ['빈 문자열', ''],
    ['stations.json에 없는 가짜 코드', 'fake-line-99'],
    ['number type', 2],
    ['null', null],
    ['undefined', undefined],
    ['object', { line: '2' }],
  ])('잘못된 입력 %s → false', (_label, input) => {
    expect(isLineNumber(input)).toBe(false);
  });
});
