import { isDuplicateBoardingLock } from '../duplicateBoardingLock';
import { useBoardingLockStore } from '../../store/useBoardingLockStore';
import type { BoardingLock } from '../../../../shared/types/boardingLock';

jest.mock('../../../../shared/utils/stationLookup', () => ({
  findStationByNameAndLine: jest.fn(),
}));
import { findStationByNameAndLine } from '../../../../shared/utils/stationLookup';
const mockFindStationByNameAndLine = findStationByNameAndLine as jest.Mock;

function makeLock(overrides: Partial<BoardingLock> = {}): BoardingLock {
  return {
    destinationId: 'dest-1',
    trainCode: 'T-1',
    boardingStationId: 'stn-A',
    boardingLine: '2',
    boardedAt: Date.now(),
    expectedDurationMs: 600_000,
    ...overrides,
  };
}

describe('isDuplicateBoardingLock (#2722)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useBoardingLockStore.setState({ lock: null });
  });

  it('lock 없음 → false', () => {
    expect(isDuplicateBoardingLock('2', '강남')).toBe(false);
  });

  it('lock 만료됨 → false', () => {
    useBoardingLockStore.setState({
      lock: makeLock({ boardedAt: 0, expectedDurationMs: 1 }),
    });
    expect(isDuplicateBoardingLock('2', '강남')).toBe(false);
  });

  it('boardingLine이 유효한 LineNumber가 아니면 → false', () => {
    useBoardingLockStore.setState({ lock: makeLock() });
    expect(isDuplicateBoardingLock('99', '강남')).toBe(false);
  });

  it('lock.boardingLine과 다른 line → false', () => {
    useBoardingLockStore.setState({ lock: makeLock({ boardingLine: '2' }) });
    expect(isDuplicateBoardingLock('7', '강남')).toBe(false);
  });

  it('같은 역명으로 매칭되는 station 없음 → false', () => {
    useBoardingLockStore.setState({ lock: makeLock({ boardingLine: '2' }) });
    mockFindStationByNameAndLine.mockReturnValue(null);
    expect(isDuplicateBoardingLock('2', '강남')).toBe(false);
  });

  it('station 매칭되지만 lock.boardingStationId와 다름 → false', () => {
    useBoardingLockStore.setState({ lock: makeLock({ boardingLine: '2', boardingStationId: 'stn-A' }) });
    mockFindStationByNameAndLine.mockReturnValue({ id: 'stn-B' });
    expect(isDuplicateBoardingLock('2', '강남')).toBe(false);
  });

  it('같은 line + 같은 station → true (중복 판정)', () => {
    useBoardingLockStore.setState({ lock: makeLock({ boardingLine: '2', boardingStationId: 'stn-A' }) });
    mockFindStationByNameAndLine.mockReturnValue({ id: 'stn-A' });
    expect(isDuplicateBoardingLock('2', '강남')).toBe(true);
  });
});
