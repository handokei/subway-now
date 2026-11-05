import { renderHook } from '@testing-library/react-native';

type DismissListener = (event: { dismissedAt: number; reason: string }) => void;

const mockAddActivityDismissedListener = jest.fn();
const mockMarkLaDismissed = jest.fn();
const mockWarn = jest.fn();
const mockLogLifecycle = jest.fn();

jest.mock('../../../../../modules/live-activity', () => ({
  addActivityDismissedListener: (...args: unknown[]) =>
    mockAddActivityDismissedListener(...args),
}));

jest.mock('../../utils/alarmLog', () => ({
  logLiveActivityLifecycle: (...args: unknown[]) => mockLogLifecycle(...args),
}));

jest.mock('../../utils/laDismissSentinel', () => ({
  markLaDismissed: (...args: unknown[]) => mockMarkLaDismissed(...args),
}));

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: (...args: unknown[]) => mockWarn(...args),
    error: jest.fn(),
  }),
}));

import { useLiveActivityDismissBridge } from '../useLiveActivityDismissBridge';

describe('useLiveActivityDismissBridge', () => {
  let listenerRemove: jest.Mock;
  let capturedListener: DismissListener | null;

  beforeEach(() => {
    jest.clearAllMocks();
    listenerRemove = jest.fn();
    capturedListener = null;
    mockAddActivityDismissedListener.mockImplementation((cb: DismissListener) => {
      capturedListener = cb;
      return { remove: listenerRemove };
    });
    mockMarkLaDismissed.mockResolvedValue(undefined);
  });

  it('마운트 시 addActivityDismissedListener 구독', () => {
    renderHook(() => useLiveActivityDismissBridge());
    expect(mockAddActivityDismissedListener).toHaveBeenCalledTimes(1);
  });

  it("reason='user' 이벤트 → markLaDismissed(dismissedAt) 호출", () => {
    renderHook(() => useLiveActivityDismissBridge());
    expect(capturedListener).not.toBeNull();
    capturedListener!({ dismissedAt: 1234567890, reason: 'user' });
    expect(mockMarkLaDismissed).toHaveBeenCalledWith(1234567890);
  });

  it("reason이 'user'가 아니면 markLaDismissed 호출 안 함", () => {
    renderHook(() => useLiveActivityDismissBridge());
    capturedListener!({ dismissedAt: 1, reason: 'system' });
    expect(mockMarkLaDismissed).not.toHaveBeenCalled();
  });

  it('unmount 시 subscription.remove 호출', () => {
    const { unmount } = renderHook(() => useLiveActivityDismissBridge());
    unmount();
    expect(listenerRemove).toHaveBeenCalledTimes(1);
  });

  it('markLaDismissed가 throw하면 logger.warn으로 흡수', async () => {
    mockMarkLaDismissed.mockRejectedValueOnce(new Error('storage down'));
    renderHook(() => useLiveActivityDismissBridge());
    capturedListener!({ dismissedAt: 1, reason: 'user' });
    // microtask flush
    await Promise.resolve();
    await Promise.resolve();
    expect(mockWarn).toHaveBeenCalledWith('markLaDismissed threw', expect.any(Error));
  });

  // #3107 — sentinel을 쓴 사실 자체를 덤프로 남긴다(누가 썼는지 판별은 직전 la-end-observed와 대조).
  it('sentinel 쓰기 성공 후 la-sentinel-written을 dismissedAt과 함께 적재', async () => {
    renderHook(() => useLiveActivityDismissBridge());
    capturedListener!({ dismissedAt: 1792000000000, reason: 'user' });
    await Promise.resolve();
    await Promise.resolve();
    expect(mockLogLifecycle).toHaveBeenCalledWith('la-sentinel-written', 'at=1792000000000');
  });

  it("[거부] reason이 'user'가 아니면 sentinel을 안 쓰므로 적재도 안 한다", async () => {
    renderHook(() => useLiveActivityDismissBridge());
    capturedListener!({ dismissedAt: 1, reason: 'system' });
    await Promise.resolve();
    expect(mockLogLifecycle).not.toHaveBeenCalled();
  });

  it('[거부] markLaDismissed가 throw하면 쓰지 못했으므로 la-sentinel-written을 적재하지 않는다', async () => {
    mockMarkLaDismissed.mockRejectedValueOnce(new Error('storage down'));
    renderHook(() => useLiveActivityDismissBridge());
    capturedListener!({ dismissedAt: 1, reason: 'user' });
    await Promise.resolve();
    await Promise.resolve();
    expect(mockLogLifecycle).not.toHaveBeenCalled();
  });
});
