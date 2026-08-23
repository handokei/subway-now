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
  getFiredAlarmLog,
  clearFiredAlarmLog,
  FIRED_ALARM_LOG_BUFFER_SIZE,
  type FiredAlarmLogEntry,
  logFiredAlarm,
  consumeAccurateDestinationFire,
  _resetAccurateDestinationFireForTests,
  logFiredStationPassed,
  logScheduledAlarm,
  logFiredAlarmsHydrate,
  logRefMismatch,
  _resetRefMismatchWindowForTests,
  logSuppressedDedupAlarm,
  _resetDedupAlarmWindowForTests,
  _resetBurstSuppressWindowForTests,
  clearAlarmLogWindows,
  _simulateAppStateForTest,
  DEDUP_LOG_WINDOW_MS,
  FLUSH_DEBOUNCE_MS,
  FLUSH_MAX_DELAY_MS,
  logSuppressedChannelAgnosticDedup,
  logSuppressedCrossCategoryDedup,
  logSuppressedCrossCategoryRecent,
  logSuppressedFireAlarmOnce,
  logSuppressedPhaseToPhaseDedup,
  logFiredAlarmsTripBoundaryReset,
  logSuppressedDedupStation,
  logSuppressedDismissSilence,
  logSuppressedSleepFirstTransfer,
  logSuppressedSleepStationPassed,
  logSuppressedGate,
  logSuppressedMovement,
  logSuppressedPhaseGate,
  logSilentPushReceived,
  logSilentPushRescheduleReceived,
  logSilentPushTripEndedReceived,
  logSilentPushSkipped,
  logAlertFallbackFired,
  summarizeAlarmLogByReason,
  logHydrationTransition,
  logSuppressedStationPassedWarmup,
  logSuppressedHopWindow,
  logSuppressedHopWindowNoSource,
  logSuppressedLocklessForwardOnly,
  logFusionCandidateDistanceReject,
  logFusionCandidateLineReject,
  logFusionPickerTier,
  _resetFusionPickerTierWindowForTests,
  formatFusionPickerTierDistribution,
  getFusionTierLog,
  FUSION_TIER_LOG_BUFFER_SIZE,
  type FusionTierLogEntry,
  logCrossTripMirrorSkip,
  logSuppressedOriginHopLockless,
  logSuppressedPassedEventOnLockOrigin,
  LOCK_ORIGIN_SUPPRESS_COOLDOWN_MS,
  logSuppressedLocklessNoUserIntent,
  logSuppressedSsotFireGate,
  logSuppressedSafetyNetRevalidation,
  logSuppressedPrescheduledRevalidation,
  summarizeAlarmLogBySource,
  countGateReasons,
  countSilentPushKindBreakdown,
  countSilentPushOutcomes,
  computeSilentPushReach,
  summarizeAlarmLogCounters,
  countAlarmLogReasonsByWindow,
  lastNReasons,
  logBoardingPromptFired,
  logBoardingPromptResponded,
  logCompanionAlarmFired,
  logLastTrainAlarmFired,
  logLegTransition,
  BOARDING_PROMPT_WINDOWS,
  countBoardingPromptByWindow,
  logBoardingPromptAutoLock,
  countBoardingPromptAutoLockOutcomes,
  countAutoLockReasonsByWindow,
  logScheduleSkipped,
  logAccelPatternObserved,
  _resetAccelPatternWindowForTests,
  ACCEL_PATTERN_DEDUP_MS,
  logBoardableLookupResult,
  _resetBoardableLookupWindowForTests,
  BOARDABLE_LOOKUP_DEDUP_MS,
  logGroundTruthResult,
  logLocklessTripEnd,
  countFiredAlarms,
  logPushContractKindSkew,
  logPushContractValueSkew,
  logPushContractVersionSkew,
  ALARM_LOG_BUFFER_SIZE,
  type AlarmLogEntry,
  type AlarmLogStamp,
  type AlarmLogReasonCounter,
  type BoardingPromptWindowKey,
} from '../alarmLog';
import { ALARM_LOG_KEY, FIRED_ALARM_LOG_KEY } from '../../../../shared/constants/storageKeys';
import type { AlarmEvent } from '../stationAlarm';
import type { Station } from '../../../../shared/types/station';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

