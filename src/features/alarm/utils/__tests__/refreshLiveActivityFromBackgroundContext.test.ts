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

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// stations.json은 lookup 경로에서만 호출. 최소 fixture로 lockFallbackStation 분기를 검증.
jest.mock('../../../../data/stations.json', () => [
  { id: '0228', name: '강남', line: '2', lat: 37.5, lng: 127.0 },
]);

import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  refreshLiveActivityFromBackgroundContext,
  __test__,
} from '../refreshLiveActivityFromBackgroundContext';
import {
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

  });
});
