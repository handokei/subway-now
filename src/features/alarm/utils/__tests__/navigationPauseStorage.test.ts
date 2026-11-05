import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  setNavigationPausedAt,
  getNavigationPausedAt,
  clearNavigationPausedAt,
  isPauseAutoEndDue,
} from '../navigationPauseStorage';
import { NAVIGATION_PAUSED_AT_KEY } from '../../../../shared/constants/storageKeys';
import { PAUSE_AUTO_END_MS } from '../../../../shared/constants/realtime';

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

describe('navigationPauseStorage (#2293)', () => {
  beforeEach(() => {
    mockSetItem.mockReset();
    mockGetItem.mockReset();
    mockRemoveItem.mockReset();
  });

  describe('setNavigationPausedAt', () => {
    it('주어진 시각을 NAVIGATION_PAUSED_AT_KEY 에 기록한다', async () => {
      mockSetItem.mockResolvedValue(undefined);
      await setNavigationPausedAt(123456);
      expect(mockSetItem).toHaveBeenCalledWith(NAVIGATION_PAUSED_AT_KEY, '123456');
    });

    it('인자 미지정 시 Date.now() 사용', async () => {
      const NOW = 999_999;
      jest.spyOn(Date, 'now').mockReturnValue(NOW);
      mockSetItem.mockResolvedValue(undefined);
      await setNavigationPausedAt();
      expect(mockSetItem).toHaveBeenCalledWith(NAVIGATION_PAUSED_AT_KEY, String(NOW));
      (Date.now as jest.Mock).mockRestore();
    });

    it('AsyncStorage 실패 시 graceful (throw 안 함)', async () => {
      mockSetItem.mockRejectedValue(new Error('fail'));
      await expect(setNavigationPausedAt(1)).resolves.toBeUndefined();
    });
  });

  describe('getNavigationPausedAt', () => {
    it('숫자 문자열을 number로 파싱해서 반환', async () => {
      mockGetItem.mockResolvedValue('42');
      await expect(getNavigationPausedAt()).resolves.toBe(42);
    });

    it('키 부재 시 null', async () => {
      mockGetItem.mockResolvedValue(null);
      await expect(getNavigationPausedAt()).resolves.toBeNull();
    });

    it('NaN/비숫자 raw 는 null', async () => {
      mockGetItem.mockResolvedValue('not-a-number');
      await expect(getNavigationPausedAt()).resolves.toBeNull();
    });

    it('AsyncStorage 실패 시 graceful null', async () => {
      mockGetItem.mockRejectedValue(new Error('fail'));
      await expect(getNavigationPausedAt()).resolves.toBeNull();
    });
  });

  describe('clearNavigationPausedAt', () => {
    it('NAVIGATION_PAUSED_AT_KEY 를 제거한다', async () => {
      mockRemoveItem.mockResolvedValue(undefined);
      await clearNavigationPausedAt();
      expect(mockRemoveItem).toHaveBeenCalledWith(NAVIGATION_PAUSED_AT_KEY);
    });

    it('AsyncStorage 실패 시 graceful (throw 안 함)', async () => {
      mockRemoveItem.mockRejectedValue(new Error('fail'));
      await expect(clearNavigationPausedAt()).resolves.toBeUndefined();
    });
  });

  describe('isPauseAutoEndDue', () => {
    it('pausedAt=null → false', () => {
      expect(isPauseAutoEndDue(null, 1_000_000)).toBe(false);
    });

    it('경과 < PAUSE_AUTO_END_MS → false', () => {
      const now = 1_000_000;
      expect(isPauseAutoEndDue(now - (PAUSE_AUTO_END_MS - 1), now)).toBe(false);
    });

    it('경과 = PAUSE_AUTO_END_MS 경계 → true', () => {
      const now = 1_000_000;
      expect(isPauseAutoEndDue(now - PAUSE_AUTO_END_MS, now)).toBe(true);
    });

    it('경과 > PAUSE_AUTO_END_MS → true', () => {
      const now = 1_000_000;
      expect(isPauseAutoEndDue(now - PAUSE_AUTO_END_MS - 60_000, now)).toBe(true);
    });

    it('now 기본값은 Date.now()', () => {
      const NOW = 1_700_000_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(NOW);
      expect(isPauseAutoEndDue(NOW - 60_000)).toBe(false);
      (Date.now as jest.Mock).mockRestore();
    });
  });
});
