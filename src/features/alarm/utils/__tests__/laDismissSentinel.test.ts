import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  clearLaDismissSentinel,
  isLaDismissed,
  markLaDismissed,
} from '../laDismissSentinel';
import { LA_DISMISSED_AT_KEY } from '../../../../shared/constants/storageKeys';
import { LA_DISMISS_SENTINEL_TTL_MS } from '../../../../shared/constants/laDismiss';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    setItem: jest.fn(),
    getItem: jest.fn(),
    removeItem: jest.fn(),
  },
}));

const setItemMock = AsyncStorage.setItem as jest.Mock;
const getItemMock = AsyncStorage.getItem as jest.Mock;
const removeItemMock = AsyncStorage.removeItem as jest.Mock;

describe('laDismissSentinel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setItemMock.mockResolvedValue(undefined);
    removeItemMock.mockResolvedValue(undefined);
  });

  describe('markLaDismissed', () => {
    it('at 인자를 문자열로 직렬화해 sentinel 키에 저장', async () => {
      await markLaDismissed(1_700_000_000_000);
      expect(setItemMock).toHaveBeenCalledWith(LA_DISMISSED_AT_KEY, '1700000000000');
    });

    it('기본값은 Date.now()', async () => {
      const now = 1_710_000_000_000;
      const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
      try {
        await markLaDismissed();
      } finally {
        spy.mockRestore();
      }
      expect(setItemMock).toHaveBeenCalledWith(LA_DISMISSED_AT_KEY, String(now));
    });

    it('AsyncStorage 실패는 graceful', async () => {
      setItemMock.mockRejectedValueOnce(new Error('disk full'));
      await expect(markLaDismissed(1)).resolves.toBeUndefined();
    });
  });

  describe('isLaDismissed', () => {
    const dismissedAt = 1_700_000_000_000;

    it('키 부재 → false', async () => {
      getItemMock.mockResolvedValueOnce(null);
      await expect(isLaDismissed(dismissedAt + 1000)).resolves.toBe(false);
    });

    it('TTL 안(+15분) → true', async () => {
      getItemMock.mockResolvedValueOnce(String(dismissedAt));
      await expect(isLaDismissed(dismissedAt + 15 * 60_000)).resolves.toBe(true);
    });

    it('TTL 경계(+30분 정각)는 만료(>=) → false', async () => {
      // TTL은 미만(<) 비교. 정확히 30분 경과 시 만료로 처리.
      getItemMock.mockResolvedValueOnce(String(dismissedAt));
      await expect(
        isLaDismissed(dismissedAt + LA_DISMISS_SENTINEL_TTL_MS),
      ).resolves.toBe(false);
    });

    it('TTL 만료(+31분) → false', async () => {
      getItemMock.mockResolvedValueOnce(String(dismissedAt));
      await expect(isLaDismissed(dismissedAt + 31 * 60_000)).resolves.toBe(false);
    });

    it('NaN 문자열 → false (graceful)', async () => {
      getItemMock.mockResolvedValueOnce('abc');
      await expect(isLaDismissed(dismissedAt)).resolves.toBe(false);
    });

    it('clock-skew (at이 미래) → false — NTP 보정으로 시각 점프 시 무기한 차단 방지', async () => {
      // 디바이스 clock이 forward 점프했다가 NTP가 backward로 정정한 케이스.
      // 저장된 at이 now보다 큼 (elapsed < 0) → 정상 elapsed로 환산 불가하므로 무효 처리.
      getItemMock.mockResolvedValueOnce(String(dismissedAt + 10 * 60_000));
      await expect(isLaDismissed(dismissedAt)).resolves.toBe(false);
    });

    it('AsyncStorage 실패 → false (게이트 fail-open)', async () => {
      // sentinel 못 읽으면 LA refresh를 허용하는 쪽으로 fail-open. 보조 채널의
      // 실패가 silent push 핵심 흐름(알람/LA refresh)을 막아서는 안 된다.
      getItemMock.mockRejectedValueOnce(new Error('boom'));
      await expect(isLaDismissed(dismissedAt)).resolves.toBe(false);
    });

    it('기본 now는 Date.now()', async () => {
      const now = dismissedAt + 5 * 60_000;
      const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
      try {
        getItemMock.mockResolvedValueOnce(String(dismissedAt));
        await expect(isLaDismissed()).resolves.toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('clearLaDismissSentinel', () => {
    it('removeItem 호출', async () => {
      await clearLaDismissSentinel();
      expect(removeItemMock).toHaveBeenCalledWith(LA_DISMISSED_AT_KEY);
    });

    it('실패는 흡수', async () => {
      removeItemMock.mockRejectedValueOnce(new Error('boom'));
      await expect(clearLaDismissSentinel()).resolves.toBeUndefined();
    });
  });
});
