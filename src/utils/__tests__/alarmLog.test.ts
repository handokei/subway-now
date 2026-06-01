import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  appendAlarmLog,
  getAlarmLog,
  clearAlarmLog,
  logFiredAlarm,
  logFiredStationPassed,
  logScheduledAlarm,
  logFiredAlarmsHydrate,
  logSuppressedDedupAlarm,
  _resetDedupAlarmWindowForTests,
  DEDUP_LOG_WINDOW_MS,
  logSuppressedDedupStation,
  logSuppressedGate,
  logSilentPushReceived,
  logSilentPushRescheduleReceived,
  logSilentPushFired,
  logSilentPushSkipped,
  logAlertFallbackFired,
  summarizeAlarmLogBySource,
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
    _resetDedupAlarmWindowForTests();
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

    it('logSuppressedDedupAlarm: reason=dedup-alarm, phase+type+stationName 적재 (#580)', async () => {
      logSuppressedDedupAlarm('fg', { phaseId: 'early', type: 'destination', stationName: '강남' });
      await flushPromises();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        source: 'fg',
        outcome: 'suppressed',
        reason: 'dedup-alarm',
        stationName: '강남',
        kind: 'destination',
        phaseId: 'early',
      });
    });

    it('#626 같은 키 윈도우 내 재호출은 drop (FG polling 매초 평가 스팸 차단)', async () => {
      const baseTs = 1_700_000_000_000;
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(baseTs);
      try {
        logSuppressedDedupAlarm('fg', { phaseId: 'early', type: 'destination', stationName: '강남' });
        await flushPromises();
        const callsAfterFirst = (AsyncStorage.setItem as jest.Mock).mock.calls.length;

        // 윈도우 내 재호출 — drop
        nowSpy.mockReturnValue(baseTs + DEDUP_LOG_WINDOW_MS - 1);
        logSuppressedDedupAlarm('fg', { phaseId: 'early', type: 'destination', stationName: '강남' });
        await flushPromises();
        expect((AsyncStorage.setItem as jest.Mock).mock.calls.length).toBe(callsAfterFirst);

        // 윈도우 경계 통과 — 통과
        nowSpy.mockReturnValue(baseTs + DEDUP_LOG_WINDOW_MS + 1);
        logSuppressedDedupAlarm('fg', { phaseId: 'early', type: 'destination', stationName: '강남' });
        await flushPromises();
        expect((AsyncStorage.setItem as jest.Mock).mock.calls.length).toBe(callsAfterFirst + 1);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('#626 다른 키(source/type/phase/station)는 별개 윈도우 — 모두 통과', async () => {
      logSuppressedDedupAlarm('fg', { phaseId: 'early', type: 'destination', stationName: '강남' });
      logSuppressedDedupAlarm('fg', { phaseId: 'early', type: 'transfer', stationName: '강남' });
      logSuppressedDedupAlarm('fg', { phaseId: 'imminent', type: 'destination', stationName: '강남' });
      logSuppressedDedupAlarm('fg', { phaseId: 'early', type: 'destination', stationName: '역삼' });
      logSuppressedDedupAlarm('bg', { phaseId: 'early', type: 'destination', stationName: '강남' });
      await flushPromises();
      expect((AsyncStorage.setItem as jest.Mock).mock.calls.length).toBe(5);
    });

    it('#626 Map cap 초과 시 만료된 엔트리 sweep — 무한 성장 방지', async () => {
      const baseTs = 1_700_000_000_000;
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(baseTs);
      try {
        // cap(64)보다 많은 고유 키 적재 — 모두 첫 호출이므로 통과.
        for (let i = 0; i < 70; i++) {
          logSuppressedDedupAlarm('fg', {
            phaseId: 'early',
            type: 'destination',
            stationName: `s${i}`,
          });
        }
        await flushPromises();
        const callsBefore = (AsyncStorage.setItem as jest.Mock).mock.calls.length;

        // 윈도우 충분히 넘긴 후 새 키 1개 → sweep 발동, 기존 만료 엔트리 정리.
        nowSpy.mockReturnValue(baseTs + DEDUP_LOG_WINDOW_MS * 2);
        logSuppressedDedupAlarm('fg', {
          phaseId: 'early',
          type: 'destination',
          stationName: 's-after',
        });
        await flushPromises();
        expect((AsyncStorage.setItem as jest.Mock).mock.calls.length).toBe(callsBefore + 1);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('logFiredAlarmsHydrate: destinationId + firedAlarmsCount 적재 (#580 race 진단)', async () => {
      logFiredAlarmsHydrate('dest-1', 2);
      await flushPromises();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        source: 'fg-hydrate',
        outcome: 'received',
        destinationId: 'dest-1',
        firedAlarmsCount: 2,
      });
    });

    it('logFiredAlarmsHydrate: destinationId=null도 그대로 기록', async () => {
      logFiredAlarmsHydrate(null, 0);
      await flushPromises();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        source: 'fg-hydrate',
        destinationId: null,
        firedAlarmsCount: 0,
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

    it('logSilentPushReceived: source=silent-push-received, outcome=received, sentAt/receivedAt 적재 (#478)', async () => {
      logSilentPushReceived({
        stationName: '강남',
        kind: 'destination',
        phaseId: 'early',
        sentAt: 1_700_000_000_000,
        receivedAt: 1_700_000_001_500,
      });
      await flushPromises();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        ts: 1_700_000_001_500,
        source: 'silent-push-received',
        outcome: 'received',
        stationName: '강남',
        kind: 'destination',
        phaseId: 'early',
        sentAt: 1_700_000_000_000,
        receivedAt: 1_700_000_001_500,
      });
    });

    it('logSilentPushReceived: intermediate → station-passed로 매핑 (#478/#416)', async () => {
      logSilentPushReceived({
        stationName: '중곡',
        kind: 'intermediate',
        phaseId: 'imminent',
        sentAt: 1_700_000_000_000,
        receivedAt: 1_700_000_001_000,
      });
      await flushPromises();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0].kind).toBe('station-passed');
    });

    it('logSilentPushReceived: kind/sentAt 미상이면 kind 미포함 + sentAt undefined (#478 구 백엔드 호환)', async () => {
      logSilentPushReceived({
        stationName: '강남',
        kind: undefined,
        phaseId: 'early',
        sentAt: undefined,
        receivedAt: 1_700_000_001_000,
      });
      await flushPromises();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0].source).toBe('silent-push-received');
      expect(saved[0].kind).toBeUndefined();
      expect(saved[0].sentAt).toBeUndefined();
      expect(saved[0].receivedAt).toBe(1_700_000_001_000);
    });

    // #725 — reschedule silent push 수신 적재. source는 동일(silent-push-received)이라
    // DebugModal `lastReceivedAt`이 자동 갱신. kind/phaseId는 reschedule 의미상 미적용.
    it('logSilentPushRescheduleReceived: source=silent-push-received, kind/phaseId 미포함, sentAt/receivedAt 적재 (#725)', async () => {
      logSilentPushRescheduleReceived({
        nextStation: '사가정',
        sentAt: 1_780_000_000_000,
        receivedAt: 1_780_000_001_500,
      });
      await flushPromises();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        ts: 1_780_000_001_500,
        source: 'silent-push-received',
        outcome: 'received',
        stationName: '사가정',
        sentAt: 1_780_000_000_000,
        receivedAt: 1_780_000_001_500,
      });
      expect(saved[0].kind).toBeUndefined();
      expect(saved[0].phaseId).toBeUndefined();
    });

    it('logSilentPushRescheduleReceived: sentAt 누락이면 undefined로 적재 (#725)', async () => {
      logSilentPushRescheduleReceived({
        nextStation: '사가정',
        sentAt: undefined,
        receivedAt: 1_780_000_001_500,
      });
      await flushPromises();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0].sentAt).toBeUndefined();
    });

    it('logSilentPushFired: 게이트 통과 후 발사 1건 적재 (#478 PR 1-2)', async () => {
      logSilentPushFired({
        stationName: '강남',
        kind: 'destination',
        phaseId: 'imminent',
        distanceM: 150,
        thresholdM: 400,
        locationSource: 'cache',
        locationAgeMs: 12_000,
      });
      await flushPromises();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        source: 'silent-push-fired',
        outcome: 'fired',
        stationName: '강남',
        kind: 'destination',
        phaseId: 'imminent',
        distanceM: 150,
        thresholdM: 400,
        locationSource: 'cache',
        locationAgeMs: 12_000,
      });
    });

    it('logSilentPushSkipped: reason + 거리/임계값 적재 (#478 PR 1-2)', async () => {
      logSilentPushSkipped({
        stationName: '강남',
        kind: 'destination',
        phaseId: 'imminent',
        reason: 'gate-out-of-range',
        distanceM: 5_000,
        thresholdM: 400,
        locationSource: 'cache',
        locationAgeMs: 10_000,
      });
      await flushPromises();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        source: 'silent-push-skipped',
        outcome: 'suppressed',
        reason: 'gate-out-of-range',
        stationName: '강남',
        kind: 'destination',
        phaseId: 'imminent',
        distanceM: 5_000,
        thresholdM: 400,
      });
    });

    it('logSilentPushSkipped: kind 미상 + 거리 정보 없을 때도 적재', async () => {
      logSilentPushSkipped({
        stationName: '강남',
        kind: undefined,
        phaseId: 'early',
        reason: 'gate-unknown-station',
      });
      await flushPromises();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0].source).toBe('silent-push-skipped');
      expect(saved[0].reason).toBe('gate-unknown-station');
      expect(saved[0].kind).toBeUndefined();
      expect(saved[0].distanceM).toBeUndefined();
    });

    it('logAlertFallbackFired: source=alert-fallback-fired, outcome=fired 적재 (#564)', async () => {
      logAlertFallbackFired({ stationName: '강남', kind: 'destination', phaseId: 'imminent' });
      await flushPromises();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        source: 'alert-fallback-fired',
        outcome: 'fired',
        stationName: '강남',
        kind: 'destination',
        phaseId: 'imminent',
      });
    });

    it('helper는 fire-and-forget: void 반환 + AsyncStorage 실패 시 throw 안 함', async () => {
      (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage 오류'));

      // 호출 자체가 throw하면 안 됨 (void)
      expect(() => logFiredAlarm('fg', event)).not.toThrow();
      await flushPromises();
    });
  });

  describe('summarizeAlarmLogBySource (#564)', () => {
    it('빈 배열이면 빈 객체를 반환한다', () => {
      expect(summarizeAlarmLogBySource([])).toEqual({});
    });

    it('source별로 카운트를 집계한다', () => {
      const entries: AlarmLogEntry[] = [
        makeEntry({ source: 'fg' }),
        makeEntry({ source: 'fg' }),
        makeEntry({ source: 'bg-scheduled' }),
        makeEntry({ source: 'alert-fallback-fired' }),
        makeEntry({ source: 'alert-fallback-fired' }),
      ];
      expect(summarizeAlarmLogBySource(entries)).toEqual({
        fg: 2,
        'bg-scheduled': 1,
        'alert-fallback-fired': 2,
      });
    });

    it('카운트 0인 source는 결과에 포함되지 않는다', () => {
      const entries: AlarmLogEntry[] = [makeEntry({ source: 'fg' })];
      const result = summarizeAlarmLogBySource(entries);
      expect(result).toEqual({ fg: 1 });
      expect(Object.keys(result)).not.toContain('bg');
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
