import { renderHook } from '@testing-library/react-native';

type DismissListener = (event: { dismissedAt: number; reason: string }) => void;

const mockAddActivityDismissedListener = jest.fn();
const mockMarkLaDismissed = jest.fn();
const mockWarn = jest.fn();

jest.mock('../../../../../modules/live-activity', () => ({
  addActivityDismissedListener: (...args: unknown[]) =>
    mockAddActivityDismissedListener(...args),
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
});
