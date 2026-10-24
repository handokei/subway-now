import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  setTripStartedAt,
  getTripStartedAt,
  clearTripStartedAt,
  tripLifecyclePhase,
} from '../tripStartStorage';
import { TRIP_STARTED_AT_KEY } from '../../../../shared/constants/storageKeys';
import {
  TRIP_LIFECYCLE_SILENCE_MS,
  TRIP_LIFECYCLE_FORCE_END_MS,
} from '../../../../shared/constants/realtime';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    setItem: jest.fn(),
    getItem: jest.fn(),
    removeItem: jest.fn(),
  },
}));

const mockSetItem = AsyncStorage.setItem as jest.Mock;
const mockGetItem = AsyncStorage.getItem as jest.Mock;
const mockRemoveItem = AsyncStorage.removeItem as jest.Mock;

describe('tripStartStorage', () => {
  beforeEach(() => {
    mockSetItem.mockReset();
    mockGetItem.mockReset();
    mockRemoveItem.mockReset();
  });

  describe('setTripStartedAt', () => {
    it('주어진 시각을 TRIP_STARTED_AT_KEY 에 기록한다', async () => {
      mockSetItem.mockResolvedValue(undefined);
      mockGetItem.mockResolvedValue(null);
      await setTripStartedAt(123456);
      expect(mockSetItem).toHaveBeenCalledWith(TRIP_STARTED_AT_KEY, '123456');
    });

    it('성공 시 #1518 refreshCorrId 도 호출한다 (TRIP_STARTED_AT_KEY getItem)', async () => {
      mockSetItem.mockResolvedValue(undefined);
      mockGetItem.mockResolvedValue('1700000000000');
      await setTripStartedAt(1);
      // refreshCorrId가 fire-and-forget이라 microtask 비움.
      await Promise.resolve();
      expect(mockGetItem).toHaveBeenCalledWith(TRIP_STARTED_AT_KEY);
    });

    it('인자 미지정 시 Date.now() 사용', async () => {
      const NOW = 999_999;
      jest.spyOn(Date, 'now').mockReturnValue(NOW);
      mockSetItem.mockResolvedValue(undefined);
      await setTripStartedAt();
      expect(mockSetItem).toHaveBeenCalledWith(TRIP_STARTED_AT_KEY, String(NOW));
      (Date.now as jest.Mock).mockRestore();
    });

    it('AsyncStorage 실패 시 graceful (throw 안 함)', async () => {
      mockSetItem.mockRejectedValue(new Error('fail'));
      await expect(setTripStartedAt(1)).resolves.toBeUndefined();
    });
  });

  describe('getTripStartedAt', () => {
    it('숫자 문자열을 number로 파싱해서 반환', async () => {
      mockGetItem.mockResolvedValue('42');
      await expect(getTripStartedAt()).resolves.toBe(42);
    });

    it('키 부재 시 null', async () => {
      mockGetItem.mockResolvedValue(null);
      await expect(getTripStartedAt()).resolves.toBeNull();
    });

    it('NaN/비숫자 raw 는 null', async () => {
      mockGetItem.mockResolvedValue('not-a-number');
      await expect(getTripStartedAt()).resolves.toBeNull();
    });

    it('AsyncStorage 실패 시 graceful null', async () => {
      mockGetItem.mockRejectedValue(new Error('fail'));
      await expect(getTripStartedAt()).resolves.toBeNull();
    });
  });

  describe('clearTripStartedAt', () => {
    it('TRIP_STARTED_AT_KEY 를 제거한다', async () => {
      mockRemoveItem.mockResolvedValue(undefined);
      mockGetItem.mockResolvedValue(null);
      await clearTripStartedAt();
      expect(mockRemoveItem).toHaveBeenCalledWith(TRIP_STARTED_AT_KEY);
    });

    it('성공 시 #1518 refreshCorrId 도 호출한다', async () => {
      mockRemoveItem.mockResolvedValue(undefined);
      mockGetItem.mockResolvedValue(null);
      await clearTripStartedAt();
      await Promise.resolve();
      expect(mockGetItem).toHaveBeenCalledWith(TRIP_STARTED_AT_KEY);
    });

    it('AsyncStorage 실패 시 graceful (throw 안 함)', async () => {
      mockRemoveItem.mockRejectedValue(new Error('fail'));
      await expect(clearTripStartedAt()).resolves.toBeUndefined();
    });
  });

  describe('#1573 tripLifecyclePhase', () => {
    it('startedAt=null → none', () => {
      expect(tripLifecyclePhase(null, 0)).toBe('none');
    });

    it('elapsed < 6h → normal', () => {
      const now = 100_000_000;
      expect(tripLifecyclePhase(now - (TRIP_LIFECYCLE_SILENCE_MS - 1), now)).toBe(
        'normal',
      );
    });

    it('elapsed = 6h 경계 → silence', () => {
      const now = 100_000_000;
      expect(tripLifecyclePhase(now - TRIP_LIFECYCLE_SILENCE_MS, now)).toBe('silence');
    });

    it('6h ≤ elapsed < 9h → silence', () => {
      const now = 100_000_000;
      const elapsed = TRIP_LIFECYCLE_SILENCE_MS + 60_000;
      expect(tripLifecyclePhase(now - elapsed, now)).toBe('silence');
    });

    it('elapsed ≥ 9h → force-end', () => {
      const now = 100_000_000;
      expect(tripLifecyclePhase(now - TRIP_LIFECYCLE_FORCE_END_MS, now)).toBe(
        'force-end',
      );
    });

    it('now 기본값은 Date.now()', () => {
      const NOW = 1_700_000_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(NOW);
      expect(tripLifecyclePhase(NOW - 60_000)).toBe('normal');
      (Date.now as jest.Mock).mockRestore();
    });
  });
});
