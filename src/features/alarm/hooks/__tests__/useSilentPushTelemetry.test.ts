import { renderHook, waitFor, act } from '@testing-library/react-native';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

const mockUpload = jest.fn();
jest.mock('../../../../api/telemetryBackend', () => ({
  uploadSilentPushTelemetry: (...args: unknown[]) => mockUpload(...args),
}));

const mockGetAlarmLog = jest.fn();
jest.mock('../../utils/alarmLog', () => ({
  getAlarmLog: (...args: unknown[]) => mockGetAlarmLog(...args),
}));

jest.mock('../../../../utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const appStateListeners: Array<(state: string) => void> = [];
jest.mock('react-native', () => ({
  AppState: {
    addEventListener: (_type: string, cb: (state: string) => void) => {
      appStateListeners.push(cb);
      return { remove: jest.fn() };
    },
  },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  useSilentPushTelemetry,
  flushSilentPushTelemetry,
  TELEMETRY_FLUSH_INTERVAL_MS,
} from '../useSilentPushTelemetry';
import { APNS_TOKEN_KEY, TELEMETRY_LAST_FLUSH_KEY } from '../../../../shared/constants/storageKeys';
import type { AlarmLogEntry } from '../../utils/alarmLog';

function silentPushReceivedEntry(ts: number): AlarmLogEntry {
  return { ts, source: 'silent-push-received', outcome: 'received' };
}

describe('flushSilentPushTelemetry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    appStateListeners.length = 0;
  });

  it('APNs 토큰 없으면 skip', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    await flushSilentPushTelemetry(1000);
    expect(mockGetAlarmLog).not.toHaveBeenCalled();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('카운터가 모두 0이면 upload 안 하고 since만 갱신', async () => {
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
      if (key === APNS_TOKEN_KEY) return 'token-abc';
      if (key === TELEMETRY_LAST_FLUSH_KEY) return '500';
      return null;
    });
    mockGetAlarmLog.mockResolvedValue([]);
    await flushSilentPushTelemetry(1000);
    expect(mockUpload).not.toHaveBeenCalled();
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(TELEMETRY_LAST_FLUSH_KEY, '1000');
  });

  it('upload 성공 시 since 갱신', async () => {
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
      if (key === APNS_TOKEN_KEY) return 'token-abc';
      if (key === TELEMETRY_LAST_FLUSH_KEY) return '500';
      return null;
    });
    mockGetAlarmLog.mockResolvedValue([silentPushReceivedEntry(600)]);
    mockUpload.mockResolvedValue({ ok: true });
    await flushSilentPushTelemetry(1000);
    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(mockUpload.mock.calls[0][0]).toBe('token-abc');
    const payload = mockUpload.mock.calls[0][1];
    expect(payload.since).toBe(500);
    expect(payload.until).toBe(1000);
    expect(payload.received).toBe(1);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(TELEMETRY_LAST_FLUSH_KEY, '1000');
  });

  it('upload 실패 시 since 유지', async () => {
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
      if (key === APNS_TOKEN_KEY) return 'token-abc';
      if (key === TELEMETRY_LAST_FLUSH_KEY) return '500';
      return null;
    });
    mockGetAlarmLog.mockResolvedValue([silentPushReceivedEntry(600)]);
    mockUpload.mockResolvedValue({ ok: false });
    await flushSilentPushTelemetry(1000);
    expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(TELEMETRY_LAST_FLUSH_KEY, '1000');
  });

  it('since 저장값이 손상되면 0으로 fallback', async () => {
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
      if (key === APNS_TOKEN_KEY) return 'token-abc';
      if (key === TELEMETRY_LAST_FLUSH_KEY) return 'not-a-number';
      return null;
    });
    mockGetAlarmLog.mockResolvedValue([silentPushReceivedEntry(100)]);
    mockUpload.mockResolvedValue({ ok: true });
    await flushSilentPushTelemetry(1000);
    expect(mockUpload).toHaveBeenCalled();
    const payload = mockUpload.mock.calls[0][1];
    expect(payload.since).toBe(0);
  });

  it('since 저장값이 음수면 0으로 fallback', async () => {
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
      if (key === APNS_TOKEN_KEY) return 'token-abc';
      if (key === TELEMETRY_LAST_FLUSH_KEY) return '-100';
      return null;
    });
    mockGetAlarmLog.mockResolvedValue([silentPushReceivedEntry(100)]);
    mockUpload.mockResolvedValue({ ok: true });
    await flushSilentPushTelemetry(1000);
    expect(mockUpload.mock.calls[0][1].since).toBe(0);
  });

  it('since 저장값 없으면 0', async () => {
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
      if (key === APNS_TOKEN_KEY) return 'token-abc';
      return null;
    });
    mockGetAlarmLog.mockResolvedValue([silentPushReceivedEntry(100)]);
    mockUpload.mockResolvedValue({ ok: true });
    await flushSilentPushTelemetry(1000);
    expect(mockUpload.mock.calls[0][1].since).toBe(0);
  });

  it('default now (Date.now) 사용', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    // token 없음 → skip path지만 default 인자 경로는 실행됨
    await expect(flushSilentPushTelemetry()).resolves.toBeUndefined();
  });

  it('in-flight guard: 동시 호출은 동일 promise로 직렬화', async () => {
    // getItem이 resolve되기 전 2번 호출 → 두 번째는 첫 번째와 같은 promise를 받아야 한다.
    let resolveToken!: (v: string | null) => void;
    (AsyncStorage.getItem as jest.Mock).mockImplementation(
      (key: string) =>
        new Promise<string | null>((resolve) => {
          if (key === APNS_TOKEN_KEY) {
            resolveToken = resolve;
          } else {
            resolve(null);
          }
        }),
    );
    const p1 = flushSilentPushTelemetry(1000);
    const p2 = flushSilentPushTelemetry(2000);
    expect(p1).toBe(p2);
    resolveToken(null);
    await p1;
    // 첫 번째 완료 후엔 새 promise가 생성되어야 함
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    const p3 = flushSilentPushTelemetry(3000);
    expect(p3).not.toBe(p1);
    await p3;
  });
});

