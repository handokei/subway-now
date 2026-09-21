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

  // #2786 — 9/21 PM 뚝섬 실측: PENDING fallback lock(trainCode 미확정) 활성 중 사용자가 실 trainCode를
  // 탭하면 dedup이 아니라 교체(승격) 대상이어야 한다. trainCode 인자로 이 구분을 반영한다.
  describe('#2786 — trainCode 반영 (PENDING sentinel 교체 vs 실 lock dedup)', () => {
    it('기존 lock이 PENDING sentinel + 탭이 실 trainCode → false (dedup 아님, 교체 대상)', () => {
      useBoardingLockStore.setState({
        lock: makeLock({ trainCode: 'PENDING-TRAIN-CODE', boardingLine: '2', boardingStationId: 'stn-A' }),
      });
      mockFindStationByNameAndLine.mockReturnValue({ id: 'stn-A' });
      expect(isDuplicateBoardingLock('2', '강남', '2371')).toBe(false);
    });

    it('기존 lock이 PENDING sentinel + trainCode 인자 미전달(LA/알림 채널) → true (기존 dedup 유지)', () => {
      useBoardingLockStore.setState({
        lock: makeLock({ trainCode: 'PENDING-TRAIN-CODE', boardingLine: '2', boardingStationId: 'stn-A' }),
      });
      mockFindStationByNameAndLine.mockReturnValue({ id: 'stn-A' });
      expect(isDuplicateBoardingLock('2', '강남')).toBe(true);
    });

    it('기존 lock이 PENDING sentinel + 탭도 PENDING sentinel → true (dedup 유지)', () => {
      useBoardingLockStore.setState({
        lock: makeLock({ trainCode: 'PENDING-TRAIN-CODE', boardingLine: '2', boardingStationId: 'stn-A' }),
      });
      mockFindStationByNameAndLine.mockReturnValue({ id: 'stn-A' });
      expect(isDuplicateBoardingLock('2', '강남', 'PENDING-TRAIN-CODE')).toBe(true);
    });

    it('기존 lock이 실 trainCode(T-1) + 탭도 실 trainCode(다른 값) → true (동일 실 trainCode 재탭과 무관하게 기존 dedup 유지)', () => {
      useBoardingLockStore.setState({
        lock: makeLock({ trainCode: 'T-1', boardingLine: '2', boardingStationId: 'stn-A' }),
      });
      mockFindStationByNameAndLine.mockReturnValue({ id: 'stn-A' });
      expect(isDuplicateBoardingLock('2', '강남', 'T-9999')).toBe(true);
    });
  });
});
