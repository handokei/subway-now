import { renderHook, waitFor } from '@testing-library/react-native';
import type { Station } from '../../types/station';

const mockRegister = jest.fn();
const mockUnregister = jest.fn();

jest.mock('../../tasks/alarmRefreshTask', () => ({
  registerAlarmRefreshTask: (...args: unknown[]) => mockRegister(...args),
  unregisterAlarmRefreshTask: (...args: unknown[]) => mockUnregister(...args),
}));

jest.mock('../../utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { useAlarmRefreshTask } from '../useAlarmRefreshTask';

const destA: Station = {
  id: 'a',
  name: '강남',
  line: '2',
  lineColor: '#009246',
  lat: 0,
  lng: 0,
};

const destB: Station = {
  id: 'b',
  name: '시청',
  line: '1',
  lineColor: '#0052A4',
  lat: 0,
  lng: 0,
};

describe('useAlarmRefreshTask', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRegister.mockResolvedValue(undefined);
    mockUnregister.mockResolvedValue(undefined);
  });

  it('destination이 있으면 register를 호출한다', async () => {
    renderHook(() => useAlarmRefreshTask(destA));
    await waitFor(() => {
      expect(mockRegister).toHaveBeenCalledTimes(1);
    });
    expect(mockUnregister).not.toHaveBeenCalled();
  });

  it('destination이 null이면 unregister만 호출한다', async () => {
    renderHook(() => useAlarmRefreshTask(null));
    await waitFor(() => {
      expect(mockUnregister).toHaveBeenCalledTimes(1);
    });
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('언마운트 시 unregister를 호출한다', async () => {
    const { unmount } = renderHook(() => useAlarmRefreshTask(destA));
    await waitFor(() => expect(mockRegister).toHaveBeenCalled());
    unmount();
    await waitFor(() => expect(mockUnregister).toHaveBeenCalled());
  });

  it('destination이 바뀌면 unregister + register 가 다시 호출된다', async () => {
    const { rerender } = renderHook(({ d }: { d: Station | null }) => useAlarmRefreshTask(d), {
      initialProps: { d: destA },
    });
    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));

    rerender({ d: destB });
    await waitFor(() => {
      expect(mockUnregister).toHaveBeenCalledTimes(1);
      expect(mockRegister).toHaveBeenCalledTimes(2);
    });
  });

  it('register 실패는 throw하지 않고 로그만 남긴다', async () => {
    mockRegister.mockRejectedValueOnce(new Error('boom'));
    renderHook(() => useAlarmRefreshTask(destA));
    await waitFor(() => expect(mockRegister).toHaveBeenCalled());
  });

  it('unregister 실패는 throw하지 않고 로그만 남긴다 (null path)', async () => {
    mockUnregister.mockRejectedValueOnce(new Error('boom'));
    renderHook(() => useAlarmRefreshTask(null));
    await waitFor(() => expect(mockUnregister).toHaveBeenCalled());
  });

  it('unregister 실패는 throw하지 않고 로그만 남긴다 (cleanup path)', async () => {
    const { unmount } = renderHook(() => useAlarmRefreshTask(destA));
    await waitFor(() => expect(mockRegister).toHaveBeenCalled());
    mockUnregister.mockRejectedValueOnce(new Error('boom'));
    unmount();
    await waitFor(() => expect(mockUnregister).toHaveBeenCalled());
  });
});