describe('useSilentPushTelemetry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    appStateListeners.length = 0;
    jest.useFakeTimers();
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    mockGetAlarmLog.mockResolvedValue([]);
    mockUpload.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('마운트 시 1회 flush 실행', async () => {
    renderHook(() => useSilentPushTelemetry());
    // initial useEffect runs flush — token 없음 path만 검증
    await waitFor(() => {
      expect(AsyncStorage.getItem).toHaveBeenCalledWith(APNS_TOKEN_KEY);
    });
  });

  it('30분 경과 시 추가 flush', async () => {
    renderHook(() => useSilentPushTelemetry());
    await waitFor(() => expect(AsyncStorage.getItem).toHaveBeenCalled());
    const initialCalls = (AsyncStorage.getItem as jest.Mock).mock.calls.length;
    act(() => {
      jest.advanceTimersByTime(TELEMETRY_FLUSH_INTERVAL_MS);
    });
    await waitFor(() => {
      expect((AsyncStorage.getItem as jest.Mock).mock.calls.length).toBeGreaterThan(initialCalls);
    });
  });

  it('AppState active 진입 시 flush', async () => {
    renderHook(() => useSilentPushTelemetry());
    await waitFor(() => expect(appStateListeners.length).toBeGreaterThan(0));
    const beforeCount = (AsyncStorage.getItem as jest.Mock).mock.calls.length;
    act(() => {
      appStateListeners[0]('active');
    });
    await waitFor(() => {
      expect((AsyncStorage.getItem as jest.Mock).mock.calls.length).toBeGreaterThan(beforeCount);
    });
  });

  it('AppState background 전환은 flush 안 함', async () => {
    renderHook(() => useSilentPushTelemetry());
    await waitFor(() => expect(appStateListeners.length).toBeGreaterThan(0));
    const beforeCount = (AsyncStorage.getItem as jest.Mock).mock.calls.length;
    act(() => {
      appStateListeners[0]('background');
    });
    // 동기 micro-tick 후에도 호출 수 동일
    await Promise.resolve();
    expect((AsyncStorage.getItem as jest.Mock).mock.calls.length).toBe(beforeCount);
  });

  it('flush throw해도 unhandled 안 됨', async () => {
    mockGetAlarmLog.mockRejectedValue(new Error('boom'));
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
      if (key === APNS_TOKEN_KEY) return 'token-abc';
      return null;
    });
    expect(() => renderHook(() => useSilentPushTelemetry())).not.toThrow();
    await waitFor(() => expect(mockGetAlarmLog).toHaveBeenCalled());
  });
});
