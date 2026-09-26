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
  TRIP_STARTED_AT_KEY,
} from '../../../../shared/constants/storageKeys';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

jest.mock('../../../../shared/utils/logger', () => ({
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

  describe('getLastNotifiedStationId (destination scoped, #1011)', () => {
    it('저장된 destinationId와 일치하면 stationId를 반환한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
        JSON.stringify({ destinationId: 'dest-1', stationId: 'station-1' }),
      );

      const result = await getLastNotifiedStationId('dest-1');

      expect(AsyncStorage.getItem).toHaveBeenCalledWith(LAST_NOTIFIED_STATION_KEY);
      expect(result).toBe('station-1');
    });

    it('저장된 destinationId와 다르면 stale로 간주하고 null을 반환한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
        JSON.stringify({ destinationId: 'dest-1', stationId: 'station-1' }),
      );

      const result = await getLastNotifiedStationId('dest-2');

      expect(result).toBeNull();
    });

    it('destinationId가 null이면 null을 반환한다 (storage read 스킵)', async () => {
      const result = await getLastNotifiedStationId(null);

      expect(result).toBeNull();
      expect(AsyncStorage.getItem).not.toHaveBeenCalled();
    });

    it('AsyncStorage가 null을 반환하면 null을 반환한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);

      const result = await getLastNotifiedStationId('dest-1');

      expect(result).toBeNull();
    });

    it('JSON 파싱 실패 시 null을 반환한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('not-json');

      const result = await getLastNotifiedStationId('dest-1');

      expect(result).toBeNull();
    });

    it('유효한 JSON이지만 레코드 형식이 아니면 null을 반환한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify({ foo: 'bar' }));

      const result = await getLastNotifiedStationId('dest-1');

      expect(result).toBeNull();
    });

    it('AsyncStorage가 에러를 던지면 null을 반환한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage 오류'));

      const result = await getLastNotifiedStationId('dest-1');

      expect(result).toBeNull();
    });
  });

  describe('setLastNotifiedStationId (destination scoped, #1011)', () => {
    it('destinationId와 stationId를 객체로 직렬화해 저장한다', async () => {
      (AsyncStorage.setItem as jest.Mock).mockResolvedValueOnce(undefined);

      await setLastNotifiedStationId('dest-1', 'station-2');

      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        LAST_NOTIFIED_STATION_KEY,
        expect.any(String),
      );
      const written = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1]);
      expect(written.destinationId).toBe('dest-1');
      expect(written.stationId).toBe('station-2');
    });

    it('AsyncStorage가 에러를 던져도 throw하지 않는다', async () => {
      (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('storage 오류'));

      await expect(setLastNotifiedStationId('dest-1', 'station-3')).resolves.toBeUndefined();
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

    // #2679 — 같은 목적지로 **다시 시작한 trip**은 옛 trip의 "이미 발사됨" 표시를 물려받으면 안 된다.
    // 실측(2026-09-17): 같은 목적지(뚝섬)로 재등록한 trip에서 `early`(1개역 전 "하차 준비")가
    // dedup으로 죽고 imminent만 발사 — 사용자는 하차 준비 알림을 못 받았다.
    it('#2679 — 같은 destination이라도 다른 trip의 기록이면 빈 Set (하차 준비 알림 영구 침묵 차단)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
        if (key === FIRED_ALARMS_KEY) {
          return JSON.stringify({
            destinationId: 'dest-1',
            alarms: ['early:뚝섬'],
            tripStartedAt: 1000,
          });
        }
        if (key === TRIP_STARTED_AT_KEY) return '2000'; // 새 trip
        return null;
      });

      const result = await getFiredAlarms('dest-1');

      expect(result).toEqual(new Set());
    });

    it('#2679 — 같은 trip이면 그대로 유지한다 (정상 dedup 보존)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
        if (key === FIRED_ALARMS_KEY) {
          return JSON.stringify({
            destinationId: 'dest-1',
            alarms: ['early:뚝섬'],
            tripStartedAt: 2000,
          });
        }
        if (key === TRIP_STARTED_AT_KEY) return '2000';
        return null;
      });

      const result = await getFiredAlarms('dest-1');

      expect(result).toEqual(new Set(['early:뚝섬']));
    });

    it('#2679 — trip 식별자가 한쪽이라도 없으면 기존 동작 유지 (hydration 중 오무효화 방지)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
        if (key === FIRED_ALARMS_KEY) {
          // 구 저장분 — tripStartedAt 없음.
          return JSON.stringify({ destinationId: 'dest-1', alarms: ['early:뚝섬'] });
        }
        if (key === TRIP_STARTED_AT_KEY) return '2000';
        return null;
      });

      expect(await getFiredAlarms('dest-1')).toEqual(new Set(['early:뚝섬']));
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
