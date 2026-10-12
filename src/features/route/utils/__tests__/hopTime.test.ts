import { hopTimeMsForSegment, hopTimeMsAt, hopsElapsedFrom } from '../hopTime';
import { HOP_TIME_MS } from '../../../../shared/constants/boardingLock';
import type { Station } from '../../../../shared/types/station';

jest.mock('../../../../shared/utils/stationRoute', () => ({
  getStopSeconds: jest.fn(),
}));

import { getStopSeconds } from '../../../../shared/utils/stationRoute';

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

  // ⓓ (#2951) — HOP_TIME_MS(90초) 경계 폴백은 tier 1 DWELL_SECONDS 가산과 무관하게 불변.
  // getStopSeconds가 mock이라 이 테스트는 가산 유무와 상관없이 항상 통과하지만, 두 fallback의
  // 의도적 분리(hopTime.ts:41-44 — 경계 fallback=HOP_TIME_MS vs mid-arc data miss=STOP_FALLBACK_SECONDS)
  // 가 이번 PR로 손상되지 않았음을 명시적으로 고정한다.
  it('ⓓ HOP_TIME_MS 상수 자체는 90_000(90초)로 불변', () => {
    expect(HOP_TIME_MS).toBe(90_000);
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
