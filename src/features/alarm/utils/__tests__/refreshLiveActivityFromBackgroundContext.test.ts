jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
}));

const mockIsLiveActivityEnabled = jest.fn(() => true);
const mockUpdateLiveActivity = jest.fn().mockResolvedValue(undefined);
const mockEndLiveActivity = jest.fn().mockResolvedValue(undefined);
// #2589 (code review 3번) — 활성 LA 존재 여부. 기본 true — 기존(mirror 도입 전) 테스트가
// 이 게이트로 인해 영향받지 않도록. mirror-sourced update-only 가드 테스트에서만 false로 override.
const mockHasActiveLiveActivity = jest.fn(() => true);
jest.mock('live-activity', () => ({
  isLiveActivityEnabled: () => mockIsLiveActivityEnabled(),
  updateLiveActivity: (...args: unknown[]) => mockUpdateLiveActivity(...args),
  endLiveActivity: () => mockEndLiveActivity(),
  hasActiveLiveActivity: () => mockHasActiveLiveActivity(),
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

// #2589 — backend SSoT mirror 채택 경로 mock. readBackendSsotMirror만 mock하고
// resolveBackendSsotMirrorStation은 실제 구현(순수 함수, stationLookup 경유)을 그대로 사용 —
// FG(useFusedNearestStation)와 동일 함수를 이 파일도 소비한다는 것 자체를 검증하려면 mock으로
// 대체하지 않아야 한다(code review 2번 — 판정 3중 구현 해소).
const mockReadBackendSsotMirror = jest.fn(async () => null as unknown);
jest.mock('../backendSsotMirror', () => ({
  ...jest.requireActual('../backendSsotMirror'),
  readBackendSsotMirror: () => mockReadBackendSsotMirror(),
}));

// stations.json은 lookup 경로에서만 호출. 최소 fixture로 station resolve 분기를 검증.
// 성수: 실제 서비스 line은 '2'뿐 — mirror가 '7'을 실으면 resolveBackendSsotMirrorStation이
// "보정"이 아니라 "거부"하는지 검증하는 fixture(#2556 성수 7호선색 클래스, #2589 code review 1번).
jest.mock('../../../../data/stations.json', () => [
  { id: '0228', name: '강남', line: '2', lat: 37.5, lng: 127.0 },
  { id: '0328', name: '성수', line: '2', lat: 37.54, lng: 127.05 },
]);

import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  refreshLiveActivityFromBackgroundContext,
  refreshLiveActivityOnMirrorAdvance,
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
    mockHasActiveLiveActivity.mockReturnValue(true);
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
    // 성수는 fixture 기준 실제 line이 '2'뿐 — 이 값으로 correct-line 케이스를 구성.
    const freshMirrorCorrectLine = {
      currentStationId: '성수',
      currentStationLine: '2',
      motionState: 'moving' as const,
      lastAdvanceEvidence: 'seed',
      lastAdvanceAt: 1_700_000_000_000,
      passedStations: [],
      receivedAt: Date.now(),
    };

    it('mirror fresh + line 일치 + 활성 LA 있음 → GPS(BG_LAST_STATION)와 달라도 mirror 역을 채택, distanceM=0', async () => {
      mockReadBackendSsotMirror.mockResolvedValue(freshMirrorCorrectLine);
      setupStorage({
        [DESTINATION_KEY]: JSON.stringify(destination),
        [BG_LAST_STATION_KEY]: JSON.stringify(bgStation), // GPS는 역삼(집) — mirror와 다름
        [ROUTE_KEY]: JSON.stringify(directRoute),
      });
      await refreshLiveActivityFromBackgroundContext();
      const [station, distanceM] = mockBuild.mock.calls[0];
      expect(station).toEqual({ id: '0328', name: '성수', line: '2', lat: 37.54, lng: 127.05 });
      expect(distanceM).toBe(0);
      expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
    });

    // #2589 code review 1/2번 — line 불일치는 "보정"이 아니라 "거부". FG cascade picker와 동일
    // resolveBackendSsotMirrorStation을 소비하므로 실제 구현(mock 아님)이 거부하는지 검증.
    it('mirror fresh 이나 line 불일치(성수 7호선 클래스, #2556) → 거부되어 BG_LAST_STATION 폴백', async () => {
      mockReadBackendSsotMirror.mockResolvedValue({
        ...freshMirrorCorrectLine,
        currentStationLine: '7', // 성수의 실제 서비스 line이 아님
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

    it('mirror stale(>180s) → BG_LAST_STATION으로 폴백', async () => {
      mockReadBackendSsotMirror.mockResolvedValue({
        ...freshMirrorCorrectLine,
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
        ...freshMirrorCorrectLine,
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

    it('mirror fresh + line 일치 + BG_LAST_STATION 둘 다 없음 → mirror 채택', async () => {
      mockReadBackendSsotMirror.mockResolvedValue(freshMirrorCorrectLine);
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
        ...freshMirrorCorrectLine,
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
        ...freshMirrorCorrectLine,
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

    it('#2481/#2659 backend-authority skip 게이트는 GPS 분기에만 적용된다 (mirror 부재 시 차단)', async () => {
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

    it('#2659 backend-authority 활성이어도 mirror 분기는 진행된다 (LA writer가 push 단일 채널로 좁혀지지 않도록)', async () => {
      mockReadBackendSsotMirror.mockResolvedValue(freshMirrorCorrectLine);
      setupStorage({
        [DESTINATION_KEY]: JSON.stringify(destination),
        [BG_LAST_STATION_KEY]: JSON.stringify(bgStation),
        [ROUTE_KEY]: JSON.stringify(directRoute),
        [ACTIVE_TRIP_KEY]: 'apns-token-abc',
      });
      mockShouldSkipDeviceLiveActivityWrite.mockReturnValueOnce(true);
      await refreshLiveActivityFromBackgroundContext();
      expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
    });

    // #2589 code review 3번 (P1 #1 클래스) — mirror-sourced 경로는 update-only.
    describe('mirror-sourced update-only 가드 (활성 LA 없으면 새로 만들지 않음)', () => {
      it('mirror 채택되었으나 활성 LA 없음 → updateLiveActivity 호출 안 함 (no-op)', async () => {
        mockReadBackendSsotMirror.mockResolvedValue(freshMirrorCorrectLine);
        mockHasActiveLiveActivity.mockReturnValue(false);
        setupStorage({
          [DESTINATION_KEY]: JSON.stringify(destination),
          [BG_LAST_STATION_KEY]: JSON.stringify(bgStation),
          [ROUTE_KEY]: JSON.stringify(directRoute),
        });
        await refreshLiveActivityFromBackgroundContext();
        expect(mockBuild).not.toHaveBeenCalled();
        expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
      });

      it('mirror 채택 + 활성 LA 있음 → 정상 update (기존 동작)', async () => {
        mockReadBackendSsotMirror.mockResolvedValue(freshMirrorCorrectLine);
        mockHasActiveLiveActivity.mockReturnValue(true);
        setupStorage({
          [DESTINATION_KEY]: JSON.stringify(destination),
          [BG_LAST_STATION_KEY]: JSON.stringify(bgStation),
          [ROUTE_KEY]: JSON.stringify(directRoute),
        });
        await refreshLiveActivityFromBackgroundContext();
        expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
      });

      it('BG_LAST_STATION(gps-bg) 경로는 활성 LA 없어도 기존처럼 update 호출 — 현행 보존', async () => {
        mockReadBackendSsotMirror.mockResolvedValue(null);
        mockHasActiveLiveActivity.mockReturnValue(false);
        setupStorage({
          [DESTINATION_KEY]: JSON.stringify(destination),
          [BG_LAST_STATION_KEY]: JSON.stringify(bgStation),
          [ROUTE_KEY]: JSON.stringify(directRoute),
        });
        await refreshLiveActivityFromBackgroundContext();
        const [station] = mockBuild.mock.calls[0];
        expect(station).toEqual(bgStation.station);
        expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
      });
    });
  });

  // #2659 — push-독립 트리거. "silent push 0건 + HTTP(/position) 정상" 조건에서 LA가 전진하는가.
  describe('#2659 refreshLiveActivityOnMirrorAdvance (push-독립 트리거)', () => {
    const mirrorAt = (currentStationId: string) => ({
      currentStationId,
      currentStationLine: '2',
      motionState: 'moving' as const,
      lastAdvanceEvidence: 'cron',
      lastAdvanceAt: 1_700_000_000_000,
      passedStations: [],
      receivedAt: Date.now(),
    });

    beforeEach(() => {
      __test__.resetMirrorAdvanceDedup();
      setupStorage({
        [DESTINATION_KEY]: JSON.stringify(destination),
        [BG_LAST_STATION_KEY]: JSON.stringify(bgStation),
        [ROUTE_KEY]: JSON.stringify(directRoute),
        [ACTIVE_TRIP_KEY]: 'apns-token-abc',
      });
    });

    it('mirror가 전진하면 silent push 없이도 LA를 갱신한다', async () => {
      mockReadBackendSsotMirror.mockResolvedValue(mirrorAt('성수'));
      await refreshLiveActivityOnMirrorAdvance();
      expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
    });

    it('같은 역이 반복되면 no-op — BG tick(~10s)마다 native update를 부르지 않는다', async () => {
      mockReadBackendSsotMirror.mockResolvedValue(mirrorAt('성수'));
      await refreshLiveActivityOnMirrorAdvance();
      await refreshLiveActivityOnMirrorAdvance();
      expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
    });

    it('mirror 부재/stale이면 no-op이고 dedup 기억이 비워져 다음 trip 첫 전진을 놓치지 않는다', async () => {
      mockReadBackendSsotMirror.mockResolvedValue(mirrorAt('성수'));
      await refreshLiveActivityOnMirrorAdvance();
      mockReadBackendSsotMirror.mockResolvedValue(null);
      await refreshLiveActivityOnMirrorAdvance();
      expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
      mockReadBackendSsotMirror.mockResolvedValue(mirrorAt('성수'));
      await refreshLiveActivityOnMirrorAdvance();
      expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(2);
    });

    it('환승(역명 동일, 노선만 전진)도 전진으로 인식한다 — dedup 키가 역명:노선 (code review P1-2)', async () => {
      // GPS 폴백을 막아 "트리거가 실제로 발화했는가"만 update 호출로 관측되게 한다.
      setupStorage({
        [DESTINATION_KEY]: JSON.stringify(destination),
        [BG_LAST_STATION_KEY]: null,
        [ROUTE_KEY]: JSON.stringify(directRoute),
      });
      mockReadBackendSsotMirror.mockResolvedValue({ ...mirrorAt('강남'), currentStationLine: '2' });
      await refreshLiveActivityOnMirrorAdvance();
      expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
      // 역명은 같고 노선 정보만 달라진 mirror — 이름만 비교하는 dedup이면 여기서 LA가 안 깨어난다.
      mockReadBackendSsotMirror.mockResolvedValue({
        ...mirrorAt('강남'),
        currentStationLine: undefined,
      });
      await refreshLiveActivityOnMirrorAdvance();
      expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(2);
    });

    it('stale mirror(수명 초과)도 no-op', async () => {
      mockReadBackendSsotMirror.mockResolvedValue({
        ...mirrorAt('성수'),
        receivedAt: Date.now() - 10 * 60_000,
      });
      await refreshLiveActivityOnMirrorAdvance();
      expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
    });

    it('non-iOS면 mirror read조차 하지 않는다', async () => {
      Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
      await refreshLiveActivityOnMirrorAdvance();
      expect(mockReadBackendSsotMirror).not.toHaveBeenCalled();
    });

    it('mirror read가 throw해도 BG task 흐름을 깨지 않는다 (graceful)', async () => {
      mockReadBackendSsotMirror.mockRejectedValueOnce(new Error('storage down'));
      await expect(refreshLiveActivityOnMirrorAdvance()).resolves.toBeUndefined();
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
  });
});
