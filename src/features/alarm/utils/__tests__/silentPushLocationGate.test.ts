const mockGetLastKnownPositionAsync = jest.fn();
const mockGetCurrentPositionAsync = jest.fn();

jest.mock('expo-location', () => ({
  getLastKnownPositionAsync: (...args: unknown[]) => mockGetLastKnownPositionAsync(...args),
  getCurrentPositionAsync: (...args: unknown[]) => mockGetCurrentPositionAsync(...args),
  Accuracy: { Balanced: 3 },
}));

const mockFindStationByName = jest.fn();
jest.mock('../../../nearest-station/utils/stationLookup', () => ({
  findStationByName: (...args: unknown[]) => mockFindStationByName(...args),
}));

jest.mock('../../../../utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import {
  checkSilentPushLocationGate,
  LOCATION_CACHE_TTL_MS,
  FRESH_FETCH_TIMEOUT_MS,
} from '../silentPushLocationGate';

const GANGNAM = { id: '2-12', name: '강남', line: '2', lat: 37.4979, lng: 127.0276 };
// 강남에서 ~330m 떨어진 좌표 (논현 방향)
const NEAR_GANGNAM = { lat: 37.5009, lng: 127.0276 };
// 강남에서 ~5km 떨어진 좌표 (정지 사용자 가정)
const FAR_FROM_GANGNAM = { lat: 37.5500, lng: 127.0276 };

function makePosition(lat: number, lng: number, ageMs: number) {
  return {
    coords: { latitude: lat, longitude: lng, accuracy: 50, altitude: null, heading: null, speed: null, altitudeAccuracy: null },
    timestamp: Date.now() - ageMs,
  };
}

