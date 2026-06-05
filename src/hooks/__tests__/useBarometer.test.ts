import { renderHook, act } from '@testing-library/react-native';

const mockIsAvailable = jest.fn();
const mockRequestPermissions = jest.fn();
const mockSetUpdateInterval = jest.fn();
const mockAddListener = jest.fn();
const mockRemove = jest.fn();

jest.mock('expo-sensors', () => ({
  Barometer: {
    isAvailableAsync: (...args: unknown[]) => mockIsAvailable(...args),
    requestPermissionsAsync: (...args: unknown[]) => mockRequestPermissions(...args),
    setUpdateInterval: (...args: unknown[]) => mockSetUpdateInterval(...args),
    addListener: (...args: unknown[]) => mockAddListener(...args),
  },
}));

import { useBarometer } from '../useBarometer';
import { BAROMETER_SAMPLE_INTERVAL_MS } from '../../shared/constants/barometer';
import {
  getBarometerReadings,
  resetBarometerState,
} from '../../utils/barometerState';

type Listener = (m: { pressure: number; timestamp: number }) => void;

beforeEach(() => {
  mockIsAvailable.mockReset();
  mockRequestPermissions.mockReset();
  mockSetUpdateInterval.mockReset();
  mockAddListener.mockReset();
  mockRemove.mockReset();
  mockAddListener.mockReturnValue({ remove: mockRemove });
  resetBarometerState();
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useBarometer (#875)', () => {
  it('isAvailable=false → permission 요청도 하지 않고 listener 등록 X', async () => {
    mockIsAvailable.mockResolvedValue(false);
    renderHook(() => useBarometer());
    await flush();
    expect(mockRequestPermissions).not.toHaveBeenCalled();
    expect(mockAddListener).not.toHaveBeenCalled();
  });

  it('isAvailable throw → graceful, no-op', async () => {
    mockIsAvailable.mockRejectedValue(new Error('boom'));
    renderHook(() => useBarometer());
    await flush();
    expect(mockAddListener).not.toHaveBeenCalled();
  });

  it('권한 거절 → listener 등록 X', async () => {
    mockIsAvailable.mockResolvedValue(true);
    mockRequestPermissions.mockResolvedValue({ granted: false });
    renderHook(() => useBarometer());
    await flush();
    expect(mockAddListener).not.toHaveBeenCalled();
  });

  it('requestPermissions throw → graceful, no-op', async () => {
    mockIsAvailable.mockResolvedValue(true);
    mockRequestPermissions.mockRejectedValue(new Error('denied'));
    renderHook(() => useBarometer());
    await flush();
    expect(mockAddListener).not.toHaveBeenCalled();
  });

  it('정상 케이스 → setUpdateInterval 호출, listener 등록, reading append', async () => {
    mockIsAvailable.mockResolvedValue(true);
    mockRequestPermissions.mockResolvedValue({ granted: true });

    const { unmount } = renderHook(() => useBarometer());
    await flush();
    expect(mockSetUpdateInterval).toHaveBeenCalledWith(BAROMETER_SAMPLE_INTERVAL_MS);
    expect(mockAddListener).toHaveBeenCalledTimes(1);

    const listener = mockAddListener.mock.calls[0][0] as Listener;
    const epochBefore = Date.now();
    listener({ pressure: 1013.25, timestamp: 12.34 });
    listener({ pressure: 1013.3, timestamp: 13.34 });
    const epochAfter = Date.now();

    const readings = getBarometerReadings();
    expect(readings).toHaveLength(2);
    expect(readings[0].pressureHpa).toBeCloseTo(1013.25);
    expect(readings[1].pressureHpa).toBeCloseTo(1013.3);
    // boot-second(12.34) 대신 epoch wall-clock으로 stamp되는지 검증.
    expect(readings[0].t).toBeGreaterThanOrEqual(epochBefore);
    expect(readings[1].t).toBeLessThanOrEqual(epochAfter);

    unmount();
    expect(mockRemove).toHaveBeenCalled();
    expect(getBarometerReadings()).toEqual([]);
  });

  it('unmount가 init 완료 전에 일어나도 listener 등록 X (cancelled 경로)', async () => {
    mockIsAvailable.mockResolvedValue(true);
    mockRequestPermissions.mockImplementation(() => new Promise(() => {}));
    const { unmount } = renderHook(() => useBarometer());
    unmount();
    await flush();
    expect(mockAddListener).not.toHaveBeenCalled();
  });

  it('unmount가 isAvailable 응답 전에 일어나도 permission 요청 X', async () => {
    mockIsAvailable.mockImplementation(() => new Promise(() => {}));
    const { unmount } = renderHook(() => useBarometer());
    unmount();
    await flush();
    expect(mockRequestPermissions).not.toHaveBeenCalled();
  });
});
