const mockIsLowPowerModeEnabledAsync = jest.fn();
const mockAddLowPowerModeListener = jest.fn();
const mockRemove = jest.fn();

jest.mock('expo-battery', () => ({
  isLowPowerModeEnabledAsync: (...args: unknown[]) =>
    mockIsLowPowerModeEnabledAsync(...args),
  addLowPowerModeListener: (...args: unknown[]) =>
    mockAddLowPowerModeListener(...args),
}));

import { readLowPowerMode, subscribeLowPowerMode } from '../lowPowerState';

type ModeListener = (event: { lowPowerMode: boolean }) => void;

beforeEach(() => {
  mockIsLowPowerModeEnabledAsync.mockReset();
  mockAddLowPowerModeListener.mockReset();
  mockRemove.mockReset();
  mockAddLowPowerModeListener.mockReturnValue({ remove: mockRemove });
});

describe('readLowPowerMode', () => {
  it('LPM on이면 true를 반환한다', async () => {
    mockIsLowPowerModeEnabledAsync.mockResolvedValue(true);
    await expect(readLowPowerMode()).resolves.toBe(true);
  });

  it('LPM off면 false를 반환한다', async () => {
    mockIsLowPowerModeEnabledAsync.mockResolvedValue(false);
    await expect(readLowPowerMode()).resolves.toBe(false);
  });

  it('네이티브가 throw하면 false로 폴백한다', async () => {
    mockIsLowPowerModeEnabledAsync.mockRejectedValue(new Error('unsupported'));
    await expect(readLowPowerMode()).resolves.toBe(false);
  });
});

describe('subscribeLowPowerMode', () => {
  it('상태 변화를 listener에 boolean으로 전달한다', () => {
    const listener = jest.fn();
    subscribeLowPowerMode(listener);
    const native = mockAddLowPowerModeListener.mock.calls[0][0] as ModeListener;
    native({ lowPowerMode: true });
    expect(listener).toHaveBeenCalledWith(true);
    native({ lowPowerMode: false });
    expect(listener).toHaveBeenCalledWith(false);
  });

  it('반환된 함수 호출 시 구독을 해제한다', () => {
    const unsubscribe = subscribeLowPowerMode(jest.fn());
    unsubscribe();
    expect(mockRemove).toHaveBeenCalledTimes(1);
  });

  it('addListener가 throw하면 no-op 구독을 반환한다 (graceful)', () => {
    mockAddLowPowerModeListener.mockImplementation(() => {
      throw new Error('unsupported');
    });
    const unsubscribe = subscribeLowPowerMode(jest.fn());
    expect(() => unsubscribe()).not.toThrow();
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('remove가 throw해도 cleanup이 throw하지 않는다 (graceful)', () => {
    mockRemove.mockImplementation(() => {
      throw new Error('detach failed');
    });
    const unsubscribe = subscribeLowPowerMode(jest.fn());
    expect(() => unsubscribe()).not.toThrow();
  });
});
