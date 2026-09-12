import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  BACKEND_CALL_BUFFER_CAPACITY,
  clearBackendCallEntries,
  createCallId,
  getBackendCallEntries,
  getCurrentCorrId,
  hydrateBackendCallBuffer,
  pushBackendCallEntry,
  refreshCorrId,
  subscribeBackendCallEntries,
  __setCorrIdForTest,
  type BackendCallEntry,
} from '../backendCallBuffer';
import {
  BACKEND_CALL_LOG_KEY,
  TRIP_STARTED_AT_KEY,
} from '../../constants/storageKeys';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    setItem: jest.fn(),
    getItem: jest.fn(),
    removeItem: jest.fn(),
  },
}));

const mockSetItem = AsyncStorage.setItem as jest.Mock;
const mockGetItem = AsyncStorage.getItem as jest.Mock;
const mockRemoveItem = AsyncStorage.removeItem as jest.Mock;

const flush = () => new Promise<void>((r) => setImmediate(r));

function makeEntry(overrides: Partial<BackendCallEntry> = {}): BackendCallEntry {
  return {
    kind: 'call',
    ts: 1,
    callId: 'c1',
    corrId: null,
    url: 'https://x/y',
    method: 'POST',
    ...overrides,
  };
}

describe('backendCallBuffer', () => {
  beforeEach(() => {
    mockSetItem.mockReset().mockResolvedValue(undefined);
    mockGetItem.mockReset().mockResolvedValue(null);
    mockRemoveItem.mockReset().mockResolvedValue(undefined);
    clearBackendCallEntries();
    __setCorrIdForTest(null);
  });

  describe('push/get/clear', () => {
    it('push 후 get으로 최신 entry를 노출한다', () => {
      pushBackendCallEntry(makeEntry({ callId: 'a' }));
      expect(getBackendCallEntries()).toHaveLength(1);
      expect(getBackendCallEntries()[0].callId).toBe('a');
    });

    it('capacity를 초과하면 오래된 entry를 drop한다', () => {
      for (let i = 0; i < BACKEND_CALL_BUFFER_CAPACITY + 5; i += 1) {
        pushBackendCallEntry(makeEntry({ callId: `c${i}`, ts: i }));
      }
      const entries = getBackendCallEntries();
      expect(entries).toHaveLength(BACKEND_CALL_BUFFER_CAPACITY);
      expect(entries[0].callId).toBe('c5');
    });

    it('clear는 in-memory ring과 AsyncStorage를 모두 비운다', async () => {
      pushBackendCallEntry(makeEntry());
      clearBackendCallEntries();
      expect(getBackendCallEntries()).toHaveLength(0);
      await flush();
      expect(mockRemoveItem).toHaveBeenCalledWith(BACKEND_CALL_LOG_KEY);
    });

    it('clear의 AsyncStorage 실패는 graceful', async () => {
      mockRemoveItem.mockRejectedValueOnce(new Error('boom'));
      pushBackendCallEntry(makeEntry());
      clearBackendCallEntries();
      await flush();
      // throw 없이 통과 — in-memory는 이미 비워짐.
      expect(getBackendCallEntries()).toHaveLength(0);
    });
  });

  describe('persist', () => {
    it('push마다 AsyncStorage에 snapshot을 mirror한다', async () => {
      pushBackendCallEntry(makeEntry({ callId: 'p1' }));
      await flush();
      expect(mockSetItem).toHaveBeenCalledWith(
        BACKEND_CALL_LOG_KEY,
        expect.stringContaining('p1'),
      );
    });

    it('AsyncStorage 실패해도 throw하지 않는다', async () => {
      mockSetItem.mockRejectedValueOnce(new Error('boom'));
      expect(() => pushBackendCallEntry(makeEntry())).not.toThrow();
      await flush();
    });
  });

  describe('subscribe', () => {
    it('push 시 listener를 호출한다', () => {
      const cb = jest.fn();
      const unsub = subscribeBackendCallEntries(cb);
      pushBackendCallEntry(makeEntry());
      expect(cb).toHaveBeenCalledTimes(1);
      unsub();
      pushBackendCallEntry(makeEntry());
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  describe('refreshCorrId / getCurrentCorrId', () => {
    it('TRIP_STARTED_AT_KEY가 유효 숫자면 base36 식별자를 캐시한다', async () => {
      mockGetItem.mockResolvedValueOnce('1700000000000');
      await refreshCorrId();
      expect(mockGetItem).toHaveBeenCalledWith(TRIP_STARTED_AT_KEY);
      const corr = getCurrentCorrId();
      expect(corr).toMatch(/^t[0-9a-z]+$/);
    });

    it('TRIP_STARTED_AT_KEY 부재면 null', async () => {
      mockGetItem.mockResolvedValueOnce(null);
      __setCorrIdForTest('t-stale');
      await refreshCorrId();
      expect(getCurrentCorrId()).toBeNull();
    });

    it('잘못된 raw(NaN/0/음수)는 null', async () => {
      mockGetItem.mockResolvedValueOnce('not-a-number');
      await refreshCorrId();
      expect(getCurrentCorrId()).toBeNull();
      mockGetItem.mockResolvedValueOnce('0');
      await refreshCorrId();
      expect(getCurrentCorrId()).toBeNull();
      mockGetItem.mockResolvedValueOnce('-5');
      await refreshCorrId();
      expect(getCurrentCorrId()).toBeNull();
    });

    it('read 실패는 graceful — 캐시 유지', async () => {
      __setCorrIdForTest('t-prev');
      mockGetItem.mockRejectedValueOnce(new Error('boom'));
      await refreshCorrId();
      expect(getCurrentCorrId()).toBe('t-prev');
    });
  });

  describe('createCallId', () => {
    it('호출마다 다른 식별자를 반환한다', () => {
      const a = createCallId();
      const b = createCallId();
      expect(a).not.toBe(b);
      expect(a).toMatch(/^[0-9a-z]+$/);
    });
  });

  describe('hydrateBackendCallBuffer', () => {
    it('AsyncStorage에 저장된 직전 ring을 복원한다', async () => {
      const stored: BackendCallEntry[] = [
        makeEntry({ callId: 'h1', ts: 10 }),
        makeEntry({ callId: 'h2', ts: 20 }),
      ];
      mockGetItem.mockResolvedValueOnce(JSON.stringify(stored));
      await hydrateBackendCallBuffer();
      const entries = getBackendCallEntries();
      expect(entries.map((e) => e.callId)).toEqual(['h1', 'h2']);
    });

    it('키 부재 시 no-op', async () => {
      mockGetItem.mockResolvedValueOnce(null);
      await hydrateBackendCallBuffer();
      expect(getBackendCallEntries()).toHaveLength(0);
    });

    it('JSON 파싱 실패는 graceful', async () => {
      mockGetItem.mockResolvedValueOnce('{not-json');
      await hydrateBackendCallBuffer();
      expect(getBackendCallEntries()).toHaveLength(0);
    });

    it('Array가 아닌 값은 graceful skip', async () => {
      mockGetItem.mockResolvedValueOnce(JSON.stringify({ not: 'array' }));
      await hydrateBackendCallBuffer();
      expect(getBackendCallEntries()).toHaveLength(0);
    });

    it('형식이 깨진 entry는 개별로 skip', async () => {
      const stored = [
        makeEntry({ callId: 'ok' }),
        null,
        { invalid: true },
        { callId: 1, ts: 'x', url: 'u', method: 'M' },
        makeEntry({ callId: 'ok2', ts: 99 }),
      ];
      mockGetItem.mockResolvedValueOnce(JSON.stringify(stored));
      await hydrateBackendCallBuffer();
      const entries = getBackendCallEntries();
      expect(entries.map((e) => e.callId)).toEqual(['ok', 'ok2']);
    });

    it('read 실패는 graceful', async () => {
      mockGetItem.mockRejectedValueOnce(new Error('boom'));
      await hydrateBackendCallBuffer();
      expect(getBackendCallEntries()).toHaveLength(0);
    });
  });
});
