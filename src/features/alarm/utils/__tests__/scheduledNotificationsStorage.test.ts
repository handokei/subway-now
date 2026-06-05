import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  addScheduledNotificationIds,
  clearScheduledNotificationIds,
  getScheduledNotificationIds,
  removeScheduledNotificationIds,
} from '../scheduledNotificationsStorage';
import { SCHEDULED_NOTIFICATIONS_KEY } from '../../../../shared/constants/storageKeys';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

jest.mock('../../../../utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const mockedGet = AsyncStorage.getItem as jest.MockedFunction<typeof AsyncStorage.getItem>;
const mockedSet = AsyncStorage.setItem as jest.MockedFunction<typeof AsyncStorage.setItem>;
const mockedRemove = AsyncStorage.removeItem as jest.MockedFunction<typeof AsyncStorage.removeItem>;

describe('scheduledNotificationsStorage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getScheduledNotificationIds', () => {
    it('값이 없으면 빈 배열 반환', async () => {
      mockedGet.mockResolvedValueOnce(null);
      await expect(getScheduledNotificationIds()).resolves.toEqual([]);
    });

    it('정상 JSON 배열을 그대로 반환', async () => {
      mockedGet.mockResolvedValueOnce(JSON.stringify(['a', 'b']));
      await expect(getScheduledNotificationIds()).resolves.toEqual(['a', 'b']);
    });

    it('형식 손상 시 빈 배열 반환', async () => {
      mockedGet.mockResolvedValueOnce(JSON.stringify({ not: 'array' }));
      await expect(getScheduledNotificationIds()).resolves.toEqual([]);
    });

    it('비-문자열 배열이면 빈 배열 반환', async () => {
      mockedGet.mockResolvedValueOnce(JSON.stringify(['a', 1]));
      await expect(getScheduledNotificationIds()).resolves.toEqual([]);
    });

    it('I/O 실패 시 빈 배열 반환', async () => {
      mockedGet.mockRejectedValueOnce(new Error('boom'));
      await expect(getScheduledNotificationIds()).resolves.toEqual([]);
    });
  });

  describe('addScheduledNotificationIds', () => {
    it('빈 배열은 storage I/O 하지 않음', async () => {
      await addScheduledNotificationIds([]);
      expect(mockedGet).not.toHaveBeenCalled();
      expect(mockedSet).not.toHaveBeenCalled();
    });

    it('기존 값과 dedup하여 저장', async () => {
      mockedGet.mockResolvedValueOnce(JSON.stringify(['a']));
      await addScheduledNotificationIds(['a', 'b']);
      expect(mockedSet).toHaveBeenCalledWith(
        SCHEDULED_NOTIFICATIONS_KEY,
        JSON.stringify(['a', 'b']),
      );
    });

    it('저장 실패 시 throw 없음', async () => {
      mockedGet.mockResolvedValueOnce(null);
      mockedSet.mockRejectedValueOnce(new Error('disk'));
      await expect(addScheduledNotificationIds(['a'])).resolves.toBeUndefined();
    });
  });

  describe('removeScheduledNotificationIds', () => {
    it('빈 배열은 no-op', async () => {
      await removeScheduledNotificationIds([]);
      expect(mockedGet).not.toHaveBeenCalled();
    });

    it('일치 항목 제거 후 저장', async () => {
      mockedGet.mockResolvedValueOnce(JSON.stringify(['a', 'b', 'c']));
      await removeScheduledNotificationIds(['b']);
      expect(mockedSet).toHaveBeenCalledWith(
        SCHEDULED_NOTIFICATIONS_KEY,
        JSON.stringify(['a', 'c']),
      );
    });

    it('제거 후 빈 결과면 removeItem 호출', async () => {
      mockedGet.mockResolvedValueOnce(JSON.stringify(['a']));
      await removeScheduledNotificationIds(['a']);
      expect(mockedRemove).toHaveBeenCalledWith(SCHEDULED_NOTIFICATIONS_KEY);
      expect(mockedSet).not.toHaveBeenCalled();
    });

    it('변동 없으면 I/O 하지 않음', async () => {
      mockedGet.mockResolvedValueOnce(JSON.stringify(['a']));
      await removeScheduledNotificationIds(['x']);
      expect(mockedSet).not.toHaveBeenCalled();
      expect(mockedRemove).not.toHaveBeenCalled();
    });
  });

  describe('clearScheduledNotificationIds', () => {
    it('removeItem 호출', async () => {
      await clearScheduledNotificationIds();
      expect(mockedRemove).toHaveBeenCalledWith(SCHEDULED_NOTIFICATIONS_KEY);
    });

    it('removeItem 실패 시 throw 없음', async () => {
      mockedRemove.mockRejectedValueOnce(new Error('boom'));
      await expect(clearScheduledNotificationIds()).resolves.toBeUndefined();
    });
  });
});
