import { deriveCongestionDirection } from '../deriveDirection';
import { getStationsOnLine } from '../../../../shared/utils/stationRoute';
import type { LineNumber, Station } from '../../../../shared/types/station';

describe('deriveCongestionDirection', () => {
  // 2호선 실제 데이터의 인접 두 역으로 방향성 검증.
  const line2: LineNumber = '2';
  let line2Stations: Station[];
  beforeAll(() => {
    line2Stations = getStationsOnLine(line2);
  });

  it.each([
    ['line null', null, '강남', '역삼'],
    ['current null', '2', null, '역삼'],
    ['next null', '2', '강남', null],
    ['current undefined', '2', undefined, '역삼'],
  ] as const)('returns null when %s', (_label, line, current, next) => {
    expect(
      deriveCongestionDirection(
        line as LineNumber | null,
        current as string | null | undefined,
        next as string | null,
      ),
    ).toBeNull();
  });

  it('returns null when current name not found on the line', () => {
    expect(deriveCongestionDirection(line2, '없는역', line2Stations[1].name)).toBeNull();
  });

  it('returns null when next name not found on the line', () => {
    expect(deriveCongestionDirection(line2, line2Stations[0].name, '없는역')).toBeNull();
  });

  it('returns null when current and next resolve to the same index', () => {
    const sameName = line2Stations[0].name;
    expect(deriveCongestionDirection(line2, sameName, sameName)).toBeNull();
  });

  it('returns "up" when next index is greater than current index', () => {
    const current = line2Stations[2].name;
    const next = line2Stations[5].name;
    expect(deriveCongestionDirection(line2, current, next)).toBe('up');
  });

  it('returns "down" when next index is less than current index', () => {
    const current = line2Stations[5].name;
    const next = line2Stations[2].name;
    expect(deriveCongestionDirection(line2, current, next)).toBe('down');
  });
});

// #3122 감사 — 이 함수는 "idx 증가=up"이라, 역방향 노선(수인분당·신분당: idx 증가=상행)에서는 이미 정답이다.
// (비역방향 노선은 idx 증가=하행이라 반대로 나오지만, 소비자가 Mock sample 데이터뿐인 PoC라
//  이 PR에서는 비역방향 동작을 바꾸지 않는다 — 현 동작 pin.)
describe('deriveCongestionDirection — 역방향 노선 pin (#3122)', () => {
  it.each([
    ['bundang', '서울숲', '압구정로데오', 'down'],
    ['bundang', '압구정로데오', '서울숲', 'up'],
    ['sinbundang', '신논현', '강남', 'down'],
    ['sinbundang', '강남', '신논현', 'up'],
  ] as const)('%s %s→%s = %s (상행=왕십리/신사 방면)', (line, from, to, expected) => {
    expect(deriveCongestionDirection(line, from, to)).toBe(expected);
  });

  it('비역방향 7호선은 기존 동작 유지(idx 증가=up) — 변경하지 않음', () => {
    expect(deriveCongestionDirection('7', '건대입구', '자양(뚝섬한강공원)')).toBe('up');
  });
});
