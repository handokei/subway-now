/**
 * #3122 — 역방향 노선(신분당·수인분당: idx 증가=상행) 방향 산출 형제 함수 감사.
 * 실제 stations.json 순서 기준. 비역방향 노선(7호선: idx 증가=하행)은 불변으로 pin.
 *
 * 수인분당 idx: 인천(0) ... 압구정로데오 < 서울숲 < 왕십리 < 청량리 — 서울숲→압구정로데오 = 하행(인천 방면)
 * 신분당 idx: 광교(0) ... 강남 < 신논현 < 논현 < 신사 — 신논현→강남 = 하행(광교 방면)
 */
import type { LineNumber } from '../../../../shared/types/station';
import { getStationsOnLine } from '../../../../shared/utils/stationRoute';
import { directionOnLine } from '../directionOnLine';
import { resolveTravelDirection, resolveProgressingTerminal } from '../travelDirection';
import { resolveNextAdjacentStationName } from '../nextAdjacentStation';

function idOf(line: LineNumber, name: string): string {
  const found = getStationsOnLine(line).find((s) => s.name === name);
  if (!found) throw new Error(`fixture station missing: ${line} ${name}`);
  return found.id;
}

// [line, from, to, 기대 direction] — 각 노선 up/down 양방향.
const CASES: ReadonlyArray<readonly [LineNumber, string, string, 'up' | 'down']> = [
  ['bundang', '서울숲', '압구정로데오', 'down'],
  ['bundang', '압구정로데오', '서울숲', 'up'],
  ['sinbundang', '신논현', '강남', 'down'],
  ['sinbundang', '강남', '신논현', 'up'],
  // 비역방향 불변 pin
  ['7', '건대입구', '자양(뚝섬한강공원)', 'down'],
  ['7', '자양(뚝섬한강공원)', '건대입구', 'up'],
];

describe.each(CASES)('%s %s→%s 기대 %s', (line, from, to, expected) => {
  it('directionOnLine', () => {
    expect(directionOnLine(line, idOf(line, from), idOf(line, to))).toBe(expected);
  });
  it('resolveTravelDirection', () => {
    expect(resolveTravelDirection(line, from, to)?.direction).toBe(expected);
  });
});

describe('resolveProgressingTerminal — 진행 방면 종착(endpoints low=idx 작은 쪽)', () => {
  it.each([
    ['bundang', '서울숲', '압구정로데오', '인천'],
    ['bundang', '압구정로데오', '서울숲', '청량리'],
    ['sinbundang', '신논현', '강남', '광교'],
    ['sinbundang', '강남', '신논현', '신사'],
    ['7', '건대입구', '자양(뚝섬한강공원)', '석남'],
    ['7', '자양(뚝섬한강공원)', '건대입구', '장암'],
  ] as const)('%s %s→%s = %s', (line, from, to, terminal) => {
    expect(resolveProgressingTerminal(line, from, to)).toBe(terminal);
  });
});

describe('resolveNextAdjacentStationName — 방향 라벨과 무관하게 실제 인접역', () => {
  it.each([
    ['bundang', '서울숲', '강남구청', '압구정로데오'],
    ['bundang', '압구정로데오', '청량리', '서울숲'],
    ['sinbundang', '신논현', '양재(서초구청)', '강남'],
    ['sinbundang', '강남', '신사', '신논현'],
    ['7', '건대입구', '부평구청', '자양(뚝섬한강공원)'],
    ['7', '자양(뚝섬한강공원)', '장암', '건대입구'],
  ] as const)('%s %s→(toward %s) = %s', (line, current, toward, next) => {
    expect(resolveNextAdjacentStationName(line, current, toward)).toBe(next);
  });
});
