import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getLastNotifiedStationId,
  setLastNotifiedStationId,
  clearLastNotifiedStationId,
  getFiredAlarms,
  setFiredAlarms,
  clearFiredAlarms,
  getLastFiredAlarmStationName,
  setLastFiredAlarmStationName,
  clearLastFiredAlarmStationName,
} from '../notificationState';
import {
  LAST_NOTIFIED_STATION_KEY,
  FIRED_ALARMS_KEY,
  LAST_FIRED_ALARM_STATION_NAME_KEY,
} from '../../shared/constants/storageKeys';

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

  describe('getFiredAlarms (destination scoped, #462)', () => {
    it('저장된 destinationId와 일치하면 alarms를 Set으로 반환한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
        JSON.stringify({ destinationId: 'dest-1', alarms: ['a:X', 'b:Y'] }),
      );

      const result = await getFiredAlarms('dest-1');

      expect(AsyncStorage.getItem).toHaveBeenCalledWith(FIRED_ALARMS_KEY);
      expect(result).toEqual(new Set(['a:X', 'b:Y']));
    });

    it('저장된 destinationId와 다르면 stale로 간주하고 빈 Set을 반환한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
        JSON.stringify({ destinationId: 'dest-1', alarms: ['a:X'] }),
      );

      const result = await getFiredAlarms('dest-2');

      expect(result).toEqual(new Set());
    });

    it('destinationId가 null이면 빈 Set을 반환한다 (storage read 스킵)', async () => {
      const result = await getFiredAlarms(null);

      expect(result).toEqual(new Set());
      expect(AsyncStorage.getItem).not.toHaveBeenCalled();
    });

    it('null 저장소면 빈 Set을 반환한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);

      const result = await getFiredAlarms('dest-1');

      expect(result).toEqual(new Set());
    });

    it('JSON 파싱 실패 시 빈 Set을 반환한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('not-json');

      const result = await getFiredAlarms('dest-1');

      expect(result).toEqual(new Set());
    });

    it('옛 포맷(배열)은 stale로 간주하고 빈 Set을 반환한다 (자동 migration)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(['a:X', 'b:Y']));

      const result = await getFiredAlarms('dest-1');

      expect(result).toEqual(new Set());
    });

    it('AsyncStorage가 에러를 던지면 빈 Set을 반환한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage 오류'));

      const result = await getFiredAlarms('dest-1');

      expect(result).toEqual(new Set());
    });
  });

  describe('setFiredAlarms (destination scoped, #462)', () => {
    it('destinationId와 alarms를 객체로 직렬화해 저장한다', async () => {
      (AsyncStorage.setItem as jest.Mock).mockResolvedValueOnce(undefined);

      await setFiredAlarms('dest-1', new Set(['a:X', 'b:Y']));

      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        FIRED_ALARMS_KEY,
        expect.any(String),
      );
      const written = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1]);
      expect(written.destinationId).toBe('dest-1');
      expect(new Set(written.alarms)).toEqual(new Set(['a:X', 'b:Y']));
    });

    it('AsyncStorage가 에러를 던져도 throw하지 않는다', async () => {
      (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('storage 오류'));

      await expect(setFiredAlarms('dest-1', new Set(['a:X']))).resolves.toBeUndefined();
    });
  });

  describe('getLastFiredAlarmStationName', () => {
    it('AsyncStorage에서 LAST_FIRED_ALARM_STATION_NAME_KEY 값을 반환한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('강남');
      const result = await getLastFiredAlarmStationName();
      expect(AsyncStorage.getItem).toHaveBeenCalledWith(LAST_FIRED_ALARM_STATION_NAME_KEY);
      expect(result).toBe('강남');
    });
  });

  describe('setLastFiredAlarmStationName', () => {
    it('AsyncStorage에 LAST_FIRED_ALARM_STATION_NAME_KEY로 값을 저장한다', async () => {
      (AsyncStorage.setItem as jest.Mock).mockResolvedValueOnce(undefined);
      await setLastFiredAlarmStationName('시청');
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(LAST_FIRED_ALARM_STATION_NAME_KEY, '시청');
    });
  });

  describe('clearLastFiredAlarmStationName (#799)', () => {
    it('AsyncStorage에서 LAST_FIRED_ALARM_STATION_NAME_KEY를 삭제한다', async () => {
      (AsyncStorage.removeItem as jest.Mock).mockResolvedValueOnce(undefined);
      await clearLastFiredAlarmStationName();
      expect(AsyncStorage.removeItem).toHaveBeenCalledWith(LAST_FIRED_ALARM_STATION_NAME_KEY);
    });

    it('AsyncStorage 오류도 swallow', async () => {
      (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('boom'));
      await expect(clearLastFiredAlarmStationName()).resolves.toBeUndefined();
    });
  });

  describe('clearFiredAlarms', () => {
    it('AsyncStorage에서 FIRED_ALARMS_KEY를 삭제한다', async () => {
      (AsyncStorage.removeItem as jest.Mock).mockResolvedValueOnce(undefined);

      await clearFiredAlarms();

      expect(AsyncStorage.removeItem).toHaveBeenCalledWith(FIRED_ALARMS_KEY);
    });

    it('AsyncStorage가 에러를 던져도 throw하지 않는다', async () => {
      (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('storage 오류'));

      await expect(clearFiredAlarms()).resolves.toBeUndefined();
    });
  });
});
