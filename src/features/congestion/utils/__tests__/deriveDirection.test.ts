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
