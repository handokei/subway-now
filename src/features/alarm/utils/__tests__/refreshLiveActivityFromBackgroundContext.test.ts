jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
}));

const mockIsLiveActivityEnabled = jest.fn(() => true);
const mockUpdateLiveActivity = jest.fn().mockResolvedValue(undefined);
const mockEndLiveActivity = jest.fn().mockResolvedValue(undefined);
jest.mock('live-activity', () => ({
  isLiveActivityEnabled: () => mockIsLiveActivityEnabled(),
  updateLiveActivity: (...args: unknown[]) => mockUpdateLiveActivity(...args),
  endLiveActivity: () => mockEndLiveActivity(),
}));

// buildLiveActivityData는 의존이 무거우므로 mock로 격리. 호출 시 인자 검증.
const mockBuild = jest.fn((..._args: unknown[]) => ({
  stationName: 'STN',
  lineName: 'L',
  lineColorHex: '#000',
  distanceM: 0,
}));
jest.mock('../stationNotification', () => ({
  buildLiveActivityData: (...args: unknown[]) => mockBuild(...args),
}));

// #926 — LA dismiss sentinel은 본 모듈의 독립 유닛 테스트(`laDismissSentinel.test.ts`)에서
// 검증한다. 여기서는 wire-up만 격리 검증 — sentinel 활성 시 LA refresh가 skip되는지.
const mockIsLaDismissed = jest.fn(async () => false);
jest.mock('../laDismissSentinel', () => ({
  isLaDismissed: () => mockIsLaDismissed(),
}));

// #2481 — 기본값 false(=device가 계속 쓴다). 게이트 로직 자체는 liveActivityPushChannel.test.ts가
// 단독 검증하고, 여기서는 refreshLiveActivityFromBackgroundContext가 판정 결과를 존중해 조기
// return하는지만 wire-up 검증한다.
const mockShouldSkipDeviceLiveActivityWrite = jest.fn((..._args: unknown[]) => false);
jest.mock('../liveActivityPushChannel', () => ({
  shouldSkipDeviceLiveActivityWrite: (...args: unknown[]) =>
    mockShouldSkipDeviceLiveActivityWrite(...args),
}));

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// #2589 — backend SSoT mirror 채택 경로 mock.
const mockReadBackendSsotMirror = jest.fn(async () => null as unknown);
jest.mock('../backendSsotMirror', () => ({
  readBackendSsotMirror: () => mockReadBackendSsotMirror(),
}));

// stations.json은 lookup 경로에서만 호출. 최소 fixture로 lockFallbackStation 분기를 검증.
// 성수: mirror가 실제와 다른 line('7')을 실어도 resolveConsistentStationLine이 실제 line('2')로
// 교정하는지 검증하는 fixture(#2556 성수 7호선색 클래스).
jest.mock('../../../../data/stations.json', () => [
  { id: '0228', name: '강남', line: '2', lat: 37.5, lng: 127.0 },
  { id: '0328', name: '성수', line: '2', lat: 37.54, lng: 127.05 },
]);

import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  refreshLiveActivityFromBackgroundContext,
  __test__,
} from '../refreshLiveActivityFromBackgroundContext';
import {
  ACTIVE_TRIP_KEY,
  BG_LAST_STATION_KEY,
  DESTINATION_KEY,
  ROUTE_KEY,
} from '../../../../shared/constants/storageKeys';

const destination = { id: '0228', name: '강남', line: '2', lat: 37.5, lng: 127.0 };
const bgStation = {
  station: { id: '0226', name: '역삼', line: '2', lat: 37.5, lng: 127.04 },
  distanceKm: 0.15,
  timestamp: 1_700_000_000_000,
};
const directRoute = { type: 'direct', line: '2', stops: 1 };

/** AsyncStorage.getItem mock helper — key→value 테이블 주도. */
function setupStorage(values: Partial<Record<string, string | null>>): void {
  (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
    return values[key] ?? null;
  });
}

