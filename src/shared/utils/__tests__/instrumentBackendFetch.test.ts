import AsyncStorage from '@react-native-async-storage/async-storage';
import { instrumentBackendFetch } from '../instrumentBackendFetch';
import {
  clearBackendCallEntries,
  getBackendCallEntries,
  __setCorrIdForTest,
} from '../backendCallBuffer';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    setItem: jest.fn().mockResolvedValue(undefined),
    getItem: jest.fn().mockResolvedValue(null),
    removeItem: jest.fn().mockResolvedValue(undefined),
  },
}));

describe('instrumentBackendFetch', () => {
  beforeEach(() => {
    clearBackendCallEntries();
    __setCorrIdForTest(null);
    (AsyncStorage.setItem as jest.Mock).mockClear();
  });

  it('성공 시 call + response entry를 push한다', async () => {
    const fakeRes = { ok: true, status: 200 } as Response;
    const fetchImpl = jest.fn().mockResolvedValue(fakeRes);
    const res = await instrumentBackendFetch(
      'https://api.example.com/trips',
      { method: 'POST' },
      fetchImpl as unknown as typeof fetch,
    );
    expect(res).toBe(fakeRes);
    const entries = getBackendCallEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].kind).toBe('call');
    expect(entries[0].method).toBe('POST');
    expect(entries[0].url).toBe('https://api.example.com/trips');
    expect(entries[1].kind).toBe('response');
    expect(entries[1].status).toBe(200);
    expect(entries[1].latencyMs).toBeGreaterThanOrEqual(0);
    expect(entries[0].callId).toBe(entries[1].callId);
  });

  it('throw 시 call + error entry를 push하고 re-throw한다', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('aborted'));
    await expect(
      instrumentBackendFetch(
        'https://x/y',
        { method: 'GET' },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow('aborted');
    const entries = getBackendCallEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].kind).toBe('call');
    expect(entries[1].kind).toBe('error');
    expect(entries[1].errorMessage).toBe('aborted');
    expect(entries[1].latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('non-Error throw 시 String()으로 message 박제', async () => {
    const fetchImpl = jest.fn().mockRejectedValue('plain-string');
    await expect(
      instrumentBackendFetch('https://x/y', {}, fetchImpl as unknown as typeof fetch),
    ).rejects.toBe('plain-string');
    const entries = getBackendCallEntries();
    expect(entries[1].kind).toBe('error');
    expect(entries[1].errorMessage).toBe('plain-string');
  });

  it('method 미지정 시 GET으로 기록', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 204 } as Response);
    await instrumentBackendFetch('https://x/y', {}, fetchImpl as unknown as typeof fetch);
    const entries = getBackendCallEntries();
    expect(entries[0].method).toBe('GET');
    expect(entries[1].method).toBe('GET');
  });

  it('현재 corrId가 entry에 박힌다', async () => {
    __setCorrIdForTest('t-abc');
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    await instrumentBackendFetch('https://x/y', {}, fetchImpl as unknown as typeof fetch);
    const entries = getBackendCallEntries();
    expect(entries[0].corrId).toBe('t-abc');
    expect(entries[1].corrId).toBe('t-abc');
  });

  it('기본 fetch 구현을 사용한다 (fetchImpl 미주입)', async () => {
    const originalFetch = global.fetch;
    const spy = jest.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    global.fetch = spy as unknown as typeof fetch;
    try {
      await instrumentBackendFetch('https://x/y', { method: 'PUT' });
      expect(spy).toHaveBeenCalledWith('https://x/y', { method: 'PUT' });
      const entries = getBackendCallEntries();
      expect(entries[0].method).toBe('PUT');
    } finally {
      global.fetch = originalFetch;
    }
  });
});
