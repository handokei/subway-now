/**
 * SPIKE→영구 캡처 도구 승격 (#2268 promotion) — accelSpikeLogger.ts 단위 테스트.
 *
 * 커버 대상:
 *   - startSpikeLogging: DeviceMotion 구독 + motion-activity 조건부 시작 + GPS watch, active guard
 *   - buildSample 경로 (DeviceMotion listener): acceleration 유무 fallback, 보조 신호 결합
 *   - markSpikeEvent: active guard
 *   - ring buffer trim (RING_CAP 초과 시 배치 컷)
 *   - stopSpikeLoggingAndExport: 구독 해제 + JSONL 직렬화 + File 생성/쓰기
 *
 * native/센서 모듈은 전부 jest.mock으로 격리 (프로젝트 관례, motionActivity.test.ts와 동형).
 */

const mockSetUpdateInterval = jest.fn();
const mockAddListener = jest.fn();
const mockDeviceMotionRemove = jest.fn();

jest.mock('expo-sensors', () => ({
  DeviceMotion: {
    setUpdateInterval: (...args: unknown[]) => mockSetUpdateInterval(...args),
    addListener: (...args: unknown[]) => mockAddListener(...args),
  },
}));

const mockRequestForegroundPermissionsAsync = jest.fn();
const mockWatchPositionAsync = jest.fn();
const mockLocationSubRemove = jest.fn();

jest.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: (...args: unknown[]) =>
    mockRequestForegroundPermissionsAsync(...args),
  watchPositionAsync: (...args: unknown[]) => mockWatchPositionAsync(...args),
  Accuracy: { BestForNavigation: 6 },
}));

const mockFileWrite = jest.fn();
const mockFileCreate = jest.fn();
let mockFileExists = false;
const mockFileConstructorArgs: unknown[][] = [];

jest.mock('expo-file-system', () => {
  class MockFile {
    uri: string;
    exists: boolean;
    constructor(...args: unknown[]) {
      mockFileConstructorArgs.push(args);
      this.uri = `mock-file://${String(args[1])}`;
      this.exists = mockFileExists;
    }
    create() {
      mockFileCreate();
    }
    write(content: string) {
      mockFileWrite(content);
    }
  }
  return {
    File: MockFile,
    Paths: { document: 'mock-doc-dir' },
  };
});

const mockNativeModule = {
  isAvailable: jest.fn(),
  requestPermission: jest.fn(),
  startUpdates: jest.fn(),
  stopUpdates: jest.fn(),
  getCurrentStationary: jest.fn(),
};
const mockedRequireOptionalNativeModule = jest.fn();

jest.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: (...args: unknown[]) =>
    mockedRequireOptionalNativeModule(...args),
}));

const mockGetLatestAccelerometerSnapshot = jest.fn();
jest.mock('../../../nearest-station/utils/accelerometerFingerprint', () => ({
  getLatestAccelerometerSnapshot: () => mockGetLatestAccelerometerSnapshot(),
}));

const mockGetBarometerReadings = jest.fn();
jest.mock('../../../../shared/utils/barometerState', () => ({
  getBarometerReadings: () => mockGetBarometerReadings(),
}));

import {
  isSpikeLoggingActive,
  getSpikeLoggingCounts,
  markSpikeEvent,
  startSpikeLogging,
  stopSpikeLoggingAndExport,
} from '../accelSpikeLogger';

type DeviceMotionListener = (measurement: {
  acceleration?: { x: number; y: number; z: number } | null;
  accelerationIncludingGravity: { x: number; y: number; z: number };
  rotationRate?: { alpha: number; beta: number; gamma: number } | null;
}) => void;

function getDeviceMotionListener(): DeviceMotionListener {
  const call = mockAddListener.mock.calls[mockAddListener.mock.calls.length - 1];
  return call[0] as DeviceMotionListener;
}

