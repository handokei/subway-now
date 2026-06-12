import { resolveCurrentLine } from '../resolveCurrentLine';
import type { Station } from '../../../../shared/types/station';

const makeStation = (line: Station['line']): Station => ({
  id: 'S1',
  name: '상왕십리',
  line,
  lineColor: '#33A23D',
  lat: 37.5638,
  lng: 127.0288,
});

describe('resolveCurrentLine (Epic #1204 N8)', () => {
  it('lock.boardingLine 있으면 lock 우선', () => {
    const nearest = makeStation('2');
    expect(resolveCurrentLine('5', nearest)).toBe('5');
  });

  it('lock 없으면 nearestStation.line fallback', () => {
    const nearest = makeStation('2');
    expect(resolveCurrentLine(null, nearest)).toBe('2');
  });

  it('lock + nearestStation 둘 다 null이면 null', () => {
    expect(resolveCurrentLine(null, null)).toBe(null);
  });

  it('lock 있고 nearestStation null이어도 lock 사용', () => {
    expect(resolveCurrentLine('5', null)).toBe('5');
  });

  it('회귀 evidence (22:52:40): lock=5호선 vs nearest=2호선 → 5호선', () => {
    // 5호선 답십리 lock 진행 중 fusion이 2호선 상왕십리를 momentary adopt하는 시나리오.
    // currentLine='5'로 유지되어야 다른 leg의 hop fire 차단.
    const wrongNearest = makeStation('2');
    expect(resolveCurrentLine('5', wrongNearest)).toBe('5');
  });
});
