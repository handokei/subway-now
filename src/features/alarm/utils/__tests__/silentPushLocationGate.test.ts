const mockGetLastKnownPositionAsync = jest.fn();
const mockGetCurrentPositionAsync = jest.fn();

jest.mock('expo-location', () => ({
  getLastKnownPositionAsync: (...args: unknown[]) => mockGetLastKnownPositionAsync(...args),
  getCurrentPositionAsync: (...args: unknown[]) => mockGetCurrentPositionAsync(...args),
  Accuracy: { Balanced: 3 },
}));

const mockFindStationByName = jest.fn();
jest.mock('../../../../shared/utils/stationLookup', () => ({
  findStationByName: (...args: unknown[]) => mockFindStationByName(...args),
}));

jest.mock('../../../../shared/utils/logger', () => ({
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

  // #1209 D3 — lockless intermediate 위치 게이트 정밀화.
  describe('lockless intermediate 위치 게이트 (#1209 D3)', () => {
    // 강남에서 ~700m 떨어진 좌표 (기존 300m 임계값에선 fail, lockless widened 800m엔 pass)
    const MID_FROM_GANGNAM = { lat: 37.5042, lng: 127.0276 };
    // 강남에서 ~1.5km 떨어진 좌표 (lockless 800m도 초과)
    const FAR_LOCKLESS = { lat: 37.5114, lng: 127.0276 };

    it('lockless + hop index 매치 시 거리 검증 우회 pass', async () => {
      // 일부러 임계값 초과 거리에 두고 hop window로 통과시킴.
      mockGetLastKnownPositionAsync.mockResolvedValue(
        makePosition(FAR_LOCKLESS.lat, FAR_LOCKLESS.lng, 5_000),
      );
      const result = await checkSilentPushLocationGate({
        stationName: '강남',
        kind: 'intermediate',
        phase: 'imminent',
        isLockless: true,
        currentHopIndex: 3,
        payloadHopIndex: 3,
      });
      expect(result.pass).toBe(true);
      expect(result.passReason).toBe('hop-window-match');
      // hop window 우회 경로는 distance/threshold 미계산.
      expect(result.distanceM).toBeUndefined();
      expect(result.thresholdM).toBeUndefined();
    });

    it('lockless + hop index 차이가 정확히 1이면 pass (경계)', async () => {
      mockGetLastKnownPositionAsync.mockResolvedValue(
        makePosition(FAR_LOCKLESS.lat, FAR_LOCKLESS.lng, 5_000),
      );
      const result = await checkSilentPushLocationGate({
        stationName: '강남',
        kind: 'intermediate',
        phase: 'imminent',
        isLockless: true,
        currentHopIndex: 4,
        payloadHopIndex: 3,
      });
      expect(result.pass).toBe(true);
      expect(result.passReason).toBe('hop-window-match');
    });

    it('lockless + hop index 차이가 2면 hop 매치 실패 → distance 게이트 진행', async () => {
      mockGetLastKnownPositionAsync.mockResolvedValue(
        makePosition(FAR_LOCKLESS.lat, FAR_LOCKLESS.lng, 5_000),
      );
      const result = await checkSilentPushLocationGate({
        stationName: '강남',
        kind: 'intermediate',
        phase: 'imminent',
        isLockless: true,
        currentHopIndex: 5,
        payloadHopIndex: 3,
      });
      // hop window 실패 + 거리 1.5km는 lockless widened 800m 초과 → out-of-range
      expect(result.pass).toBe(false);
      expect(result.reason).toBe('out-of-range');
      expect(result.thresholdM).toBe(800);
    });

    it('lockless + hop index 미제공 + 700m → widened 임계값(800m) 내 pass', async () => {
      mockGetLastKnownPositionAsync.mockResolvedValue(
        makePosition(MID_FROM_GANGNAM.lat, MID_FROM_GANGNAM.lng, 5_000),
      );
      const result = await checkSilentPushLocationGate({
        stationName: '강남',
        kind: 'intermediate',
        phase: 'imminent',
        isLockless: true,
      });
      expect(result.pass).toBe(true);
      expect(result.passReason).toBe('within-threshold');
      expect(result.thresholdM).toBe(800);
      expect(result.distanceM).toBeGreaterThan(300);
      expect(result.distanceM).toBeLessThanOrEqual(800);
    });

    it('lockless + hop index 미제공 + 1.5km → widened 임계값도 초과 → out-of-range', async () => {
      mockGetLastKnownPositionAsync.mockResolvedValue(
        makePosition(FAR_LOCKLESS.lat, FAR_LOCKLESS.lng, 5_000),
      );
      const result = await checkSilentPushLocationGate({
        stationName: '강남',
        kind: 'intermediate',
        phase: 'imminent',
        isLockless: true,
      });
      expect(result.pass).toBe(false);
      expect(result.reason).toBe('out-of-range');
      expect(result.thresholdM).toBe(800);
      expect(result.distanceM).toBeGreaterThan(800);
    });

    it('lockless + early phase는 widened 1200m 임계값', async () => {
      mockGetLastKnownPositionAsync.mockResolvedValue(
        makePosition(FAR_LOCKLESS.lat, FAR_LOCKLESS.lng, 5_000),
      );
      const result = await checkSilentPushLocationGate({
        stationName: '강남',
        kind: 'intermediate',
        phase: 'early',
        isLockless: true,
      });
      // 1.5km는 1200m도 초과
      expect(result.pass).toBe(false);
      expect(result.thresholdM).toBe(1200);
    });

    it('lockless + early phase + 700m → widened 1200m 내 pass', async () => {
      mockGetLastKnownPositionAsync.mockResolvedValue(
        makePosition(MID_FROM_GANGNAM.lat, MID_FROM_GANGNAM.lng, 5_000),
      );
      const result = await checkSilentPushLocationGate({
        stationName: '강남',
        kind: 'intermediate',
        phase: 'early',
        isLockless: true,
      });
      expect(result.pass).toBe(true);
      expect(result.passReason).toBe('within-threshold');
      expect(result.thresholdM).toBe(1200);
    });

    it('hop window match passReason은 motion fields도 함께 노출', async () => {
      mockGetLastKnownPositionAsync.mockResolvedValue({
        coords: {
          latitude: FAR_LOCKLESS.lat,
          longitude: FAR_LOCKLESS.lng,
          accuracy: 12,
          altitude: null,
          heading: null,
          speed: 4.5,
          altitudeAccuracy: null,
        },
        timestamp: Date.now() - 5_000,
      });
      const result = await checkSilentPushLocationGate({
        stationName: '강남',
        kind: 'intermediate',
        phase: 'imminent',
        isLockless: true,
        currentHopIndex: 2,
        payloadHopIndex: 2,
      });
      expect(result.pass).toBe(true);
      expect(result.passReason).toBe('hop-window-match');
      expect(result.speedMps).toBe(4.5);
      expect(result.accuracyM).toBe(12);
    });

    it('lockless가 아닌데 hop index 제공해도 기존 좁은 임계값 그대로 (회귀 차단)', async () => {
      mockGetLastKnownPositionAsync.mockResolvedValue(
        makePosition(MID_FROM_GANGNAM.lat, MID_FROM_GANGNAM.lng, 5_000),
      );
      const result = await checkSilentPushLocationGate({
        stationName: '강남',
        kind: 'intermediate',
        phase: 'imminent',
        isLockless: false,
        currentHopIndex: 3,
        payloadHopIndex: 3,
      });
      // lock 활성으로 간주 → 기존 300m 임계 → 700m fail
      expect(result.pass).toBe(false);
      expect(result.thresholdM).toBe(300);
    });

    it('lockless transfer kind는 widened 적용 X (transfer는 기존 좁은 임계 유지)', async () => {
      mockGetLastKnownPositionAsync.mockResolvedValue(
        makePosition(MID_FROM_GANGNAM.lat, MID_FROM_GANGNAM.lng, 5_000),
      );
      const result = await checkSilentPushLocationGate({
        stationName: '강남',
        kind: 'transfer',
        phase: 'imminent',
        isLockless: true,
        currentHopIndex: 3,
        payloadHopIndex: 3,
      });
      // intermediate만 hop window/widened 분기. transfer는 기존 400m 임계.
      expect(result.thresholdM).toBe(400);
      expect(result.pass).toBe(false);
    });

    it('lockless intermediate + currentHopIndex만 제공(payload 누락) → widened distance 경로', async () => {
      mockGetLastKnownPositionAsync.mockResolvedValue(
        makePosition(MID_FROM_GANGNAM.lat, MID_FROM_GANGNAM.lng, 5_000),
      );
      const result = await checkSilentPushLocationGate({
        stationName: '강남',
        kind: 'intermediate',
        phase: 'imminent',
        isLockless: true,
        currentHopIndex: 3,
        // payloadHopIndex 미제공
      });
      // hop window 판정 불가 → widened distance 경로
      expect(result.pass).toBe(true);
      expect(result.passReason).toBe('within-threshold');
      expect(result.thresholdM).toBe(800);
    });

    // Epic #1204 그룹 2 D3 (#1273) — gate-no-location fallback 분기.
    describe('gate-no-location hop fallback (#1273)', () => {
      it('lockless intermediate + hop 매치 + 위치 미획득 → hop-window-match pass (locationSource 부재)', async () => {
        mockGetLastKnownPositionAsync.mockResolvedValue(null);
        mockGetCurrentPositionAsync.mockRejectedValue(new Error('denied'));
        const result = await checkSilentPushLocationGate({
          stationName: '강남',
          kind: 'intermediate',
          phase: 'imminent',
          isLockless: true,
          currentHopIndex: 4,
          payloadHopIndex: 4,
        });
        expect(result.pass).toBe(true);
        expect(result.passReason).toBe('hop-window-match');
        expect(result.locationSource).toBeUndefined();
        expect(result.distanceM).toBeUndefined();
        expect(result.thresholdM).toBeUndefined();
      });

      it('lockless intermediate + hop ±1 매치 (경계) + 위치 미획득 → fallback pass', async () => {
        mockGetLastKnownPositionAsync.mockResolvedValue(null);
        mockGetCurrentPositionAsync.mockRejectedValue(new Error('denied'));
        const result = await checkSilentPushLocationGate({
          stationName: '강남',
          kind: 'intermediate',
          phase: 'imminent',
          isLockless: true,
          currentHopIndex: 5,
          payloadHopIndex: 4,
        });
        expect(result.pass).toBe(true);
        expect(result.passReason).toBe('hop-window-match');
      });

      it('lockless intermediate + hop diff ≥2 + 위치 미획득 → no-location skip (fallback 미적용)', async () => {
        mockGetLastKnownPositionAsync.mockResolvedValue(null);
        mockGetCurrentPositionAsync.mockRejectedValue(new Error('denied'));
        const result = await checkSilentPushLocationGate({
          stationName: '강남',
          kind: 'intermediate',
          phase: 'imminent',
          isLockless: true,
          currentHopIndex: 6,
          payloadHopIndex: 4,
        });
        expect(result.pass).toBe(false);
        expect(result.reason).toBe('no-location');
      });

      it('lockless + transfer kind + 위치 미획득 → fallback 미적용 (intermediate만 허용)', async () => {
        mockGetLastKnownPositionAsync.mockResolvedValue(null);
        mockGetCurrentPositionAsync.mockRejectedValue(new Error('denied'));
        const result = await checkSilentPushLocationGate({
          stationName: '강남',
          kind: 'transfer',
          phase: 'imminent',
          isLockless: true,
          currentHopIndex: 4,
          payloadHopIndex: 4,
        });
        expect(result.pass).toBe(false);
        expect(result.reason).toBe('no-location');
      });

      it('isLockless=false + 위치 미획득 + hop 매치 → fallback 미적용 (lock 활성 trip은 보수적)', async () => {
        mockGetLastKnownPositionAsync.mockResolvedValue(null);
        mockGetCurrentPositionAsync.mockRejectedValue(new Error('denied'));
        const result = await checkSilentPushLocationGate({
          stationName: '강남',
          kind: 'intermediate',
          phase: 'imminent',
          isLockless: false,
          currentHopIndex: 4,
          payloadHopIndex: 4,
        });
        expect(result.pass).toBe(false);
        expect(result.reason).toBe('no-location');
      });

      it('lockless intermediate + currentHopIndex 부재 + 위치 미획득 → no-location skip', async () => {
        mockGetLastKnownPositionAsync.mockResolvedValue(null);
        mockGetCurrentPositionAsync.mockRejectedValue(new Error('denied'));
        const result = await checkSilentPushLocationGate({
          stationName: '강남',
          kind: 'intermediate',
          phase: 'imminent',
          isLockless: true,
          payloadHopIndex: 4,
        });
        expect(result.pass).toBe(false);
        expect(result.reason).toBe('no-location');
      });

      it('lockless intermediate + payloadHopIndex 부재 + 위치 미획득 → no-location skip', async () => {
        mockGetLastKnownPositionAsync.mockResolvedValue(null);
        mockGetCurrentPositionAsync.mockRejectedValue(new Error('denied'));
        const result = await checkSilentPushLocationGate({
          stationName: '강남',
          kind: 'intermediate',
          phase: 'imminent',
          isLockless: true,
          currentHopIndex: 4,
        });
        expect(result.pass).toBe(false);
        expect(result.reason).toBe('no-location');
      });
    });

    it('lockless intermediate + payloadHopIndex만 제공(estimator 미연결) → widened distance 경로', async () => {
      mockGetLastKnownPositionAsync.mockResolvedValue(
        makePosition(MID_FROM_GANGNAM.lat, MID_FROM_GANGNAM.lng, 5_000),
      );
      const result = await checkSilentPushLocationGate({
        stationName: '강남',
        kind: 'intermediate',
        phase: 'imminent',
        isLockless: true,
        // currentHopIndex 미제공
        payloadHopIndex: 3,
      });
      expect(result.pass).toBe(true);
      expect(result.passReason).toBe('within-threshold');
      expect(result.thresholdM).toBe(800);
    });
  });

  // #1307 — subsurface(지하) intermediate 거리 검증 우회.
  describe('subsurface bypass (#1307)', () => {
    const runGate = (overrides: Partial<Parameters<typeof checkSilentPushLocationGate>[0]>) =>
      checkSilentPushLocationGate({
        stationName: '강남',
        kind: 'intermediate',
        phase: 'imminent',
        ...overrides,
      });

    // subsurface=true + intermediate면 위치 상태(out-of-range / stale / 미획득)와 무관하게 우회 pass.
    it.each([
      [
        'GPS out-of-range여도 bypass (cache source 노출)',
        () => mockGetLastKnownPositionAsync.mockResolvedValue(makePosition(FAR_FROM_GANGNAM.lat, FAR_FROM_GANGNAM.lng, 5_000)),
        'cache' as const,
      ],
      [
        '위치 stale(TTL 초과)여도 bypass',
        () => mockGetLastKnownPositionAsync.mockResolvedValue(makePosition(FAR_FROM_GANGNAM.lat, FAR_FROM_GANGNAM.lng, LOCATION_CACHE_TTL_MS + 10_000)),
        'cache' as const,
      ],
      [
        '위치 미획득여도 bypass (locationSource 부재)',
        () => {
          mockGetLastKnownPositionAsync.mockResolvedValue(null);
          mockGetCurrentPositionAsync.mockRejectedValue(new Error('denied'));
        },
        undefined,
      ],
    ])('subsurface=true + intermediate + %s', async (_label, setup, expectedSource) => {
      setup();
      const result = await runGate({ subsurface: true });
      expect(result.pass).toBe(true);
      expect(result.passReason).toBe('subsurface-bypass');
      expect(result.locationSource).toBe(expectedSource);
    });

    it('subsurface-bypass도 motion fields(speed/accuracy) 함께 노출', async () => {
      mockGetLastKnownPositionAsync.mockResolvedValue({
        coords: {
          latitude: FAR_FROM_GANGNAM.lat,
          longitude: FAR_FROM_GANGNAM.lng,
          accuracy: 18,
          altitude: null,
          heading: null,
          speed: 3.2,
          altitudeAccuracy: null,
        },
        timestamp: Date.now() - 5_000,
      });
      const result = await runGate({ subsurface: true });
      expect(result.pass).toBe(true);
      expect(result.passReason).toBe('subsurface-bypass');
      expect(result.speedMps).toBe(3.2);
      expect(result.accuracyM).toBe(18);
    });

    // transfer/destination은 misfire 방지로 bypass 미적용. intermediate라도 subsurface 미지정이면 미적용.
    it.each([
      ['subsurface=true + transfer는 미적용 (기존 게이트)', { kind: 'transfer' as const, subsurface: true }],
      ['subsurface=true + destination은 미적용 (기존 게이트)', { kind: 'destination' as const, subsurface: true }],
      ['subsurface 미지정 + intermediate는 미적용 (no bypass)', {}],
    ])('out-of-range로 skip — %s', async (_label, overrides) => {
      mockGetLastKnownPositionAsync.mockResolvedValue(
        makePosition(FAR_FROM_GANGNAM.lat, FAR_FROM_GANGNAM.lng, 5_000),
      );
      const result = await runGate(overrides);
      expect(result.pass).toBe(false);
      expect(result.reason).toBe('out-of-range');
    });
  });
});
