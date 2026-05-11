import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getLastNotifiedStationId,
  setLastNotifiedStationId,
  clearLastNotifiedStationId,
} from '../notificationState';
import { LAST_NOTIFIED_STATION_KEY } from '../../constants/storageKeys';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

jest.mock('../logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

describe('notificationState', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getLastNotifiedStationId', () => {
    it('AsyncStorage에서 LAST_NOTIFIED_STATION_KEY 값을 읽어 반환한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('station-1');

      const result = await getLastNotifiedStationId();

      expect(AsyncStorage.getItem).toHaveBeenCalledWith(LAST_NOTIFIED_STATION_KEY);
      expect(result).toBe('station-1');
    });

    it('AsyncStorage가 null을 반환하면 null을 반환한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);

      const result = await getLastNotifiedStationId();

      expect(result).toBeNull();
    });

    it('AsyncStorage가 에러를 던지면 null을 반환한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage 오류'));

      const result = await getLastNotifiedStationId();

      expect(result).toBeNull();
    });
  });

  describe('setLastNotifiedStationId', () => {
    it('AsyncStorage에 LAST_NOTIFIED_STATION_KEY로 값을 저장한다', async () => {
      (AsyncStorage.setItem as jest.Mock).mockResolvedValueOnce(undefined);

      await setLastNotifiedStationId('station-2');

      expect(AsyncStorage.setItem).toHaveBeenCalledWith(LAST_NOTIFIED_STATION_KEY, 'station-2');
    });

    it('AsyncStorage가 에러를 던져도 throw하지 않는다', async () => {
      (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('storage 오류'));

      await expect(setLastNotifiedStationId('station-3')).resolves.toBeUndefined();
    });
  });

  describe('clearLastNotifiedStationId', () => {
    it('AsyncStorage에서 LAST_NOTIFIED_STATION_KEY를 삭제한다', async () => {
      (AsyncStorage.removeItem as jest.Mock).mockResolvedValueOnce(undefined);

      await clearLastNotifiedStationId();

      expect(AsyncStorage.removeItem).toHaveBeenCalledWith(LAST_NOTIFIED_STATION_KEY);
    });

    it('AsyncStorage가 에러를 던져도 throw하지 않는다', async () => {
      (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('storage 오류'));

      await expect(clearLastNotifiedStationId()).resolves.toBeUndefined();
    });
  });
});
