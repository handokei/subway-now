import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  PUSH_RECEIPT_BUFFER_CAPACITY,
  PUSH_RECEIPT_WRITE_THROTTLE_MS,
  clearPushReceiptEntries,
  getPushReceiptEntries,
  hydratePushReceiptBuffer,
  pushPushReceiptEntry,
  subscribePushReceipt,
  __resetPushReceiptForTests__,
  type PushReceiptBufferEntry,
} from '../pushReceiptBuffer';
import { PUSH_RECEIPT_BUFFER_KEY } from '../../../../shared/constants/storageKeys';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

function makeEntry(overrides: Partial<PushReceiptBufferEntry> = {}): PushReceiptBufferEntry {
  return {
    ts: Date.now(),
    corrId: null,
    detail: {
      pushId: 'push-1',
      station: '용마산',
      kind: 'station-passed',
      pushType: 'background',
      displayed: true,
    },
    ...overrides,
  };
}

describe('pushReceiptBuffer (#2861 T1 — cycle/enter/exit과 cap 비공유)', () => {
  beforeEach(async () => {
    jest.useRealTimers();
    __resetPushReceiptForTests__();
    await AsyncStorage.clear();
    jest.clearAllMocks();
    (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    (AsyncStorage.removeItem as jest.Mock).mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('pushes and reads entries in order', () => {
    pushPushReceiptEntry(makeEntry({ ts: 1 }));
    pushPushReceiptEntry(makeEntry({ ts: 2 }));
    const entries = getPushReceiptEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].ts).toBe(1);
    expect(entries[1].ts).toBe(2);
  });

  it('caps at PUSH_RECEIPT_BUFFER_CAPACITY, dropping oldest', () => {
    for (let i = 0; i < PUSH_RECEIPT_BUFFER_CAPACITY + 3; i += 1) {
      pushPushReceiptEntry(makeEntry({ ts: i }));
    }
    const entries = getPushReceiptEntries();
    expect(entries).toHaveLength(PUSH_RECEIPT_BUFFER_CAPACITY);
    expect(entries[0].ts).toBe(3);
  });

  it('clears entries', () => {
    pushPushReceiptEntry(makeEntry());
    clearPushReceiptEntries();
    expect(getPushReceiptEntries()).toHaveLength(0);
  });

  it('notifies subscribers on push and unsubscribe stops notifications', () => {
    const listener = jest.fn();
    const unsub = subscribePushReceipt(listener);
    pushPushReceiptEntry(makeEntry());
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    pushPushReceiptEntry(makeEntry());
    expect(listener).toHaveBeenCalledTimes(1);
  });

  // #2861 (T1) — audit-sides 자가점검으로 발견: logPushReceipt는 BG headless JS 컨텍스트
  // (silentPushTask.ts)에서도 호출된다. BG 프로세스는 FG DebugModal과 별도 JS 인스턴스라
  // in-memory만으로는 BG가 적재한 receipt가 FG에 전혀 전달되지 않는다 — rawSignalBuffer가
  // 원래 갖고 있던 "BG→FG 영속 전달" 보장을 독립 버퍼 분리 과정에서 빠뜨리면 안 된다.
  describe('persistence (BG→FG delivery, rawSignalBuffer와 동일 패턴)', () => {
    it('push 후 throttle 경과 후 AsyncStorage.setItem 호출', () => {
      jest.useFakeTimers();
      pushPushReceiptEntry(makeEntry({ ts: 1 }));
      expect(AsyncStorage.setItem).not.toHaveBeenCalled();
      jest.advanceTimersByTime(PUSH_RECEIPT_WRITE_THROTTLE_MS);
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        PUSH_RECEIPT_BUFFER_KEY,
        expect.any(String),
      );
      jest.useRealTimers();
    });

    it('burst push도 write는 1회만 (마지막 push 기준 throttle)', () => {
      jest.useFakeTimers();
      pushPushReceiptEntry(makeEntry({ ts: 1 }));
      jest.advanceTimersByTime(PUSH_RECEIPT_WRITE_THROTTLE_MS / 2);
      pushPushReceiptEntry(makeEntry({ ts: 2 }));
      jest.advanceTimersByTime(PUSH_RECEIPT_WRITE_THROTTLE_MS);
      expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
      jest.useRealTimers();
    });

    it('clear가 buffer + AsyncStorage 모두 비움', () => {
      pushPushReceiptEntry(makeEntry());
      clearPushReceiptEntries();
      expect(AsyncStorage.removeItem).toHaveBeenCalledWith(PUSH_RECEIPT_BUFFER_KEY);
    });

    it('setItem reject는 graceful 흡수(throw 없음)', () => {
      jest.useFakeTimers();
      (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('fail'));
      expect(() => {
        pushPushReceiptEntry(makeEntry());
        jest.advanceTimersByTime(PUSH_RECEIPT_WRITE_THROTTLE_MS);
      }).not.toThrow();
      jest.useRealTimers();
    });

    it('키 부재 시 buffer 비어 있음', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
      await hydratePushReceiptBuffer();
      expect(getPushReceiptEntries()).toHaveLength(0);
    });

    it('유효 JSON은 buffer로 복원 (BG 프로세스가 적재한 entry를 FG가 읽는 시나리오)', async () => {
      const persisted: PushReceiptBufferEntry[] = [makeEntry({ ts: 42 })];
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(persisted));
      await hydratePushReceiptBuffer();
      expect(getPushReceiptEntries()).toEqual(persisted);
    });

    it('손상 JSON은 무시 (빈 buffer 유지)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('not-json{{{');
      await hydratePushReceiptBuffer();
      expect(getPushReceiptEntries()).toHaveLength(0);
    });

    it('비배열 JSON은 무시', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify({ a: 1 }));
      await hydratePushReceiptBuffer();
      expect(getPushReceiptEntries()).toHaveLength(0);
    });

    it('AsyncStorage.getItem reject는 graceful (빈 buffer)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('fail'));
      await hydratePushReceiptBuffer();
      expect(getPushReceiptEntries()).toHaveLength(0);
    });

    it('두 번째 호출은 멱등 (latch — buffer 재로드 안 함)', async () => {
      const persisted: PushReceiptBufferEntry[] = [makeEntry({ ts: 1 })];
      (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(JSON.stringify(persisted));
      await hydratePushReceiptBuffer();
      pushPushReceiptEntry(makeEntry({ ts: 2 }));
      await hydratePushReceiptBuffer();
      expect(getPushReceiptEntries()).toHaveLength(2);
    });
  });
});
