import AsyncStorage from '@react-native-async-storage/async-storage';

// #735 — react-native AppState 모킹 (alarmLog가 모듈 스코프에서 listener 등록).
// jest.mock 팩토리는 hoist되어 import 이전에 적용 — 모듈 로드 시 등록되는 listener 호출이 안전하게 no-op.
// 실제 AppState 전환 시뮬레이트는 alarmLog._simulateAppStateForTest()로 직접 트리거.
jest.mock('react-native', () => ({
  AppState: {
    addEventListener: jest.fn().mockReturnValue({ remove: jest.fn() }),
  },
}));

import {
  appendAlarmLog,
  flushAlarmLog,
  resetAlarmLogForTest,
  getAlarmLog,
  clearAlarmLog,
  logFiredAlarm,
  logFiredStationPassed,
  logScheduledAlarm,
  logFiredAlarmsHydrate,
  logRefMismatch,
  _resetRefMismatchWindowForTests,
  logSuppressedDedupAlarm,
  _resetDedupAlarmWindowForTests,
  _resetBurstSuppressWindowForTests,
  _simulateAppStateForTest,
  DEDUP_LOG_WINDOW_MS,
  FLUSH_DEBOUNCE_MS,
  FLUSH_MAX_DELAY_MS,
  logSuppressedDedupStation,
  logSuppressedDismissSilence,
  logSuppressedSleepFirstTransfer,
  logSuppressedGate,
  logSuppressedMovement,
  logSilentPushReceived,
  logSilentPushRescheduleReceived,
  logSilentPushTripEndedReceived,
  logSilentPushFired,
  logSilentPushSkipped,
  logAlertFallbackFired,
  logSuppressedStationPassedWarmup,
  summarizeAlarmLogBySource,
  countSilentPushOutcomes,
  ALARM_LOG_BUFFER_SIZE,
  type AlarmLogEntry,
  type AlarmLogStamp,
} from '../alarmLog';
import { ALARM_LOG_KEY } from '../../../../shared/constants/storageKeys';
import type { AlarmEvent } from '../stationAlarm';
import type { Station } from '../../../../shared/types/station';

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
    // #735 — 이전 테스트가 큐에 남긴 mockResolvedValueOnce/mockResolvedValue가 다음 테스트의
    // getItem 호출을 오염시키지 않도록 명시 reset. clearAllMocks는 implementation을 안 지움.
    (AsyncStorage.getItem as jest.Mock).mockReset();
    (AsyncStorage.setItem as jest.Mock).mockReset().mockResolvedValue(undefined);
    (AsyncStorage.removeItem as jest.Mock).mockReset().mockResolvedValue(undefined);
    _resetDedupAlarmWindowForTests();
    _resetRefMismatchWindowForTests();
    _resetBurstSuppressWindowForTests();
    // #735 — 모듈 스코프 pending/timer 격리.
    resetAlarmLogForTest();
  });

  describe('appendAlarmLog + flushAlarmLog (#735 batched write)', () => {
    it('flush 전엔 storage write 안 함, flush 호출 후 단일 엔트리로 저장한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      const entry = makeEntry();

      appendAlarmLog(entry);
      expect(AsyncStorage.setItem).not.toHaveBeenCalled();

      await flushAlarmLog();

      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        ALARM_LOG_KEY,
        JSON.stringify([entry]),
      );
    });

    it('기존 로그가 있으면 뒤에 append한다', async () => {
      const existing = [makeEntry({ stationName: '시청' })];
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(existing));
      const entry = makeEntry({ stationName: '강남' });

      appendAlarmLog(entry);
      await flushAlarmLog();

      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        ALARM_LOG_KEY,
        JSON.stringify([...existing, entry]),
      );
    });

    it('여러 entry를 push 후 한 번에 flush — RMW 1회로 batch', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      appendAlarmLog(makeEntry({ stationName: 'A' }));
      appendAlarmLog(makeEntry({ stationName: 'B' }));
      appendAlarmLog(makeEntry({ stationName: 'C' }));

      await flushAlarmLog();

      expect(AsyncStorage.getItem).toHaveBeenCalledTimes(1);
      expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved.map((e) => e.stationName)).toEqual(['A', 'B', 'C']);
    });

    it('BUFFER 크기 초과 시 가장 오래된 엔트리부터 drop한다 (FIFO)', async () => {
      const existing: AlarmLogEntry[] = Array.from({ length: ALARM_LOG_BUFFER_SIZE }, (_, i) =>
        makeEntry({ ts: i, stationName: `station-${i}` }),
      );
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(existing));
      const entry = makeEntry({ ts: 9999, stationName: '신규' });

      appendAlarmLog(entry);
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved).toHaveLength(ALARM_LOG_BUFFER_SIZE);
      // 가장 오래된 ts=0이 drop되고 새 엔트리가 마지막
      expect(saved[0].ts).toBe(1);
      expect(saved.at(-1)?.stationName).toBe('신규');
    });

    it('손상된 JSON이 저장돼 있어도 빈 배열로 초기화 후 append한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('not-json{{{');
      const entry = makeEntry();

      appendAlarmLog(entry);
      await flushAlarmLog();

      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        ALARM_LOG_KEY,
        JSON.stringify([entry]),
      );
    });

    it('JSON.parse 결과가 배열이 아니면 빈 배열로 초기화한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify({ foo: 'bar' }));
      const entry = makeEntry();

      appendAlarmLog(entry);
      await flushAlarmLog();

      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        ALARM_LOG_KEY,
        JSON.stringify([entry]),
      );
    });

    it('AsyncStorage가 에러를 던져도 throw하지 않는다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage 오류'));

      appendAlarmLog(makeEntry());
      await expect(flushAlarmLog()).resolves.toBeUndefined();
    });

    it('pending 없을 때 flush 호출은 no-op (storage 미접근)', async () => {
      await flushAlarmLog();
      expect(AsyncStorage.getItem).not.toHaveBeenCalled();
      expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    });

    it('debounce: timer 만료까지 기다리면 자동 flush (FLUSH_DEBOUNCE_MS)', async () => {
      jest.useFakeTimers();
      try {
        (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
        appendAlarmLog(makeEntry({ stationName: 'A' }));
        expect(AsyncStorage.setItem).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);

        expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it('debounce: 새 push가 들어오면 timer reset', async () => {
      jest.useFakeTimers();
      try {
        (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
        appendAlarmLog(makeEntry({ stationName: 'A' }));
        await jest.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS - 100);
        appendAlarmLog(makeEntry({ stationName: 'B' }));
        await jest.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS - 100);
        expect(AsyncStorage.setItem).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(200);

        expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
        const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
        const saved: AlarmLogEntry[] = JSON.parse(savedJson);
        expect(saved.map((e) => e.stationName)).toEqual(['A', 'B']);
      } finally {
        jest.useRealTimers();
      }
    });

    it('max-delay: 가장 오래된 pending이 FLUSH_MAX_DELAY_MS 도달하면 다음 append에서 즉시 flush', async () => {
      const startTime = 1_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(startTime);
      try {
        (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);

        appendAlarmLog(makeEntry({ stationName: 'first' }));
        // FLUSH_MAX_DELAY_MS 경과 시뮬레이트
        (Date.now as jest.Mock).mockReturnValue(startTime + FLUSH_MAX_DELAY_MS);
        appendAlarmLog(makeEntry({ stationName: 'second' }));

        // void flushAlarmLog() 마이크로태스크 chain 모두 drain
        await flushPromises();
        await flushPromises();

        expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
        const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
        const saved: AlarmLogEntry[] = JSON.parse(savedJson);
        expect(saved.map((e) => e.stationName)).toEqual(['first', 'second']);
      } finally {
        (Date.now as jest.Mock).mockRestore();
      }
    });

    it('AppState background 전환 시 자동 flush', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      appendAlarmLog(makeEntry({ stationName: 'A' }));
      expect(AsyncStorage.setItem).not.toHaveBeenCalled();

      _simulateAppStateForTest('background');
      await flushPromises();
      await flushPromises();

      expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
    });

    it('AppState inactive 전환 시 자동 flush', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      appendAlarmLog(makeEntry({ stationName: 'A' }));

      _simulateAppStateForTest('inactive');
      await flushPromises();
      await flushPromises();

      expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
    });

    it('AppState active 전환은 flush 안 함', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      appendAlarmLog(makeEntry({ stationName: 'A' }));

      _simulateAppStateForTest('active');
      await flushPromises();

      expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    });

    // #735 review P1 fix: 동시 flush race로 lost-update 발생하지 않는지 검증.
    // mutex 없으면 두 flush가 같은 storage 상태를 읽고 서로의 write를 덮어 E1이 사라진다.
    it('동시 flushAlarmLog 호출 시 lost-update 없음 (mutex 직렬화)', async () => {
      // getItem이 호출될 때마다 현재 setItem된 값을 reflect — 실제 storage 시뮬레이션.
      let storage: string | null = null;
      (AsyncStorage.getItem as jest.Mock).mockImplementation(async () => storage);
      (AsyncStorage.setItem as jest.Mock).mockImplementation(async (_key: string, value: string) => {
        storage = value;
      });

      appendAlarmLog(makeEntry({ stationName: 'E1' }));
      const p1 = flushAlarmLog();
      appendAlarmLog(makeEntry({ stationName: 'E2' }));
      const p2 = flushAlarmLog();
      await Promise.all([p1, p2]);

      const finalSaved: AlarmLogEntry[] = storage ? JSON.parse(storage) : [];
      const names = finalSaved.map((e) => e.stationName ?? '');
      expect(names.sort((a, b) => a.localeCompare(b))).toEqual(['E1', 'E2']);
    });

    it('인플라이트 flush 중에 추가 push가 없으면 recursive 재호출 안 함 (no-op)', async () => {
      let storage: string | null = null;
      (AsyncStorage.getItem as jest.Mock).mockImplementation(async () => storage);
      (AsyncStorage.setItem as jest.Mock).mockImplementation(async (_key: string, value: string) => {
        storage = value;
      });

      appendAlarmLog(makeEntry({ stationName: 'E1' }));
      const p1 = flushAlarmLog();
      const p2 = flushAlarmLog(); // 추가 append 없이 즉시 두 번째 flush
      await Promise.all([p1, p2]);

      // setItem은 1회만 (E1 1건 write). p2는 재귀 호출 skip.
      expect((AsyncStorage.setItem as jest.Mock).mock.calls.length).toBe(1);
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

    it('#735 pending이 있으면 persisted + pending 병합 반환 (UI 즉시 가시)', async () => {
      const persisted = [makeEntry({ stationName: 'P1' })];
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(persisted));
      appendAlarmLog(makeEntry({ stationName: 'Pend1' }));
      appendAlarmLog(makeEntry({ stationName: 'Pend2' }));

      const result = await getAlarmLog();

      expect(result.map((e) => e.stationName)).toEqual(['P1', 'Pend1', 'Pend2']);
    });

    it('#735 병합 결과가 BUFFER 초과면 가장 오래된 것부터 drop', async () => {
      const persisted = Array.from({ length: ALARM_LOG_BUFFER_SIZE }, (_, i) =>
        makeEntry({ ts: i, stationName: `P-${i}` }),
      );
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(persisted));
      appendAlarmLog(makeEntry({ ts: 9999, stationName: 'NEW' }));

      const result = await getAlarmLog();

      expect(result).toHaveLength(ALARM_LOG_BUFFER_SIZE);
      expect(result[0].ts).toBe(1);
      expect(result.at(-1)?.stationName).toBe('NEW');
    });

    it('#735 AsyncStorage 실패 시에도 pending은 반환', async () => {
      (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage'));
      appendAlarmLog(makeEntry({ stationName: 'Pend1' }));

      const result = await getAlarmLog();

      expect(result.map((e) => e.stationName)).toEqual(['Pend1']);
    });
  });

  describe('clearAlarmLog (#735 pending도 초기화)', () => {
    it('removeItem 호출 + pending 비움', async () => {
      appendAlarmLog(makeEntry({ stationName: 'A' }));
      await clearAlarmLog();
      expect(AsyncStorage.removeItem).toHaveBeenCalledWith(ALARM_LOG_KEY);

      // 직후 getAlarmLog는 pending 0 (storage empty)
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      const result = await getAlarmLog();
      expect(result).toEqual([]);
    });

    it('AsyncStorage removeItem 실패해도 throw하지 않음', async () => {
      (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('remove fail'));
      await expect(clearAlarmLog()).resolves.toBeUndefined();
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

    // 마지막 setItem 호출에 저장된 첫 엔트리가 matchers와 일치하는지 검증.
    // log helper 테스트들의 flush + JSON.parse + toMatchObject 반복 패턴 추출
    // (SonarCloud new_duplicated_lines_density 임계 준수).
    async function expectLastSavedEntryMatches(matchers: Partial<AlarmLogEntry>): Promise<AlarmLogEntry> {
      await flushAlarmLog();
      const calls = (AsyncStorage.setItem as jest.Mock).mock.calls;
      const [, savedJson] = calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject(matchers);
      return saved[0];
    }

    it('logFiredAlarm: source + event를 outcome=fired로 적재한다', async () => {
      logFiredAlarm('fg', event);
      await flushAlarmLog();

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
      await flushAlarmLog();

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
      await flushAlarmLog();

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
      await expectLastSavedEntryMatches({
        source: 'fg',
        outcome: 'suppressed',
        reason: 'dedup-alarm',
        stationName: '강남',
        kind: 'destination',
        phaseId: 'early',
      });
    });

    it('logSuppressedDismissSilence: reason=dismiss-silence + source/kind/phaseId 보존 (#746)', async () => {
      logSuppressedDismissSilence({
        source: 'fg',
        stationName: '강남',
        kind: 'destination',
        phaseId: 'early',
      });
      await expectLastSavedEntryMatches({
        source: 'fg',
        outcome: 'suppressed',
        reason: 'dismiss-silence',
        stationName: '강남',
        kind: 'destination',
        phaseId: 'early',
      });
    });

    it('logSuppressedDismissSilence: phaseId 미전달 시에도 적재 (station-passed kind)', async () => {
      logSuppressedDismissSilence({
        source: 'bg',
        stationName: '시청',
        kind: 'station-passed',
      });
      const entry = await expectLastSavedEntryMatches({
        source: 'bg',
        outcome: 'suppressed',
        reason: 'dismiss-silence',
        kind: 'station-passed',
      });
      expect(entry.phaseId).toBeUndefined();
    });

    it('logSuppressedSleepFirstTransfer: reason=sleep-first-transfer, kind=transfer 고정, source/phaseId 보존 (#750)', async () => {
      logSuppressedSleepFirstTransfer({
        source: 'bg-scheduled',
        stationName: '강남',
        phaseId: 'early',
      });
      await expectLastSavedEntryMatches({
        source: 'bg-scheduled',
        outcome: 'suppressed',
        reason: 'sleep-first-transfer',
        stationName: '강남',
        kind: 'transfer',
        phaseId: 'early',
      });
    });

    it('logSuppressedSleepFirstTransfer: phaseId 미전달 시에도 적재', async () => {
      logSuppressedSleepFirstTransfer({
        source: 'fg',
        stationName: '역삼',
      });
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        source: 'fg',
        outcome: 'suppressed',
        reason: 'sleep-first-transfer',
        stationName: '역삼',
        kind: 'transfer',
      });
      expect(saved[0].phaseId).toBeUndefined();
    });

    it('#1010 logSuppressedStationPassedWarmup: reason=gate-station-passed-warmup + kind=station-passed + source=fg 고정', async () => {
      logSuppressedStationPassedWarmup('역삼');
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        source: 'fg',
        outcome: 'suppressed',
        reason: 'gate-station-passed-warmup',
        stationName: '역삼',
        kind: 'station-passed',
      });
    });

    it('#1010 logSuppressedStationPassedWarmup: stationName=undefined 허용', async () => {
      logSuppressedStationPassedWarmup(undefined);
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        source: 'fg',
        outcome: 'suppressed',
        reason: 'gate-station-passed-warmup',
        kind: 'station-passed',
      });
      expect(saved[0].stationName).toBeUndefined();
    });

    it('#626 같은 키 윈도우 내 재호출은 drop (FG polling 매초 평가 스팸 차단)', async () => {
      const baseTs = 1_700_000_000_000;
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(baseTs);
      try {
        logSuppressedDedupAlarm('fg', { phaseId: 'early', type: 'destination', stationName: '강남' });
        await flushAlarmLog();
        const callsAfterFirst = (AsyncStorage.setItem as jest.Mock).mock.calls.length;

        // 윈도우 내 재호출 — drop
        nowSpy.mockReturnValue(baseTs + DEDUP_LOG_WINDOW_MS - 1);
        logSuppressedDedupAlarm('fg', { phaseId: 'early', type: 'destination', stationName: '강남' });
        await flushAlarmLog();
        expect((AsyncStorage.setItem as jest.Mock).mock.calls.length).toBe(callsAfterFirst);

        // 윈도우 경계 통과 — 통과
        nowSpy.mockReturnValue(baseTs + DEDUP_LOG_WINDOW_MS + 1);
        logSuppressedDedupAlarm('fg', { phaseId: 'early', type: 'destination', stationName: '강남' });
        await flushAlarmLog();
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
      await flushAlarmLog();
      // #735 — 모든 호출이 1회 batch RMW로 적재. setItem 1번, payload에 5건 모두 포함.
      expect((AsyncStorage.setItem as jest.Mock).mock.calls.length).toBe(1);
      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved).toHaveLength(5);
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
        await flushAlarmLog();
        const callsBefore = (AsyncStorage.setItem as jest.Mock).mock.calls.length;

        // 윈도우 충분히 넘긴 후 새 키 1개 → sweep 발동, 기존 만료 엔트리 정리.
        nowSpy.mockReturnValue(baseTs + DEDUP_LOG_WINDOW_MS * 2);
        logSuppressedDedupAlarm('fg', {
          phaseId: 'early',
          type: 'destination',
          stationName: 's-after',
        });
        await flushAlarmLog();
        expect((AsyncStorage.setItem as jest.Mock).mock.calls.length).toBe(callsBefore + 1);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('logFiredAlarmsHydrate: destinationId + firedAlarmsCount 적재 (#580 race 진단)', async () => {
      logFiredAlarmsHydrate('dest-1', 2);
      await flushAlarmLog();

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
      await flushAlarmLog();

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
      await flushAlarmLog();

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
      await flushAlarmLog();

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
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        source: 'bg',
        outcome: 'suppressed',
        reason: 'gate-accuracy',
        location,
      });
    });

    // #727 — 정적 misfire 가드(movementGate.ts)가 차단한 발사. source/stationName/kind/phaseId 보존.
    it('logSuppressedMovement: 모든 필드 지정 시 그대로 적재', async () => {
      logSuppressedMovement({
        source: 'fg',
        stationName: '강남',
        kind: 'destination',
        phaseId: 'imminent',
        reason: 'movement-static-speed',
      });
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        source: 'fg',
        outcome: 'suppressed',
        reason: 'movement-static-speed',
        stationName: '강남',
        kind: 'destination',
        phaseId: 'imminent',
      });
    });

    it('logSuppressedMovement: kind/phaseId 미지정도 허용 (silent push 등)', async () => {
      logSuppressedMovement({
        source: 'silent-push-skipped',
        stationName: '사가정',
        reason: 'movement-low-accuracy',
      });
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        source: 'silent-push-skipped',
        outcome: 'suppressed',
        reason: 'movement-low-accuracy',
        stationName: '사가정',
      });
      expect(saved[0].kind).toBeUndefined();
      expect(saved[0].phaseId).toBeUndefined();
    });

    // #1023 — logSuppressedMovement / logSuppressedDedupStation burst dedup window.
    it.each<Extract<import('../alarmLog').AlarmLogReason, `movement-${string}`>>([
      'movement-motion-stationary',
      'movement-static-speed',
      'movement-static-position',
      'movement-low-accuracy',
    ])(
      '#1023 logSuppressedMovement(%s): 윈도우 내 같은 reason+station 재호출은 drop',
      async (reason) => {
        const baseTs = 1_700_000_000_000;
        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(baseTs);
        try {
          logSuppressedMovement({ source: 'fg', stationName: '강남', reason });
          await flushAlarmLog();
          const callsAfterFirst = (AsyncStorage.setItem as jest.Mock).mock.calls.length;

          // 윈도우 내 재호출 — drop
          nowSpy.mockReturnValue(baseTs + DEDUP_LOG_WINDOW_MS - 1);
          logSuppressedMovement({ source: 'fg', stationName: '강남', reason });
          await flushAlarmLog();
          expect((AsyncStorage.setItem as jest.Mock).mock.calls.length).toBe(callsAfterFirst);

          // 윈도우 경계 통과 — 통과
          nowSpy.mockReturnValue(baseTs + DEDUP_LOG_WINDOW_MS + 1);
          logSuppressedMovement({ source: 'fg', stationName: '강남', reason });
          await flushAlarmLog();
          expect((AsyncStorage.setItem as jest.Mock).mock.calls.length).toBe(callsAfterFirst + 1);
        } finally {
          nowSpy.mockRestore();
        }
      },
    );

    it('#1023 logSuppressedMovement: 다른 역은 별개 윈도우 — 모두 통과', async () => {
      logSuppressedMovement({ source: 'fg', stationName: '강남', reason: 'movement-static-speed' });
      logSuppressedMovement({ source: 'fg', stationName: '역삼', reason: 'movement-static-speed' });
      logSuppressedMovement({ source: 'fg', stationName: '강남', reason: 'movement-motion-stationary' });
      await flushAlarmLog();
      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved).toHaveLength(3);
    });

    it('#1023 logSuppressedDedupStation: 윈도우 내 같은 station 재호출은 drop', async () => {
      const baseTs = 1_700_000_000_000;
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(baseTs);
      try {
        logSuppressedDedupStation('fg', station);
        await flushAlarmLog();
        const callsAfterFirst = (AsyncStorage.setItem as jest.Mock).mock.calls.length;

        nowSpy.mockReturnValue(baseTs + DEDUP_LOG_WINDOW_MS - 1);
        logSuppressedDedupStation('fg', station);
        await flushAlarmLog();
        expect((AsyncStorage.setItem as jest.Mock).mock.calls.length).toBe(callsAfterFirst);

        nowSpy.mockReturnValue(baseTs + DEDUP_LOG_WINDOW_MS + 1);
        logSuppressedDedupStation('fg', station);
        await flushAlarmLog();
        expect((AsyncStorage.setItem as jest.Mock).mock.calls.length).toBe(callsAfterFirst + 1);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('#1023 logSuppressedDedupStation: 다른 역은 별개 윈도우 — 모두 통과', async () => {
      const station2: Station = { ...station, id: 'S2', name: '역삼' };
      logSuppressedDedupStation('fg', station);
      logSuppressedDedupStation('fg', station2);
      await flushAlarmLog();
      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved).toHaveLength(2);
    });

    it('#1023 logSuppressedMovement dedup은 logSuppressedDedupAlarm dedup과 독립 — 크로스 간섭 없음', async () => {
      // movement dedup에 등록
      logSuppressedMovement({ source: 'fg', stationName: '강남', reason: 'movement-static-speed' });
      // dedup-alarm은 별개 Map → 영향 없이 통과
      logSuppressedDedupAlarm('fg', { phaseId: 'early', type: 'destination', stationName: '강남' });
      await flushAlarmLog();
      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved).toHaveLength(2);
    });

    it('#1023 burst Map cap 초과 시 만료 엔트리 sweep — logSuppressedMovement 사용', async () => {
      const baseTs = 1_700_000_000_000;
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(baseTs);
      try {
        // cap(64)보다 많은 고유 역 키 적재 — 모두 첫 호출이므로 통과.
        for (let i = 0; i < 70; i++) {
          logSuppressedMovement({
            source: 'fg',
            stationName: `s${i}`,
            reason: 'movement-static-speed',
          });
        }
        await flushAlarmLog();
        const callsBefore = (AsyncStorage.setItem as jest.Mock).mock.calls.length;

        // 윈도우 충분히 넘긴 후 새 키 1개 → sweep 발동, 만료 엔트리 정리.
        nowSpy.mockReturnValue(baseTs + DEDUP_LOG_WINDOW_MS * 2);
        logSuppressedMovement({
          source: 'fg',
          stationName: 's-after',
          reason: 'movement-static-speed',
        });
        await flushAlarmLog();
        expect((AsyncStorage.setItem as jest.Mock).mock.calls.length).toBe(callsBefore + 1);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('logSilentPushReceived: source=silent-push-received, outcome=received, sentAt/receivedAt 적재 (#478)', async () => {
      logSilentPushReceived({
        stationName: '강남',
        kind: 'destination',
        phaseId: 'early',
        sentAt: 1_700_000_000_000,
        receivedAt: 1_700_000_001_500,
      });
      await flushAlarmLog();

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
      await flushAlarmLog();

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
      await flushAlarmLog();

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
      await flushAlarmLog();

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
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0].sentAt).toBeUndefined();
    });

    // #868 — trip-ended 수신 적재. station name 자리에 `trip-ended:${reason}`을 인코딩해
    // DebugModal에서 reason을 가시화. kind/phaseId는 trip 종료라 의미 없음.
    it.each<['eta-missing' | 'destination-arrived', number | undefined]>([
      ['eta-missing', 1_780_000_000_000],
      ['destination-arrived', undefined],
    ])(
      'logSilentPushTripEndedReceived reason=%s sentAt=%s 적재 (#868)',
      async (reason, sentAt) => {
        const receivedAt = 1_780_000_001_500;
        logSilentPushTripEndedReceived({ reason, sentAt, receivedAt });
        await flushAlarmLog();
        const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
        const saved: AlarmLogEntry[] = JSON.parse(savedJson);
        expect(saved[0]).toMatchObject({
          ts: receivedAt,
          source: 'silent-push-received',
          outcome: 'received',
          stationName: `trip-ended:${reason}`,
          receivedAt,
        });
        expect(saved[0].sentAt).toBe(sentAt);
        expect(saved[0].kind).toBeUndefined();
        expect(saved[0].phaseId).toBeUndefined();
      },
    );

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
      await flushAlarmLog();

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
      await flushAlarmLog();

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
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0].source).toBe('silent-push-skipped');
      expect(saved[0].reason).toBe('gate-unknown-station');
      expect(saved[0].kind).toBeUndefined();
      expect(saved[0].distanceM).toBeUndefined();
    });

    it('logAlertFallbackFired: source=alert-fallback-fired, outcome=fired 적재 (#564)', async () => {
      logAlertFallbackFired({ stationName: '강남', kind: 'destination', phaseId: 'imminent' });
      await flushAlarmLog();

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
      await flushAlarmLog();
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

  describe('countSilentPushOutcomes (#856)', () => {
    it('빈 배열이면 모두 0', () => {
      expect(countSilentPushOutcomes([])).toEqual({ received: 0, fired: 0, skipped: 0 });
    });

    it('silent-push-received / silent-push-fired / silent-push-skipped만 집계한다', () => {
      const entries: AlarmLogEntry[] = [
        makeEntry({ source: 'silent-push-received' }),
        makeEntry({ source: 'silent-push-received' }),
        makeEntry({ source: 'silent-push-received' }),
        makeEntry({ source: 'silent-push-fired' }),
        makeEntry({ source: 'silent-push-skipped' }),
        makeEntry({ source: 'silent-push-skipped' }),
      ];
      expect(countSilentPushOutcomes(entries)).toEqual({ received: 3, fired: 1, skipped: 2 });
    });

    it('silent push 외 source(fg/bg/bg-scheduled/alert-fallback-fired/fg-hydrate/fg-evaluated/fg-ref-mismatch)는 무시', () => {
      const entries: AlarmLogEntry[] = [
        makeEntry({ source: 'fg' }),
        makeEntry({ source: 'bg' }),
        makeEntry({ source: 'bg-scheduled' }),
        makeEntry({ source: 'alert-fallback-fired' }),
        makeEntry({ source: 'fg-hydrate' }),
        makeEntry({ source: 'fg-evaluated' }),
        makeEntry({ source: 'fg-ref-mismatch' }),
        makeEntry({ source: 'silent-push-received' }),
      ];
      expect(countSilentPushOutcomes(entries)).toEqual({ received: 1, fired: 0, skipped: 0 });
    });
  });

  describe('logRefMismatch (#580 M4 race detection stamp)', () => {
    it('destinationId + refDestId를 fg-ref-mismatch/suppressed 엔트리로 적재한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      logRefMismatch('dest-1', 'dest-0');
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        source: 'fg-ref-mismatch',
        outcome: 'suppressed',
        destinationId: 'dest-1',
        refDestId: 'dest-0',
      });
    });

    it('refDestId=null(초기 상태)도 그대로 기록한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      logRefMismatch('dest-1', null);
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        source: 'fg-ref-mismatch',
        outcome: 'suppressed',
        destinationId: 'dest-1',
        refDestId: null,
      });
    });

    it('같은 (destinationId, refDestId) 쌍은 DEDUP_LOG_WINDOW_MS 안에 1건만 적재한다 (#626 패턴)', async () => {
      jest.useFakeTimers();
      try {
        (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
        logRefMismatch('dest-1', 'dest-0');
        logRefMismatch('dest-1', 'dest-0'); // dedup → drop
        logRefMismatch('dest-1', 'dest-0'); // dedup → drop
        await flushAlarmLog();

        const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
        const saved: AlarmLogEntry[] = JSON.parse(savedJson);
        expect(saved.filter((e) => e.source === 'fg-ref-mismatch')).toHaveLength(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it('window 리셋 후에는 같은 쌍도 다시 적재된다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
      logRefMismatch('dest-1', 'dest-0');
      // 윈도우 캐시를 명시 리셋해 만료를 시뮬레이트.
      _resetRefMismatchWindowForTests();
      logRefMismatch('dest-1', 'dest-0'); // 캐시 비어있으므로 적재
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved.filter((e) => e.source === 'fg-ref-mismatch')).toHaveLength(2);
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
