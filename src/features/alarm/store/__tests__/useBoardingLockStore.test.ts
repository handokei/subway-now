import { act } from '@testing-library/react-native';
import { useBoardingLockStore } from '../useBoardingLockStore';
import type { BoardingLock } from '../../../../shared/types/boardingLock';

const mockGetBoardingLock = jest.fn();
const mockSetBoardingLock = jest.fn();
const mockClearBoardingLock = jest.fn();
const mockClearDismissSilence = jest.fn();
const mockAddDomainBreadcrumb = jest.fn();

jest.mock('../../utils/boardingLockStorage', () => ({
  getBoardingLock: (...args: unknown[]) => mockGetBoardingLock(...args),
  setBoardingLock: (...args: unknown[]) => mockSetBoardingLock(...args),
  clearBoardingLock: (...args: unknown[]) => mockClearBoardingLock(...args),
}));

jest.mock('../../utils/dismissSilenceStorage', () => ({
  clearDismissSilence: (...args: unknown[]) => mockClearDismissSilence(...args),
}));

jest.mock('../../../../shared/infra/monitoring/breadcrumb', () => ({
  addLogBreadcrumb: jest.fn(),
  addDomainBreadcrumb: (...args: unknown[]) => mockAddDomainBreadcrumb(...args),
}));

const sample: BoardingLock = {
  destinationId: 'dest-1',
  trainCode: 'T-100',
  boardingStationId: 'stn-A',
  boardingLine: '2',
  boardedAt: 1_000_000,
  expectedDurationMs: 600_000,
};

describe('useBoardingLockStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSetBoardingLock.mockResolvedValue(undefined);
    mockClearBoardingLock.mockResolvedValue(undefined);
    mockClearDismissSilence.mockResolvedValue(undefined);
    useBoardingLockStore.setState({ lock: null });
  });

  it('초기 상태는 lock=null', () => {
    expect(useBoardingLockStore.getState().lock).toBeNull();
  });

  describe('createLock', () => {
    it('state + storage 양쪽 갱신', async () => {
      await act(async () => {
        await useBoardingLockStore.getState().createLock(sample);
      });
      expect(useBoardingLockStore.getState().lock).toEqual(sample);
      expect(mockSetBoardingLock).toHaveBeenCalledWith(sample);
    });

    it('기존 Lock을 새 Lock으로 교체 (multi-transfer 전환 대비)', async () => {
      await act(async () => {
        await useBoardingLockStore.getState().createLock(sample);
      });
      const next: BoardingLock = { ...sample, trainCode: 'T-200', boardingLine: '7' };
      await act(async () => {
        await useBoardingLockStore.getState().createLock(next);
      });
      expect(useBoardingLockStore.getState().lock).toEqual(next);
      expect(mockSetBoardingLock).toHaveBeenLastCalledWith(next);
    });

    it('#746 — createLock은 dismissSilence storage를 즉시 클리어', async () => {
      await act(async () => {
        await useBoardingLockStore.getState().createLock(sample);
      });
      expect(mockClearDismissSilence).toHaveBeenCalledTimes(1);
    });
  });

  describe('releaseLock', () => {
    it('state=null + storage 정리', async () => {
      useBoardingLockStore.setState({ lock: sample });
      await act(async () => {
        await useBoardingLockStore.getState().releaseLock();
      });
      expect(useBoardingLockStore.getState().lock).toBeNull();
      expect(mockClearBoardingLock).toHaveBeenCalled();
    });

    it('release breadcrumb는 직전 lock이 있을 때만 추가', async () => {
      useBoardingLockStore.setState({ lock: sample });
      await act(async () => {
        await useBoardingLockStore.getState().releaseLock();
      });
      expect(mockAddDomainBreadcrumb).toHaveBeenCalledWith('boarding', 'lock-release', {
        trainCode: sample.trainCode,
        line: sample.boardingLine,
      });
    });

    it('lock이 없으면 release breadcrumb skip (noise 방지)', async () => {
      await act(async () => {
        await useBoardingLockStore.getState().releaseLock();
      });
      expect(mockAddDomainBreadcrumb).not.toHaveBeenCalled();
    });
  });

  describe('breadcrumb', () => {
    it('createLock 시 lock-create breadcrumb 추가', async () => {
      await act(async () => {
        await useBoardingLockStore.getState().createLock(sample);
      });
      expect(mockAddDomainBreadcrumb).toHaveBeenCalledWith('boarding', 'lock-create', {
        trainCode: sample.trainCode,
        line: sample.boardingLine,
      });
    });
  });

  describe('loadLock', () => {
    it('storage 값 hydrate', async () => {
      mockGetBoardingLock.mockResolvedValueOnce(sample);
      await act(async () => {
        await useBoardingLockStore.getState().loadLock();
      });
      expect(useBoardingLockStore.getState().lock).toEqual(sample);
    });

    it('storage가 비어있으면 lock=null 유지', async () => {
      mockGetBoardingLock.mockResolvedValueOnce(null);
      await act(async () => {
        await useBoardingLockStore.getState().loadLock();
      });
      expect(useBoardingLockStore.getState().lock).toBeNull();
    });
  });

  describe('checkExpiry', () => {
    it('lock 없으면 false (no-op)', async () => {
      const expired = await useBoardingLockStore.getState().checkExpiry();
      expect(expired).toBe(false);
      expect(mockClearBoardingLock).not.toHaveBeenCalled();
    });

    it('미만료면 false + 상태 유지', async () => {
      useBoardingLockStore.setState({ lock: sample });
      const expired = await useBoardingLockStore
        .getState()
        .checkExpiry(sample.boardedAt + sample.expectedDurationMs);
      expect(expired).toBe(false);
      expect(useBoardingLockStore.getState().lock).toEqual(sample);
    });

    it('만료 시 true 반환 + state/storage 정리', async () => {
      useBoardingLockStore.setState({ lock: sample });
      const wayAfter = sample.boardedAt + sample.expectedDurationMs * 2;
      let expired = false;
      await act(async () => {
        expired = await useBoardingLockStore.getState().checkExpiry(wayAfter);
      });
      expect(expired).toBe(true);
      expect(useBoardingLockStore.getState().lock).toBeNull();
      expect(mockClearBoardingLock).toHaveBeenCalled();
    });

    it('now 미전달 시 Date.now() 사용', async () => {
      useBoardingLockStore.setState({ lock: sample });
      const expired = await useBoardingLockStore.getState().checkExpiry();
      // sample.boardedAt=1_000_000은 1970년대 초 — 현재 시각이면 항상 만료.
      expect(expired).toBe(true);
    });
  });
});
