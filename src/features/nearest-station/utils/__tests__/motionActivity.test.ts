/**
 * #728 — CMMotionActivity JS wrapper 테스트.
 *
 * native module이 jest 환경에서 null이라 graceful fallback이 핵심:
 *   - 미지원/권한 거절 시 isMotionStationary는 false (== "not known stationary" → suppress 안 함)
 *   - 호출 자체는 throw 없이 안전
 *
 * native 호출의 성공/실패 시나리오는 module spy로 시뮬레이션.
 */

const mockNativeModule = {
  isAvailable: jest.fn(),
  requestPermission: jest.fn(),
  startUpdates: jest.fn(),
  stopUpdates: jest.fn(),
  getCurrentStationary: jest.fn(),
};

const mockedRequire = jest.fn();

jest.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: (...args: unknown[]) => mockedRequire(...args),
}));

import {
  isMotionActivitySupported,
  requestMotionActivityPermission,
  startMotionActivityUpdates,
  stopMotionActivityUpdates,
  getCurrentMotionStationary,
} from '../motionActivity';

describe('motionActivity (#728)', () => {
  beforeEach(() => {
    mockedRequire.mockReset();
    mockNativeModule.isAvailable.mockReset();
    mockNativeModule.requestPermission.mockReset();
    mockNativeModule.startUpdates.mockReset();
    mockNativeModule.stopUpdates.mockReset();
    mockNativeModule.getCurrentStationary.mockReset();
  });

  describe('native module 없음 (jest 기본 / 미지원 디바이스)', () => {
    beforeEach(() => {
      mockedRequire.mockReturnValue(null);
    });

    it('isMotionActivitySupported() → false', () => {
      expect(isMotionActivitySupported()).toBe(false);
    });

    it('requestMotionActivityPermission() → false (no-op)', async () => {
      await expect(requestMotionActivityPermission()).resolves.toBe(false);
    });

    it('startMotionActivityUpdates() — throw 없이 graceful', () => {
      expect(() => startMotionActivityUpdates()).not.toThrow();
    });

    it('stopMotionActivityUpdates() — throw 없이 graceful', () => {
      expect(() => stopMotionActivityUpdates()).not.toThrow();
    });

    it('getCurrentMotionStationary() → false (모르는 상태는 suppress 안 함)', () => {
      expect(getCurrentMotionStationary()).toBe(false);
    });
  });

  describe('native module 있음 (iOS 디바이스)', () => {
    beforeEach(() => {
      mockedRequire.mockReturnValue(mockNativeModule);
    });

    it('isMotionActivitySupported() — native isAvailable 위임 true', () => {
      mockNativeModule.isAvailable.mockReturnValue(true);
      expect(isMotionActivitySupported()).toBe(true);
      expect(mockNativeModule.isAvailable).toHaveBeenCalled();
    });

    it('isMotionActivitySupported() — native가 false 반환하면 false', () => {
      mockNativeModule.isAvailable.mockReturnValue(false);
      expect(isMotionActivitySupported()).toBe(false);
    });

    it('isMotionActivitySupported() — native 예외 시 false (graceful)', () => {
      mockNativeModule.isAvailable.mockImplementation(() => {
        throw new Error('available-fail');
      });
      expect(isMotionActivitySupported()).toBe(false);
    });

    it('requestMotionActivityPermission() — 권한 부여 시 true', async () => {
      mockNativeModule.requestPermission.mockResolvedValue(true);
      await expect(requestMotionActivityPermission()).resolves.toBe(true);
    });

    it('requestMotionActivityPermission() — 권한 거절 시 false', async () => {
      mockNativeModule.requestPermission.mockResolvedValue(false);
      await expect(requestMotionActivityPermission()).resolves.toBe(false);
    });

    it('requestMotionActivityPermission() — native 예외 시 false (graceful)', async () => {
      mockNativeModule.requestPermission.mockRejectedValue(new Error('perm-fail'));
      await expect(requestMotionActivityPermission()).resolves.toBe(false);
    });

    it('startMotionActivityUpdates() — native startUpdates 호출', () => {
      startMotionActivityUpdates();
      expect(mockNativeModule.startUpdates).toHaveBeenCalledTimes(1);
    });

    it('startMotionActivityUpdates() — native 예외 graceful', () => {
      mockNativeModule.startUpdates.mockImplementation(() => {
        throw new Error('start-fail');
      });
      expect(() => startMotionActivityUpdates()).not.toThrow();
    });

    it('stopMotionActivityUpdates() — native stopUpdates 호출', () => {
      stopMotionActivityUpdates();
      expect(mockNativeModule.stopUpdates).toHaveBeenCalledTimes(1);
    });

    it('stopMotionActivityUpdates() — native 예외 graceful', () => {
      mockNativeModule.stopUpdates.mockImplementation(() => {
        throw new Error('stop-fail');
      });
      expect(() => stopMotionActivityUpdates()).not.toThrow();
    });

    it('getCurrentMotionStationary() — true 보고', () => {
      mockNativeModule.getCurrentStationary.mockReturnValue(true);
      expect(getCurrentMotionStationary()).toBe(true);
    });

    it('getCurrentMotionStationary() — false 보고', () => {
      mockNativeModule.getCurrentStationary.mockReturnValue(false);
      expect(getCurrentMotionStationary()).toBe(false);
    });

    it('getCurrentMotionStationary() — native 예외 시 false (graceful)', () => {
      mockNativeModule.getCurrentStationary.mockImplementation(() => {
        throw new Error('get-fail');
      });
      expect(getCurrentMotionStationary()).toBe(false);
    });

    it('getCurrentMotionStationary() — non-boolean 반환 시 false (방어)', () => {
      mockNativeModule.getCurrentStationary.mockReturnValue(undefined);
      expect(getCurrentMotionStationary()).toBe(false);
    });
  });
});