describe('checkSilentPushLocationGate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-21T10:00:00Z'));
    mockFindStationByName.mockReturnValue(GANGNAM);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('stationName이 stations.json에 없으면 unknown-station skip', async () => {
    mockFindStationByName.mockReturnValue(null);
    const result = await checkSilentPushLocationGate({
      stationName: '없는역',
      kind: 'destination',
      phase: 'imminent',
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe('unknown-station');
    expect(mockGetLastKnownPositionAsync).not.toHaveBeenCalled();
  });

  it('캐시 위치가 가까우면 pass (cache source, distance 표기)', async () => {
    mockGetLastKnownPositionAsync.mockResolvedValue(
      makePosition(NEAR_GANGNAM.lat, NEAR_GANGNAM.lng, 10_000),
    );
    const result = await checkSilentPushLocationGate({
      stationName: '강남',
      kind: 'destination',
      phase: 'imminent',
    });
    expect(result.pass).toBe(true);
    expect(result.locationSource).toBe('cache');
    expect(result.locationAgeMs).toBe(10_000);
    expect(result.distanceM).toBeGreaterThan(0);
    expect(result.thresholdM).toBe(400);
  });

  it('캐시 위치가 멀면 out-of-range skip + distance 기록', async () => {
    mockGetLastKnownPositionAsync.mockResolvedValue(
      makePosition(FAR_FROM_GANGNAM.lat, FAR_FROM_GANGNAM.lng, 5_000),
    );
    const result = await checkSilentPushLocationGate({
      stationName: '강남',
      kind: 'destination',
      phase: 'imminent',
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe('out-of-range');
    expect(result.distanceM).toBeGreaterThan(400);
    expect(result.thresholdM).toBe(400);
  });

  it('phase=early는 imminent보다 넓은 임계값(800m) 사용', async () => {
    // 강남에서 ~500m 떨어진 좌표 (imminent에선 fail, early에선 pass 예상)
    mockGetLastKnownPositionAsync.mockResolvedValue(
      makePosition(37.5025, 127.0276, 5_000),
    );
    const imminent = await checkSilentPushLocationGate({
      stationName: '강남',
      kind: 'transfer',
      phase: 'imminent',
    });
    expect(imminent.pass).toBe(false);

    mockGetLastKnownPositionAsync.mockResolvedValue(
      makePosition(37.5025, 127.0276, 5_000),
    );
    const early = await checkSilentPushLocationGate({
      stationName: '강남',
      kind: 'transfer',
      phase: 'early',
    });
    expect(early.pass).toBe(true);
    expect(early.thresholdM).toBe(800);
  });

  it('intermediate kind는 더 좁은 임계값 (imminent=300, early=600)', async () => {
    mockGetLastKnownPositionAsync.mockResolvedValue(
      makePosition(NEAR_GANGNAM.lat, NEAR_GANGNAM.lng, 5_000),
    );
    const result = await checkSilentPushLocationGate({
      stationName: '강남',
      kind: 'intermediate',
      phase: 'imminent',
    });
    expect(result.thresholdM).toBe(300);
  });

  it('캐시가 없으면 fresh fetch fallback', async () => {
    mockGetLastKnownPositionAsync.mockResolvedValue(null);
    mockGetCurrentPositionAsync.mockResolvedValue(
      makePosition(NEAR_GANGNAM.lat, NEAR_GANGNAM.lng, 0),
    );
    const result = await checkSilentPushLocationGate({
      stationName: '강남',
      kind: 'destination',
      phase: 'imminent',
    });
    expect(result.pass).toBe(true);
    expect(result.locationSource).toBe('fresh');
    expect(result.locationAgeMs).toBe(0);
  });

  it('캐시 throw 시에도 fresh fetch fallback', async () => {
    mockGetLastKnownPositionAsync.mockRejectedValue(new Error('os error'));
    mockGetCurrentPositionAsync.mockResolvedValue(
      makePosition(NEAR_GANGNAM.lat, NEAR_GANGNAM.lng, 0),
    );
    const result = await checkSilentPushLocationGate({
      stationName: '강남',
      kind: 'destination',
      phase: 'imminent',
    });
    expect(result.pass).toBe(true);
    expect(result.locationSource).toBe('fresh');
  });

  it('캐시 + fresh 모두 실패하면 no-location skip', async () => {
    mockGetLastKnownPositionAsync.mockResolvedValue(null);
    mockGetCurrentPositionAsync.mockRejectedValue(new Error('denied'));
    const result = await checkSilentPushLocationGate({
      stationName: '강남',
      kind: 'destination',
      phase: 'imminent',
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe('no-location');
  });

  it('fresh fetch가 타임아웃 초과면 no-location skip', async () => {
    mockGetLastKnownPositionAsync.mockResolvedValue(null);
    // FRESH_FETCH_TIMEOUT_MS 동안 응답 없는 promise
    mockGetCurrentPositionAsync.mockImplementation(() => new Promise(() => {}));
    const promise = checkSilentPushLocationGate({
      stationName: '강남',
      kind: 'destination',
      phase: 'imminent',
    });
    await jest.advanceTimersByTimeAsync(FRESH_FETCH_TIMEOUT_MS + 100);
    const result = await promise;
    expect(result.pass).toBe(false);
    expect(result.reason).toBe('no-location');
  });

  it('캐시 ageMs가 TTL 초과면 stale-location skip', async () => {
    // getLastKnownPositionAsync는 maxAge 옵션에도 불구하고 모킹에서 직접 반환 가능
    // 실제 OS는 maxAge 초과 시 null을 반환하지만 방어적 게이트 동작 검증.
    mockGetLastKnownPositionAsync.mockResolvedValue(
      makePosition(NEAR_GANGNAM.lat, NEAR_GANGNAM.lng, LOCATION_CACHE_TTL_MS + 5_000),
    );
    const result = await checkSilentPushLocationGate({
      stationName: '강남',
      kind: 'destination',
      phase: 'imminent',
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toBe('stale-location');
    expect(result.locationSource).toBe('cache');
  });

  it('캐시 timestamp가 미래(음수 age)면 0으로 clamp', async () => {
    mockGetLastKnownPositionAsync.mockResolvedValue({
      coords: {
        latitude: NEAR_GANGNAM.lat,
        longitude: NEAR_GANGNAM.lng,
        accuracy: 50,
        altitude: null,
        heading: null,
        speed: null,
        altitudeAccuracy: null,
      },
      timestamp: Date.now() + 10_000,
    });
    const result = await checkSilentPushLocationGate({
      stationName: '강남',
      kind: 'destination',
      phase: 'imminent',
    });
    expect(result.locationAgeMs).toBe(0);
  });

  it('timestamp가 null이면 ?? 0 fallback (큰 값 → stale)', async () => {
    mockGetLastKnownPositionAsync.mockResolvedValue({
      coords: {
        latitude: NEAR_GANGNAM.lat,
        longitude: NEAR_GANGNAM.lng,
        accuracy: 50,
        altitude: null,
        heading: null,
        speed: null,
        altitudeAccuracy: null,
      },
      timestamp: null,
    });
    const result = await checkSilentPushLocationGate({
      stationName: '강남',
      kind: 'destination',
      phase: 'imminent',
    });
    expect(result.reason).toBe('stale-location');
  });

  it('timestamp 누락(0) 시에도 Date.now()로 ageMs 계산 (큰 값 → stale)', async () => {
    mockGetLastKnownPositionAsync.mockResolvedValue({
      coords: {
        latitude: NEAR_GANGNAM.lat,
        longitude: NEAR_GANGNAM.lng,
        accuracy: 50,
        altitude: null,
        heading: null,
        speed: null,
        altitudeAccuracy: null,
      },
      timestamp: 0,
    });
    const result = await checkSilentPushLocationGate({
      stationName: '강남',
      kind: 'destination',
      phase: 'imminent',
    });
    // timestamp=0이면 ageMs는 Date.now()와 같은 거대값 → stale
    expect(result.reason).toBe('stale-location');
  });

  // #727 — movementGate가 후속 정적 misfire 평가에 사용할 speed/accuracy를 노출.
  describe('movementGate 신호 노출 (#727)', () => {
    it('expo-location speed/accuracy가 정상이면 GateResult에 노출 (cache)', async () => {
      mockGetLastKnownPositionAsync.mockResolvedValue({
        coords: {
          latitude: NEAR_GANGNAM.lat,
          longitude: NEAR_GANGNAM.lng,
          accuracy: 25,
          altitude: null,
          heading: null,
          speed: 2.5,
          altitudeAccuracy: null,
        },
        timestamp: Date.now() - 5_000,
      });
      const result = await checkSilentPushLocationGate({
        stationName: '강남',
        kind: 'destination',
        phase: 'imminent',
      });
      expect(result.pass).toBe(true);
      expect(result.speedMps).toBe(2.5);
      expect(result.accuracyM).toBe(25);
    });

    it('expo-location speed/accuracy가 음수(-1: 측정 불가)면 미노출', async () => {
      mockGetLastKnownPositionAsync.mockResolvedValue({
        coords: {
          latitude: NEAR_GANGNAM.lat,
          longitude: NEAR_GANGNAM.lng,
          accuracy: -1,
          altitude: null,
          heading: null,
          speed: -1,
          altitudeAccuracy: null,
        },
        timestamp: Date.now() - 5_000,
      });
      const result = await checkSilentPushLocationGate({
        stationName: '강남',
        kind: 'destination',
        phase: 'imminent',
      });
      expect(result.pass).toBe(true);
      expect(result.speedMps).toBeUndefined();
      expect(result.accuracyM).toBeUndefined();
    });

    it('expo-location speed/accuracy가 null이면 미노출', async () => {
      mockGetLastKnownPositionAsync.mockResolvedValue({
        coords: {
          latitude: NEAR_GANGNAM.lat,
          longitude: NEAR_GANGNAM.lng,
          accuracy: null,
          altitude: null,
          heading: null,
          speed: null,
          altitudeAccuracy: null,
        },
        timestamp: Date.now() - 5_000,
      });
      const result = await checkSilentPushLocationGate({
        stationName: '강남',
        kind: 'destination',
        phase: 'imminent',
      });
      expect(result.pass).toBe(true);
      expect(result.speedMps).toBeUndefined();
      expect(result.accuracyM).toBeUndefined();
    });

    it('fresh fetch 경로에서도 speed/accuracy 노출', async () => {
      mockGetLastKnownPositionAsync.mockResolvedValue(null);
      mockGetCurrentPositionAsync.mockResolvedValue({
        coords: {
          latitude: NEAR_GANGNAM.lat,
          longitude: NEAR_GANGNAM.lng,
          accuracy: 15,
          altitude: null,
          heading: null,
          speed: 3.2,
          altitudeAccuracy: null,
        },
        timestamp: Date.now(),
      });
      const result = await checkSilentPushLocationGate({
        stationName: '강남',
        kind: 'destination',
        phase: 'imminent',
      });
      expect(result.locationSource).toBe('fresh');
      expect(result.speedMps).toBe(3.2);
      expect(result.accuracyM).toBe(15);
    });
  });
});
