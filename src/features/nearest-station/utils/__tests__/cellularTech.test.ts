/**
 * #1543 (ADR-016 S10) — CTRadioAccessTechnology JS wrapper + 환경 분류 테스트.
 *
 * 핵심 정책:
 *   - native module 부재 → 모든 API graceful (null / no-op / false)
 *   - 예외 → null / no-op (graceful)
 *   - classifyCellularEnvironment: 4G/5G→surface, 2G/3G→underground, 그 외→unknown
 */

const mockNativeModule = {
  isAvailable: jest.fn(),
  startUpdates: jest.fn(),
  stopUpdates: jest.fn(),
  getCurrentTech: jest.fn(),
};

const mockedRequire = jest.fn();

jest.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: (...args: unknown[]) => mockedRequire(...args),
}));

import {
  classifyCellularEnvironment,
  getCurrentCellularTech,
  isCellularTechSupported,
  startCellularTechUpdates,
  stopCellularTechUpdates,
} from '../cellularTech';

describe('cellularTech native wrapper (#1543)', () => {
  beforeEach(() => {
    mockedRequire.mockReset();
    mockNativeModule.isAvailable.mockReset();
    mockNativeModule.startUpdates.mockReset();
    mockNativeModule.stopUpdates.mockReset();
    mockNativeModule.getCurrentTech.mockReset();
  });

  describe('native module 없음 (jest / Android / 미지원)', () => {
    beforeEach(() => {
      mockedRequire.mockReturnValue(null);
    });

    it('isCellularTechSupported() → false', () => {
      expect(isCellularTechSupported()).toBe(false);
    });

    it('startCellularTechUpdates() → no-op (throw 없음)', () => {
      expect(() => startCellularTechUpdates()).not.toThrow();
    });

    it('stopCellularTechUpdates() → no-op', () => {
      expect(() => stopCellularTechUpdates()).not.toThrow();
    });

    it('getCurrentCellularTech() → null', () => {
      expect(getCurrentCellularTech()).toBeNull();
    });
  });

  describe('native module 있음 — 정상', () => {
    beforeEach(() => {
      mockedRequire.mockReturnValue(mockNativeModule);
    });

    it('isCellularTechSupported() → native isAvailable 반영', () => {
      mockNativeModule.isAvailable.mockReturnValue(true);
      expect(isCellularTechSupported()).toBe(true);
      mockNativeModule.isAvailable.mockReturnValue(false);
      expect(isCellularTechSupported()).toBe(false);
    });

    it('startCellularTechUpdates() → native startUpdates 호출', () => {
      startCellularTechUpdates();
      expect(mockNativeModule.startUpdates).toHaveBeenCalledTimes(1);
    });

    it('stopCellularTechUpdates() → native stopUpdates 호출', () => {
      stopCellularTechUpdates();
      expect(mockNativeModule.stopUpdates).toHaveBeenCalledTimes(1);
    });

    it('getCurrentCellularTech() → native 값 그대로 반환', () => {
      mockNativeModule.getCurrentTech.mockReturnValue('CTRadioAccessTechnologyLTE');
      expect(getCurrentCellularTech()).toBe('CTRadioAccessTechnologyLTE');
    });

    it('getCurrentCellularTech() — empty string → null로 정규화', () => {
      mockNativeModule.getCurrentTech.mockReturnValue('');
      expect(getCurrentCellularTech()).toBeNull();
    });

    it('getCurrentCellularTech() — null 반환 → null', () => {
      mockNativeModule.getCurrentTech.mockReturnValue(null);
      expect(getCurrentCellularTech()).toBeNull();
    });

    it('getCurrentCellularTech() — non-string → null', () => {
      mockNativeModule.getCurrentTech.mockReturnValue(undefined);
      expect(getCurrentCellularTech()).toBeNull();
    });
  });

  describe('native module 있음 — 예외 (graceful)', () => {
    beforeEach(() => {
      mockedRequire.mockReturnValue(mockNativeModule);
    });

    it('isAvailable 예외 → false', () => {
      mockNativeModule.isAvailable.mockImplementation(() => {
        throw new Error('boom');
      });
      expect(isCellularTechSupported()).toBe(false);
    });

    it('startUpdates 예외 → no-op (throw 없음)', () => {
      mockNativeModule.startUpdates.mockImplementation(() => {
        throw new Error('boom');
      });
      expect(() => startCellularTechUpdates()).not.toThrow();
    });

    it('stopUpdates 예외 → no-op', () => {
      mockNativeModule.stopUpdates.mockImplementation(() => {
        throw new Error('boom');
      });
      expect(() => stopCellularTechUpdates()).not.toThrow();
    });

    it('getCurrentTech 예외 → null', () => {
      mockNativeModule.getCurrentTech.mockImplementation(() => {
        throw new Error('boom');
      });
      expect(getCurrentCellularTech()).toBeNull();
    });
  });
});

describe('classifyCellularEnvironment (#1543)', () => {
  it.each([
    'CTRadioAccessTechnologyLTE',
    'CTRadioAccessTechnologyLTEAdvanced',
    'CTRadioAccessTechnologyNR',
    'CTRadioAccessTechnologyNRNSA',
  ])('%s → surface (4G/5G)', (tech) => {
    expect(classifyCellularEnvironment(tech)).toBe('surface');
  });

  it.each([
    'CTRadioAccessTechnologyGPRS',
    'CTRadioAccessTechnologyEdge',
    'CTRadioAccessTechnologyWCDMA',
    'CTRadioAccessTechnologyHSDPA',
    'CTRadioAccessTechnologyHSUPA',
    'CTRadioAccessTechnologyCDMA1x',
    'CTRadioAccessTechnologyeHRPD',
    'CTRadioAccessTechnologyCDMAEVDORev0',
    'CTRadioAccessTechnologyCDMAEVDORevA',
    'CTRadioAccessTechnologyCDMAEVDORevB',
  ])('%s → underground (2G/3G)', (tech) => {
    expect(classifyCellularEnvironment(tech)).toBe('underground');
  });

  it('null → unknown (미투표)', () => {
    expect(classifyCellularEnvironment(null)).toBe('unknown');
  });

  it('빈 문자열 → unknown', () => {
    expect(classifyCellularEnvironment('')).toBe('unknown');
  });

  it('미지의 미래 상수 → unknown (보수)', () => {
    expect(classifyCellularEnvironment('CTRadioAccessTechnology6G')).toBe('unknown');
  });
});
