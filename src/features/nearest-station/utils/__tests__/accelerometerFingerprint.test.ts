/**
 * #1542 (ADR-016 S9) — CMMotionManager accelerometer fingerprint JS wrapper 테스트.
 *
 * 핵심 정책:
 *   - native module 부재 → 모든 API graceful (null / no-op / false)
 *   - 예외 → null / no-op (graceful)
 *   - classifyAccelerometerPattern: 분류 결과 그대로, null → 'unknown'
 *   - isValidSnapshot: invalid shape → null fallback (binary 호환성 안전망)
 */

const mockNativeModule = {
  isAvailable: jest.fn(),
  start: jest.fn(),
  stop: jest.fn(),
  getLatestSnapshot: jest.fn(),
};

const mockedRequire = jest.fn();

jest.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: (...args: unknown[]) => mockedRequire(...args),
}));

import {
  classifyAccelerometerPattern,
  getLatestAccelerometerSnapshot,
  isAccelerometerFingerprintSupported,
  startAccelerometerFingerprint,
  stopAccelerometerFingerprint,
  type AccelerometerPattern,
  type AccelerometerSnapshot,
} from '../accelerometerFingerprint';

function makeSnapshot(overrides: Partial<AccelerometerSnapshot> = {}): AccelerometerSnapshot {
  return {
    timestamp: 1_700_000_000_000,
    rmsMagnitude: 0.5,
    patternClass: 'walking',
    sampleCount: 200,
    ...overrides,
  };
}

beforeEach(() => {
  mockedRequire.mockReset();
  mockNativeModule.isAvailable.mockReset();
  mockNativeModule.start.mockReset();
  mockNativeModule.stop.mockReset();
  mockNativeModule.getLatestSnapshot.mockReset();
});

describe('accelerometerFingerprint native wrapper (#1542)', () => {
  describe('native module 없음 (jest / Android / 미지원)', () => {
    beforeEach(() => {
      mockedRequire.mockReturnValue(null);
    });

    it('isAccelerometerFingerprintSupported() → false', () => {
      expect(isAccelerometerFingerprintSupported()).toBe(false);
    });

    it('startAccelerometerFingerprint() → no-op', () => {
      expect(() => startAccelerometerFingerprint()).not.toThrow();
    });

    it('stopAccelerometerFingerprint() → no-op', () => {
      expect(() => stopAccelerometerFingerprint()).not.toThrow();
    });

    it('getLatestAccelerometerSnapshot() → null', () => {
      expect(getLatestAccelerometerSnapshot()).toBeNull();
    });
  });

  describe('native module 있음 — 정상', () => {
    beforeEach(() => {
      mockedRequire.mockReturnValue(mockNativeModule);
    });

    it('isAccelerometerFingerprintSupported() — native isAvailable 반영', () => {
      mockNativeModule.isAvailable.mockReturnValue(true);
      expect(isAccelerometerFingerprintSupported()).toBe(true);
      mockNativeModule.isAvailable.mockReturnValue(false);
      expect(isAccelerometerFingerprintSupported()).toBe(false);
    });

    it('startAccelerometerFingerprint() — native start 호출', () => {
      startAccelerometerFingerprint();
      expect(mockNativeModule.start).toHaveBeenCalledTimes(1);
    });

    it('stopAccelerometerFingerprint() — native stop 호출', () => {
      stopAccelerometerFingerprint();
      expect(mockNativeModule.stop).toHaveBeenCalledTimes(1);
    });

    it('getLatestAccelerometerSnapshot() — valid snapshot 그대로 반환', () => {
      const snap = makeSnapshot();
      mockNativeModule.getLatestSnapshot.mockReturnValue(snap);
      expect(getLatestAccelerometerSnapshot()).toEqual(snap);
    });

    it('getLatestAccelerometerSnapshot() — native null → null', () => {
      mockNativeModule.getLatestSnapshot.mockReturnValue(null);
      expect(getLatestAccelerometerSnapshot()).toBeNull();
    });

    it.each([
      { case: 'undefined', value: undefined },
      { case: 'string', value: 'oops' },
      { case: 'missing timestamp', value: { ...makeSnapshot(), timestamp: undefined } },
      { case: 'missing rmsMagnitude', value: { ...makeSnapshot(), rmsMagnitude: undefined } },
      { case: 'missing sampleCount', value: { ...makeSnapshot(), sampleCount: undefined } },
      { case: 'invalid patternClass', value: { ...makeSnapshot(), patternClass: 'driving' } },
      { case: 'patternClass non-string', value: { ...makeSnapshot(), patternClass: 1 } },
    ])('getLatestAccelerometerSnapshot() — invalid ($case) → null', ({ value }) => {
      mockNativeModule.getLatestSnapshot.mockReturnValue(value);
      expect(getLatestAccelerometerSnapshot()).toBeNull();
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
      expect(isAccelerometerFingerprintSupported()).toBe(false);
    });

    it('start 예외 → no-op (throw 없음)', () => {
      mockNativeModule.start.mockImplementation(() => {
        throw new Error('boom');
      });
      expect(() => startAccelerometerFingerprint()).not.toThrow();
    });

    it('stop 예외 → no-op', () => {
      mockNativeModule.stop.mockImplementation(() => {
        throw new Error('boom');
      });
      expect(() => stopAccelerometerFingerprint()).not.toThrow();
    });

    it('getLatestSnapshot 예외 → null', () => {
      mockNativeModule.getLatestSnapshot.mockImplementation(() => {
        throw new Error('boom');
      });
      expect(getLatestAccelerometerSnapshot()).toBeNull();
    });
  });
});

describe('classifyAccelerometerPattern (#1542)', () => {
  it.each<AccelerometerPattern>(['stationary', 'walking', 'automotive', 'unknown'])(
    'snapshot patternClass=%s → 그대로 반환',
    (pattern) => {
      expect(classifyAccelerometerPattern(makeSnapshot({ patternClass: pattern }))).toBe(pattern);
    },
  );

  it('null snapshot → unknown (미투표)', () => {
    expect(classifyAccelerometerPattern(null)).toBe('unknown');
  });
});
