import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  appendAlarmLog,
  getAlarmLog,
  clearAlarmLog,
  logFiredAlarm,
  logFiredStationPassed,
  logScheduledAlarm,
  logSuppressedDedupStation,
  logSuppressedGate,
  ALARM_LOG_BUFFER_SIZE,
  type AlarmLogEntry,
  type AlarmLogStamp,
} from '../alarmLog';
import { ALARM_LOG_KEY } from '../../constants/storageKeys';
import type { AlarmEvent } from '../stationAlarm';
import type { Station } from '../../types/station';

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

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeEntry(overrides: Partial<AlarmLogEntry> = {}): AlarmLogEntry {
  return {
    ts: 1_700_000_000_000,
    source: 'bg',
    outcome: 'fired',
    stationName: '강남',
    kind: 'station-passed',
    ...overrides,
  };
}

describe('alarmLog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);
    (AsyncStorage.removeItem as jest.Mock).mockResolvedValue(undefined);
  });

  describe('appendAlarmLog', () => {
    it('기존 로그가 없으면 단일 엔트리로 저장한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      const entry = makeEntry();

      await appendAlarmLog(entry);

      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        ALARM_LOG_KEY,
        JSON.stringify([entry]),
      );
    });

    it('기존 로그가 있으면 뒤에 append한다', async () => {
      const existing = [makeEntry({ stationName: '시청' })];
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(existing));
      const entry = makeEntry({ stationName: '강남' });

      await appendAlarmLog(entry);

      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        ALARM_LOG_KEY,
        JSON.stringify([...existing, entry]),
      );
    });

    it('BUFFER 크기 초과 시 가장 오래된 엔트리부터 drop한다 (FIFO)', async () => {
      const existing: AlarmLogEntry[] = Array.from({ length: ALARM_LOG_BUFFER_SIZE }, (_, i) =>
        makeEntry({ ts: i, stationName: `station-${i}` }),
      );
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(existing));
      const entry = makeEntry({ ts: 9999, stationName: '신규' });

      await appendAlarmLog(entry);

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved).toHaveLength(ALARM_LOG_BUFFER_SIZE);
      // 가장 오래된 ts=0이 drop되고 새 엔트리가 마지막
      expect(saved[0].ts).toBe(1);
      expect(saved[saved.length - 1].stationName).toBe('신규');
    });

    it('손상된 JSON이 저장돼 있어도 빈 배열로 초기화 후 append한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('not-json{{{');
      const entry = makeEntry();

      await appendAlarmLog(entry);

      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        ALARM_LOG_KEY,
        JSON.stringify([entry]),
      );
    });

    it('JSON.parse 결과가 배열이 아니면 빈 배열로 초기화한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify({ foo: 'bar' }));
      const entry = makeEntry();

      await appendAlarmLog(entry);

      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        ALARM_LOG_KEY,
        JSON.stringify([entry]),
      );
    });

    it('AsyncStorage가 에러를 던져도 throw하지 않는다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage 오류'));

      await expect(appendAlarmLog(makeEntry())).resolves.toBeUndefined();
    });
  });

  describe('getAlarmLog', () => {
    it('AsyncStorage 값을 파싱해 반환한다', async () => {
      const entries = [makeEntry({ stationName: 'A' }), makeEntry({ stationName: 'B' })];
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(entries));

      const result = await getAlarmLog();

      expect(AsyncStorage.getItem).toHaveBeenCalledWith(ALARM_LOG_KEY);
      expect(result).toEqual(entries);
    });

    it('값이 없으면 빈 배열을 반환한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);

      const result = await getAlarmLog();

      expect(result).toEqual([]);
    });

    it('손상된 JSON이면 빈 배열을 반환한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('not-json');

      const result = await getAlarmLog();

      expect(result).toEqual([]);
    });

    it('AsyncStorage가 에러를 던지면 빈 배열을 반환한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage 오류'));

      const result = await getAlarmLog();

      expect(result).toEqual([]);
    });
  });

  describe('helpers', () => {
    const station: Station = {
      id: 'S1',
      name: '강남',
      line: '2',
      lineColor: '#009246',
      lat: 37.498,
      lng: 127.028,
    };
    const event: AlarmEvent = { phaseId: 'early', type: 'destination', stationName: '시청' };

    beforeEach(() => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    });

    it('logFiredAlarm: source + event를 outcome=fired로 적재한다', async () => {
      logFiredAlarm('fg', event);
      await flushPromises();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        source: 'fg',
        outcome: 'fired',
        stationName: event.stationName,
        kind: event.type,
        phaseId: event.phaseId,
      });
      expect(saved[0].ts).toBeGreaterThan(0);
    });

    it('logFiredStationPassed: station.name과 kind=station-passed로 적재한다', async () => {
      logFiredStationPassed('bg', station);
      await flushPromises();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        source: 'bg',
        outcome: 'fired',
        stationName: station.name,
        kind: 'station-passed',
      });
    });

    it('logSuppressedDedupStation: reason=dedup-station, kind=station-passed로 적재한다', async () => {
      logSuppressedDedupStation('fg', station);
      await flushPromises();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        source: 'fg',
        outcome: 'suppressed',
        reason: 'dedup-station',
        stationName: station.name,
        kind: 'station-passed',
      });
    });

    it('logScheduledAlarm: source=bg-scheduled, outcome=fired + stamp 필드 전부 적재한다', async () => {
      const stamp: AlarmLogStamp = {
        direction: 'up',
        usedTrainCode: 'T-42',
        selectedArrivalSeconds: 600,
        expectedStationAtFire: '강남',
        actualLastNotifiedStation: 'S-7',
      };
      logScheduledAlarm(event, stamp);
      await flushPromises();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        source: 'bg-scheduled',
        outcome: 'fired',
        stationName: event.stationName,
        kind: event.type,
        phaseId: event.phaseId,
        direction: 'up',
        usedTrainCode: 'T-42',
        selectedArrivalSeconds: 600,
        expectedStationAtFire: '강남',
        actualLastNotifiedStation: 'S-7',
      });
    });

    it('logScheduledAlarm: stamp 필드가 null이면 null로 그대로 적재한다', async () => {
      const stamp: AlarmLogStamp = {
        direction: null,
        usedTrainCode: null,
        selectedArrivalSeconds: null,
        expectedStationAtFire: null,
        actualLastNotifiedStation: null,
      };
      logScheduledAlarm(event, stamp);
      await flushPromises();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        source: 'bg-scheduled',
        direction: null,
        usedTrainCode: null,
        selectedArrivalSeconds: null,
        expectedStationAtFire: null,
        actualLastNotifiedStation: null,
      });
    });

    it('logSuppressedGate: reason + location, source=bg 고정으로 적재한다', async () => {
      const location = { lat: 37.5, lng: 127.0, accuracy: 250, ageMs: 30_000 };
      logSuppressedGate('gate-accuracy', location);
      await flushPromises();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        source: 'bg',
        outcome: 'suppressed',
        reason: 'gate-accuracy',
        location,
      });
    });

    it('helper는 fire-and-forget: void 반환 + AsyncStorage 실패 시 throw 안 함', async () => {
      (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage 오류'));

      // 호출 자체가 throw하면 안 됨 (void)
      expect(() => logFiredAlarm('fg', event)).not.toThrow();
      await flushPromises();
    });
  });

  describe('clearAlarmLog', () => {
    it('AsyncStorage에서 ALARM_LOG_KEY를 삭제한다', async () => {
      await clearAlarmLog();

      expect(AsyncStorage.removeItem).toHaveBeenCalledWith(ALARM_LOG_KEY);
    });

    it('AsyncStorage가 에러를 던져도 throw하지 않는다', async () => {
      (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('storage 오류'));

      await expect(clearAlarmLog()).resolves.toBeUndefined();
    });
  });
});
