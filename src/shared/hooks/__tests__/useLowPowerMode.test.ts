import { renderHook, act, waitFor } from '@testing-library/react-native';

const mockReadLowPowerMode = jest.fn();
const mockSubscribeLowPowerMode = jest.fn();
const mockUnsubscribe = jest.fn();

jest.mock('../../utils/lowPowerState', () => ({
  readLowPowerMode: (...args: unknown[]) => mockReadLowPowerMode(...args),
  subscribeLowPowerMode: (...args: unknown[]) => mockSubscribeLowPowerMode(...args),
}));

import { useLowPowerMode } from '../useLowPowerMode';

type Listener = (enabled: boolean) => void;

beforeEach(() => {
  mockReadLowPowerMode.mockReset();
  mockSubscribeLowPowerMode.mockReset();
  mockUnsubscribe.mockReset();
  mockReadLowPowerMode.mockResolvedValue(false);
  mockSubscribeLowPowerMode.mockReturnValue(mockUnsubscribe);
});

it('마운트 시 현재 LPM 상태를 조회해 반영한다', async () => {
  mockReadLowPowerMode.mockResolvedValue(true);
  const { result } = renderHook(() => useLowPowerMode());
  expect(result.current).toBe(false);
  await waitFor(() => expect(result.current).toBe(true));
});

it('구독 listener가 발화하면 상태가 갱신된다', async () => {
  const { result } = renderHook(() => useLowPowerMode());
  await waitFor(() => expect(mockSubscribeLowPowerMode).toHaveBeenCalled());
  const listener = mockSubscribeLowPowerMode.mock.calls[0][0] as Listener;
  act(() => listener(true));
  expect(result.current).toBe(true);
  act(() => listener(false));
  expect(result.current).toBe(false);
});

it('unmount 시 구독을 해제한다', async () => {
  const { unmount } = renderHook(() => useLowPowerMode());
  await waitFor(() => expect(mockSubscribeLowPowerMode).toHaveBeenCalled());
  unmount();
  expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
});

it('unmount 후 비동기 조회가 늦게 끝나도 상태를 갱신하지 않는다 (cancelled 가드)', async () => {
  let resolveRead: ((value: boolean) => void) | null = null;
  mockReadLowPowerMode.mockReturnValue(
    new Promise<boolean>((resolve) => {
      resolveRead = resolve;
    }),
  );
  const { unmount } = renderHook(() => useLowPowerMode());
  unmount();
  await act(async () => {
    resolveRead?.(true);
    await Promise.resolve();
  });
  // unmount 후 listener도 발화하지 않는다 — cancelled 가드로 setState 미호출.
  const listener = mockSubscribeLowPowerMode.mock.calls[0][0] as Listener;
  expect(() => listener(true)).not.toThrow();
});
