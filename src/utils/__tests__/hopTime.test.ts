import { hopTimeMsForSegment, hopTimeMsAt, hopsElapsedFrom } from '../hopTime';
import { HOP_TIME_MS } from '../../shared/constants/boardingLock';
import type { Station } from '../../types/station';

jest.mock('../stationRoute', () => ({
  getStopSeconds: jest.fn(),
}));

import { getStopSeconds } from '../stationRoute';

const mockedGetStopSeconds = getStopSeconds as jest.MockedFunction<typeof getStopSeconds>;

const ARC: Station[] = [
  { id: 'a', name: 'A', line: '7', lineColor: '#x', lat: 0, lng: 0 },
  { id: 'b', name: 'B', line: '7', lineColor: '#x', lat: 0, lng: 0 },
  { id: 'c', name: 'C', line: '7', lineColor: '#x', lat: 0, lng: 0 },
];

describe('hopTimeMsForSegment', () => {
  beforeEach(() => mockedGetStopSeconds.mockReset());

  it('returns getStopSeconds(line, from, to) × 1000', () => {
    mockedGetStopSeconds.mockReturnValue(150);
    expect(hopTimeMsForSegment('7', 'a', 'b')).toBe(150_000);
    expect(mockedGetStopSeconds).toHaveBeenCalledWith('7', 'a', 'b');
  });
});

describe('hopTimeMsAt', () => {
  beforeEach(() => mockedGetStopSeconds.mockReset());

  it('returns segment lookup for valid arc fromIdx', () => {
    mockedGetStopSeconds.mockReturnValue(120);
    expect(hopTimeMsAt(ARC, 0, '7')).toBe(120_000);
    expect(mockedGetStopSeconds).toHaveBeenCalledWith('7', 'a', 'b');
  });

  it('returns HOP_TIME_MS fallback for negative fromIdx', () => {
    expect(hopTimeMsAt(ARC, -1, '7')).toBe(HOP_TIME_MS);
    expect(mockedGetStopSeconds).not.toHaveBeenCalled();
  });

  it('returns HOP_TIME_MS fallback at arc end (fromIdx === length - 1)', () => {
    expect(hopTimeMsAt(ARC, ARC.length - 1, '7')).toBe(HOP_TIME_MS);
    expect(mockedGetStopSeconds).not.toHaveBeenCalled();
  });
});

describe('hopsElapsedFrom', () => {
  const arcLen = 5;
  const uniform = (_idx: number) => HOP_TIME_MS;

  it('returns 0 for elapsed <= 0 (zero and negative)', () => {
    expect(hopsElapsedFrom(arcLen, 0, 0, uniform)).toBe(0);
    expect(hopsElapsedFrom(arcLen, 0, -1, uniform)).toBe(0);
  });

  it('returns floor(elapsed / HOP_TIME_MS) for uniform hop times', () => {
    expect(hopsElapsedFrom(arcLen, 0, HOP_TIME_MS, uniform)).toBe(1);
    expect(hopsElapsedFrom(arcLen, 0, HOP_TIME_MS * 2.5, uniform)).toBe(2);
  });

  it('accumulates segment-specific hop times (variable lookup)', () => {
    const variable = (idx: number) => (idx === 0 ? 60_000 : 120_000);
    // anchor=0, elapsed=180_000 → hop 0(60s) + hop 1(120s) = 180s, hops=2
    expect(hopsElapsedFrom(arcLen, 0, 180_000, variable)).toBe(2);
  });

  it('uses HOP_TIME_MS fallback for hops beyond arc end (over-terminal grace)', () => {
    // anchor=arcLen-1, cursor >= len-1 분기 → fallback HOP_TIME_MS로 계속 카운트
    // elapsed = 3 * HOP_TIME_MS → hops=3 (종착 cap+grace 검사가 트리거되도록 정직히 누적)
    expect(hopsElapsedFrom(arcLen, arcLen - 1, HOP_TIME_MS * 3, uniform)).toBe(3);
  });

  it('breaks when next partial hop would exceed elapsedMs (floor semantics)', () => {
    expect(hopsElapsedFrom(arcLen, 0, HOP_TIME_MS - 1, uniform)).toBe(0);
  });
});