// #2284 — line lookup을 mock해 fired-only 버퍼 테스트를 stations.json 실데이터와 분리(결정적).
jest.mock('../../../../shared/utils/stationLookup', () => ({
  findLineByStationName: jest.fn((name: string) => (name === '강남' ? '2' : null)),
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

// #2284 — 기본 outcome을 'suppressed'로 변경. 'fired'(+ FIRED_ALARM_SOURCES 소스)는
// appendAlarmLog/flushAlarmLog 경로에서 독립 fired-only 버퍼(FIRED_ALARM_LOG_KEY)에도
// 동시 write를 트리거하므로, fired 여부와 무관한 일반 배치 동작을 검증하는 기존 테스트가
// 의도치 않게 두 번째 AsyncStorage 호출을 관측하지 않도록 한다. fired 전용 동작은
// 'fired-only 독립 버퍼(#2284)' describe 블록에서 명시적으로 outcome: 'fired'를 지정한다.
function makeEntry(overrides: Partial<AlarmLogEntry> = {}): AlarmLogEntry {
  return {
    ts: 1_700_000_000_000,
    source: 'bg',
    outcome: 'suppressed',
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
    _resetFusionPickerTierWindowForTests();
    _resetAccelPatternWindowForTests();
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

    it('#1024 burst inline counter: 같은 key 연속 append는 단일 entry로 count++ 합산', async () => {
      // 780-783 라인: (source, reason, kind, phaseId, stationName) 동일한 연속 entry를 inline 합산.
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      const base = makeEntry({ outcome: 'suppressed', reason: 'gate-age', stationName: '강남', kind: 'station-passed', ts: 100 });
      const second = { ...base, ts: 200 };
      appendAlarmLog(base);
      appendAlarmLog(second);
      await flushAlarmLog();
      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      // 2개가 아닌 1개 entry로 합산, ts는 최신값(200), count=2
      expect(saved).toHaveLength(1);
      expect(saved[0].count).toBe(2);
      expect(saved[0].ts).toBe(200);
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

    // #2309 — destination imminent 발사(fusion arrival-confirmed 신호)는 accurate-fire flag를
    // 세운다. trip 종료 시 triggerTripGroundTruthPrompt가 소비해 수동 정답지 없이 즉시 확정.
    describe('consumeAccurateDestinationFire (#2309)', () => {
      beforeEach(() => {
        _resetAccurateDestinationFireForTests();
      });

      it('destination + imminent 발사 시 flag가 true로 세워지고 1회 소비 후 리셋된다', () => {
        expect(consumeAccurateDestinationFire()).toBe(false);
        logFiredAlarm('fg', { phaseId: 'imminent', type: 'destination', stationName: '뚝섬' });
        expect(consumeAccurateDestinationFire()).toBe(true);
        // 소비 직후 리셋 — 다음 trip으로 새지 않는다.
        expect(consumeAccurateDestinationFire()).toBe(false);
      });

      it('destination이라도 phase가 early면 flag를 세우지 않는다', () => {
        logFiredAlarm('fg', event); // event = { phaseId: 'early', type: 'destination', ... }
        expect(consumeAccurateDestinationFire()).toBe(false);
      });

      it('kind가 transfer/station-passed면 phaseId=imminent여도 flag를 세우지 않는다', () => {
        logFiredAlarm('fg', { phaseId: 'imminent', type: 'transfer', stationName: '건대입구' });
        expect(consumeAccurateDestinationFire()).toBe(false);
      });
    });

    // #2122 (FG 보조 발사) — station-passed는 phase가 없어 logFiredAlarm(AlarmEvent 전용)을
    // 재사용하지 않고 전용 helper로 kind='station-passed' 고정.
    it('logFiredStationPassed: source + stationName을 outcome=fired, kind=station-passed로 적재한다', async () => {
      logFiredStationPassed('fg', station.name);
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        source: 'fg',
        outcome: 'fired',
        stationName: station.name,
        kind: 'station-passed',
      });
      expect(saved[0].phaseId).toBeUndefined();
      expect(saved[0].ts).toBeGreaterThan(0);
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

    it('#1515 logSuppressedCrossCategoryDedup: reason=dedup-station-unified + kind/phase 보존', async () => {
      _resetBurstSuppressWindowForTests();
      logSuppressedCrossCategoryDedup({
        source: 'fg',
        stationName: '성수',
        kind: 'station-passed',
      });
      await expectLastSavedEntryMatches({
        source: 'fg',
        outcome: 'suppressed',
        reason: 'dedup-station-unified',
        stationName: '성수',
        kind: 'station-passed',
      });
    });

    it('#1515 logSuppressedCrossCategoryDedup: 윈도우 내 같은 stationName 재호출은 drop', async () => {
      _resetBurstSuppressWindowForTests();
      logSuppressedCrossCategoryDedup({ source: 'fg', stationName: '성수', kind: 'destination' });
      logSuppressedCrossCategoryDedup({ source: 'fg', stationName: '성수', kind: 'station-passed' });
      await flushAlarmLog();
      const calls = (AsyncStorage.setItem as jest.Mock).mock.calls;
      const lastJson = calls[calls.length - 1][1];
      const saved: AlarmLogEntry[] = JSON.parse(lastJson);
      const unified = saved.filter((e) => e.reason === 'dedup-station-unified');
      expect(unified).toHaveLength(1);
    });

    it('#1643 logSuppressedCrossCategoryRecent: reason=dedup-cross-category-recent + kind/phase 보존', async () => {
      _resetBurstSuppressWindowForTests();
      logSuppressedCrossCategoryRecent({
        source: 'fg',
        stationName: '성수',
        kind: 'destination',
        phaseId: 'imminent',
      });
      await expectLastSavedEntryMatches({
        source: 'fg',
        outcome: 'suppressed',
        reason: 'dedup-cross-category-recent',
        stationName: '성수',
        kind: 'destination',
        phaseId: 'imminent',
      });
    });

    it('#1643 logSuppressedCrossCategoryRecent: 윈도우 내 같은 stationName 재호출은 drop', async () => {
      _resetBurstSuppressWindowForTests();
      logSuppressedCrossCategoryRecent({ source: 'fg', stationName: '성수', kind: 'destination' });
      logSuppressedCrossCategoryRecent({ source: 'bg', stationName: '성수', kind: 'station-passed' });
      await flushAlarmLog();
      const calls = (AsyncStorage.setItem as jest.Mock).mock.calls;
      const lastJson = calls[calls.length - 1][1];
      const saved: AlarmLogEntry[] = JSON.parse(lastJson);
      const recent = saved.filter((e) => e.reason === 'dedup-cross-category-recent');
      expect(recent).toHaveLength(1);
    });

    it('#1656 logSuppressedPhaseToPhaseDedup: reason=dedup-phase-to-phase + kind/phase 보존', async () => {
      _resetBurstSuppressWindowForTests();
      logSuppressedPhaseToPhaseDedup({
        source: 'fg',
        stationName: '성수',
        kind: 'destination',
        phaseId: 'imminent',
      });
      await expectLastSavedEntryMatches({
        source: 'fg',
        outcome: 'suppressed',
        reason: 'dedup-phase-to-phase',
        stationName: '성수',
        kind: 'destination',
        phaseId: 'imminent',
      });
    });

    it('#1656 logSuppressedPhaseToPhaseDedup: 윈도우 내 같은 stationName 재호출은 drop', async () => {
      _resetBurstSuppressWindowForTests();
      logSuppressedPhaseToPhaseDedup({ source: 'fg', stationName: '성수', kind: 'destination' });
      logSuppressedPhaseToPhaseDedup({ source: 'bg', stationName: '성수', kind: 'transfer' });
      await flushAlarmLog();
      const calls = (AsyncStorage.setItem as jest.Mock).mock.calls;
      const lastJson = calls[calls.length - 1][1];
      const saved: AlarmLogEntry[] = JSON.parse(lastJson);
      const p2p = saved.filter((e) => e.reason === 'dedup-phase-to-phase');
      expect(p2p).toHaveLength(1);
    });

    it('#1901/#1900 logSuppressedChannelAgnosticDedup: reason=dedup-channel-agnostic + kind/phase 보존', async () => {
      _resetBurstSuppressWindowForTests();
      logSuppressedChannelAgnosticDedup({
        source: 'fg',
        stationName: '동대문역사문화공원',
        kind: 'station-passed',
        phaseId: 'imminent',
      });
      await expectLastSavedEntryMatches({
        source: 'fg',
        outcome: 'suppressed',
        reason: 'dedup-channel-agnostic',
        stationName: '동대문역사문화공원',
        kind: 'station-passed',
        phaseId: 'imminent',
      });
    });

    it('#1901/#1900 logSuppressedChannelAgnosticDedup: 윈도우 내 같은 stationName 재호출은 drop', async () => {
      _resetBurstSuppressWindowForTests();
      logSuppressedChannelAgnosticDedup({
        source: 'fg',
        stationName: '동대문역사문화공원',
        kind: 'destination',
      });
      logSuppressedChannelAgnosticDedup({
        source: 'silent-push-skipped',
        stationName: '동대문역사문화공원',
        kind: 'station-passed',
      });
      await flushAlarmLog();
      const calls = (AsyncStorage.setItem as jest.Mock).mock.calls;
      const lastJson = calls[calls.length - 1][1];
      const saved: AlarmLogEntry[] = JSON.parse(lastJson);
      const channelAgnostic = saved.filter((e) => e.reason === 'dedup-channel-agnostic');
      expect(channelAgnostic).toHaveLength(1);
    });

    it('#1984 logSuppressedFireAlarmOnce: reason=dedup-simple-arch-fire-once + kind/phase 보존', async () => {
      _resetBurstSuppressWindowForTests();
      logSuppressedFireAlarmOnce({
        source: 'fg',
        stationName: '성수',
        kind: 'station-passed',
        phaseId: 'imminent',
      });
      await expectLastSavedEntryMatches({
        source: 'fg',
        outcome: 'suppressed',
        reason: 'dedup-simple-arch-fire-once',
        stationName: '성수',
        kind: 'station-passed',
        phaseId: 'imminent',
      });
    });

    it('#1984 logSuppressedFireAlarmOnce: 윈도우 내 같은 stationName 재호출은 drop', async () => {
      _resetBurstSuppressWindowForTests();
      logSuppressedFireAlarmOnce({ source: 'fg', stationName: '성수', kind: 'destination' });
      logSuppressedFireAlarmOnce({ source: 'fg', stationName: '성수', kind: 'destination' });
      await flushAlarmLog();
      const calls = (AsyncStorage.setItem as jest.Mock).mock.calls;
      const lastJson = calls[calls.length - 1][1];
      const saved: AlarmLogEntry[] = JSON.parse(lastJson);
      const fireOnce = saved.filter((e) => e.reason === 'dedup-simple-arch-fire-once');
      expect(fireOnce).toHaveLength(1);
    });

    it('#1893 logFiredAlarmsTripBoundaryReset: reason=fired-alarms-trip-boundary-reset + epoch 슬롯 보존', async () => {
      logFiredAlarmsTripBoundaryReset({
        source: 'fg',
        destinationId: 'dest-1',
        previousTripStartedAt: 1_000_000,
        nextTripStartedAt: 2_000_000,
      });
      await expectLastSavedEntryMatches({
        source: 'fg',
        outcome: 'suppressed',
        reason: 'fired-alarms-trip-boundary-reset',
        destinationId: 'dest-1',
        sentAt: 1_000_000,
        receivedAt: 2_000_000,
      });
    });

    it('#1893 logFiredAlarmsTripBoundaryReset: previousTripStartedAt=null → sentAt=undefined', async () => {
      logFiredAlarmsTripBoundaryReset({
        source: 'fg',
        destinationId: 'dest-1',
        previousTripStartedAt: null,
        nextTripStartedAt: 2_000_000,
      });
      await flushAlarmLog();
      const calls = (AsyncStorage.setItem as jest.Mock).mock.calls;
      const lastJson = calls[calls.length - 1][1];
      const saved: AlarmLogEntry[] = JSON.parse(lastJson);
      const entry = saved.find((e) => e.reason === 'fired-alarms-trip-boundary-reset');
      expect(entry?.destinationId).toBe('dest-1');
      expect(entry?.sentAt).toBeUndefined();
      expect(entry?.receivedAt).toBe(2_000_000);
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

    it.each<['fg' | 'fg-arvlcd' | 'bg', string]>([
      ['fg', '사가정'],
      ['fg-arvlcd', '강남'],
      ['bg', '잠실'],
    ])(
      '#1236 logSuppressedSleepStationPassed: source=%s — reason=sleep-first-station-passed, kind=station-passed 고정',
      async (source, stationName) => {
        logSuppressedSleepStationPassed({ source, stationName });
        await expectLastSavedEntryMatches({
          source,
          outcome: 'suppressed',
          reason: 'sleep-first-station-passed',
          stationName,
          kind: 'station-passed',
        });
      },
    );

    it.each([
      ['revalidate-no-trip' as const, '강남', 'early' as const],
      ['revalidate-trip-token-mismatch' as const, '시청', 'imminent' as const],
      ['revalidate-waypoint-mismatch' as const, '서울역', 'early' as const],
      // #1704 — 사용자 위치 대비 fire 대상이 N hop 이상 미래 (2026-06-23 trip evidence backstop).
      ['revalidate-position-mismatch' as const, '종로3가', 'imminent' as const],
    ])(
      '#918 A3 PR2 logSuppressedSafetyNetRevalidation: %s — source=bg-scheduled 고정 + reason/stationName/phaseId 보존',
      async (reason, stationName, phaseId) => {
        logSuppressedSafetyNetRevalidation({ reason, stationName, phaseId });
        await expectLastSavedEntryMatches({
          source: 'bg-scheduled',
          outcome: 'suppressed',
          reason,
          stationName,
          phaseId,
        });
      },
    );

    it.each([
      ['revalidate-no-trip' as const, '강남'],
      ['revalidate-trip-token-mismatch' as const, '시청'],
      ['revalidate-sleep-mode-on' as const, '서울역'],
    ])(
      '#918 logSuppressedPrescheduledRevalidation: %s — source=bg-scheduled, outcome=suppressed',
      async (reason, stationName) => {
        logSuppressedPrescheduledRevalidation({ reason, stationName });
        await expectLastSavedEntryMatches({
          source: 'bg-scheduled',
          outcome: 'suppressed',
          reason,
          stationName,
        });
      },
    );

    it('#918 A3 PR2 logSuppressedSafetyNetRevalidation: phaseId 미전달 시에도 적재', async () => {
      logSuppressedSafetyNetRevalidation({
        reason: 'revalidate-no-trip',
        stationName: '약수',
      });
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        source: 'bg-scheduled',
        outcome: 'suppressed',
        reason: 'revalidate-no-trip',
        stationName: '약수',
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

    it('#1208 logSuppressedHopWindow: reason=gate-hop-window + kind=station-passed + hop 인덱스 stamp', async () => {
      logSuppressedHopWindow({
        source: 'fg',
        stationName: '사가정',
        currentHopIndex: 2,
        candidateIndex: 6,
      });
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        source: 'fg',
        outcome: 'suppressed',
        reason: 'gate-hop-window',
        stationName: '사가정',
        kind: 'station-passed',
        currentHopIndex: 2,
        candidateIndex: 6,
      });
    });

    it('#2373 logSuppressedHopWindow: kind/phaseId 전달 시(BG phase 알람 게이트) 그대로 stamp', async () => {
      logSuppressedHopWindow({
        source: 'bg',
        stationName: '건대입구',
        currentHopIndex: 1,
        candidateIndex: 3,
        kind: 'transfer',
        phaseId: 'early',
      });
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        source: 'bg',
        outcome: 'suppressed',
        reason: 'gate-hop-window',
        stationName: '건대입구',
        kind: 'transfer',
        phaseId: 'early',
        currentHopIndex: 1,
        candidateIndex: 3,
      });
    });

    it('#1208 logSuppressedHopWindowNoSource: reason=gate-hop-window-no-source + kind=station-passed', async () => {
      logSuppressedHopWindowNoSource({ source: 'fg', stationName: '용마산' });
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        source: 'fg',
        outcome: 'suppressed',
        reason: 'gate-hop-window-no-source',
        stationName: '용마산',
        kind: 'station-passed',
      });
    });

    it('#1616 (R8a) logSuppressedLocklessForwardOnly: reason=lockless-forward-only-block + source=fg-evaluated + trainNo stamped', async () => {
      logSuppressedLocklessForwardOnly({
        rejectedStationName: '시청',
        rejectedTrainNo: 'BACK',
      });
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        source: 'fg-evaluated',
        outcome: 'suppressed',
        reason: 'lockless-forward-only-block',
        stationName: '시청',
        usedTrainCode: 'BACK',
      });
    });

    it('#1616 (R8a) logSuppressedLocklessForwardOnly: burst dedup applies — repeated same station within window dropped', async () => {
      _resetBurstSuppressWindowForTests();
      logSuppressedLocklessForwardOnly({ rejectedStationName: '시청', rejectedTrainNo: 'A' });
      logSuppressedLocklessForwardOnly({ rejectedStationName: '시청', rejectedTrainNo: 'B' });
      logSuppressedLocklessForwardOnly({ rejectedStationName: '시청', rejectedTrainNo: 'C' });
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      const matching = saved.filter((e) => e.reason === 'lockless-forward-only-block');
      // 첫 entry 한 건 (burst inline count로 누적되거나 단일 entry 유지).
      expect(matching).toHaveLength(1);
    });

    it('#1628 logFusionCandidateDistanceReject: reason=candidate-distance-reject + source=fusion-candidate-reject + stationName stamped', async () => {
      _resetBurstSuppressWindowForTests();
      logFusionCandidateDistanceReject({ stationName: '시청' });
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        source: 'fusion-candidate-reject',
        outcome: 'suppressed',
        reason: 'candidate-distance-reject',
        stationName: '시청',
      });
    });

    it('#1628 logFusionCandidateDistanceReject: burst dedup applies — same stationName within window dropped', async () => {
      _resetBurstSuppressWindowForTests();
      logFusionCandidateDistanceReject({ stationName: '시청' });
      logFusionCandidateDistanceReject({ stationName: '시청' });
      logFusionCandidateDistanceReject({ stationName: '시청' });
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      const matching = saved.filter((e) => e.reason === 'candidate-distance-reject');
      expect(matching).toHaveLength(1);
    });

    it('#1628 logFusionCandidateDistanceReject: different stationName entries are NOT deduped', async () => {
      _resetBurstSuppressWindowForTests();
      logFusionCandidateDistanceReject({ stationName: '시청' });
      logFusionCandidateDistanceReject({ stationName: '종각' });
      logFusionCandidateDistanceReject({ stationName: '종로3가' });
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      const matching = saved.filter((e) => e.reason === 'candidate-distance-reject');
      expect(matching).toHaveLength(3);
    });

    it('#1902 logFusionCandidateLineReject: reason=candidate-line-reject + source=fusion-candidate-reject + line stamp in stationName', async () => {
      _resetBurstSuppressWindowForTests();
      logFusionCandidateLineReject({ line: '6' });
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        source: 'fusion-candidate-reject',
        outcome: 'suppressed',
        reason: 'candidate-line-reject',
        stationName: 'line:6',
      });
    });

    it('#1902 logFusionCandidateLineReject: burst dedup per line — same line within window dropped', async () => {
      _resetBurstSuppressWindowForTests();
      logFusionCandidateLineReject({ line: '6' });
      logFusionCandidateLineReject({ line: '6' });
      logFusionCandidateLineReject({ line: '6' });
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      const matching = saved.filter((e) => e.reason === 'candidate-line-reject');
      expect(matching).toHaveLength(1);
    });

    it('#1902 logFusionCandidateLineReject: different lines are NOT deduped', async () => {
      _resetBurstSuppressWindowForTests();
      logFusionCandidateLineReject({ line: '5' });
      logFusionCandidateLineReject({ line: '6' });
      logFusionCandidateLineReject({ line: '7' });
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      const matching = saved.filter((e) => e.reason === 'candidate-line-reject');
      expect(matching).toHaveLength(3);
    });

    it.each([
      ['register' as const, 'cross-trip-mirror-register' as const],
      ['mismatch' as const, 'cross-trip-mirror-mismatch' as const],
      ['launch' as const, 'cross-trip-mirror-launch' as const],
    ])(
      '#1628 logCrossTripMirrorSkip(%s): reason=cross-trip-mirror-skip + source=%s',
      async (site, expectedSource) => {
        _resetBurstSuppressWindowForTests();
        logCrossTripMirrorSkip(site);
        await flushAlarmLog();

        const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
        const saved: AlarmLogEntry[] = JSON.parse(savedJson);
        expect(saved[0]).toMatchObject({
          source: expectedSource,
          outcome: 'suppressed',
          reason: 'cross-trip-mirror-skip',
        });
      },
    );

    it('#1628 logCrossTripMirrorSkip: burst dedup applies per site — same site within window dropped', async () => {
      _resetBurstSuppressWindowForTests();
      logCrossTripMirrorSkip('register');
      logCrossTripMirrorSkip('register');
      logCrossTripMirrorSkip('register');
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      const matching = saved.filter((e) => e.reason === 'cross-trip-mirror-skip');
      expect(matching).toHaveLength(1);
    });

    it('#1628 logCrossTripMirrorSkip: different sites are NOT deduped (independent burst keys)', async () => {
      _resetBurstSuppressWindowForTests();
      logCrossTripMirrorSkip('register');
      logCrossTripMirrorSkip('mismatch');
      logCrossTripMirrorSkip('launch');
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      const matching = saved.filter((e) => e.reason === 'cross-trip-mirror-skip');
      expect(matching).toHaveLength(3);
    });

    it('#1514 logSuppressedOriginHopLockless: reason=gate-origin-hop-lockless + kind=station-passed', async () => {
      logSuppressedOriginHopLockless({ source: 'fg', stationName: '용마산' });
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        source: 'fg',
        outcome: 'suppressed',
        reason: 'gate-origin-hop-lockless',
        stationName: '용마산',
        kind: 'station-passed',
      });
    });

    it('#1599 logSuppressedPassedEventOnLockOrigin: reason=gate-passed-event-on-lock-origin + kind=station-passed', async () => {
      logSuppressedPassedEventOnLockOrigin({ source: 'fg', stationName: '용마산' });
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        source: 'fg',
        outcome: 'suppressed',
        reason: 'gate-passed-event-on-lock-origin',
        stationName: '용마산',
        kind: 'station-passed',
      });
    });

    it('#2093 (B) logSuppressedPassedEventOnLockOrigin: 30s 쿨다운 내 같은 station 재호출은 drop', async () => {
      const baseTs = 1_700_000_000_000;
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(baseTs);
      try {
        logSuppressedPassedEventOnLockOrigin({ source: 'fg', stationName: '용마산' });
        await flushAlarmLog();
        const callsAfterFirst = (AsyncStorage.setItem as jest.Mock).mock.calls.length;

        // 쿨다운 내 재호출 (fg-arvlcd 매초 재평가 busy-loop 시뮬레이션) — drop
        nowSpy.mockReturnValue(baseTs + LOCK_ORIGIN_SUPPRESS_COOLDOWN_MS - 1);
        logSuppressedPassedEventOnLockOrigin({ source: 'fg-arvlcd', stationName: '용마산' });
        await flushAlarmLog();
        expect((AsyncStorage.setItem as jest.Mock).mock.calls.length).toBe(callsAfterFirst);

        // 쿨다운 경계 통과 — 재개
        nowSpy.mockReturnValue(baseTs + LOCK_ORIGIN_SUPPRESS_COOLDOWN_MS + 1);
        logSuppressedPassedEventOnLockOrigin({ source: 'fg', stationName: '용마산' });
        await flushAlarmLog();
        expect((AsyncStorage.setItem as jest.Mock).mock.calls.length).toBe(callsAfterFirst + 1);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('#2093 (B) logSuppressedPassedEventOnLockOrigin: 다른 station은 별개 쿨다운 — drop 안 됨', async () => {
      logSuppressedPassedEventOnLockOrigin({ source: 'fg', stationName: '용마산' });
      logSuppressedPassedEventOnLockOrigin({ source: 'fg', stationName: '건대입구' });
      await flushAlarmLog();
      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved).toHaveLength(2);
    });

    it('#1816 logSuppressedLocklessNoUserIntent: reason=lockless-no-user-intent + kind/phaseId 보존', async () => {
      logSuppressedLocklessNoUserIntent({
        source: 'fg-evaluated',
        stationName: '한양대',
        kind: 'transfer',
        phaseId: 'early',
      });
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        source: 'fg-evaluated',
        outcome: 'suppressed',
        reason: 'lockless-no-user-intent',
        stationName: '한양대',
        kind: 'transfer',
        phaseId: 'early',
      });
    });

    it('#1572 logSuppressedSsotFireGate (Gate A alarm-already-decided): source/kind/phaseId 보존', async () => {
      logSuppressedSsotFireGate({
        source: 'fg',
        reason: 'gate-alarm-already-decided',
        stationName: '용마산',
        kind: 'transfer',
        phaseId: 'imminent',
      });
      await flushAlarmLog();
      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        source: 'fg',
        outcome: 'suppressed',
        reason: 'gate-alarm-already-decided',
        stationName: '용마산',
        kind: 'transfer',
        phaseId: 'imminent',
      });
    });

    it('#1572 logSuppressedSsotFireGate (Gate B station-already-passed): silent-push-skipped source', async () => {
      logSuppressedSsotFireGate({
        source: 'silent-push-skipped',
        reason: 'gate-station-already-passed',
        stationName: '용마산',
        kind: 'station-passed',
      });
      await flushAlarmLog();
      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        source: 'silent-push-skipped',
        outcome: 'suppressed',
        reason: 'gate-station-already-passed',
        stationName: '용마산',
        kind: 'station-passed',
      });
    });

    it('#1572 logSuppressedSsotFireGate: burst dedup 적용 (같은 reason+station 짧은 시간 중복은 drop)', async () => {
      logSuppressedSsotFireGate({
        source: 'fg',
        reason: 'gate-alarm-already-decided',
        stationName: '용마산',
        kind: 'transfer',
      });
      logSuppressedSsotFireGate({
        source: 'fg',
        reason: 'gate-alarm-already-decided',
        stationName: '용마산',
        kind: 'transfer',
      });
      await flushAlarmLog();
      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved).toHaveLength(1);
    });

    it('#1012 logHydrationTransition: 4 phase 각각 hydration-* reason + fg-hydrate source로 적재', async () => {
      logHydrationTransition('pre-hydrate', 'D1');
      logHydrationTransition('hydrating', 'D1');
      logHydrationTransition('storage-synced', 'D1');
      logHydrationTransition('ready', 'D1');
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved).toHaveLength(4);
      expect(saved.map((e) => e.reason)).toEqual([
        'hydration-pre-hydrate',
        'hydration-hydrating',
        'hydration-storage-synced',
        'hydration-ready',
      ]);
      for (const entry of saved) {
        expect(entry).toMatchObject({
          source: 'fg-hydrate',
          outcome: 'received',
          destinationId: 'D1',
        });
      }
    });

    it('#1012 logHydrationTransition: destinationId=null 허용', async () => {
      logHydrationTransition('pre-hydrate', null);
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0]).toMatchObject({
        source: 'fg-hydrate',
        outcome: 'received',
        reason: 'hydration-pre-hydrate',
        destinationId: null,
      });
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
      // #1024 — burst counter key는 (source, reason, kind, phaseId, stationName).
      // kind/phaseId가 다른 5개 호출은 각자 별개 key이므로 합산 없이 5건 적재.
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

    // #2339 — 지하 BG trip에서 같은 gate reason이 fix마다 반복 suppress되어도 burst dedup으로
    // 첫 1건만 적재하고 이후 반복은 append/breadcrumb/flush를 skip해야 한다 (배터리 절감).
    it('#2339 logSuppressedGate: burst dedup applies — same reason repeated within window dropped', async () => {
      _resetBurstSuppressWindowForTests();
      const location = { lat: 37.5, lng: 127.0, accuracy: 250, ageMs: 30_000 };
      logSuppressedGate('gate-accuracy', location);
      logSuppressedGate('gate-accuracy', location);
      logSuppressedGate('gate-accuracy', location);
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      const matching = saved.filter((e) => e.reason === 'gate-accuracy');
      expect(matching).toHaveLength(1);
    });

    it('#2339 logSuppressedGate: different reasons are NOT deduped against each other', async () => {
      _resetBurstSuppressWindowForTests();
      const location = { lat: 37.5, lng: 127.0, accuracy: 250, ageMs: 30_000 };
      logSuppressedGate('gate-accuracy', location);
      logSuppressedGate('gate-age', location);
      logSuppressedGate('gate-jump', location);
      logSuppressedGate('gate-motion-stationary', location);
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      const matching = saved.filter((e) =>
        ['gate-accuracy', 'gate-age', 'gate-jump', 'gate-motion-stationary'].includes(e.reason ?? ''),
      );
      expect(matching).toHaveLength(4);
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

    // #2231 — kind가 알려진 값과 매치되지 않을 때(계약 스큐) rawKind를 pushKindRaw로 보존.
    it('logSilentPushReceived: kind 매핑 실패 + rawKind 전달 시 pushKindRaw 적재 (#2231)', async () => {
      logSilentPushReceived({
        stationName: '강남',
        kind: undefined,
        phaseId: 'early',
        sentAt: undefined,
        receivedAt: 1_700_000_001_000,
        rawKind: 'future-kind',
      });
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0].kind).toBeUndefined();
      expect(saved[0].pushKindRaw).toBe('future-kind');
    });

    it('logSilentPushReceived: kind가 정상 매핑되면 rawKind가 전달돼도 pushKindRaw 미적재 (#2231)', async () => {
      logSilentPushReceived({
        stationName: '강남',
        kind: 'destination',
        phaseId: 'early',
        sentAt: undefined,
        receivedAt: 1_700_000_001_000,
        rawKind: 'destination',
      });
      await flushAlarmLog();

      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved: AlarmLogEntry[] = JSON.parse(savedJson);
      expect(saved[0].pushKindRaw).toBeUndefined();
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
      // #2231 — reschedule discriminator 보존 (unknown 버킷과 분리 집계용).
      expect(saved[0].pushKindRaw).toBe('reschedule');
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
        // #2231 — trip-ended discriminator 보존 (unknown 버킷과 분리 집계용).
        expect(saved[0].pushKindRaw).toBe('trip-ended');
      },
    );

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

  describe('countSilentPushKindBreakdown (#1683)', () => {
    it('빈 배열이면 모두 0', () => {
      expect(countSilentPushKindBreakdown([])).toEqual({
        'station-passed': 0,
        transfer: 0,
        destination: 0,
        reschedule: 0,
        tripEnded: 0,
        unknown: 0,
      });
    });

    it('silent-push-received 엔트리만 kind별 집계한다', () => {
      const entries: AlarmLogEntry[] = [
        makeEntry({ source: 'silent-push-received', kind: 'station-passed' }),
        makeEntry({ source: 'silent-push-received', kind: 'station-passed' }),
        makeEntry({ source: 'silent-push-received', kind: 'transfer' }),
        makeEntry({ source: 'silent-push-received', kind: 'destination' }),
        makeEntry({ source: 'silent-push-fired', kind: 'station-passed' }), // fired는 집계 X
      ];
      expect(countSilentPushKindBreakdown(entries)).toEqual({
        'station-passed': 2,
        transfer: 1,
        destination: 1,
        reschedule: 0,
        tripEnded: 0,
        unknown: 0,
      });
    });

    it('kind 미지정(구버전 backend)은 unknown 버킷', () => {
      const entries: AlarmLogEntry[] = [
        makeEntry({ source: 'silent-push-received', kind: undefined }), // kind 명시 없음
        makeEntry({ source: 'silent-push-received', kind: 'transfer' }),
      ];
      expect(countSilentPushKindBreakdown(entries)).toEqual({
        'station-passed': 0,
        transfer: 1,
        destination: 0,
        reschedule: 0,
        tripEnded: 0,
        unknown: 1,
      });
    });

    it('silent-push-received 이외 source(fired/skipped/fg 등)는 무시', () => {
      const entries: AlarmLogEntry[] = [
        makeEntry({ source: 'silent-push-fired', kind: 'station-passed' }),
        makeEntry({ source: 'silent-push-skipped', kind: 'transfer' }),
        makeEntry({ source: 'fg', kind: 'destination' }),
        makeEntry({ source: 'silent-push-received', kind: 'destination' }),
      ];
      expect(countSilentPushKindBreakdown(entries)).toEqual({
        'station-passed': 0,
        transfer: 0,
        destination: 1,
        reschedule: 0,
        tripEnded: 0,
        unknown: 0,
      });
    });

    // #2231 — reschedule/trip-ended는 알려진 non-station 제어 push discriminator. unknown과
    // 분리 집계해 unknown이 진짜 계약 스큐(device가 모르는 kind)만 남도록 한다.
    it('pushKindRaw=reschedule 엔트리는 reschedule 버킷으로 집계 (unknown 아님)', () => {
      const entries: AlarmLogEntry[] = [
        makeEntry({ source: 'silent-push-received', kind: undefined, pushKindRaw: 'reschedule' }),
        makeEntry({ source: 'silent-push-received', kind: undefined, pushKindRaw: 'reschedule' }),
        makeEntry({ source: 'silent-push-received', kind: 'transfer' }),
      ];
      expect(countSilentPushKindBreakdown(entries)).toEqual({
        'station-passed': 0,
        transfer: 1,
        destination: 0,
        reschedule: 2,
        tripEnded: 0,
        unknown: 0,
      });
    });

    it('pushKindRaw=trip-ended 엔트리는 tripEnded 버킷으로 집계 (unknown 아님)', () => {
      const entries: AlarmLogEntry[] = [
        makeEntry({ source: 'silent-push-received', kind: undefined, pushKindRaw: 'trip-ended' }),
      ];
      expect(countSilentPushKindBreakdown(entries)).toEqual({
        'station-passed': 0,
        transfer: 0,
        destination: 0,
        reschedule: 0,
        tripEnded: 1,
        unknown: 0,
      });
    });

    it('알 수 없는 pushKindRaw(계약 스큐)는 unknown 버킷으로 집계된다', () => {
      const entries: AlarmLogEntry[] = [
        makeEntry({ source: 'silent-push-received', kind: undefined, pushKindRaw: 'future-kind' }),
      ];
      expect(countSilentPushKindBreakdown(entries)).toEqual({
        'station-passed': 0,
        transfer: 0,
        destination: 0,
        reschedule: 0,
        tripEnded: 0,
        unknown: 1,
      });
    });
  });

  describe('computeSilentPushReach (#2231)', () => {
    it('엔트리가 없으면 0/0', () => {
      expect(computeSilentPushReach([])).toEqual({ visibleReceived: 0, totalReceived: 0 });
    });

    it('visibleReceived는 station-passed/transfer/destination 합, totalReceived는 전체 received', () => {
      const entries: AlarmLogEntry[] = [
        makeEntry({ source: 'silent-push-received', kind: 'station-passed' }),
        makeEntry({ source: 'silent-push-received', kind: 'transfer' }),
        makeEntry({ source: 'silent-push-received', kind: 'destination' }),
        makeEntry({ source: 'silent-push-received', kind: undefined, pushKindRaw: 'reschedule' }),
        makeEntry({ source: 'silent-push-received', kind: undefined, pushKindRaw: 'trip-ended' }),
        makeEntry({ source: 'silent-push-received', kind: undefined, pushKindRaw: 'future-kind' }),
      ];
      // visible station kind 3건 / 전체 수신 6건 — reschedule/trip-ended/unknown은 분모에만 포함.
      expect(computeSilentPushReach(entries)).toEqual({ visibleReceived: 3, totalReceived: 6 });
    });

    it('silent-push-fired source는 received 집계에 포함되지 않는다 (#2064 no-op 이후 죽은 지표 배제)', () => {
      const entries: AlarmLogEntry[] = [
        makeEntry({ source: 'silent-push-received', kind: 'transfer' }),
        makeEntry({ source: 'silent-push-fired', kind: 'transfer' }),
      ];
      expect(computeSilentPushReach(entries)).toEqual({ visibleReceived: 1, totalReceived: 1 });
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


  describe('summarizeAlarmLogByReason (#1019)', () => {
    it('suppressed reason별 카운트', () => {
      expect(summarizeAlarmLogByReason([
        makeEntry({ outcome: 'suppressed', reason: 'movement-static-speed' }),
        makeEntry({ outcome: 'suppressed', reason: 'movement-static-speed' }),
        makeEntry({ outcome: 'suppressed', reason: 'gate-phase-accuracy' }),
        makeEntry({ outcome: 'fired' }),
      ])).toEqual({ 'movement-static-speed': 2, 'gate-phase-accuracy': 1 });
    });
    it('fired/received는 제외', () => {
      expect(summarizeAlarmLogByReason([makeEntry({ outcome: 'fired' })])).toEqual({});
    });
    it('reason 없으면 (unknown)', () => {
      expect(summarizeAlarmLogByReason([makeEntry({ outcome: 'suppressed', reason: undefined })])['(unknown)']).toBe(1);
    });
    it('빈 배열', () => { expect(summarizeAlarmLogByReason([])).toEqual({}); });
  });
  describe('logSuppressedPhaseGate (#1019)', () => {
    it('gate-phase-accuracy: fg-evaluated/suppressed로 적재', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      logSuppressedPhaseGate('gate-phase-accuracy', '강남');
      await flushAlarmLog();
      const saved = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1]);
      expect(saved[0]).toMatchObject({ source: 'fg-evaluated', outcome: 'suppressed', reason: 'gate-phase-accuracy', stationName: '강남' });
    });
    it('gate-phase-warmup: fg-evaluated/suppressed로 적재', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      logSuppressedPhaseGate('gate-phase-warmup', '역삼');
      await flushAlarmLog();
      const saved = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1]);
      expect(saved[0]).toMatchObject({ source: 'fg-evaluated', outcome: 'suppressed', reason: 'gate-phase-warmup', stationName: '역삼' });
    });
    it('stationName undefined이면 (unknown)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      logSuppressedPhaseGate('gate-phase-accuracy', undefined);
      await flushAlarmLog();
      const saved = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1]);
      expect(saved[0].stationName).toBe('(unknown)');
    });
    it('DEDUP_LOG_WINDOW_MS 내 같은 reason+station은 drop', async () => {
      const baseTs = 1_700_000_000_000;
      const spy = jest.spyOn(Date, 'now').mockReturnValue(baseTs);
      try {
        (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
        logSuppressedPhaseGate('gate-phase-accuracy', '강남');
        await flushAlarmLog();
        const n = (AsyncStorage.setItem as jest.Mock).mock.calls.length;
        spy.mockReturnValue(baseTs + DEDUP_LOG_WINDOW_MS - 1);
        logSuppressedPhaseGate('gate-phase-accuracy', '강남');
        await flushAlarmLog();
        expect((AsyncStorage.setItem as jest.Mock).mock.calls.length).toBe(n);
        spy.mockReturnValue(baseTs + DEDUP_LOG_WINDOW_MS + 1);
        logSuppressedPhaseGate('gate-phase-accuracy', '강남');
        await flushAlarmLog();
        expect((AsyncStorage.setItem as jest.Mock).mock.calls.length).toBe(n + 1);
      } finally { spy.mockRestore(); }
    });
    it('다른 역은 별개 윈도우', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      logSuppressedPhaseGate('gate-phase-accuracy', '강남');
      logSuppressedPhaseGate('gate-phase-accuracy', '역삼');
      await flushAlarmLog();
      expect(JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1])).toHaveLength(2);
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

  describe('countGateReasons (#1025)', () => {
    it('빈 배열이면 빈 객체를 반환한다', () => {
      expect(countGateReasons([], ['gate-age', 'gate-accuracy'])).toEqual({});
    });

    it('지정한 reason에 해당하는 항목만 집계한다', () => {
      const logs: AlarmLogEntry[] = [
        { ts: 1, source: 'bg', outcome: 'suppressed', reason: 'gate-out-of-range' },
        { ts: 2, source: 'bg', outcome: 'suppressed', reason: 'gate-out-of-range' },
        { ts: 3, source: 'fg', outcome: 'suppressed', reason: 'movement-static-speed' },
        { ts: 4, source: 'fg', outcome: 'fired' },
        { ts: 5, source: 'bg', outcome: 'suppressed', reason: 'dedup-station' },
      ];
      expect(
        countGateReasons(logs, ['gate-out-of-range', 'movement-static-speed']),
      ).toEqual({ 'gate-out-of-range': 2, 'movement-static-speed': 1 });
    });

    it('reason이 없는 항목은 무시한다', () => {
      const logs: AlarmLogEntry[] = [
        { ts: 1, source: 'fg', outcome: 'fired' },
        { ts: 2, source: 'bg', outcome: 'fired' },
      ];
      expect(countGateReasons(logs, ['gate-age'])).toEqual({});
    });

    it('목록에 없는 reason은 집계하지 않는다', () => {
      const logs: AlarmLogEntry[] = [
        { ts: 1, source: 'bg', outcome: 'suppressed', reason: 'dedup-alarm' },
      ];
      expect(countGateReasons(logs, ['gate-age', 'gate-accuracy'])).toEqual({});
    });
  });

  describe('summarizeAlarmLogCounters (#1021)', () => {
    it('suppressed 엔트리의 reason별 count+lastTs를 합산해 내림차순으로 반환한다', () => {
      const entries: AlarmLogEntry[] = [
        makeEntry({ outcome: 'suppressed', reason: 'movement-static-speed', count: 2, ts: 100 }),
        makeEntry({ outcome: 'suppressed', reason: 'movement-static-speed', count: 3, ts: 200 }),
        makeEntry({ outcome: 'suppressed', reason: 'gate-age', count: 1, ts: 50 }),
        makeEntry({ outcome: 'fired' }),
      ];
      const result: AlarmLogReasonCounter[] = summarizeAlarmLogCounters(entries);
      expect(result[0]).toEqual({ reason: 'movement-static-speed', count: 5, lastTs: 200 });
      expect(result[1]).toEqual({ reason: 'gate-age', count: 1, lastTs: 50 });
    });

    it('suppressed가 없으면 빈 배열을 반환한다', () => {
      expect(summarizeAlarmLogCounters([makeEntry({ outcome: 'fired' })])).toEqual([]);
    });

    it('reason 없는 suppressed 엔트리는 (unknown)으로 집계한다', () => {
      const entry: AlarmLogEntry = { ts: 1, source: 'fg', outcome: 'suppressed' };
      const result = summarizeAlarmLogCounters([entry]);
      expect(result).toEqual([{ reason: '(unknown)', count: 1, lastTs: 1 }]);
    });

    it('count 필드가 없으면 1로 해석해 합산한다', () => {
      const entries: AlarmLogEntry[] = [
        makeEntry({ outcome: 'suppressed', reason: 'gate-age', ts: 10 }),
        makeEntry({ outcome: 'suppressed', reason: 'gate-age', ts: 20 }),
      ];
      const result = summarizeAlarmLogCounters(entries);
      expect(result).toEqual([{ reason: 'gate-age', count: 2, lastTs: 20 }]);
    });

    it('나중 entry의 ts가 더 작으면 lastTs를 갱신하지 않는다 — line 565 false branch', () => {
      // 첫 entry ts=200, 두 번째 ts=100 (역순) → existing.lastTs=200 유지.
      const entries: AlarmLogEntry[] = [
        makeEntry({ outcome: 'suppressed', reason: 'gate-age', ts: 200 }),
        makeEntry({ outcome: 'suppressed', reason: 'gate-age', ts: 100 }),
      ];
      const result = summarizeAlarmLogCounters(entries);
      expect(result).toEqual([{ reason: 'gate-age', count: 2, lastTs: 200 }]);
    });
  });

  describe('countAlarmLogReasonsByWindow (#1692)', () => {
    it('1h 윈도우 내 suppressed reason을 count 내림차순으로 반환한다', () => {
      const now = 1_700_000_000_000;
      const oneHourMs = 60 * 60 * 1000;
      const entries: AlarmLogEntry[] = [
        makeEntry({ outcome: 'suppressed', reason: 'movement-static-speed', ts: now - 1000 }),
        makeEntry({ outcome: 'suppressed', reason: 'movement-static-speed', ts: now - 2000 }),
        makeEntry({ outcome: 'suppressed', reason: 'gate-age', ts: now - 3000 }),
        makeEntry({ outcome: 'fired', ts: now - 100 }),
      ];
      const result = countAlarmLogReasonsByWindow(entries, oneHourMs, now);
      expect(result[0]).toEqual({ reason: 'movement-static-speed', count: 2, lastTs: now - 1000 });
      expect(result[1]).toEqual({ reason: 'gate-age', count: 1, lastTs: now - 3000 });
    });

    it('1h 윈도우 밖 항목은 제외한다', () => {
      const now = 1_700_000_000_000;
      const oneHourMs = 60 * 60 * 1000;
      const entries: AlarmLogEntry[] = [
        makeEntry({ outcome: 'suppressed', reason: 'gate-age', ts: now - oneHourMs - 1 }),
        makeEntry({ outcome: 'suppressed', reason: 'dedup-station', ts: now - 1000 }),
      ];
      const result = countAlarmLogReasonsByWindow(entries, oneHourMs, now);
      expect(result).toHaveLength(1);
      expect(result[0]?.reason).toBe('dedup-station');
    });

    it('suppressed가 없으면 빈 배열을 반환한다', () => {
      const now = 1_700_000_000_000;
      const entries: AlarmLogEntry[] = [
        makeEntry({ outcome: 'fired', ts: now - 1000 }),
      ];
      expect(countAlarmLogReasonsByWindow(entries, 60 * 60 * 1000, now)).toEqual([]);
    });

    it('topN 제한이 적용된다', () => {
      const now = 1_700_000_000_000;
      const entries: AlarmLogEntry[] = Array.from({ length: 15 }, (_, i) =>
        makeEntry({ outcome: 'suppressed', reason: 'gate-age', ts: now - (i + 1) * 1000, count: 15 - i }),
      );
      const result = countAlarmLogReasonsByWindow(entries, 60 * 60 * 1000, now, 3);
      expect(result.length).toBeLessThanOrEqual(3);
    });

    it('count 필드가 없으면 1로 해석한다', () => {
      const now = 1_700_000_000_000;
      const entries: AlarmLogEntry[] = [
        makeEntry({ outcome: 'suppressed', reason: 'gate-age', ts: now - 100 }),
        makeEntry({ outcome: 'suppressed', reason: 'gate-age', ts: now - 200 }),
      ];
      const result = countAlarmLogReasonsByWindow(entries, 60 * 60 * 1000, now);
      expect(result).toEqual([{ reason: 'gate-age', count: 2, lastTs: now - 100 }]);
    });

    it('나중 entry의 ts가 더 작으면 lastTs를 갱신하지 않는다', () => {
      const now = 1_700_000_000_000;
      const entries: AlarmLogEntry[] = [
        makeEntry({ outcome: 'suppressed', reason: 'gate-age', ts: now - 100 }),
        makeEntry({ outcome: 'suppressed', reason: 'gate-age', ts: now - 500 }),
      ];
      const result = countAlarmLogReasonsByWindow(entries, 60 * 60 * 1000, now);
      expect(result).toEqual([{ reason: 'gate-age', count: 2, lastTs: now - 100 }]);
    });

    it('나중 entry의 ts가 더 크면 lastTs를 갱신한다', () => {
      const now = 1_700_000_000_000;
      const entries: AlarmLogEntry[] = [
        makeEntry({ outcome: 'suppressed', reason: 'gate-age', ts: now - 500 }),
        makeEntry({ outcome: 'suppressed', reason: 'gate-age', ts: now - 100 }),
      ];
      const result = countAlarmLogReasonsByWindow(entries, 60 * 60 * 1000, now);
      expect(result).toEqual([{ reason: 'gate-age', count: 2, lastTs: now - 100 }]);
    });

    it('reason이 없으면 (unknown)으로 집계한다', () => {
      const now = 1_700_000_000_000;
      const entries: AlarmLogEntry[] = [
        makeEntry({ outcome: 'suppressed', reason: undefined, ts: now - 100 }),
        makeEntry({ outcome: 'suppressed', reason: undefined, ts: now - 200 }),
      ];
      const result = countAlarmLogReasonsByWindow(entries, 60 * 60 * 1000, now);
      expect(result).toEqual([{ reason: '(unknown)', count: 2, lastTs: now - 100 }]);
    });

    it('windowMs/now 기본값으로 호출해도 동작한다', () => {
      const entries: AlarmLogEntry[] = [
        makeEntry({ outcome: 'suppressed', reason: 'gate-age', ts: Date.now() - 1000 }),
      ];
      const result = countAlarmLogReasonsByWindow(entries);
      expect(result).toHaveLength(1);
      expect(result[0]?.reason).toBe('gate-age');
    });
  });

  describe('logBoardingPromptFired + countBoardingPromptByWindow (#1021)', () => {
    it('logBoardingPromptFired가 boarding-prompt entry를 적재한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      logBoardingPromptFired({ originStation: '강남', line: '2' });
      await flushAlarmLog();
      const saved = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1]);
      expect(saved).toHaveLength(1);
      expect(saved[0].source).toBe('boarding-prompt');
      expect(saved[0].outcome).toBe('fired');
      expect(saved[0].stationName).toBe('2·강남');
    });

    it('#2067 (Phase 2-device, D3): logCompanionAlarmFired가 companion entry를 적재한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      logCompanionAlarmFired({
        originStation: '성수',
        nextStation: '뚝섬',
        nextLine: '2',
      });
      await flushAlarmLog();
      const saved = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1]);
      expect(saved).toHaveLength(1);
      expect(saved[0].source).toBe('companion');
      expect(saved[0].outcome).toBe('fired');
      expect(saved[0].stationName).toBe('2·뚝섬');
    });

    it('#2284 (P1 wire matrix gap): logLastTrainAlarmFired가 last-train-alarm entry를 적재한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      logLastTrainAlarmFired({ stationName: '소요산' });
      await flushAlarmLog();
      const saved = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1]);
      expect(saved).toHaveLength(1);
      expect(saved[0].source).toBe('last-train-alarm');
      expect(saved[0].outcome).toBe('fired');
      expect(saved[0].stationName).toBe('소요산');
    });

    it('#2243 (ADR-029 Phase 1, G6): logPushContractKindSkew station-like → outcome=fired', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      logPushContractKindSkew({
        category: 'station-like',
        rawKind: 'imminent-hop',
        stationName: '성수',
      });
      await flushAlarmLog();
      const saved = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1]);
      expect(saved).toHaveLength(1);
      expect(saved[0].source).toBe('push-contract-skew');
      expect(saved[0].outcome).toBe('fired');
      expect(saved[0].reason).toBe('push-contract-skew-station-fallback-fired');
      expect(saved[0].pushKindRaw).toBe('imminent-hop');
      expect(saved[0].stationName).toBe('성수');
    });

    it('#2243 (ADR-029 Phase 1, G6): logPushContractKindSkew control-like → outcome=suppressed', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      logPushContractKindSkew({ category: 'control-like', rawKind: 'new-control-kind' });
      await flushAlarmLog();
      const saved = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1]);
      expect(saved).toHaveLength(1);
      expect(saved[0].source).toBe('push-contract-skew');
      expect(saved[0].outcome).toBe('suppressed');
      expect(saved[0].reason).toBe('push-contract-skew-control-fail-closed');
      expect(saved[0].pushKindRaw).toBe('new-control-kind');
    });

    it('#2243 (ADR-029 Phase 1, G2): logPushContractValueSkew이 value drift entry를 적재한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      logPushContractValueSkew({ field: 'etaSeconds', rawValue: -5, stationName: '강남' });
      await flushAlarmLog();
      const saved = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1]);
      expect(saved).toHaveLength(1);
      expect(saved[0].source).toBe('push-contract-skew');
      expect(saved[0].outcome).toBe('suppressed');
      expect(saved[0].reason).toBe('push-contract-skew-value-drift');
      expect(saved[0].pushKindRaw).toBe('etaSeconds=-5');
      expect(saved[0].stationName).toBe('강남');
    });

    it('#2253 (ADR-029 Phase 5, G1): logPushContractVersionSkew이 version skew entry를 적재한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      logPushContractVersionSkew({ deviceVersion: 1, backendVersion: 2, stationName: '강남' });
      await flushAlarmLog();
      const saved = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1]);
      expect(saved).toHaveLength(1);
      expect(saved[0].source).toBe('push-contract-skew');
      expect(saved[0].outcome).toBe('received');
      expect(saved[0].reason).toBe('push-contract-skew-version-old');
      expect(saved[0].pushKindRaw).toBe('device=1 backend=2');
      expect(saved[0].stationName).toBe('강남');
    });

    it('#2067 (Phase 2-device, D3): companion source는 silent push outcome 집계에서 제외 (null bucket)', () => {
      const now = 1_700_000_000_000;
      const entries: AlarmLogEntry[] = [
        { ts: now - 1000, source: 'companion', outcome: 'fired' },
        { ts: now - 2000, source: 'silent-push-fired', outcome: 'fired' },
      ];
      const counts = countSilentPushOutcomes(entries);
      // companion은 SILENT_PUSH_OUTCOME_SOURCES에서 null bucket — silent push 카운터에 미반영.
      expect(counts).toEqual({ received: 0, fired: 1, skipped: 0 });
    });

    it('#2067 (Phase 2-device, D3): companion은 fire 분모에 포함 (실제 사용자 노출 알람)', () => {
      const now = 1_700_000_000_000;
      const entries: AlarmLogEntry[] = [
        { ts: now - 1000, source: 'companion', outcome: 'fired' },
        { ts: now - 2000, source: 'boarding-prompt', outcome: 'fired' },
      ];
      // FIRED_ALARM_SOURCES: companion=true, boarding-prompt=false → 1건만 카운트.
      expect(countFiredAlarms(entries)).toBe(1);
    });

    it('#1887 (RC-14): logLegTransition가 leg-transition entry를 적재한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      logLegTransition({ fromLine: '2', transferStationName: '건대입구' });
      await flushAlarmLog();
      const saved = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1]);
      expect(saved).toHaveLength(1);
      expect(saved[0].source).toBe('leg-transition');
      expect(saved[0].outcome).toBe('fired');
      expect(saved[0].stationName).toBe('2·건대입구');
    });

    it('#1887 (RC-14): leg-transition source는 silent push outcome 집계에서 제외 (null bucket)', () => {
      const now = 1_700_000_000_000;
      const entries: AlarmLogEntry[] = [
        { ts: now - 1000, source: 'leg-transition', outcome: 'fired' },
        { ts: now - 2000, source: 'silent-push-fired', outcome: 'fired' },
      ];
      const counts = countSilentPushOutcomes(entries);
      // leg-transition은 SILENT_PUSH_OUTCOME_SOURCES에서 null bucket — silent push 카운터에 미반영.
      expect(counts).toEqual({ received: 0, fired: 1, skipped: 0 });
    });

    it('countBoardingPromptByWindow가 윈도우별 발사 횟수를 집계한다', () => {
      const now = 1_700_000_000_000;
      const entries: AlarmLogEntry[] = [
        { ts: now - 2 * 60 * 1000, source: 'boarding-prompt', outcome: 'fired' },
        { ts: now - 10 * 60 * 1000, source: 'boarding-prompt', outcome: 'fired' },
        { ts: now - 2 * 60 * 60 * 1000, source: 'boarding-prompt', outcome: 'fired' },
        { ts: now - 1000, source: 'fg', outcome: 'fired' },
      ];
      const counts = countBoardingPromptByWindow(entries, now);
      expect(counts['5m']).toBe(1);
      expect(counts['1h']).toBe(2);
      expect(counts['all']).toBe(3);
    });

    it('엔트리가 없으면 모든 윈도우가 0', () => {
      const counts = countBoardingPromptByWindow([], Date.now());
      for (const { key } of BOARDING_PROMPT_WINDOWS) {
        expect(counts[key as BoardingPromptWindowKey]).toBe(0);
      }
    });

    it('suppressed outcome은 집계하지 않는다', () => {
      const now = Date.now();
      const entries: AlarmLogEntry[] = [
        { ts: now - 1000, source: 'boarding-prompt', outcome: 'suppressed' },
      ];
      expect(countBoardingPromptByWindow(entries, now)['5m']).toBe(0);
    });

    it('now 인자 생략 시 Date.now() 기본값 사용 — line 733 default branch', () => {
      // 1초 전 fired entry → 기본 now 기준으로 '5m' window 안에 포함.
      const entries: AlarmLogEntry[] = [
        { ts: Date.now() - 1000, source: 'boarding-prompt', outcome: 'fired' },
      ];
      expect(countBoardingPromptByWindow(entries)['5m']).toBe(1);
    });

    it('reason 필드가 있는 boarding-prompt entry는 #1021 윈도우 집계에서 제외 (autolock/response와 분리)', () => {
      const now = Date.now();
      const entries: AlarmLogEntry[] = [
        // autolock-success는 outcome='fired'지만 reason 있음 → 발사 빈도엔 카운트 X.
        {
          ts: now - 1000,
          source: 'boarding-prompt',
          outcome: 'fired',
          reason: 'autolock-success',
        },
        // #1170 — response telemetry entry도 reason 있음 → 발사 빈도엔 제외.
        { ts: now - 1500, source: 'boarding-prompt', outcome: 'fired', reason: 'dedup-station' },
        // reason 없는 fired entry만 카운트.
        { ts: now - 2000, source: 'boarding-prompt', outcome: 'fired' },
      ];
      expect(countBoardingPromptByWindow(entries, now)['5m']).toBe(1);
    });
  });

  describe('logBoardingPromptAutoLock + countBoardingPromptAutoLockOutcomes (#1167)', () => {
    it.each([
      ['autolock-success', 'fired'],
      ['autolock-no-trip', 'suppressed'],
      ['autolock-arrivals-empty', 'suppressed'],
      ['autolock-ambiguity', 'suppressed'],
      ['autolock-station-lookup', 'suppressed'],
      ['autolock-lock-failed', 'suppressed'],
    ] as const)('reason=%s → outcome=%s + stationName 합성', async (reason, expectedOutcome) => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      logBoardingPromptAutoLock({ reason, originStation: '강남', line: '2' });
      await flushAlarmLog();
      const saved = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1]);
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({
        source: 'boarding-prompt',
        outcome: expectedOutcome,
        reason,
        stationName: '2·강남',
      });
    });

    it('countBoardingPromptAutoLockOutcomes가 reason별 분포 집계', () => {
      const entries: AlarmLogEntry[] = [
        { ts: 1, source: 'boarding-prompt', outcome: 'fired', reason: 'autolock-success' },
        { ts: 2, source: 'boarding-prompt', outcome: 'fired', reason: 'autolock-success' },
        { ts: 3, source: 'boarding-prompt', outcome: 'suppressed', reason: 'autolock-ambiguity' },
        { ts: 4, source: 'boarding-prompt', outcome: 'suppressed', reason: 'autolock-no-trip' },
        { ts: 5, source: 'boarding-prompt', outcome: 'suppressed', reason: 'autolock-arrivals-empty' },
        { ts: 6, source: 'boarding-prompt', outcome: 'suppressed', reason: 'autolock-station-lookup' },
        { ts: 7, source: 'boarding-prompt', outcome: 'suppressed', reason: 'autolock-lock-failed' },
        // reason 없는 #1021 발사 entry는 제외
        { ts: 8, source: 'boarding-prompt', outcome: 'fired' },
        // 다른 source는 제외
        { ts: 9, source: 'fg', outcome: 'fired' },
      ];
      const counts = countBoardingPromptAutoLockOutcomes(entries);
      expect(counts).toEqual({
        'autolock-success': 2,
        'autolock-no-trip': 1,
        'autolock-arrivals-empty': 1,
        'autolock-ambiguity': 1,
        'autolock-station-lookup': 1,
        'autolock-lock-failed': 1,
      });
    });

    it('boarding-prompt source인데 reason이 autolock 계열이 아니면 무시 (방어)', () => {
      const entries: AlarmLogEntry[] = [
        {
          ts: 1,
          source: 'boarding-prompt',
          outcome: 'suppressed',
          // 다른 도메인 reason — counts에 영향 없음
          reason: 'gate-age',
        },
      ];
      const counts = countBoardingPromptAutoLockOutcomes(entries);
      expect(counts['autolock-success']).toBe(0);
      expect(counts['autolock-no-trip']).toBe(0);
    });
  });

  describe('countAutoLockReasonsByWindow (#1687)', () => {
    it('windowMs 이후 엔트리만 집계한다', () => {
      const now = 10_000;
      const entries: AlarmLogEntry[] = [
        // 윈도우 안 (now - 5000 = 5000, ts=6000 > 5000)
        { ts: 6_000, source: 'boarding-prompt', outcome: 'fired', reason: 'autolock-success' },
        // 윈도우 경계 밖 (ts=5000 <= 5000)
        { ts: 5_000, source: 'boarding-prompt', outcome: 'fired', reason: 'autolock-success' },
        // 윈도우 밖 (ts=4000 < 5000)
        { ts: 4_000, source: 'boarding-prompt', outcome: 'suppressed', reason: 'autolock-ambiguity' },
      ];
      const counts = countAutoLockReasonsByWindow(entries, 5_000, now);
      expect(counts['autolock-success']).toBe(1);
      expect(counts['autolock-ambiguity']).toBe(0);
    });

    it('reason별 분포를 올바르게 집계한다', () => {
      const now = 100_000;
      const entries: AlarmLogEntry[] = [
        { ts: 99_000, source: 'boarding-prompt', outcome: 'fired', reason: 'autolock-success' },
        { ts: 99_001, source: 'boarding-prompt', outcome: 'suppressed', reason: 'autolock-ambiguity' },
        { ts: 99_002, source: 'boarding-prompt', outcome: 'suppressed', reason: 'autolock-arrivals-empty' },
        { ts: 99_003, source: 'boarding-prompt', outcome: 'suppressed', reason: 'autolock-no-trip' },
        { ts: 99_004, source: 'boarding-prompt', outcome: 'suppressed', reason: 'autolock-station-lookup' },
        { ts: 99_005, source: 'boarding-prompt', outcome: 'suppressed', reason: 'autolock-lock-failed' },
      ];
      const counts = countAutoLockReasonsByWindow(entries, 10_000, now);
      expect(counts).toEqual({
        'autolock-success': 1,
        'autolock-ambiguity': 1,
        'autolock-arrivals-empty': 1,
        'autolock-no-trip': 1,
        'autolock-station-lookup': 1,
        'autolock-lock-failed': 1,
      });
    });

    it('boarding-prompt 외 source는 무시한다', () => {
      const now = 10_000;
      const entries: AlarmLogEntry[] = [
        { ts: 9_000, source: 'fg', outcome: 'fired', reason: 'autolock-success' },
        { ts: 9_001, source: 'boarding-prompt', outcome: 'fired', reason: 'autolock-success' },
      ];
      const counts = countAutoLockReasonsByWindow(entries, 5_000, now);
      expect(counts['autolock-success']).toBe(1);
    });

    it('엔트리 없을 때 모든 카운터가 0', () => {
      const counts = countAutoLockReasonsByWindow([], 3_600_000);
      expect(counts['autolock-success']).toBe(0);
      expect(counts['autolock-ambiguity']).toBe(0);
      expect(counts['autolock-arrivals-empty']).toBe(0);
      expect(counts['autolock-no-trip']).toBe(0);
      expect(counts['autolock-station-lookup']).toBe(0);
      expect(counts['autolock-lock-failed']).toBe(0);
    });

    it('reason 없는 entry(발사 빈도 #1021)는 집계에서 제외한다', () => {
      const now = 10_000;
      const entries: AlarmLogEntry[] = [
        // reason 없는 발사 빈도 entry — autolock 집계 제외
        { ts: 9_000, source: 'boarding-prompt', outcome: 'fired' },
      ];
      const counts = countAutoLockReasonsByWindow(entries, 5_000, now);
      expect(counts['autolock-success']).toBe(0);
    });
  });

  describe('logBoardingPromptResponded (#1170)', () => {
    it.each<['boarded' | 'dismissed', 'response-boarded' | 'response-dismissed']>([
      ['boarded', 'response-boarded'],
      ['dismissed', 'response-dismissed'],
    ])('%s outcome → reason=%s entry 적재', async (outcome, reason) => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      logBoardingPromptResponded({ outcome });
      await flushAlarmLog();
      const saved = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1]);
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({
        source: 'boarding-prompt',
        outcome: 'received',
        reason,
      });
    });
  });

  describe('logScheduleSkipped (#1357 S1)', () => {
    beforeEach(() => {
      resetAlarmLogForTest();
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    });

    it('channel + destinationName을 stationName 슬롯에 인코딩해 적재', async () => {
      logScheduleSkipped({ channel: 'tba', reason: 'motion-stationary', destinationName: '강남' });
      await flushAlarmLog();
      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved = JSON.parse(savedJson);
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({
        source: 'bg-scheduled',
        outcome: 'suppressed',
        reason: 'schedule-skipped-motion-stationary',
        stationName: 'tba:강남',
      });
    });

    it('channel=bl + destinationName 미상이면 channel만 stationName으로 기록', async () => {
      logScheduleSkipped({ channel: 'bl', reason: 'motion-stationary' });
      await flushAlarmLog();
      const [, savedJson] = (AsyncStorage.setItem as jest.Mock).mock.calls[0];
      const saved = JSON.parse(savedJson);
      expect(saved[0].stationName).toBe('bl');
    });
  });

  // #1545 (S12) — TRIP_BOUND_CLEANUPS에 wiring될 production reset.
  describe('clearAlarmLogWindows (#1545 S12)', () => {
    it('3개 윈도우(refMismatch / dedupAlarm / burst)를 모두 비우고 graceful resolve한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);

      // 윈도우를 채운다 — 같은 key를 5_000ms 내에 두 번 호출하면 두 번째는 silence.
      logRefMismatch('dest-1', 'ref-1');
      logSuppressedDedupAlarm('fg-arvlcd', {
        phaseId: 'imminent',
        type: 'destination',
        stationName: '강남',
      });
      const baseline = (await getAlarmLog()).length;

      // 같은 키 즉시 재호출 — 윈도우 silence로 추가 entry 0건이어야 함 (sanity check).
      logRefMismatch('dest-1', 'ref-1');
      logSuppressedDedupAlarm('fg-arvlcd', {
        phaseId: 'imminent',
        type: 'destination',
        stationName: '강남',
      });
      const blocked = (await getAlarmLog()).length;
      expect(blocked).toBe(baseline);

      // production reset → 다음 동일 키 호출이 silence 풀려 다시 append.
      await expect(clearAlarmLogWindows()).resolves.toBeUndefined();
      logRefMismatch('dest-1', 'ref-1');
      logSuppressedDedupAlarm('fg-arvlcd', {
        phaseId: 'imminent',
        type: 'destination',
        stationName: '강남',
      });
      const afterClear = (await getAlarmLog()).length;
      expect(afterClear).toBeGreaterThan(baseline);
    });

    it('빈 상태에서도 graceful no-op resolve한다 (멱등)', async () => {
      await expect(clearAlarmLogWindows()).resolves.toBeUndefined();
      await expect(clearAlarmLogWindows()).resolves.toBeUndefined();
    });
  });

  describe('Sentry breadcrumb forward (#1578)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Sentry = require('@sentry/react-native');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { setSentryEnabled } = require('../../../../shared/infra/monitoring/sentryState');

    afterEach(() => {
      setSentryEnabled(false);
    });

    it('opt-in 미동의 시 breadcrumb 발사 X', () => {
      appendAlarmLog(makeEntry({ stationName: '강남' }));
      expect(Sentry.addBreadcrumb).not.toHaveBeenCalled();
    });

    it('opt-in 활성 시 alarmLog entry → breadcrumb forward (category=alarm)', () => {
      setSentryEnabled(true);
      appendAlarmLog(
        makeEntry({
          source: 'fg',
          outcome: 'fired',
          stationName: '용마산',
          kind: 'destination',
          phaseId: 'imminent',
        }),
      );
      expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'alarm',
          message: 'fg/fired',
          data: expect.objectContaining({
            kind: 'destination',
            phaseId: 'imminent',
            stationName: '용마산',
          }),
        }),
      );
    });

    it('gate-stale-location entry → X3 captureMessage', () => {
      setSentryEnabled(true);
      appendAlarmLog(
        makeEntry({
          source: 'bg',
          outcome: 'suppressed',
          reason: 'gate-stale-location',
          stationName: '용마산',
          locationAgeMs: 360_000,
        }),
      );
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'X3-stale-alarm',
        expect.objectContaining({ tags: { xEvent: 'X3-stale-alarm' } }),
      );
    });

    it('revalidate-waypoint-mismatch entry → X11 captureMessage', () => {
      setSentryEnabled(true);
      appendAlarmLog(
        makeEntry({
          source: 'bg-scheduled',
          outcome: 'suppressed',
          reason: 'revalidate-waypoint-mismatch',
          stationName: '용마산',
        }),
      );
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'X11-bg-scheduled-leak',
        expect.objectContaining({ tags: { xEvent: 'X11-bg-scheduled-leak' } }),
      );
    });

    it('일반 entry는 X event 발사 X', () => {
      setSentryEnabled(true);
      appendAlarmLog(makeEntry({ source: 'fg', outcome: 'fired' }));
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });
  });

  describe('countAlarmLogReasonsByWindow (#1682)', () => {
    const NOW = 1_700_000_000_000;
    // 테스트 내 shared factory — SonarCloud CPD 회피 (lesson_sonarcloud_dup_prevention).
    const sup = (
      reason: AlarmLogEntry['reason'],
      tsOffset = 1_000,
      extra?: Partial<AlarmLogEntry>,
    ): AlarmLogEntry =>
      makeEntry({ ts: NOW - tsOffset, outcome: 'suppressed', reason, ...extra });

    it('windowMs 이내 suppressed 엔트리만 집계하고 윈도우 밖은 제외한다', () => {
      const entries = [sup('dedup-station'), sup('dedup-station', 2_000), sup('dedup-station', 10_000)];
      const result = countAlarmLogReasonsByWindow(entries, 5_000, NOW);
      expect(result).toHaveLength(1);
      expect(result[0].reason).toBe('dedup-station');
      expect(result[0].count).toBe(2);
    });

    it.each<{ name: string; entries: AlarmLogEntry[]; expectLen: number; expectReason?: string }>([
      {
        name: 'suppressed 아닌 엔트리는 집계 제외',
        entries: [
          makeEntry({ ts: NOW - 1_000, outcome: 'fired', reason: 'dedup-station' }),
          makeEntry({ ts: NOW - 1_000, outcome: 'received', reason: 'dedup-station' }),
          sup('gate-accuracy'),
        ],
        expectLen: 1,
        expectReason: 'gate-accuracy',
      },
      {
        name: 'reason 미설정이면 (unknown)으로 집계',
        entries: [sup(undefined)],
        expectLen: 1,
        expectReason: '(unknown)',
      },
    ])('$name', ({ entries, expectLen, expectReason }) => {
      const result = countAlarmLogReasonsByWindow(entries, 5_000, NOW);
      expect(result).toHaveLength(expectLen);
      if (expectReason !== undefined) expect(result[0].reason).toBe(expectReason);
    });

    it('count 내림차순 정렬', () => {
      const entries = [sup('gate-accuracy'), sup('dedup-station'), sup('dedup-station'), sup('dedup-station')];
      const result = countAlarmLogReasonsByWindow(entries, 5_000, NOW);
      expect(result[0]).toMatchObject({ reason: 'dedup-station', count: 3 });
      expect(result[1]).toMatchObject({ reason: 'gate-accuracy', count: 1 });
    });

    it('count 필드가 있는 엔트리는 count를 합산한다', () => {
      const entries = [sup('dedup-alarm', 1_000, { count: 5 }), sup('dedup-alarm', 1_000, { count: 3 })];
      const result = countAlarmLogReasonsByWindow(entries, 5_000, NOW);
      expect(result[0].count).toBe(8);
    });

    it('lastTs는 windowMs 내 가장 최신 ts를 기록한다', () => {
      const entries = [sup('dedup-station', 3_000), sup('dedup-station', 1_000), sup('dedup-station', 2_000)];
      const result = countAlarmLogReasonsByWindow(entries, 5_000, NOW);
      expect(result[0].lastTs).toBe(NOW - 1_000);
    });

    it.each([
      { label: 'windowMs=0', windowMs: 0 },
      { label: 'windowMs=-100', windowMs: -100 },
    ])('$label이면 빈 배열 반환', ({ windowMs }) => {
      const entries = [sup('dedup-station')];
      expect(countAlarmLogReasonsByWindow(entries, windowMs, NOW)).toEqual([]);
    });

    it('빈 entries면 빈 배열 반환', () => {
      expect(countAlarmLogReasonsByWindow([], 3_600_000, NOW)).toEqual([]);
    });

    it('windowMs=Infinity면 전체 집계', () => {
      const entries = [sup('dedup-station', 999_999_999), sup('dedup-station')];
      expect(countAlarmLogReasonsByWindow(entries, Infinity, NOW)[0].count).toBe(2);
    });

    it('now 미지정 시 Date.now() 기준으로 집계 (default parameter 분기)', () => {
      const ts = Date.now() - 500;
      const entries: AlarmLogEntry[] = [makeEntry({ ts, outcome: 'suppressed', reason: 'dedup-station' })];
      const result = countAlarmLogReasonsByWindow(entries, 5_000);
      expect(result[0].reason).toBe('dedup-station');
    });
  });

  describe('lastNReasons (#1682)', () => {
    const NOW = 1_700_000_000_000;
    const sup = (reason: AlarmLogEntry['reason'], tsOffset = 1_000): AlarmLogEntry =>
      makeEntry({ ts: NOW - tsOffset, outcome: 'suppressed', reason });

    it('suppressed 엔트리 최근 N건을 시간 역순으로 반환한다', () => {
      const entries = [sup('gate-accuracy', 3_000), sup('dedup-station', 2_000), sup('dedup-alarm', 1_000)];
      const result = lastNReasons(entries, 2);
      expect(result).toHaveLength(2);
      expect(result[0].reason).toBe('dedup-alarm');
      expect(result[1].reason).toBe('dedup-station');
    });

    it.each<{ name: string; entries: AlarmLogEntry[]; expectLen: number; expectReason?: string }>([
      {
        name: 'fired/received 엔트리는 제외',
        entries: [
          makeEntry({ ts: NOW - 1_000, outcome: 'fired', reason: 'dedup-station' }),
          makeEntry({ ts: NOW - 1_000, outcome: 'received', reason: 'dedup-station' }),
          sup('gate-accuracy'),
        ],
        expectLen: 1,
        expectReason: 'gate-accuracy',
      },
      {
        name: 'reason 미설정 억제 엔트리는 제외',
        entries: [sup(undefined), sup('dedup-station')],
        expectLen: 1,
        expectReason: 'dedup-station',
      },
    ])('$name', ({ entries, expectLen, expectReason }) => {
      const result = lastNReasons(entries, 10);
      expect(result).toHaveLength(expectLen);
      if (expectReason !== undefined) expect(result[0].reason).toBe(expectReason);
    });

    it.each([
      { label: 'n=0', n: 0 },
      { label: 'n=-1', n: -1 },
    ])('$label이면 빈 배열 반환', ({ n }) => {
      expect(lastNReasons([sup('dedup-station')], n)).toEqual([]);
    });

    it('빈 entries면 빈 배열 반환', () => {
      expect(lastNReasons([], 5)).toEqual([]);
    });

    it('entries 수가 n보다 적으면 있는 것만 반환', () => {
      expect(lastNReasons([sup('dedup-station')], 10)).toHaveLength(1);
    });
  });

  describe('logFusionPickerTier + getFusionTierLog (#1693/#1706 별 ring buffer)', () => {
    it('logFusionPickerTier: 별 ring buffer에만 적재 — alarmLog ring에 안 들어감', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      logFusionPickerTier('gpsFallback');
      // alarmLog는 flush 시도해도 빈 채로 유지 — 별 채널 분리 검증.
      await flushAlarmLog();
      expect(AsyncStorage.setItem).not.toHaveBeenCalled();

      const ring = getFusionTierLog();
      expect(ring).toHaveLength(1);
      expect(ring[0]?.tier).toBe('gpsFallback');
      expect(typeof ring[0]?.ts).toBe('number');
    });

    it('logFusionPickerTier: 1s 윈도우 내 같은 tier 재호출은 drop (dedup)', () => {
      const baseTs = 1_700_000_000_000;
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(baseTs);
      try {
        logFusionPickerTier('backendSsotAccepts');
        logFusionPickerTier('backendSsotAccepts'); // 동일 tier, 1s 이내 → drop

        const ring = getFusionTierLog();
        expect(ring).toHaveLength(1);
        expect(ring[0]?.tier).toBe('backendSsotAccepts');
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('logFusionPickerTier: dedup 윈도우 reset 후 같은 tier 재호출은 새 entry 추가', () => {
      logFusionPickerTier('fused');
      // dedup window 리셋 (1s+ 경과 시뮬레이션)
      _resetFusionPickerTierWindowForTests();
      logFusionPickerTier('fused');

      const ring = getFusionTierLog();
      expect(ring).toHaveLength(1); // reset이 ring도 비웠으므로 1건만 (사양: reset = full reset)
      expect(ring[0]?.tier).toBe('fused');
    });

    it('logFusionPickerTier: 다른 tier는 각각 독립 dedup → 모두 ring에 적재', () => {
      logFusionPickerTier('positionTrainBoardingLockMatch');
      logFusionPickerTier('gpsDerivedFastPath');

      const ring = getFusionTierLog();
      expect(ring).toHaveLength(2);
      expect(ring[0]?.tier).toBe('positionTrainBoardingLockMatch');
      expect(ring[1]?.tier).toBe('gpsDerivedFastPath');
    });

    it(`logFusionPickerTier: ring buffer cap=${FUSION_TIER_LOG_BUFFER_SIZE} FIFO drop`, () => {
      // cap+5건을 unique tier 조합 + ts 진행으로 push.
      // dedup window를 매 호출마다 reset해 모두 적재.
      const baseTs = 2_000_000_000_000;
      const nowSpy = jest.spyOn(Date, 'now');
      try {
        for (let i = 0; i < FUSION_TIER_LOG_BUFFER_SIZE + 5; i++) {
          nowSpy.mockReturnValue(baseTs + i * 2_000);
          // dedup map reset 없이도 ts gap > 1s 이므로 dedup 통과
          // 단 첫 reset은 ring 비우니까 호출 X
          logFusionPickerTier('gpsFallback');
        }
        const ring = getFusionTierLog();
        expect(ring).toHaveLength(FUSION_TIER_LOG_BUFFER_SIZE);
        // 가장 오래된 entry(i=0~4)가 drop됐는지: 첫 entry ts는 baseTs+5*2000 이상.
        expect(ring[0]?.ts).toBeGreaterThanOrEqual(baseTs + 5 * 2_000);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('getFusionTierLog: 호출 시 snapshot copy 반환 (외부 변경 영향 없음)', () => {
      logFusionPickerTier('routeResult');
      const ring = getFusionTierLog() as FusionTierLogEntry[];
      ring.push({ ts: 0, tier: 'gpsFallback' });
      // 내부 ring은 외부 push에 영향 없음.
      expect(getFusionTierLog()).toHaveLength(1);
    });

    it('_resetFusionPickerTierWindowForTests: dedup window + ring 모두 reset', () => {
      logFusionPickerTier('positionTrain');
      expect(getFusionTierLog()).toHaveLength(1);
      _resetFusionPickerTierWindowForTests();
      expect(getFusionTierLog()).toHaveLength(0);
    });

    it('formatFusionPickerTierDistribution: 1h 내 entries만 집계', () => {
      const nowMs = 1_700_000_000_000;
      const ONE_HOUR_MS = 60 * 60 * 1_000;
      const entries: FusionTierLogEntry[] = [
        { ts: nowMs - 100, tier: 'gpsFallback' },
        { ts: nowMs - 200, tier: 'gpsFallback' },
        { ts: nowMs - ONE_HOUR_MS - 1, tier: 'gpsFallback' }, // 1h 초과 → 제외
        { ts: nowMs - 100, tier: 'backendSsotAccepts' },
      ];

      const result = formatFusionPickerTierDistribution(entries, nowMs);
      expect(result).toContain('tier-gpsFallback=2');
      expect(result).toContain('tier-backendSsotAccepts=1');
      expect(result).not.toContain('tier-gpsFallback=3'); // stale entry 포함 X
    });

    it('formatFusionPickerTierDistribution: entries 없으면 (none) 반환', () => {
      const result = formatFusionPickerTierDistribution([], Date.now());
      expect(result).toBe('(none)');
    });

    it('formatFusionPickerTierDistribution: count 내림차순 정렬', () => {
      const nowMs = 1_700_000_000_000;
      const entries: FusionTierLogEntry[] = [
        { ts: nowMs - 100, tier: 'fused' },
        { ts: nowMs - 200, tier: 'gpsFallback' },
        { ts: nowMs - 300, tier: 'gpsFallback' },
      ];

      const result = formatFusionPickerTierDistribution(entries, nowMs);
      const parts = result.split(', ');
      expect(parts[0]).toBe('tier-gpsFallback=2');
      expect(parts[1]).toBe('tier-fused=1');
    });

    it('formatFusionPickerTierDistribution: 1h 윈도우 밖 entries만 있으면 (none)', () => {
      const nowMs = 1_700_000_000_000;
      const ONE_HOUR_MS = 60 * 60 * 1_000;
      const entries: FusionTierLogEntry[] = [
        { ts: nowMs - ONE_HOUR_MS - 1, tier: 'gpsFallback' },
      ];
      expect(formatFusionPickerTierDistribution(entries, nowMs)).toBe('(none)');
    });
  });

  // ── #1769 logAccelPatternObserved ───────────────────────────────────────────

  describe('logAccelPatternObserved (#1769)', () => {
    it('첫 호출은 source=accel-pattern-observed / outcome=received / stationName=pattern으로 적재', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      logAccelPatternObserved('automotive');
      await flushAlarmLog();
      const stored = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1] as string) as AlarmLogEntry[];
      expect(stored).toHaveLength(1);
      expect(stored[0].source).toBe('accel-pattern-observed');
      expect(stored[0].outcome).toBe('received');
      expect(stored[0].stationName).toBe('automotive');
    });

    it('4 pattern 모두 지원 (automotive/walking/stationary/unknown)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
      for (const pattern of ['automotive', 'walking', 'stationary', 'unknown'] as const) {
        logAccelPatternObserved(pattern);
      }
      await flushAlarmLog();
      const stored = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1] as string) as AlarmLogEntry[];
      const names = stored.map((e) => e.stationName);
      expect(names).toContain('automotive');
      expect(names).toContain('walking');
      expect(names).toContain('stationary');
      expect(names).toContain('unknown');
    });

    it(`같은 pattern ${ACCEL_PATTERN_DEDUP_MS}ms 이내 반복 호출 → 1건만 적재`, async () => {
      jest.useFakeTimers();
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
      logAccelPatternObserved('automotive');
      logAccelPatternObserved('automotive');
      logAccelPatternObserved('automotive');
      jest.advanceTimersByTime(ACCEL_PATTERN_DEDUP_MS + 1);
      jest.useRealTimers();
      await flushAlarmLog();
      const stored = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1] as string) as AlarmLogEntry[];
      const automotiveEntries = stored.filter((e) => e.stationName === 'automotive');
      expect(automotiveEntries).toHaveLength(1);
    });

    it('다른 pattern으로 전환 시 즉시 새 엔트리 적재', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
      logAccelPatternObserved('automotive');
      logAccelPatternObserved('walking'); // 다른 pattern → dedup 윈도우 무관
      await flushAlarmLog();
      const stored = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1] as string) as AlarmLogEntry[];
      expect(stored).toHaveLength(2);
      expect(stored[0].stationName).toBe('automotive');
      expect(stored[1].stationName).toBe('walking');
    });

    it('_resetAccelPatternWindowForTests 후 같은 pattern 재적재 가능', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
      logAccelPatternObserved('automotive');
      _resetAccelPatternWindowForTests();
      logAccelPatternObserved('automotive');
      await flushAlarmLog();
      const stored = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1] as string) as AlarmLogEntry[];
      const automotiveEntries = stored.filter((e) => e.stationName === 'automotive');
      expect(automotiveEntries).toHaveLength(2);
    });
  });

  // ── #1503 logBoardableLookupResult ──────────────────────────────────────────

  describe('logBoardableLookupResult (#1503)', () => {
    beforeEach(() => {
      _resetBoardableLookupWindowForTests();
    });

    it('status="ok" → source=boardable-lookup / outcome=received / stationName 전달', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      logBoardableLookupResult({ status: 'ok', line: '3', stationName: '종로3가' });
      await flushAlarmLog();
      const stored = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1] as string) as AlarmLogEntry[];
      expect(stored).toHaveLength(1);
      expect(stored[0].source).toBe('boardable-lookup');
      expect(stored[0].outcome).toBe('received');
      expect(stored[0].stationName).toBe('종로3가');
    });

    it('status="miss" → outcome=suppressed', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      logBoardableLookupResult({ status: 'miss', line: '2', stationName: '사당' });
      await flushAlarmLog();
      const stored = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1] as string) as AlarmLogEntry[];
      expect(stored).toHaveLength(1);
      expect(stored[0].outcome).toBe('suppressed');
      expect(stored[0].stationName).toBe('사당');
    });

    it(`같은 (status,line,stationName) ${BOARDABLE_LOOKUP_DEDUP_MS}ms 이내 반복 → 1건만 적재`, async () => {
      jest.useFakeTimers();
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
      logBoardableLookupResult({ status: 'ok', line: '3', stationName: '종로3가' });
      logBoardableLookupResult({ status: 'ok', line: '3', stationName: '종로3가' });
      logBoardableLookupResult({ status: 'ok', line: '3', stationName: '종로3가' });
      jest.advanceTimersByTime(BOARDABLE_LOOKUP_DEDUP_MS + 1);
      jest.useRealTimers();
      await flushAlarmLog();
      const stored = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1] as string) as AlarmLogEntry[];
      const matches = stored.filter((e) => e.source === 'boardable-lookup' && e.stationName === '종로3가');
      expect(matches).toHaveLength(1);
    });

    it('다른 line 또는 stationName이면 즉시 새 엔트리 (dedup 안 됨)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
      logBoardableLookupResult({ status: 'ok', line: '3', stationName: '종로3가' });
      logBoardableLookupResult({ status: 'ok', line: '4', stationName: '충무로' });
      logBoardableLookupResult({ status: 'ok', line: '3', stationName: '왕십리' });
      await flushAlarmLog();
      const stored = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1] as string) as AlarmLogEntry[];
      const matches = stored.filter((e) => e.source === 'boardable-lookup');
      expect(matches).toHaveLength(3);
    });

    it('status 전환(ok→miss)은 즉시 새 엔트리 (dedup 안 됨)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
      logBoardableLookupResult({ status: 'ok', line: '3', stationName: '종로3가' });
      logBoardableLookupResult({ status: 'miss', line: '3', stationName: '종로3가' });
      await flushAlarmLog();
      const stored = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1] as string) as AlarmLogEntry[];
      const matches = stored.filter((e) => e.source === 'boardable-lookup');
      expect(matches).toHaveLength(2);
      expect(matches[0].outcome).toBe('received');
      expect(matches[1].outcome).toBe('suppressed');
    });

    it('_resetBoardableLookupWindowForTests 후 같은 key 재적재 가능', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
      logBoardableLookupResult({ status: 'ok', line: '3', stationName: '종로3가' });
      _resetBoardableLookupWindowForTests();
      logBoardableLookupResult({ status: 'ok', line: '3', stationName: '종로3가' });
      await flushAlarmLog();
      const stored = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1] as string) as AlarmLogEntry[];
      const matches = stored.filter((e) => e.source === 'boardable-lookup');
      expect(matches).toHaveLength(2);
    });
  });

  // ── #1957 logGroundTruthResult ──────────────────────────────────────────────

  describe('logGroundTruthResult (#1957)', () => {
    it('outcome="accurate" → source=ground-truth-response / outcome=fired / corrId in stationName', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      logGroundTruthResult({ corrId: 'trip-abc-1234', outcome: 'accurate' });
      await flushAlarmLog();
      const stored = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1] as string) as AlarmLogEntry[];
      expect(stored).toHaveLength(1);
      expect(stored[0].source).toBe('ground-truth-response');
      expect(stored[0].outcome).toBe('fired');
      expect(stored[0].stationName).toBe('trip-abc-1234');
    });

    it('outcome="inaccurate" → outcome=suppressed', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      logGroundTruthResult({ corrId: 'trip-def-5678', outcome: 'inaccurate' });
      await flushAlarmLog();
      const stored = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1] as string) as AlarmLogEntry[];
      expect(stored).toHaveLength(1);
      expect(stored[0].source).toBe('ground-truth-response');
      expect(stored[0].outcome).toBe('suppressed');
      expect(stored[0].stationName).toBe('trip-def-5678');
    });

    it('outcome="unanswered" → outcome=received', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      logGroundTruthResult({ corrId: 'trip-ghi-9012', outcome: 'unanswered' });
      await flushAlarmLog();
      const stored = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1] as string) as AlarmLogEntry[];
      expect(stored).toHaveLength(1);
      expect(stored[0].source).toBe('ground-truth-response');
      expect(stored[0].outcome).toBe('received');
      expect(stored[0].stationName).toBe('trip-ghi-9012');
    });

    it('연속 호출은 모두 적재 (dedup 없음)', async () => {
      // 같은 corrId 동일 outcome으로 두 번 호출해도 dedup 없이 둘 다 적재되는지 검증.
      // 실제 운영에서는 store.respond가 pendingPrompt를 null로 비워 두 번째 호출 차단하지만,
      // 본 함수 단위에서는 raw 호출 1:1을 보장한다.
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
      logGroundTruthResult({ corrId: 'trip-abc', outcome: 'accurate' });
      logGroundTruthResult({ corrId: 'trip-abc', outcome: 'accurate' });
      await flushAlarmLog();
      const stored = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1] as string) as AlarmLogEntry[];
      const matches = stored.filter((e) => e.source === 'ground-truth-response');
      expect(matches).toHaveLength(2);
    });
  });

  // ── #1972 logLocklessTripEnd ─────────────────────────────────────────────────

  describe('logLocklessTripEnd (#1972)', () => {
    it('fireCount >= 1 → outcome=fired (정상 동작)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      logLocklessTripEnd({ fireCount: 5, userIntentDeclared: true });
      await flushAlarmLog();
      const stored = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1] as string) as AlarmLogEntry[];
      expect(stored).toHaveLength(1);
      expect(stored[0].source).toBe('lockless-trip-end');
      expect(stored[0].outcome).toBe('fired');
      expect(stored[0].stationName).toBe('5:intent');
    });

    it('fireCount=0 + userIntentDeclared=true → outcome=suppressed (진짜 miss)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      logLocklessTripEnd({ fireCount: 0, userIntentDeclared: true });
      await flushAlarmLog();
      const stored = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1] as string) as AlarmLogEntry[];
      expect(stored).toHaveLength(1);
      expect(stored[0].source).toBe('lockless-trip-end');
      expect(stored[0].outcome).toBe('suppressed');
      expect(stored[0].stationName).toBe('0:intent');
    });

    it('fireCount=0 + userIntentDeclared=false → outcome=received (paradigm intent)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      logLocklessTripEnd({ fireCount: 0, userIntentDeclared: false });
      await flushAlarmLog();
      const stored = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1] as string) as AlarmLogEntry[];
      expect(stored).toHaveLength(1);
      expect(stored[0].source).toBe('lockless-trip-end');
      expect(stored[0].outcome).toBe('received');
      expect(stored[0].stationName).toBe('0:paradigm');
    });

    it('fireCount=10 + userIntentDeclared=false → outcome=fired (fire ≥ 1이면 분기 무관)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      logLocklessTripEnd({ fireCount: 10, userIntentDeclared: false });
      await flushAlarmLog();
      const stored = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1] as string) as AlarmLogEntry[];
      expect(stored).toHaveLength(1);
      expect(stored[0].outcome).toBe('fired');
      expect(stored[0].stationName).toBe('10:paradigm');
    });

    it('연속 호출은 모두 적재 (trip 1건당 1 stamp, dedup 없음)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
      logLocklessTripEnd({ fireCount: 0, userIntentDeclared: true });
      logLocklessTripEnd({ fireCount: 3, userIntentDeclared: true });
      await flushAlarmLog();
      const stored = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1] as string) as AlarmLogEntry[];
      const matches = stored.filter((e) => e.source === 'lockless-trip-end');
      expect(matches).toHaveLength(2);
    });
  });

  // ── #1972 countFiredAlarms ───────────────────────────────────────────────────

  describe('countFiredAlarms (#1972)', () => {
    it('빈 entries → 0', () => {
      expect(countFiredAlarms([])).toBe(0);
    });

    it('outcome=fired + FIRED_ALARM_SOURCES=true source만 카운트', () => {
      const entries: AlarmLogEntry[] = [
        { ts: 1, source: 'fg', outcome: 'fired' },
        { ts: 2, source: 'bg', outcome: 'fired' },
        { ts: 3, source: 'fg-arvlcd', outcome: 'fired' },
        { ts: 4, source: 'silent-push-fired', outcome: 'fired' },
        { ts: 5, source: 'alert-fallback-fired', outcome: 'fired' },
        { ts: 6, source: 'fg-evaluated', outcome: 'fired' },
        { ts: 7, source: 'bg-scheduled', outcome: 'fired' },
      ];
      expect(countFiredAlarms(entries)).toBe(7);
    });

    it('outcome=suppressed/received는 분모 제외', () => {
      const entries: AlarmLogEntry[] = [
        { ts: 1, source: 'fg', outcome: 'fired' },
        { ts: 2, source: 'fg', outcome: 'suppressed' },
        { ts: 3, source: 'fg', outcome: 'received' },
      ];
      expect(countFiredAlarms(entries)).toBe(1);
    });

    it('metadata source(boarding-prompt / accel-pattern-observed / boardable-lookup / ground-truth-response / lockless-trip-end 등)는 분모 제외', () => {
      const entries: AlarmLogEntry[] = [
        { ts: 1, source: 'boarding-prompt', outcome: 'fired' },
        { ts: 2, source: 'accel-pattern-observed', outcome: 'fired' },
        { ts: 3, source: 'boardable-lookup', outcome: 'fired' },
        { ts: 4, source: 'ground-truth-response', outcome: 'fired' },
        { ts: 5, source: 'lockless-trip-end', outcome: 'fired' },
        { ts: 6, source: 'leg-transition', outcome: 'fired' },
        { ts: 7, source: 'cross-trip-mirror-register', outcome: 'fired' },
        { ts: 8, source: 'cross-trip-mirror-mismatch', outcome: 'fired' },
        { ts: 9, source: 'cross-trip-mirror-launch', outcome: 'fired' },
        { ts: 10, source: 'lifecycle-backstop', outcome: 'fired' },
        { ts: 11, source: 'fusion-candidate-reject', outcome: 'fired' },
        { ts: 12, source: 'fg-hydrate', outcome: 'fired' },
        { ts: 13, source: 'fg-ref-mismatch', outcome: 'fired' },
        { ts: 14, source: 'silent-push-received', outcome: 'fired' },
        { ts: 15, source: 'silent-push-skipped', outcome: 'fired' },
        // 실제 fire 1건
        { ts: 16, source: 'fg', outcome: 'fired' },
      ];
      expect(countFiredAlarms(entries)).toBe(1);
    });
  });

  // ── #2284 fired-only 독립 영속 링버퍼 ──────────────────────────────────────
  describe('fired-only 독립 버퍼 (#2284)', () => {
    // AsyncStorage mock을 key별 in-memory Map으로 라우팅 — ALARM_LOG_KEY와
    // FIRED_ALARM_LOG_KEY가 서로 다른 storage slot임을 시뮬레이션한다.
    function makeKeyedStorage(): Map<string, string> {
      const store = new Map<string, string>();
      (AsyncStorage.getItem as jest.Mock).mockImplementation(
        async (key: string) => store.get(key) ?? null,
      );
      (AsyncStorage.setItem as jest.Mock).mockImplementation(
        async (key: string, value: string) => {
          store.set(key, value);
        },
      );
      (AsyncStorage.removeItem as jest.Mock).mockImplementation(async (key: string) => {
        store.delete(key);
      });
      return store;
    }

    it('outcome=fired + FIRED_ALARM_SOURCES=true 소스만 독립 버퍼에 적재된다', async () => {
      makeKeyedStorage();
      appendAlarmLog(
        makeEntry({ source: 'fg', outcome: 'fired', kind: 'destination', stationName: '강남' }),
      );
      await flushAlarmLog();

      const fired = await getFiredAlarmLog();
      expect(fired).toEqual<FiredAlarmLogEntry[]>([
        { ts: 1_700_000_000_000, kind: 'destination', station: '강남', line: '2', channel: 'fg' },
      ]);
    });

    it('outcome=suppressed/received 엔트리는 독립 버퍼에 적재되지 않는다', async () => {
      makeKeyedStorage();
      appendAlarmLog(makeEntry({ source: 'fg', outcome: 'suppressed', reason: 'gate-age' }));
      appendAlarmLog(makeEntry({ source: 'fg-hydrate', outcome: 'received' }));
      await flushAlarmLog();

      expect(await getFiredAlarmLog()).toEqual([]);
      // 독립 버퍼 key에는 write 자체가 발생하지 않는다 — fired 엔트리 0건이면 no-op.
      expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(
        FIRED_ALARM_LOG_KEY,
        expect.anything(),
      );
    });

    it('metadata source(FIRED_ALARM_SOURCES=false)는 outcome=fired여도 독립 버퍼 제외', async () => {
      makeKeyedStorage();
      appendAlarmLog(makeEntry({ source: 'boarding-prompt', outcome: 'fired' }));
      appendAlarmLog(makeEntry({ source: 'lifecycle-backstop', outcome: 'fired' }));
      await flushAlarmLog();

      expect(await getFiredAlarmLog()).toEqual([]);
    });

    it('kind 없는 엔트리는 line-agnostic 처리, station 미상은 unknown으로 채운다', async () => {
      makeKeyedStorage();
      appendAlarmLog({
        ts: 5,
        source: 'silent-push-fired',
        outcome: 'fired',
      });
      await flushAlarmLog();

      expect(await getFiredAlarmLog()).toEqual<FiredAlarmLogEntry[]>([
        { ts: 5, kind: 'unknown', station: 'unknown', line: null, channel: 'silent-push-fired' },
      ]);
    });

    it(
      '#2284 핵심 회귀 — alarmLog(200-cap, 혼합 outcome) rotate로 과거 fired 기록이 밀려나도 ' +
        '독립 버퍼는 보존한다 (2026-08-11 07:38:28 이전 fired 소실 evidence)',
      async () => {
        makeKeyedStorage();
        // 오래된 fired 발사 1건 + 이후 대량 suppressed burst(200-cap 초과) — 실제 회귀 재현.
        appendAlarmLog(
          makeEntry({
            ts: 1,
            source: 'fg',
            outcome: 'fired',
            kind: 'station-passed',
            stationName: '강남',
          }),
        );
        for (let i = 0; i < ALARM_LOG_BUFFER_SIZE + 10; i += 1) {
          appendAlarmLog(
            makeEntry({ ts: i + 100, outcome: 'suppressed', reason: 'gate-age', stationName: `s${i}` }),
          );
        }
        await flushAlarmLog();

        // alarmLog 200-cap rotate로 가장 오래된 fired 엔트리(ts=1)는 사라진다 — 기존 동작.
        const alarmLog = await getAlarmLog();
        expect(alarmLog).toHaveLength(ALARM_LOG_BUFFER_SIZE);
        expect(alarmLog.some((e) => e.ts === 1)).toBe(false);

        // 그러나 fired-only 독립 버퍼는 rotate와 무관하게 그 발사 기록을 보존한다.
        const fired = await getFiredAlarmLog();
        expect(fired).toHaveLength(1);
        expect(fired[0]).toMatchObject({ ts: 1, station: '강남', channel: 'fg' });
      },
    );

    it('FIRED_ALARM_LOG_BUFFER_SIZE 초과 시 가장 오래된 fired 엔트리부터 drop (FIFO)', async () => {
      const store = makeKeyedStorage();
      const existing: FiredAlarmLogEntry[] = Array.from(
        { length: FIRED_ALARM_LOG_BUFFER_SIZE },
        (_, i) => ({ ts: i, kind: 'unknown', station: `s${i}`, line: null, channel: 'fg' }),
      );
      store.set(FIRED_ALARM_LOG_KEY, JSON.stringify(existing));

      appendAlarmLog(makeEntry({ ts: 9999, source: 'fg', outcome: 'fired', stationName: '신규' }));
      await flushAlarmLog();

      const fired = await getFiredAlarmLog();
      expect(fired).toHaveLength(FIRED_ALARM_LOG_BUFFER_SIZE);
      expect(fired[0].ts).toBe(1); // ts=0인 가장 오래된 엔트리 drop
      expect(fired.at(-1)?.station).toBe('신규'); // 새로 추가된 엔트리가 마지막
    });

    it('콜드런치 — 모듈 스코프 pending 없이도 저장된 값을 그대로 복원한다', async () => {
      const store = makeKeyedStorage();
      const persisted: FiredAlarmLogEntry[] = [
        { ts: 1, kind: 'transfer', station: '강남', line: '2', channel: 'bg-scheduled' },
      ];
      store.set(FIRED_ALARM_LOG_KEY, JSON.stringify(persisted));

      // resetAlarmLogForTest() 이후 append 없이 바로 read — 콜드런치와 동일 조건.
      expect(await getFiredAlarmLog()).toEqual(persisted);
    });

    it('손상된 JSON이면 빈 배열을 반환한다', async () => {
      const store = makeKeyedStorage();
      store.set(FIRED_ALARM_LOG_KEY, 'not-json{{{');
      expect(await getFiredAlarmLog()).toEqual([]);
    });

    it('JSON.parse 결과가 배열이 아니면 빈 배열을 반환한다', async () => {
      const store = makeKeyedStorage();
      store.set(FIRED_ALARM_LOG_KEY, JSON.stringify({ foo: 'bar' }));
      expect(await getFiredAlarmLog()).toEqual([]);
    });

    it('AsyncStorage read 실패 시 빈 배열을 반환한다(throw 안 함)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('storage 오류'));
      await expect(getFiredAlarmLog()).resolves.toEqual([]);
    });

    it('alarmLog write 실패해도 fired-only 버퍼 적재는 별도로 시도된다', async () => {
      const store = makeKeyedStorage();
      (AsyncStorage.setItem as jest.Mock).mockImplementation(
        async (key: string, value: string) => {
          if (key === ALARM_LOG_KEY) throw new Error('alarmLog write 실패');
          store.set(key, value);
        },
      );
      appendAlarmLog(makeEntry({ source: 'fg', outcome: 'fired', stationName: '강남' }));
      await expect(flushAlarmLog()).resolves.toBeUndefined();

      expect(await getFiredAlarmLog()).toHaveLength(1);
    });

    it('fired-only 버퍼 write 실패해도 throw하지 않는다(alarmLog write는 정상 진행)', async () => {
      const store = makeKeyedStorage();
      (AsyncStorage.setItem as jest.Mock).mockImplementation(
        async (key: string, value: string) => {
          if (key === FIRED_ALARM_LOG_KEY) throw new Error('fired 버퍼 write 실패');
          store.set(key, value);
        },
      );
      appendAlarmLog(makeEntry({ source: 'fg', outcome: 'fired', stationName: '강남' }));
      await expect(flushAlarmLog()).resolves.toBeUndefined();

      // alarmLog(ALARM_LOG_KEY) write는 fired-only 버퍼 실패와 무관하게 정상 진행됐다.
      expect(store.has(ALARM_LOG_KEY)).toBe(true);
    });

    it('clearFiredAlarmLog — removeItem 호출', async () => {
      makeKeyedStorage();
      await clearFiredAlarmLog();
      expect(AsyncStorage.removeItem).toHaveBeenCalledWith(FIRED_ALARM_LOG_KEY);
    });

    it('clearFiredAlarmLog — AsyncStorage 실패해도 throw 안 함', async () => {
      (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('remove fail'));
      await expect(clearFiredAlarmLog()).resolves.toBeUndefined();
    });
  });
});