describe('refreshLiveActivityFromBackgroundContext', () => {
  const originalOs = Platform.OS;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsLiveActivityEnabled.mockReturnValue(true);
    mockIsLaDismissed.mockResolvedValue(false);
    mockReadBackendSsotMirror.mockResolvedValue(null);
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: originalOs, configurable: true });
  });

  it('non-iOS면 즉시 no-op', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    await refreshLiveActivityFromBackgroundContext();
    expect(AsyncStorage.getItem).not.toHaveBeenCalled();
    expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
    expect(mockEndLiveActivity).not.toHaveBeenCalled();
  });

  it('LA disabled면 storage조차 읽지 않는다', async () => {
    mockIsLiveActivityEnabled.mockReturnValue(false);
    await refreshLiveActivityFromBackgroundContext();
    expect(AsyncStorage.getItem).not.toHaveBeenCalled();
  });

  it('#926 — dismiss sentinel 활성이면 storage 읽기 전에 skip (LA 안 살림)', async () => {
    mockIsLaDismissed.mockResolvedValueOnce(true);
    await refreshLiveActivityFromBackgroundContext();
    expect(AsyncStorage.getItem).not.toHaveBeenCalled();
    expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
    expect(mockEndLiveActivity).not.toHaveBeenCalled();
  });

  it('destination 없으면 endLiveActivity 호출', async () => {
    setupStorage({ [DESTINATION_KEY]: null });
    await refreshLiveActivityFromBackgroundContext();
    expect(mockEndLiveActivity).toHaveBeenCalledTimes(1);
    expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
  });

  it('destination JSON 손상이면 endLiveActivity', async () => {
    setupStorage({ [DESTINATION_KEY]: '{{ broken' });
    await refreshLiveActivityFromBackgroundContext();
    expect(mockEndLiveActivity).toHaveBeenCalledTimes(1);
  });

  it('destination에 id 없으면 endLiveActivity', async () => {
    setupStorage({ [DESTINATION_KEY]: JSON.stringify({ name: 'x' }) });
    await refreshLiveActivityFromBackgroundContext();
    expect(mockEndLiveActivity).toHaveBeenCalledTimes(1);
  });

  it('bg 없으면 no-op (마지막 상태 유지)', async () => {
    setupStorage({
      [DESTINATION_KEY]: JSON.stringify(destination),
      [BG_LAST_STATION_KEY]: null,
      [ROUTE_KEY]: null,
    });
    await refreshLiveActivityFromBackgroundContext();
    expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
    expect(mockEndLiveActivity).not.toHaveBeenCalled();
  });

  it('bg 있으면 1순위로 station/distance 결정 + updateLiveActivity', async () => {
    setupStorage({
      [DESTINATION_KEY]: JSON.stringify(destination),
      [BG_LAST_STATION_KEY]: JSON.stringify(bgStation),
      [ROUTE_KEY]: JSON.stringify(directRoute),
    });
    await refreshLiveActivityFromBackgroundContext();
    expect(mockBuild).toHaveBeenCalledTimes(1);
    const [station, distanceM, dest, route, eta, isMock, alarm] = mockBuild.mock.calls[0];
    expect(station).toEqual(bgStation.station);
    expect(distanceM).toBe(150); // 0.15 km → 150 m
    expect(dest).toEqual(destination);
    expect(route).toEqual(directRoute);
    expect(eta).toBeNull();
    expect(isMock).toBe(false);
    expect(alarm).toBeNull();
    expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
  });

  // #2481 — backend-authority(dogfood 플래그 OFF) + backend가 이 trip의 LA push 채널을 이미
  // 쥐고 있으면(shouldSkipDeviceLiveActivityWrite=true) BG silent-push refresh는 LA content를
  // 전혀 쓰지 않는다 — backend push가 단독 저자(Wave 2). 이게 이 파일이 고치는 W3 writer다.
  describe('#2481 backend-authority device 쓰기 억제 게이트', () => {
    it('게이트가 true를 반환하면 buildLiveActivityData/updateLiveActivity 둘 다 호출 안 함', async () => {
      setupStorage({
        [DESTINATION_KEY]: JSON.stringify(destination),
        [BG_LAST_STATION_KEY]: JSON.stringify(bgStation),
        [ROUTE_KEY]: JSON.stringify(directRoute),
        [ACTIVE_TRIP_KEY]: 'apns-token-abc',
      });
      mockShouldSkipDeviceLiveActivityWrite.mockReturnValueOnce(true);
      await refreshLiveActivityFromBackgroundContext();
      expect(mockShouldSkipDeviceLiveActivityWrite).toHaveBeenCalledWith('apns-token-abc');
      expect(mockBuild).not.toHaveBeenCalled();
      expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
    });

    it('게이트가 false면(기본값) 기존처럼 updateLiveActivity로 계속 진행 — blank LA 방지', async () => {
      setupStorage({
        [DESTINATION_KEY]: JSON.stringify(destination),
        [BG_LAST_STATION_KEY]: JSON.stringify(bgStation),
        [ROUTE_KEY]: JSON.stringify(directRoute),
        [ACTIVE_TRIP_KEY]: null,
      });
      await refreshLiveActivityFromBackgroundContext();
      expect(mockShouldSkipDeviceLiveActivityWrite).toHaveBeenCalledWith(null);
      expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
    });
  });

  it('bg 없으면 no-op (마지막 정상 LA 유지) — updateLiveActivity 미호출', async () => {
    // P1 #1 + #3 가드: bg 부재 시 boardingLock fallback으로 stale "탑승역" 표시 + 활성 LA 없는데
    // updateLiveActivity가 새 LA 시작하는 사고를 동시에 차단.
    setupStorage({
      [DESTINATION_KEY]: JSON.stringify(destination),
      [BG_LAST_STATION_KEY]: null,
    });
    await refreshLiveActivityFromBackgroundContext();
    expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
  });

  it('bg JSON 손상은 null처럼 처리 → no-op', async () => {
    setupStorage({
      [DESTINATION_KEY]: JSON.stringify(destination),
      [BG_LAST_STATION_KEY]: '{{ broken',
    });
    await refreshLiveActivityFromBackgroundContext();
    expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
  });

  it('route JSON 손상은 route=null로 진행 (LA 갱신 계속)', async () => {
    setupStorage({
      [DESTINATION_KEY]: JSON.stringify(destination),
      [BG_LAST_STATION_KEY]: JSON.stringify(bgStation),
      [ROUTE_KEY]: '{{ broken',
    });
    await refreshLiveActivityFromBackgroundContext();
    const [, , , route] = mockBuild.mock.calls[0];
    expect(route).toBeNull();
    expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
  });

  it('AsyncStorage 자체가 throw해도 caller로 전파 안 함', async () => {
    (AsyncStorage.getItem as jest.Mock).mockRejectedValue(new Error('IO'));
    await expect(refreshLiveActivityFromBackgroundContext()).resolves.toBeUndefined();
  });

  it('updateLiveActivity throw도 graceful', async () => {
    setupStorage({
      [DESTINATION_KEY]: JSON.stringify(destination),
      [BG_LAST_STATION_KEY]: JSON.stringify(bgStation),
    });
    mockUpdateLiveActivity.mockRejectedValueOnce(new Error('native'));
    await expect(refreshLiveActivityFromBackgroundContext()).resolves.toBeUndefined();
  });

  it('endLiveActivity throw도 graceful', async () => {
    setupStorage({ [DESTINATION_KEY]: null });
    mockEndLiveActivity.mockRejectedValueOnce(new Error('native'));
    await expect(refreshLiveActivityFromBackgroundContext()).resolves.toBeUndefined();
  });

  // #2589 — backend SSoT mirror 1순위 채택 (확정 아키텍처: backend추적 → LA 표시).
  describe('#2589 backend SSoT mirror 1순위 채택', () => {
    const freshMirror = {
      currentStationId: '성수',
      currentStationLine: '7', // 실제 stations.json fixture의 성수는 2호선 — 정합 가드 검증용
      motionState: 'moving' as const,
      lastAdvanceEvidence: 'seed',
      lastAdvanceAt: 1_700_000_000_000,
      passedStations: [],
      receivedAt: Date.now(),
    };

    it('mirror fresh + station resolve 성공 → GPS(BG_LAST_STATION)와 달라도 mirror 역을 채택, distanceM=0', async () => {
      mockReadBackendSsotMirror.mockResolvedValue(freshMirror);
      setupStorage({
        [DESTINATION_KEY]: JSON.stringify(destination),
        [BG_LAST_STATION_KEY]: JSON.stringify(bgStation), // GPS는 역삼(집) — mirror와 다름
        [ROUTE_KEY]: JSON.stringify(directRoute),
      });
      await refreshLiveActivityFromBackgroundContext();
      const [station, distanceM] = mockBuild.mock.calls[0];
      // #2556 정합 가드: mirror line('7')이 실제 성수 서비스 노선이 아니므로 실제 line('2')로 교정.
      expect(station).toEqual({ id: '0328', name: '성수', line: '2', lat: 37.54, lng: 127.05 });
      expect(distanceM).toBe(0);
      expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
    });

    it('mirror stale(>180s) → BG_LAST_STATION으로 폴백', async () => {
      mockReadBackendSsotMirror.mockResolvedValue({
        ...freshMirror,
        receivedAt: Date.now() - 200_000, // 200s > 180s
      });
      setupStorage({
        [DESTINATION_KEY]: JSON.stringify(destination),
        [BG_LAST_STATION_KEY]: JSON.stringify(bgStation),
        [ROUTE_KEY]: JSON.stringify(directRoute),
      });
      await refreshLiveActivityFromBackgroundContext();
      const [station, distanceM] = mockBuild.mock.calls[0];
      expect(station).toEqual(bgStation.station);
      expect(distanceM).toBe(150);
    });

    it('mirror 부재(null) → legacy 경로(BG_LAST_STATION) 불변', async () => {
      mockReadBackendSsotMirror.mockResolvedValue(null);
      setupStorage({
        [DESTINATION_KEY]: JSON.stringify(destination),
        [BG_LAST_STATION_KEY]: JSON.stringify(bgStation),
        [ROUTE_KEY]: JSON.stringify(directRoute),
      });
      await refreshLiveActivityFromBackgroundContext();
      const [station] = mockBuild.mock.calls[0];
      expect(station).toEqual(bgStation.station);
    });

    it('mirror fresh이나 station name이 stations.json에 없음 → BG_LAST_STATION 폴백', async () => {
      mockReadBackendSsotMirror.mockResolvedValue({
        ...freshMirror,
        currentStationId: '존재하지않는역',
        currentStationLine: undefined,
      });
      setupStorage({
        [DESTINATION_KEY]: JSON.stringify(destination),
        [BG_LAST_STATION_KEY]: JSON.stringify(bgStation),
        [ROUTE_KEY]: JSON.stringify(directRoute),
      });
      await refreshLiveActivityFromBackgroundContext();
      const [station] = mockBuild.mock.calls[0];
      expect(station).toEqual(bgStation.station);
    });

    it('mirror fresh + BG_LAST_STATION 둘 다 없음 → mirror 채택', async () => {
      mockReadBackendSsotMirror.mockResolvedValue(freshMirror);
      setupStorage({
        [DESTINATION_KEY]: JSON.stringify(destination),
        [BG_LAST_STATION_KEY]: null,
        [ROUTE_KEY]: null,
      });
      await refreshLiveActivityFromBackgroundContext();
      const [station] = mockBuild.mock.calls[0];
      expect(station).toEqual({ id: '0328', name: '성수', line: '2', lat: 37.54, lng: 127.05 });
      expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
    });

    it('mirror stale + BG_LAST_STATION 둘 다 없음 → no-op (기존 안전장치 유지)', async () => {
      mockReadBackendSsotMirror.mockResolvedValue({
        ...freshMirror,
        receivedAt: Date.now() - 200_000,
      });
      setupStorage({
        [DESTINATION_KEY]: JSON.stringify(destination),
        [BG_LAST_STATION_KEY]: null,
      });
      await refreshLiveActivityFromBackgroundContext();
      expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
    });

    it('mirror currentStationLine 부재(legacy v1) + 정상 역명 → name-only resolve로 채택', async () => {
      mockReadBackendSsotMirror.mockResolvedValue({
        ...freshMirror,
        currentStationId: '강남',
        currentStationLine: undefined,
      });
      setupStorage({
        [DESTINATION_KEY]: JSON.stringify(destination),
        [BG_LAST_STATION_KEY]: JSON.stringify(bgStation),
        [ROUTE_KEY]: null,
      });
      await refreshLiveActivityFromBackgroundContext();
      const [station] = mockBuild.mock.calls[0];
      expect(station).toEqual(destination);
    });

    it('#2481 backend-authority skip 게이트는 mirror 채택 이후에도 적용된다', async () => {
      mockReadBackendSsotMirror.mockResolvedValue(freshMirror);
      setupStorage({
        [DESTINATION_KEY]: JSON.stringify(destination),
        [BG_LAST_STATION_KEY]: JSON.stringify(bgStation),
        [ROUTE_KEY]: JSON.stringify(directRoute),
        [ACTIVE_TRIP_KEY]: 'apns-token-abc',
      });
      mockShouldSkipDeviceLiveActivityWrite.mockReturnValueOnce(true);
      await refreshLiveActivityFromBackgroundContext();
      expect(mockBuild).not.toHaveBeenCalled();
      expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
    });
  });

  // ── __test__ helper 직접 검증 ──
  describe('__test__ helpers', () => {
    it('readDestination — 정상/손상/id누락 분기', () => {
      expect(__test__.readDestination(JSON.stringify(destination))).toEqual(destination);
      expect(__test__.readDestination(null)).toBeNull();
      expect(__test__.readDestination('{')).toBeNull();
      expect(__test__.readDestination(JSON.stringify({ name: 'x' }))).toBeNull();
    });

    it('readBgLastStation — 정상/손상/필드 누락 분기', () => {
      expect(__test__.readBgLastStation(JSON.stringify(bgStation))).toEqual(bgStation);
      expect(__test__.readBgLastStation(null)).toBeNull();
      expect(__test__.readBgLastStation('{')).toBeNull();
      expect(__test__.readBgLastStation(JSON.stringify({ distanceKm: 0.1 }))).toBeNull();
      expect(__test__.readBgLastStation(JSON.stringify({ station: { id: 's' } }))).toBeNull();
    });

    it('resolveMirrorStation — line 있음/정합가드 교정/line 없음(legacy)/역명 미존재', () => {
      expect(
        __test__.resolveMirrorStation({
          currentStationId: '강남',
          currentStationLine: '2',
          motionState: 'moving',
          lastAdvanceEvidence: 'seed',
          lastAdvanceAt: 0,
          passedStations: [],
          receivedAt: 0,
        }),
      ).toEqual({ id: '0228', name: '강남', line: '2', lat: 37.5, lng: 127.0 });

      // #2556 정합 가드 — mirror line('7')이 실제 서비스 노선이 아니면 실제 line('2')로 교정.
      expect(
        __test__.resolveMirrorStation({
          currentStationId: '성수',
          currentStationLine: '7',
          motionState: 'moving',
          lastAdvanceEvidence: 'seed',
          lastAdvanceAt: 0,
          passedStations: [],
          receivedAt: 0,
        }),
      ).toEqual({ id: '0328', name: '성수', line: '2', lat: 37.54, lng: 127.05 });

      // legacy v1 mirror — currentStationLine 부재 시 name-only.
      expect(
        __test__.resolveMirrorStation({
          currentStationId: '강남',
          motionState: 'moving',
          lastAdvanceEvidence: 'seed',
          lastAdvanceAt: 0,
          passedStations: [],
          receivedAt: 0,
        }),
      ).toEqual({ id: '0228', name: '강남', line: '2', lat: 37.5, lng: 127.0 });

      // 역명 자체가 stations.json에 없음 → null.
      expect(
        __test__.resolveMirrorStation({
          currentStationId: '존재하지않는역',
          motionState: 'moving',
          lastAdvanceEvidence: 'seed',
          lastAdvanceAt: 0,
          passedStations: [],
          receivedAt: 0,
        }),
      ).toBeNull();
    });
  });
});