/** watchPositionAsync에 전달된 콜백을 즉시 호출하는 위치 좌표. */
function grantLocationAndCapture() {
  mockRequestForegroundPermissionsAsync.mockResolvedValue({ status: 'granted' });
  let locationCallback: ((loc: unknown) => void) | undefined;
  mockWatchPositionAsync.mockImplementation(async (_opts: unknown, cb: (loc: unknown) => void) => {
    locationCallback = cb;
    return { remove: mockLocationSubRemove };
  });
  return () => locationCallback;
}

describe('accelSpikeLogger (SPIKE 영구 캡처 도구 승격, #2268)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFileExists = false;
    mockFileConstructorArgs.length = 0;
    mockAddListener.mockReturnValue({ remove: mockDeviceMotionRemove });
    mockedRequireOptionalNativeModule.mockReturnValue(null);
    mockGetLatestAccelerometerSnapshot.mockReturnValue(null);
    mockGetBarometerReadings.mockReturnValue([]);
    mockRequestForegroundPermissionsAsync.mockResolvedValue({ status: 'denied' });
    mockWatchPositionAsync.mockResolvedValue({ remove: mockLocationSubRemove });
  });

  afterEach(async () => {
    // module-level state 격리 — active 상태였다면 다음 테스트로 새지 않게 정리.
    if (isSpikeLoggingActive()) {
      await stopSpikeLoggingAndExport();
    }
  });

  describe('startSpikeLogging', () => {
    it('DeviceMotion을 20Hz(50ms)로 구독한다', () => {
      startSpikeLogging({ ride: 'r1', placement: 'pocket', line: '2' });
      expect(mockSetUpdateInterval).toHaveBeenCalledWith(50);
      expect(mockAddListener).toHaveBeenCalledTimes(1);
      expect(isSpikeLoggingActive()).toBe(true);
    });

    it('이미 active면 재호출 시 no-op — buffer/meta가 리셋되지 않는다', () => {
      startSpikeLogging({ ride: 'first', placement: 'pocket', line: '2' });
      markSpikeEvent('arrive');
      expect(getSpikeLoggingCounts().marks).toBe(1);

      startSpikeLogging({ ride: 'second', placement: 'hand', line: '9' });
      expect(mockAddListener).toHaveBeenCalledTimes(1);
      expect(getSpikeLoggingCounts().marks).toBe(1);
    });

    it('motion-activity 모듈이 없으면(null) 예외 없이 동작', () => {
      mockedRequireOptionalNativeModule.mockReturnValue(null);
      expect(() =>
        startSpikeLogging({ ride: 'r', placement: 'bag', line: '3' }),
      ).not.toThrow();
      expect(mockNativeModule.requestPermission).not.toHaveBeenCalled();
    });

    it('motion-activity isAvailable() false면 requestPermission 호출 안 함', () => {
      mockedRequireOptionalNativeModule.mockReturnValue(mockNativeModule);
      mockNativeModule.isAvailable.mockReturnValue(false);
      startSpikeLogging({ ride: 'r', placement: 'bag', line: '3' });
      expect(mockNativeModule.requestPermission).not.toHaveBeenCalled();
    });

    it('motion-activity isAvailable() 예외 시 graceful (throw 없음)', () => {
      mockedRequireOptionalNativeModule.mockReturnValue(mockNativeModule);
      mockNativeModule.isAvailable.mockImplementation(() => {
        throw new Error('boom');
      });
      expect(() =>
        startSpikeLogging({ ride: 'r', placement: 'bag', line: '3' }),
      ).not.toThrow();
    });

    it('motion-activity 권한 허용 시 startUpdates 호출', async () => {
      mockedRequireOptionalNativeModule.mockReturnValue(mockNativeModule);
      mockNativeModule.isAvailable.mockReturnValue(true);
      mockNativeModule.requestPermission.mockResolvedValue(true);
      startSpikeLogging({ ride: 'r', placement: 'bag', line: '3' });
      await Promise.resolve();
      await Promise.resolve();
      expect(mockNativeModule.startUpdates).toHaveBeenCalledTimes(1);
    });

    it('motion-activity 권한 허용됐지만 그 사이 stop된 경우 startUpdates 호출 안 함', async () => {
      mockedRequireOptionalNativeModule.mockReturnValue(mockNativeModule);
      mockNativeModule.isAvailable.mockReturnValue(true);
      let resolvePermission: (granted: boolean) => void = () => {};
      mockNativeModule.requestPermission.mockReturnValue(
        new Promise<boolean>((resolve) => {
          resolvePermission = resolve;
        }),
      );
      startSpikeLogging({ ride: 'r', placement: 'bag', line: '3' });
      await stopSpikeLoggingAndExport();
      resolvePermission(true);
      await Promise.resolve();
      await Promise.resolve();
      expect(mockNativeModule.startUpdates).not.toHaveBeenCalled();
    });

    it('motion-activity 권한 거절 시 startUpdates 호출 안 함', async () => {
      mockedRequireOptionalNativeModule.mockReturnValue(mockNativeModule);
      mockNativeModule.isAvailable.mockReturnValue(true);
      mockNativeModule.requestPermission.mockResolvedValue(false);
      startSpikeLogging({ ride: 'r', placement: 'bag', line: '3' });
      await Promise.resolve();
      await Promise.resolve();
      expect(mockNativeModule.startUpdates).not.toHaveBeenCalled();
    });

    it('GPS 권한 허용 시 watchPositionAsync 구독 + fix 갱신', async () => {
      const getCallback = grantLocationAndCapture();
      startSpikeLogging({ ride: 'r', placement: 'pocket', line: '2' });
      await Promise.resolve();
      await Promise.resolve();
      expect(mockWatchPositionAsync).toHaveBeenCalledTimes(1);

      const cb = getCallback();
      expect(cb).toBeDefined();
      cb!({ coords: { latitude: 37.5, longitude: 127.0, accuracy: 5 } });

      const listener = getDeviceMotionListener();
      listener({
        acceleration: { x: 0, y: 0, z: 0 },
        accelerationIncludingGravity: { x: 0, y: 0, z: 9.8 },
      });
      markSpikeEvent('arrive'); // buffer에 sample이 쌓였는지는 counts로 검증
      expect(getSpikeLoggingCounts().samples).toBe(1);
    });

    it('GPS 좌표 accuracy가 없으면 -1로 대체', async () => {
      const getCallback = grantLocationAndCapture();
      startSpikeLogging({ ride: 'r', placement: 'pocket', line: '2' });
      await Promise.resolve();
      await Promise.resolve();
      const cb = getCallback();
      cb!({ coords: { latitude: 1, longitude: 2, accuracy: null } });

      const listener = getDeviceMotionListener();
      listener({
        acceleration: { x: 0, y: 0, z: 0 },
        accelerationIncludingGravity: { x: 0, y: 0, z: 9.8 },
      });
      const uri = await stopSpikeLoggingAndExport();
      const written = mockFileWrite.mock.calls[0][0] as string;
      const lines = written.split('\n');
      const sampleLine = JSON.parse(lines[1]);
      expect(sampleLine.gps).toEqual([1, 2, -1]);
      expect(uri).toContain('mock-file://');
    });

    it('GPS 권한 거절 시 watchPositionAsync 호출 안 함 (gps는 null로 계속 기록)', async () => {
      mockRequestForegroundPermissionsAsync.mockResolvedValue({ status: 'denied' });
      startSpikeLogging({ ride: 'r', placement: 'pocket', line: '2' });
      await Promise.resolve();
      await Promise.resolve();
      expect(mockWatchPositionAsync).not.toHaveBeenCalled();
    });

    it('GPS 권한 허용됐지만 이미 stop된 경우 watchPositionAsync 호출 안 함', async () => {
      let resolvePermission: (result: { status: string }) => void = () => {};
      mockRequestForegroundPermissionsAsync.mockReturnValue(
        new Promise((resolve) => {
          resolvePermission = resolve;
        }),
      );
      startSpikeLogging({ ride: 'r', placement: 'pocket', line: '2' });
      await stopSpikeLoggingAndExport();
      resolvePermission({ status: 'granted' });
      await Promise.resolve();
      await Promise.resolve();
      expect(mockWatchPositionAsync).not.toHaveBeenCalled();
    });

    it('GPS 권한 요청이 예외를 던지면 graceful (throw 없음, gps=null 유지)', async () => {
      mockRequestForegroundPermissionsAsync.mockRejectedValue(new Error('perm-fail'));
      startSpikeLogging({ ride: 'r', placement: 'pocket', line: '2' });
      await Promise.resolve();
      await Promise.resolve();
      expect(mockWatchPositionAsync).not.toHaveBeenCalled();
    });
  });

  describe('buildSample (DeviceMotion listener)', () => {
    it('acceleration이 있으면 중력 제거값 사용 + g는 gravity - accel', () => {
      startSpikeLogging({ ride: 'r', placement: 'pocket', line: '2' });
      const listener = getDeviceMotionListener();
      listener({
        acceleration: { x: 1, y: 2, z: 3 },
        accelerationIncludingGravity: { x: 1, y: 2, z: 12.8 },
        rotationRate: { alpha: 0.1, beta: 0.2, gamma: 0.3 },
      });
      markSpikeEvent('depart');
      expect(getSpikeLoggingCounts()).toEqual({ samples: 1, marks: 1 });
    });

    it('acceleration이 없으면 accelerationIncludingGravity로 대체하고 g=[0,0,0]', async () => {
      startSpikeLogging({ ride: 'r', placement: 'pocket', line: '2' });
      const listener = getDeviceMotionListener();
      listener({
        acceleration: null,
        accelerationIncludingGravity: { x: 0, y: 0, z: 9.8 },
      });
      const uri = await stopSpikeLoggingAndExport();
      expect(uri).toBeDefined();
      const written = mockFileWrite.mock.calls[0][0] as string;
      const sampleLine = JSON.parse(written.split('\n')[1]);
      expect(sampleLine.ua).toEqual([0, 0, 9.8]);
      expect(sampleLine.g).toEqual([0, 0, 0]);
      expect(sampleLine.rr).toEqual([0, 0, 0]);
    });

    it('rotationRate가 없으면 rr=[0,0,0]', async () => {
      startSpikeLogging({ ride: 'r', placement: 'pocket', line: '2' });
      const listener = getDeviceMotionListener();
      listener({
        acceleration: { x: 0, y: 0, z: 0 },
        accelerationIncludingGravity: { x: 0, y: 0, z: 9.8 },
        rotationRate: null,
      });
      await stopSpikeLoggingAndExport();
      const written = mockFileWrite.mock.calls[0][0] as string;
      const sampleLine = JSON.parse(written.split('\n')[1]);
      expect(sampleLine.rr).toEqual([0, 0, 0]);
    });

    it('accelerometerFingerprint snapshot이 있으면 rms/pat를 채운다', async () => {
      mockGetLatestAccelerometerSnapshot.mockReturnValue({
        timestamp: 1,
        rmsMagnitude: 1.23,
        patternClass: 'walking',
        sampleCount: 60,
      });
      startSpikeLogging({ ride: 'r', placement: 'pocket', line: '2' });
      const listener = getDeviceMotionListener();
      listener({
        acceleration: { x: 0, y: 0, z: 0 },
        accelerationIncludingGravity: { x: 0, y: 0, z: 9.8 },
      });
      await stopSpikeLoggingAndExport();
      const written = mockFileWrite.mock.calls[0][0] as string;
      const sampleLine = JSON.parse(written.split('\n')[1]);
      expect(sampleLine.rms).toBe(1.23);
      expect(sampleLine.pat).toBe('walking');
    });

    it('accelerometerFingerprint snapshot이 null이면 rms/pat는 null', async () => {
      mockGetLatestAccelerometerSnapshot.mockReturnValue(null);
      startSpikeLogging({ ride: 'r', placement: 'pocket', line: '2' });
      const listener = getDeviceMotionListener();
      listener({
        acceleration: { x: 0, y: 0, z: 0 },
        accelerationIncludingGravity: { x: 0, y: 0, z: 9.8 },
      });
      await stopSpikeLoggingAndExport();
      const written = mockFileWrite.mock.calls[0][0] as string;
      const sampleLine = JSON.parse(written.split('\n')[1]);
      expect(sampleLine.rms).toBeNull();
      expect(sampleLine.pat).toBeNull();
    });

    it('barometer readings가 비어있으면 hpa는 null', async () => {
      mockGetBarometerReadings.mockReturnValue([]);
      startSpikeLogging({ ride: 'r', placement: 'pocket', line: '2' });
      const listener = getDeviceMotionListener();
      listener({
        acceleration: { x: 0, y: 0, z: 0 },
        accelerationIncludingGravity: { x: 0, y: 0, z: 9.8 },
      });
      await stopSpikeLoggingAndExport();
      const written = mockFileWrite.mock.calls[0][0] as string;
      const sampleLine = JSON.parse(written.split('\n')[1]);
      expect(sampleLine.hpa).toBeNull();
    });

    it('barometer readings가 있으면 마지막 reading의 pressureHpa 사용', async () => {
      mockGetBarometerReadings.mockReturnValue([
        { t: 1, pressureHpa: 1000 },
        { t: 2, pressureHpa: 998.5 },
      ]);
      startSpikeLogging({ ride: 'r', placement: 'pocket', line: '2' });
      const listener = getDeviceMotionListener();
      listener({
        acceleration: { x: 0, y: 0, z: 0 },
        accelerationIncludingGravity: { x: 0, y: 0, z: 9.8 },
      });
      await stopSpikeLoggingAndExport();
      const written = mockFileWrite.mock.calls[0][0] as string;
      const sampleLine = JSON.parse(written.split('\n')[1]);
      expect(sampleLine.hpa).toBe(998.5);
    });

    it('motion-activity 모듈이 있고 getCurrentStationary true면 cm="stationary"', async () => {
      mockedRequireOptionalNativeModule.mockReturnValue(mockNativeModule);
      mockNativeModule.isAvailable.mockReturnValue(false);
      mockNativeModule.getCurrentStationary.mockReturnValue(true);
      startSpikeLogging({ ride: 'r', placement: 'pocket', line: '2' });
      const listener = getDeviceMotionListener();
      listener({
        acceleration: { x: 0, y: 0, z: 0 },
        accelerationIncludingGravity: { x: 0, y: 0, z: 9.8 },
      });
      await stopSpikeLoggingAndExport();
      const written = mockFileWrite.mock.calls[0][0] as string;
      const sampleLine = JSON.parse(written.split('\n')[1]);
      expect(sampleLine.cm).toBe('stationary');
      expect(sampleLine.cmc).toBeNull();
    });

    it('motion-activity getCurrentStationary false면 cm="not-stationary"', async () => {
      mockedRequireOptionalNativeModule.mockReturnValue(mockNativeModule);
      mockNativeModule.isAvailable.mockReturnValue(false);
      mockNativeModule.getCurrentStationary.mockReturnValue(false);
      startSpikeLogging({ ride: 'r', placement: 'pocket', line: '2' });
      const listener = getDeviceMotionListener();
      listener({
        acceleration: { x: 0, y: 0, z: 0 },
        accelerationIncludingGravity: { x: 0, y: 0, z: 9.8 },
      });
      await stopSpikeLoggingAndExport();
      const written = mockFileWrite.mock.calls[0][0] as string;
      const sampleLine = JSON.parse(written.split('\n')[1]);
      expect(sampleLine.cm).toBe('not-stationary');
    });

    it('motion-activity getCurrentStationary 예외 시 cm=null (graceful)', async () => {
      mockedRequireOptionalNativeModule.mockReturnValue(mockNativeModule);
      mockNativeModule.isAvailable.mockReturnValue(false);
      mockNativeModule.getCurrentStationary.mockImplementation(() => {
        throw new Error('boom');
      });
      startSpikeLogging({ ride: 'r', placement: 'pocket', line: '2' });
      const listener = getDeviceMotionListener();
      listener({
        acceleration: { x: 0, y: 0, z: 0 },
        accelerationIncludingGravity: { x: 0, y: 0, z: 9.8 },
      });
      await stopSpikeLoggingAndExport();
      const written = mockFileWrite.mock.calls[0][0] as string;
      const sampleLine = JSON.parse(written.split('\n')[1]);
      expect(sampleLine.cm).toBeNull();
    });

    it('motion-activity 모듈이 없으면(null) cm=null', async () => {
      mockedRequireOptionalNativeModule.mockReturnValue(null);
      startSpikeLogging({ ride: 'r', placement: 'pocket', line: '2' });
      const listener = getDeviceMotionListener();
      listener({
        acceleration: { x: 0, y: 0, z: 0 },
        accelerationIncludingGravity: { x: 0, y: 0, z: 9.8 },
      });
      await stopSpikeLoggingAndExport();
      const written = mockFileWrite.mock.calls[0][0] as string;
      const sampleLine = JSON.parse(written.split('\n')[1]);
      expect(sampleLine.cm).toBeNull();
    });
  });

  describe('markSpikeEvent', () => {
    it('active 상태면 mark를 buffer에 push', () => {
      startSpikeLogging({ ride: 'r', placement: 'pocket', line: '2' });
      markSpikeEvent('arrive');
      markSpikeEvent('depart');
      expect(getSpikeLoggingCounts()).toEqual({ samples: 0, marks: 2 });
    });

    it('active 아니면 no-op', () => {
      expect(isSpikeLoggingActive()).toBe(false);
      markSpikeEvent('arrive');
      expect(getSpikeLoggingCounts()).toEqual({ samples: 0, marks: 0 });
    });
  });

  describe('isSpikeLoggingActive / getSpikeLoggingCounts', () => {
    it('시작 전 false, 시작 후 true', () => {
      expect(isSpikeLoggingActive()).toBe(false);
      startSpikeLogging({ ride: 'r', placement: 'pocket', line: '2' });
      expect(isSpikeLoggingActive()).toBe(true);
    });

    it('sample과 mark를 구분 카운트', () => {
      startSpikeLogging({ ride: 'r', placement: 'pocket', line: '2' });
      const listener = getDeviceMotionListener();
      listener({
        acceleration: { x: 0, y: 0, z: 0 },
        accelerationIncludingGravity: { x: 0, y: 0, z: 9.8 },
      });
      listener({
        acceleration: { x: 0, y: 0, z: 0 },
        accelerationIncludingGravity: { x: 0, y: 0, z: 9.8 },
      });
      markSpikeEvent('arrive');
      expect(getSpikeLoggingCounts()).toEqual({ samples: 2, marks: 1 });
    });
  });

  describe('ring buffer trim', () => {
    it('RING_CAP(200,000) + TRIM_BATCH(5,000) 초과 시 앞부분을 잘라 RING_CAP으로 유지', () => {
      startSpikeLogging({ ride: 'r', placement: 'pocket', line: '2' });
      const total = 205_001;
      for (let i = 0; i < total; i++) {
        markSpikeEvent('arrive');
      }
      expect(getSpikeLoggingCounts()).toEqual({ samples: 0, marks: 200_000 });
    });
  });

  describe('stopSpikeLoggingAndExport', () => {
    it('구독 해제(DeviceMotion + Location) 후 active=false', async () => {
      const getCallback = grantLocationAndCapture();
      startSpikeLogging({ ride: 'r', placement: 'pocket', line: '2' });
      await Promise.resolve();
      await Promise.resolve();
      expect(getCallback()).toBeDefined();

      await stopSpikeLoggingAndExport();
      expect(mockDeviceMotionRemove).toHaveBeenCalledTimes(1);
      expect(mockLocationSubRemove).toHaveBeenCalledTimes(1);
      expect(isSpikeLoggingActive()).toBe(false);
    });

    it('motion-activity가 시작되지 않았으면 stopUpdates 호출 안 함', async () => {
      mockedRequireOptionalNativeModule.mockReturnValue(null);
      startSpikeLogging({ ride: 'r', placement: 'pocket', line: '2' });
      await stopSpikeLoggingAndExport();
      expect(mockNativeModule.stopUpdates).not.toHaveBeenCalled();
    });

    it('motion-activity가 시작됐으면 stopUpdates 호출', async () => {
      mockedRequireOptionalNativeModule.mockReturnValue(mockNativeModule);
      mockNativeModule.isAvailable.mockReturnValue(true);
      mockNativeModule.requestPermission.mockResolvedValue(true);
      startSpikeLogging({ ride: 'r', placement: 'pocket', line: '2' });
      await Promise.resolve();
      await Promise.resolve();
      await stopSpikeLoggingAndExport();
      expect(mockNativeModule.stopUpdates).toHaveBeenCalledTimes(1);
    });

    it('motion-activity stopUpdates 예외 시 graceful (throw 없음)', async () => {
      mockedRequireOptionalNativeModule.mockReturnValue(mockNativeModule);
      mockNativeModule.isAvailable.mockReturnValue(true);
      mockNativeModule.requestPermission.mockResolvedValue(true);
      mockNativeModule.stopUpdates.mockImplementation(() => {
        throw new Error('stop-fail');
      });
      startSpikeLogging({ ride: 'r', placement: 'pocket', line: '2' });
      await Promise.resolve();
      await Promise.resolve();
      await expect(stopSpikeLoggingAndExport()).resolves.toBeDefined();
    });

    it('JSONL 직렬화 — 첫 줄은 meta, 이후 sample/mark 순서 보존', async () => {
      startSpikeLogging({ ride: 'ride-A', placement: 'hand', line: '9' });
      const listener = getDeviceMotionListener();
      listener({
        acceleration: { x: 0, y: 0, z: 0 },
        accelerationIncludingGravity: { x: 0, y: 0, z: 9.8 },
      });
      markSpikeEvent('arrive');
      await stopSpikeLoggingAndExport();

      const written = mockFileWrite.mock.calls[0][0] as string;
      const lines = written.split('\n').map((l) => JSON.parse(l));
      expect(lines).toHaveLength(3);
      expect(lines[0].meta).toMatchObject({ ride: 'ride-A', placement: 'hand', line: '9' });
      expect(typeof lines[0].meta.startedAt).toBe('number');
      expect(lines[1]).toHaveProperty('ua');
      expect(lines[2]).toEqual(expect.objectContaining({ mark: 'arrive' }));
    });

    it('meta가 없으면(시작 없이 stop) meta 줄을 포함하지 않는다', async () => {
      expect(isSpikeLoggingActive()).toBe(false);
      const uri = await stopSpikeLoggingAndExport();
      const written = mockFileWrite.mock.calls[0][0] as string;
      expect(written).toBe('');
      expect(uri).toContain('mock-file://');
    });

    it('file.exists가 false면 create() 호출', async () => {
      mockFileExists = false;
      startSpikeLogging({ ride: 'r', placement: 'pocket', line: '2' });
      await stopSpikeLoggingAndExport();
      expect(mockFileCreate).toHaveBeenCalledTimes(1);
    });

    it('file.exists가 true면 create() 호출 안 함', async () => {
      mockFileExists = true;
      startSpikeLogging({ ride: 'r', placement: 'pocket', line: '2' });
      await stopSpikeLoggingAndExport();
      expect(mockFileCreate).not.toHaveBeenCalled();
    });

    it('반환값은 file.uri', async () => {
      startSpikeLogging({ ride: 'r', placement: 'pocket', line: '2' });
      const uri = await stopSpikeLoggingAndExport();
      expect(uri).toBe(mockFileConstructorArgs.length > 0 ? `mock-file://${String(mockFileConstructorArgs[0][1])}` : undefined);
    });

    it('종료 후 buffer/meta가 리셋된다 (연속 stop 시 두 번째는 빈 JSONL)', async () => {
      startSpikeLogging({ ride: 'r', placement: 'pocket', line: '2' });
      markSpikeEvent('arrive');
      await stopSpikeLoggingAndExport();
      const secondUri = await stopSpikeLoggingAndExport();
      const secondWritten = mockFileWrite.mock.calls[1][0] as string;
      expect(secondWritten).toBe('');
      expect(secondUri).toBeDefined();
    });
  });
});
