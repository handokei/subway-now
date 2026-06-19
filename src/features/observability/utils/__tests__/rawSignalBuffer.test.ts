import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  pushRawSignal,
  getRawSignalEntries,
  clearRawSignalEntries,
  subscribeRawSignal,
  hydrateRawSignalBuffer,
  RAW_SIGNAL_BUFFER_CAPACITY,
  RAW_SIGNAL_WRITE_THROTTLE_MS,
  __resetRawSignalForTests__,
  type RawSignalEntry,
} from '../rawSignalBuffer';
import { RAW_SIGNAL_BUFFER_KEY } from '../../../../shared/constants/storageKeys';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

function entry(overrides?: Partial<RawSignalEntry>): RawSignalEntry {
  return {
    ts: 1_700_000_000_000,
    corrId: 'cid-1',
    kind: 'cycle',
    gps: { lat: 37.5, lng: 127.0, accM: 30, speedMps: 1.2 },
    motion: null,
    subsurface: false,
    arvlCd: null,
    line: '2',
    dir: null,
    arcIdx: null,
    arcProgress: null,
    stationId: '2-022',
    source: 'gps',
    confidence: 'gps-only',
    ...overrides,
  };
}

describe('rawSignalBuffer (#1501 PR-A)', () => {
  beforeEach(async () => {
    jest.useRealTimers();
    __resetRawSignalForTests__();
    await AsyncStorage.clear();
    jest.clearAllMocks();
    (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    (AsyncStorage.removeItem as jest.Mock).mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('push/get/clear', () => {
    it('push 후 getRawSignalEntries에 포함', () => {
      pushRawSignal(entry({ stationId: 'A' }));
      pushRawSignal(entry({ stationId: 'B' }));
      const entries = getRawSignalEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0].stationId).toBe('A');
      expect(entries[1].stationId).toBe('B');
    });

    it('clear가 buffer + AsyncStorage 모두 비움', () => {
      pushRawSignal(entry());
      expect(getRawSignalEntries()).toHaveLength(1);
      clearRawSignalEntries();
      expect(getRawSignalEntries()).toHaveLength(0);
      expect(AsyncStorage.removeItem).toHaveBeenCalledWith(RAW_SIGNAL_BUFFER_KEY);
    });

    it('push 없는 상태에서 clear도 graceful (writeTimer null branch)', () => {
      // push가 한 번도 일어나지 않아 writeTimer === null일 때 clear가 writeTimer 분기를 skip.
      expect(() => clearRawSignalEntries()).not.toThrow();
      expect(getRawSignalEntries()).toHaveLength(0);
      expect(AsyncStorage.removeItem).toHaveBeenCalledWith(RAW_SIGNAL_BUFFER_KEY);
    });

    it('clear의 removeItem reject는 graceful 흡수', async () => {
      (AsyncStorage.removeItem as jest.Mock).mockRejectedValueOnce(new Error('boom'));
      pushRawSignal(entry());
      expect(() => clearRawSignalEntries()).not.toThrow();
      // wait microtasks so internal catch runs
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  describe('capacity rotation', () => {
    it(`capacity ${RAW_SIGNAL_BUFFER_CAPACITY} 초과 시 오래된 항목부터 drop`, () => {
      for (let i = 0; i < RAW_SIGNAL_BUFFER_CAPACITY + 5; i += 1) {
        pushRawSignal(entry({ stationId: `S${i}` }));
      }
      const entries = getRawSignalEntries();
      expect(entries).toHaveLength(RAW_SIGNAL_BUFFER_CAPACITY);
      expect(entries[0].stationId).toBe('S5');
      expect(entries[entries.length - 1].stationId).toBe(`S${RAW_SIGNAL_BUFFER_CAPACITY + 4}`);
    });
  });

  describe('subscribe', () => {
    it('push 시 subscriber 호출, unsubscribe 후 호출 안 됨', () => {
      const cb = jest.fn();
      const unsub = subscribeRawSignal(cb);
      pushRawSignal(entry());
      expect(cb).toHaveBeenCalledTimes(1);
      unsub();
      pushRawSignal(entry());
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  describe('throttled write', () => {
    it(`push 후 ${RAW_SIGNAL_WRITE_THROTTLE_MS}ms 경과 후 write 1회`, () => {
      jest.useFakeTimers();
      pushRawSignal(entry({ stationId: 'A' }));
      expect(AsyncStorage.setItem).not.toHaveBeenCalled();
      jest.advanceTimersByTime(RAW_SIGNAL_WRITE_THROTTLE_MS);
      expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
      expect((AsyncStorage.setItem as jest.Mock).mock.calls[0][0]).toBe(RAW_SIGNAL_BUFFER_KEY);
    });

    it('burst push도 write는 1회만 (마지막 push 기준 throttle)', () => {
      jest.useFakeTimers();
      pushRawSignal(entry({ stationId: 'A' }));
      jest.advanceTimersByTime(500);
      pushRawSignal(entry({ stationId: 'B' }));
      jest.advanceTimersByTime(500);
      // 첫 push에서 1s 지났지만 두 번째 push가 timer reset → 아직 write 없음
      expect(AsyncStorage.setItem).not.toHaveBeenCalled();
      jest.advanceTimersByTime(500);
      expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
      // 마지막 write에 두 entry가 모두 직렬화됐는지 확인
      const written = JSON.parse((AsyncStorage.setItem as jest.Mock).mock.calls[0][1] as string);
      expect(written).toHaveLength(2);
    });

    it('setItem reject는 graceful 흡수', async () => {
      jest.useFakeTimers();
      (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('boom'));
      pushRawSignal(entry());
      jest.advanceTimersByTime(RAW_SIGNAL_WRITE_THROTTLE_MS);
      // microtask flush
      jest.useRealTimers();
      await Promise.resolve();
      await Promise.resolve();
      // 다음 push + advance에서 throw 없이 다시 시도 가능
      pushRawSignal(entry());
    });
  });

  describe('hydrate', () => {
    it('키 부재 시 buffer 비어 있음', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      await hydrateRawSignalBuffer();
      expect(getRawSignalEntries()).toHaveLength(0);
    });

    it('유효 JSON은 buffer로 복원', async () => {
      const stored = [entry({ stationId: 'X' }), entry({ stationId: 'Y' })];
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(stored));
      await hydrateRawSignalBuffer();
      const entries = getRawSignalEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0].stationId).toBe('X');
      expect(entries[1].stationId).toBe('Y');
    });

    it('손상 JSON은 무시 (빈 buffer 유지)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('not json {{{');
      await hydrateRawSignalBuffer();
      expect(getRawSignalEntries()).toHaveLength(0);
    });

    it('비배열 JSON은 무시', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify({ foo: 'bar' }));
      await hydrateRawSignalBuffer();
      expect(getRawSignalEntries()).toHaveLength(0);
    });

    it('배열 안에 null/primitive 섞이면 그 항목만 skip', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
        JSON.stringify([entry({ stationId: 'K' }), null, 'oops', entry({ stationId: 'L' })]),
      );
      await hydrateRawSignalBuffer();
      const entries = getRawSignalEntries();
      expect(entries.map((e) => e.stationId)).toEqual(['K', 'L']);
    });

    it('AsyncStorage.getItem reject는 graceful (빈 buffer)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('boom'));
      await hydrateRawSignalBuffer();
      expect(getRawSignalEntries()).toHaveLength(0);
    });

    it('두 번째 호출은 멱등 (latch — buffer 재로드 안 함)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(
        JSON.stringify([entry({ stationId: 'X' })]),
      );
      await hydrateRawSignalBuffer();
      expect(getRawSignalEntries()).toHaveLength(1);
      // 두 번째 호출은 getItem을 추가로 부르지 않음
      await hydrateRawSignalBuffer();
      expect(AsyncStorage.getItem).toHaveBeenCalledTimes(1);
    });
  });

  describe('enter/exit kind', () => {
    it('kind=enter / exit 모두 push 가능', () => {
      pushRawSignal(entry({ kind: 'enter', stationId: 'NEW' }));
      pushRawSignal(entry({ kind: 'exit', stationId: 'OLD' }));
      const entries = getRawSignalEntries();
      expect(entries[0].kind).toBe('enter');
      expect(entries[1].kind).toBe('exit');
    });
  });

  describe('reset helper', () => {
    it('__resetRawSignalForTests__는 in-memory + hydration latch + timer 초기화', () => {
      jest.useFakeTimers();
      pushRawSignal(entry());
      expect(getRawSignalEntries()).toHaveLength(1);
      __resetRawSignalForTests__();
      expect(getRawSignalEntries()).toHaveLength(0);
      // pending timer 없는지 advance로 확인
      jest.advanceTimersByTime(RAW_SIGNAL_WRITE_THROTTLE_MS * 2);
      expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    });
  });
});
