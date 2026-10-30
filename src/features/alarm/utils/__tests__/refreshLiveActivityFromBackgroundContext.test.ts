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

// #3221 PR-4 — 탑승 LA 종료 호출 검증용. 채널 자체는 boardingActivityChannel.test.ts에서 검증한다.
const mockEndBoardingActivity = jest.fn().mockResolvedValue(undefined);
jest.mock('../boardingActivityChannel', () => ({
  endBoardingActivity: (...args: unknown[]) => mockEndBoardingActivity(...args),
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
// #3163 후속 P1-b — FG 복귀 없는 BG-only trip에서도 LA 토큰 불변식을 복구하는 진입점.
const mockReconcileLiveActivityToken = jest.fn((..._args: unknown[]) => Promise.resolve());
// #2735 PR-4 — 침묵 판정 뒤 device 쓰기에 붙일 출처(ADR-041 결정 4). 기본 undefined(=붙이지 않음).
const mockResolveDeviceFallbackSource = jest.fn(async (..._args: unknown[]) => undefined as string | undefined);
jest.mock('../liveActivityPushChannel', () => ({
  shouldSkipDeviceLiveActivityWrite: (...args: unknown[]) =>
    mockShouldSkipDeviceLiveActivityWrite(...args),
  resolveDeviceFallbackSource: (...args: unknown[]) => mockResolveDeviceFallbackSource(...args),
  reconcileLiveActivityToken: (...args: unknown[]) => mockReconcileLiveActivityToken(...args),
}));

const mockLoggerInfo = jest.fn();
jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// #2735 PR-1 — 결정 행/writer 행 적재 관측. 나머지 alarmLog는 실제 구현 유지.
const mockLogLaRefreshDecision = jest.fn();
const mockLogLaWrite = jest.fn();
jest.mock('../alarmLog', () => ({
  ...jest.requireActual('../alarmLog'),
  logLaRefreshDecision: (...args: unknown[]) => mockLogLaRefreshDecision(...args),
  logLaWrite: (...args: unknown[]) => mockLogLaWrite(...args),
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
// #2732 gap1 — 뚝섬을 추가해 3역 arc(강남→성수→뚝섬)를 구성. tail-stuck 회귀 가드
// (isBackendSsotRouteRegression) 테스트가 실제 경로 순서를 필요로 한다.
jest.mock('../../../../data/stations.json', () => [
  { id: '0228', name: '강남', line: '2', lat: 37.5, lng: 127.0 },
  { id: '0328', name: '성수', line: '2', lat: 37.54, lng: 127.05 },
  { id: '0329', name: '뚝섬', line: '2', lat: 37.547, lng: 127.047 },
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
  TRIP_ORIGIN_KEY,
} from '../../../../shared/constants/storageKeys';

const destination = { id: '0228', name: '강남', line: '2', lat: 37.5, lng: 127.0 };
const bgStation = {
  station: { id: '0226', name: '역삼', line: '2', lat: 37.5, lng: 127.04 },
  distanceKm: 0.15,
  // #2589 PR-5 — gps-bg 분기는 bg.timestamp 나이 상한(60s)이 생겼다. 고정 과거값이면 항상 stale이라
  // "쓰기" 테스트가 성립하지 않으므로 모듈 로드 시각(테스트 파일 실행 동안 상한 안쪽)을 쓴다.
  timestamp: Date.now(),
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

  it('#3163 P1-b — BG refresh 진입 시 토큰 복구를 data 없이(재생성 금지) 호출한다', async () => {
    await refreshLiveActivityFromBackgroundContext();
    expect(mockReconcileLiveActivityToken).toHaveBeenCalledTimes(1);
    expect(mockReconcileLiveActivityToken).toHaveBeenCalledWith();
  });

  it('#3163 P1-b [거부] LA disabled / dismiss sentinel 활성이면 토큰 복구도 하지 않는다', async () => {
    mockIsLiveActivityEnabled.mockReturnValue(false);
    await refreshLiveActivityFromBackgroundContext();
    mockIsLiveActivityEnabled.mockReturnValue(true);
    mockIsLaDismissed.mockResolvedValue(true);
    await refreshLiveActivityFromBackgroundContext();
    expect(mockReconcileLiveActivityToken).not.toHaveBeenCalled();
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

  // #3221 PR-4 — 종료 3곳 중 3: BG refresh의 trip 종료(destination·활성 trip 모두 없음) 판정도 탑승 LA를 닫는다.
  it('#3221 — destination·ACTIVE_TRIP 모두 없으면 탑승 LA도 종료 (B4 bg-refresh-dest-absent)', async () => {
    setupStorage({ [DESTINATION_KEY]: null, [ACTIVE_TRIP_KEY]: null });
    await refreshLiveActivityFromBackgroundContext();
    expect(mockEndBoardingActivity).toHaveBeenCalledTimes(1);
    expect(mockEndBoardingActivity).toHaveBeenCalledWith('bg-refresh-dest-absent');
  });

  it('#3221 — 활성 trip 중 destination read 실패(#2732 gap2 race guard)에서는 탑승 LA를 닫지 않는다', async () => {
    setupStorage({ [DESTINATION_KEY]: null, [ACTIVE_TRIP_KEY]: 'apns-token-abc' });
    await refreshLiveActivityFromBackgroundContext();
    expect(mockEndBoardingActivity).not.toHaveBeenCalled();
  });

  // #2732 gap2 — 2026-09-30 교차추적 감사. destination read가 비었다고 해서 활성 trip 중인
  // LA를 무조건 꺼서는 안 된다(BG 레이스/일시 손실로 인한 LA 생존 불변식 위반).
  describe('#2732 gap2 — 활성 trip 중 destination read 실패로 LA end 금지', () => {
    it('destination 없음 + ACTIVE_TRIP_KEY 존재(활성 trip) → endLiveActivity 호출 안 함', async () => {
      setupStorage({
        [DESTINATION_KEY]: null,
        [ACTIVE_TRIP_KEY]: 'apns-token-abc',
      });
      await refreshLiveActivityFromBackgroundContext();
      expect(mockEndLiveActivity).not.toHaveBeenCalled();
      expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
    });

    it('destination 없음 + ACTIVE_TRIP_KEY도 없음(정당한 trip 종료) → 기존대로 endLiveActivity 호출', async () => {
      setupStorage({
        [DESTINATION_KEY]: null,
        [ACTIVE_TRIP_KEY]: null,
      });
      await refreshLiveActivityFromBackgroundContext();
      expect(mockEndLiveActivity).toHaveBeenCalledTimes(1);
    });
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

  // #2811 편측 감사(#2848) — gps-bg 분기는 etaMinutes를 애초에 null로 보내 ETA 자체는 문제
  // 없지만, route(stopsRemaining 파생원)가 트립 시작 시점 고정값이라 정거장 수가 트립 진행에도
  // 줄지 않는 동일 클래스의 self-contradiction. currentStation(bg.station)=목적지(강남) 자체인데
  // route가 여전히 1정거장 남았다고 주장하면 anchoring 후 0으로 정정돼야 한다.
  it('#2811 편측 감사: gps-bg 분기도 currentStation 기준 remaining route를 buildLiveActivityData에 넘긴다', async () => {
    const bgAtDestination = {
      station: destination, // 강남 — 이미 목적지에 도착(anchoring 대상)
      distanceKm: 0,
      timestamp: Date.now(),
    };
    setupStorage({
      [DESTINATION_KEY]: JSON.stringify(destination),
      [BG_LAST_STATION_KEY]: JSON.stringify(bgAtDestination),
      [ROUTE_KEY]: JSON.stringify(directRoute), // stops: 1 (트립 시작 시점 고정값)
    });
    await refreshLiveActivityFromBackgroundContext();
    expect(mockBuild).toHaveBeenCalledTimes(1);
    const [, , , route] = mockBuild.mock.calls[0] as [unknown, unknown, unknown, { stops: number }];
    // 회귀 상태(fix 전)라면 route === directRoute(stops:1)로 실패한다.
    expect(route.stops).toBe(0);
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

    // #2732 gap1 — 2026-09-30 교차추적 감사. FG(useFusedNearestStation)는
    // isBackendSsotRouteRegression(#2669/#2841)를 경유해 얼어붙은 mirror가 신뢰 가능한 GPS보다
    // 우선 채택되는 것을 막지만, BG LA 경로는 이 가드를 전혀 거치지 않아 트립 꼬리(9/30 성수
    // 실측)에서 잠금화면 LA가 직전 역에 고착될 수 있다. 3역 arc(강남→성수→뚝섬)로 재현.
    describe('#2732 gap1 — tail-stuck 회귀 가드(isBackendSsotRouteRegression) BG LA 경로 배선', () => {
      const tripOrigin = { id: '0228', name: '강남', line: '2', lat: 37.5, lng: 127.0 };
      const tripDestination = { id: '0329', name: '뚝섬', line: '2', lat: 37.547, lng: 127.047 };
      const localTuksum = { id: '0329', name: '뚝섬', line: '2', lat: 37.547, lng: 127.047 };

      // mirror는 성수(idx1)에 얼어붙어 164s 전 마지막 advance(9/30 실측과 동일 elapsed) —
      // GPS 경로 완화 임계(BACKEND_SSOT_ADVANCE_STALE_GPS_MS, 60s)를 이미 초과.
      const staleMirrorAtSeongsu = {
        currentStationId: '성수',
        currentStationLine: '2',
        motionState: 'moving' as const,
        lastAdvanceEvidence: 'seed',
        lastAdvanceAt: Date.now() - 164_000,
        passedStations: [],
        receivedAt: Date.now(),
      };

      it('BG 로컬(GPS) 관측이 신선하고 mirror보다 arc상 앞서 있으면(뚝섬 idx2 > 성수 idx1) mirror를 거부하고 BG 로컬로 폴백한다', async () => {
        mockReadBackendSsotMirror.mockResolvedValue(staleMirrorAtSeongsu);
        setupStorage({
          [DESTINATION_KEY]: JSON.stringify(tripDestination),
          [TRIP_ORIGIN_KEY]: JSON.stringify(tripOrigin),
          [BG_LAST_STATION_KEY]: JSON.stringify({
            station: localTuksum,
            distanceKm: 0.05,
            timestamp: Date.now(),
          }),
          [ROUTE_KEY]: JSON.stringify(directRoute),
        });
        await refreshLiveActivityFromBackgroundContext();
        const [station] = mockBuild.mock.calls[0];
        // fix 전: station이 성수(mirror)로 고착 — red. fix 후: 뚝섬(BG 로컬)로 폴백.
        expect(station).toEqual(localTuksum);
      });

      it('BG 로컬(GPS) 관측이 stale(신선하지 않음)이면 회귀 판정 근거가 없어 mirror를 그대로 채택한다(안전 기본)', async () => {
        mockReadBackendSsotMirror.mockResolvedValue(staleMirrorAtSeongsu);
        setupStorage({
          [DESTINATION_KEY]: JSON.stringify(tripDestination),
          [TRIP_ORIGIN_KEY]: JSON.stringify(tripOrigin),
          [BG_LAST_STATION_KEY]: JSON.stringify({
            station: localTuksum,
            distanceKm: 0.05,
            timestamp: Date.now() - 10 * 60_000, // 10분 전 — 신뢰 불가
          }),
          [ROUTE_KEY]: JSON.stringify(directRoute),
        });
        await refreshLiveActivityFromBackgroundContext();
        const [station] = mockBuild.mock.calls[0];
        expect(station).toEqual({ id: '0328', name: '성수', line: '2', lat: 37.54, lng: 127.05 });
      });

      it('mirror가 최근에 advance했으면(정상 추적 중) BG 로컬이 앞서 있어도 거부하지 않는다', async () => {
        mockReadBackendSsotMirror.mockResolvedValue({
          ...staleMirrorAtSeongsu,
          lastAdvanceAt: Date.now() - 5_000, // 5초 전 — 정상 추적
        });
        setupStorage({
          [DESTINATION_KEY]: JSON.stringify(tripDestination),
          [TRIP_ORIGIN_KEY]: JSON.stringify(tripOrigin),
          [BG_LAST_STATION_KEY]: JSON.stringify({
            station: localTuksum,
            distanceKm: 0.05,
            timestamp: Date.now(),
          }),
          [ROUTE_KEY]: JSON.stringify(directRoute),
        });
        await refreshLiveActivityFromBackgroundContext();
        const [station] = mockBuild.mock.calls[0];
        expect(station).toEqual({ id: '0328', name: '성수', line: '2', lat: 37.54, lng: 127.05 });
      });

      // #2846 P1 (편측 감사) — GPS 신뢰 proxy 신선도 창이 가드 자체의 GPS-경로 stale 임계
      // (BACKEND_SSOT_ADVANCE_STALE_GPS_MS, 60s)보다 느슨하면, 정상 advance 중인 신선한 mirror가
      // 수 분 묵은 BG fix 때문에 오탈락할 수 있다(개악 방향) — proxy 신선도는 가드 임계와 정합돼야 함.
      it('#2846 P1 — mirror가 정상 advance 중(65s 전, 역간 소요 내 정상)이어도 BG fix가 4분(오래된 관측)이면 신뢰 불가 → mirror 유지', async () => {
        mockReadBackendSsotMirror.mockResolvedValue({
          ...staleMirrorAtSeongsu,
          lastAdvanceAt: Date.now() - 65_000, // 65s 전 — GPS-경로 stale 임계(60s)를 막 넘긴 정상 범위
        });
        setupStorage({
          [DESTINATION_KEY]: JSON.stringify(tripDestination),
          [TRIP_ORIGIN_KEY]: JSON.stringify(tripOrigin),
          [BG_LAST_STATION_KEY]: JSON.stringify({
            station: localTuksum, // 뚝섬(idx2) — arc상 mirror(성수 idx1)보다 앞
            distanceKm: 0.05,
            timestamp: Date.now() - 4 * 60_000, // 4분 전 — 5분 freshness proxy였다면 "신선"으로 오인
          }),
          [ROUTE_KEY]: JSON.stringify(directRoute),
        });
        await refreshLiveActivityFromBackgroundContext();
        const [station] = mockBuild.mock.calls[0];
        // fix 전(5분 proxy): 뚝섬(BG 로컬)로 오탈락 — red. fix 후(60s 정합 proxy): 성수(mirror) 유지.
        expect(station).toEqual({ id: '0328', name: '성수', line: '2', lat: 37.54, lng: 127.05 });
      });

      it('route/origin이 arc를 구성 못 함(computeRouteArc null) → 판정 근거 없음 → mirror를 그대로 채택한다(안전 기본)', async () => {
        mockReadBackendSsotMirror.mockResolvedValue(staleMirrorAtSeongsu);
        setupStorage({
          [DESTINATION_KEY]: JSON.stringify(tripDestination),
          [TRIP_ORIGIN_KEY]: JSON.stringify(tripOrigin),
          [BG_LAST_STATION_KEY]: JSON.stringify({
            station: localTuksum,
            distanceKm: 0.05,
            timestamp: Date.now(),
          }),
          // 존재하지 않는 line(9호선 — mock stations.json에 없음)이라 computeRouteArc가 null 반환.
          [ROUTE_KEY]: JSON.stringify({ type: 'direct', line: '9', stops: 1 }),
        });
        await refreshLiveActivityFromBackgroundContext();
        const [station] = mockBuild.mock.calls[0];
        expect(station).toEqual({ id: '0328', name: '성수', line: '2', lat: 37.54, lng: 127.05 });
      });

      it('TRIP_ORIGIN_KEY 부재(arc를 못 만듦) → 판정 근거 없음 → mirror를 그대로 채택한다(안전 기본)', async () => {
        mockReadBackendSsotMirror.mockResolvedValue(staleMirrorAtSeongsu);
        setupStorage({
          [DESTINATION_KEY]: JSON.stringify(tripDestination),
          [TRIP_ORIGIN_KEY]: null,
          [BG_LAST_STATION_KEY]: JSON.stringify({
            station: localTuksum,
            distanceKm: 0.05,
            timestamp: Date.now(),
          }),
          [ROUTE_KEY]: JSON.stringify(directRoute),
        });
        await refreshLiveActivityFromBackgroundContext();
        const [station] = mockBuild.mock.calls[0];
        expect(station).toEqual({ id: '0328', name: '성수', line: '2', lat: 37.54, lng: 127.05 });
      });
    });

    // #2735 PR-4 (U3) — #2659를 좁힌다: backend가 LA를 갱신 중(권위 active)이면 mirror 전체 교체도 skip.
    // 면제 근거(채널 0/0)는 silent push 공백이 T를 넘으면 권위가 풀려 계속 충족된다.
    it('#2735 backend-authority 활성이면 mirror 분기도 쓰지 않는다 (D2 게이트)', async () => {
      mockReadBackendSsotMirror.mockResolvedValue(freshMirrorCorrectLine);
      setupStorage({
        [DESTINATION_KEY]: JSON.stringify(destination),
        [BG_LAST_STATION_KEY]: JSON.stringify(bgStation),
        [ROUTE_KEY]: JSON.stringify(directRoute),
        [ACTIVE_TRIP_KEY]: 'apns-token-abc',
      });
      mockShouldSkipDeviceLiveActivityWrite.mockReturnValue(true);
      await refreshLiveActivityFromBackgroundContext();
      expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
      expect(mockLogLaRefreshDecision).toHaveBeenCalledWith('backend-authority-skip', expect.any(String));
      expect(mockLogLaWrite).not.toHaveBeenCalled();
    });

    it('[거부] 권위가 active가 아니면 mirror 분기는 그대로 쓴다', async () => {
      mockReadBackendSsotMirror.mockResolvedValue(freshMirrorCorrectLine);
      setupStorage({
        [DESTINATION_KEY]: JSON.stringify(destination),
        [BG_LAST_STATION_KEY]: JSON.stringify(bgStation),
        [ROUTE_KEY]: JSON.stringify(directRoute),
        [ACTIVE_TRIP_KEY]: 'apns-token-abc',
      });
      mockShouldSkipDeviceLiveActivityWrite.mockReturnValue(false);
      await refreshLiveActivityFromBackgroundContext();
      expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
    });

    it('#2735 침묵 뒤 gps-bg 쓰기는 출처(deviceFallback)를 buildLiveActivityData에 싣는다', async () => {
      mockResolveDeviceFallbackSource.mockResolvedValueOnce('deviceFallback');
      setupStorage({
        [DESTINATION_KEY]: JSON.stringify(destination),
        [BG_LAST_STATION_KEY]: JSON.stringify(bgStation),
        [ROUTE_KEY]: JSON.stringify(directRoute),
        [ACTIVE_TRIP_KEY]: 'apns-token-abc',
      });
      await refreshLiveActivityFromBackgroundContext();
      expect(mockResolveDeviceFallbackSource).toHaveBeenCalledWith('apns-token-abc');
      expect(mockBuild).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        null,
        false,
        null,
        'deviceFallback',
      );
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

      // #2806 — 이전에는 "현행 보존"으로 BG_LAST_STATION(gps-bg) 경로가 update-only 가드 없이
      // 그대로 update를 호출했다. 활성 LA가 없을 때 native update()가 start()로 fall-through해
      // BG에서 Activity.request가 throw → catch → 일반 알림 폴백 버스트로 이어지는 실측 회귀
      // (dump la-fallback-notification×14, 전부 트립 경계)의 원인이라 mirror 경로(#2610)와
      // 동일한 update-only 가드를 이 경로에도 적용한다.
      it('#2806 — BG_LAST_STATION(gps-bg) 경로도 활성 LA 없으면 update-only 가드로 skip한다', async () => {
        mockReadBackendSsotMirror.mockResolvedValue(null);
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

      it('#2806 — BG_LAST_STATION(gps-bg) 경로는 활성 LA 있으면 기존처럼 update 호출', async () => {
        mockReadBackendSsotMirror.mockResolvedValue(null);
        mockHasActiveLiveActivity.mockReturnValue(true);
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

  // #2589 PR-5 — BG_LAST_STATION(GPS) 2순위 분기 신선도 상한. trip 180(17:27:44 이후 BG fix 전부
  // gate-accuracy 기각 → BG_LAST_STATION이 갱신 안 된 채 wake) 에서 묵은 역으로 LA 전체 교체가 가능했다.
  describe('#2589 PR-5 stale-bg 상한 (BACKEND_SSOT_ADVANCE_STALE_GPS_MS=60s)', () => {
    const NOW = 1_800_000_000_000;
    const bgAged = (ageMs: number) => ({ ...bgStation, timestamp: NOW - ageMs });
    const arrange = (bg: unknown) =>
      setupStorage({
        [DESTINATION_KEY]: JSON.stringify(destination),
        [BG_LAST_STATION_KEY]: JSON.stringify(bg),
        [ROUTE_KEY]: JSON.stringify(directRoute),
      });

    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(NOW);
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('61s 전 fix → LA 쓰기 없음(no-op) + stale-bg 로그', async () => {
      arrange(bgAged(61_000));
      await refreshLiveActivityFromBackgroundContext();
      expect(mockBuild).not.toHaveBeenCalled();
      expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
      expect(mockLoggerInfo).toHaveBeenCalledWith(expect.stringContaining('stale-bg'));
      // #2735 PR-1 연결 — 결정 행(la-refresh-decision)에도 stale-bg가 정확히 1건 남는다(나이 detail 포함).
      expect(mockLogLaRefreshDecision).toHaveBeenCalledTimes(1);
      expect(mockLogLaRefreshDecision).toHaveBeenCalledWith('stale-bg', expect.stringContaining('61000'));
    });

    it('59s 전 fix → 기존대로 gps-bg 쓰기', async () => {
      arrange(bgAged(59_000));
      await refreshLiveActivityFromBackgroundContext();
      expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
      expect(mockLoggerInfo).not.toHaveBeenCalledWith(expect.stringContaining('stale-bg'));
    });

    it('경계 정확히 60s는 쓴다(상한 초과만 차단 — gap1 가드의 <= 와 동일 의미)', async () => {
      arrange(bgAged(60_000));
      await refreshLiveActivityFromBackgroundContext();
      expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
    });

    it('trip 180 모사 — 마지막 수용 fix 이후 wake가 이어져도(61s→10분) 쓰기 0건', async () => {
      for (const ageMs of [61_000, 120_000, 5 * 60_000, 10 * 60_000]) {
        arrange(bgAged(ageMs));
        await refreshLiveActivityFromBackgroundContext();
      }
      expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
      expect(mockEndLiveActivity).not.toHaveBeenCalled();
    });

    it('[거부] stale-bg여도 mirror(1순위) 채택은 막지 않는다 — 상한은 gps-bg 분기 전용', async () => {
      arrange(bgAged(10 * 60_000));
      mockReadBackendSsotMirror.mockResolvedValue({
        currentStationId: '성수',
        currentStationLine: '2',
        motionState: 'moving',
        lastAdvanceEvidence: 'cron',
        lastAdvanceAt: NOW - 5_000,
        passedStations: [],
        receivedAt: NOW,
      });
      await refreshLiveActivityFromBackgroundContext();
      expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
    });
  });

  // #2735 PR-1 — 반환 지점마다 결정 행 1건. "SSoT 없는 wake에서 gps-bg가 썼는가 skip했는가"를 가른다(plan B1·B9).
  describe('#2735 PR-1 la-refresh-decision / la-write(D3) 관측', () => {
    const fullStorage = (extra: Partial<Record<string, string | null>> = {}) =>
      setupStorage({
        [DESTINATION_KEY]: JSON.stringify(destination),
        [BG_LAST_STATION_KEY]: JSON.stringify({ ...bgStation, timestamp: Date.now() }),
        [ROUTE_KEY]: JSON.stringify(directRoute),
        [ACTIVE_TRIP_KEY]: 'apns-token-abc',
        ...extra,
      });
    const decisions = () => mockLogLaRefreshDecision.mock.calls.map(([d]) => d);

    beforeEach(() => {
      __test__.resetMirrorAdvanceDedup();
      mockShouldSkipDeviceLiveActivityWrite.mockReset().mockReturnValue(false);
      mockReadBackendSsotMirror.mockResolvedValue(null);
      (AsyncStorage.getItem as jest.Mock).mockReset();
    });

    it.each([
      [
        'la-disabled',
        () => mockIsLiveActivityEnabled.mockReturnValue(false),
      ],
      [
        'dismissed',
        () => mockIsLaDismissed.mockResolvedValue(true),
      ],
      [
        'dest-absent-active-trip',
        () => setupStorage({ [DESTINATION_KEY]: null, [ACTIVE_TRIP_KEY]: 'tok' }),
      ],
      [
        'dest-absent-end',
        () => setupStorage({ [DESTINATION_KEY]: null, [ACTIVE_TRIP_KEY]: null }),
      ],
      [
        'backend-authority-skip',
        () => {
          fullStorage();
          mockShouldSkipDeviceLiveActivityWrite.mockReturnValueOnce(true);
        },
      ],
      [
        'no-source',
        () => fullStorage({ [BG_LAST_STATION_KEY]: null }),
      ],
      [
        'no-active-la',
        () => {
          fullStorage();
          mockHasActiveLiveActivity.mockReturnValue(false);
        },
      ],
      [
        'error',
        () => (AsyncStorage.getItem as jest.Mock).mockRejectedValue(new Error('storage down')),
      ],
    ])('결정 %s — 반환 지점에서 정확히 1건', async (decision, arrange) => {
      arrange();
      await refreshLiveActivityFromBackgroundContext();
      expect(decisions()).toEqual([decision]);
      expect(mockLogLaWrite).not.toHaveBeenCalled();
    });

    it('gps-bg-write — 쓰기 후 결정 1건 + D3 la-write(역·권위 not-active) 1건', async () => {
      fullStorage();
      await refreshLiveActivityFromBackgroundContext();
      expect(decisions()).toEqual(['gps-bg-write']);
      expect(mockLogLaRefreshDecision).toHaveBeenCalledWith('gps-bg-write', bgStation.station.name);
      expect(mockLogLaWrite).toHaveBeenCalledTimes(1);
      expect(mockLogLaWrite).toHaveBeenCalledWith({
        writer: 'D3',
        source: 'gps-bg',
        data: expect.objectContaining({ stationName: 'STN' }),
        authority: 'not-active',
      });
    });

    it('mirror 분기 — 쓰기 성공이면 mirror-write, 가드 skip이면 mirror-skip', async () => {
      fullStorage({ [BG_LAST_STATION_KEY]: null });
      mockReadBackendSsotMirror.mockResolvedValue({
        currentStationId: '성수',
        currentStationLine: '2',
        motionState: 'moving',
        lastAdvanceEvidence: 'cron',
        lastAdvanceAt: Date.now(),
        passedStations: [],
        receivedAt: Date.now(),
      });
      await refreshLiveActivityFromBackgroundContext();
      expect(decisions()).toEqual(['mirror-write']);
      expect(mockLogLaWrite).toHaveBeenCalledWith(
        expect.objectContaining({ writer: 'D2', source: 'backend-ssot', authority: 'not-active' }),
      );

      mockLogLaRefreshDecision.mockClear();
      mockHasActiveLiveActivity.mockReturnValue(false);
      await refreshLiveActivityFromBackgroundContext();
      expect(decisions()).toEqual(['mirror-skip']);
    });

    it('trip 180 wake 시퀀스(SSoT 없는 reschedule/mid-cycle 5건) — wake당 결정 행 정확히 1건', async () => {
      // 17:26:07·17:27:16·17:28:48·17:29:17·17:30:49 — lock 이후 SSoT 없는 wake 5건. 권위 active라 전부 skip.
      fullStorage();
      mockShouldSkipDeviceLiveActivityWrite.mockReturnValue(true);
      for (let wake = 0; wake < 5; wake += 1) {
        await refreshLiveActivityFromBackgroundContext();
      }
      expect(decisions()).toEqual(Array(5).fill('backend-authority-skip'));
      expect(mockLogLaWrite).not.toHaveBeenCalled();
    });

    it('trip 180 wake 시퀀스(권위 pending) — wake 5건 = gps-bg-write 5건 + D3 la-write 5건', async () => {
      fullStorage();
      for (let wake = 0; wake < 5; wake += 1) {
        await refreshLiveActivityFromBackgroundContext();
      }
      expect(decisions()).toEqual(Array(5).fill('gps-bg-write'));
      expect(mockLogLaWrite).toHaveBeenCalledTimes(5);
    });

    it('refreshLiveActivityOnMirrorAdvance — dedup no-op이면 mirror-advance-dedup 결정(역:노선)을 남긴다', async () => {
      fullStorage({ [BG_LAST_STATION_KEY]: null });
      mockReadBackendSsotMirror.mockResolvedValue({
        currentStationId: '성수',
        currentStationLine: '2',
        motionState: 'moving',
        lastAdvanceEvidence: 'cron',
        lastAdvanceAt: Date.now(),
        passedStations: [],
        receivedAt: Date.now(),
      });
      await refreshLiveActivityOnMirrorAdvance();
      expect(decisions()).toEqual(['mirror-write']);
      await refreshLiveActivityOnMirrorAdvance();
      expect(decisions()).toEqual(['mirror-write', 'mirror-advance-dedup']);
      expect(mockLogLaRefreshDecision).toHaveBeenLastCalledWith('mirror-advance-dedup', '성수:2');
    });

    it('refreshLiveActivityOnMirrorAdvance — mirror 부재/stale이면 결정 행 없음(refresh 미진입)', async () => {
      mockReadBackendSsotMirror.mockResolvedValue(null);
      await refreshLiveActivityOnMirrorAdvance();
      expect(mockLogLaRefreshDecision).not.toHaveBeenCalled();
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
