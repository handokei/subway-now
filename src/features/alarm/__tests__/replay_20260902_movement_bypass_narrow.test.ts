/**
 * #2483 — MINIMAL_ALARM 승격(#2482) 시뮬로 잡은 ship-blocker: `stationPipeline.ts`의 movement
 * 게이트가 `!isMinimalAlarmEnabled()` 조건이라 flag ON이면 movement 검증을 조건 없이 전면
 * 제거했다. lock 유무/dedup 무관 — 신규 trip 첫 tick에 정적(GPS-static) destination-early가
 * phantom 발사된다(건대입구→뚝섬, #2200과 동일 좌표를 flag ON으로 재현).
 *
 * ## fix (#2483)
 * movement 게이트 우회 조건을 `isMinimalAlarmEnabled() && fusionSource === 'position-train'`로
 * 좁힌다 — flag ON이어도 arvlCd/열차 확증(fusionSource=position-train) 없이는 정적 상태에서
 * 우회하지 않는다.
 *
 * ## 동작 매트릭스 (이슈 #2483)
 * | flag | 정적 | fusionSource     | 기대       |
 * |------|------|-------------------|-----------|
 * | OFF  | static | any             | 억제(불변, #2200) |
 * | ON   | static | gps              | 억제(FIXED, 본 fixture) |
 * | ON   | static | position-train   | 발사(불변, arvlCd 확증) |
 * | any  | moving | any              | 발사(불변) |
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { NearestStationResult } from '../../../shared/types/station';
import type { DirectRoute } from '../../../shared/utils/stationRoute';
import { makeDirectRoute } from '../../../testUtils/routeFixtures';
import {
  PHANTOM_NEAREST_STATION,
  PHANTOM_DESTINATION,
  PHANTOM_ALARM_EVENT,
  PHANTOM_STATIONARY_SPEED_MPS,
} from './fixtures/replay_20260807_phantom';

// ==========================================================================
// Mock 정의 — replay_20260807_phantom.test.ts 패턴 재사용해 격리.
// ==========================================================================

const mockFindNearestStation = jest.fn();
jest.mock('../../nearest-station/utils/findNearestStation', () => ({
  findNearestStation: (...args: unknown[]) => mockFindNearestStation(...args),
}));

const mockFindRoute = jest.fn();
const mockCalculateStaticETA = jest.fn();
const mockUpdateRouteFromPosition = jest.fn();
const mockIsStationOnRoute = jest.fn();
const mockIsSameStationName = jest.fn((a: string, b: string) => a === b);
const mockGetFirstLeg = jest.fn((..._args: unknown[]) => ({ line: '2', endName: '' }));
const mockGetRouteRemainingSeconds = jest.fn((..._args: unknown[]) => 120);
jest.mock('../../../shared/utils/stationRoute', () => ({
  findRoute: (...args: unknown[]) => mockFindRoute(...args),
  calculateStaticETA: (...args: unknown[]) => mockCalculateStaticETA(...args),
  updateRouteFromPosition: (...args: unknown[]) => mockUpdateRouteFromPosition(...args),
  isStationOnRoute: (...args: unknown[]) => mockIsStationOnRoute(...args),
  isSameStationName: (a: string, b: string) => mockIsSameStationName(a, b),
  getFirstLeg: (...args: unknown[]) => mockGetFirstLeg(...args),
  getRouteRemainingSeconds: (...args: unknown[]) => mockGetRouteRemainingSeconds(...args),
}));

const mockEvaluateAlarmPhase = jest.fn();
const mockResolveAllTargets = jest.fn(
  (..._args: unknown[]) =>
    [] as Array<{ name: string; stops: number; alarmType: 'destination' | 'transfer'; approachLine: string }>,
);
jest.mock('../utils/stationAlarm', () => ({
  evaluateAlarmPhase: (...args: unknown[]) => mockEvaluateAlarmPhase(...args),
  resolveAllTargets: (...args: unknown[]) => mockResolveAllTargets(...args),
}));

const mockGetBoardingLock = jest.fn();
jest.mock('../utils/boardingLockStorage', () => ({
  getBoardingLock: () => mockGetBoardingLock(),
}));

const mockGetDismissSilence = jest.fn();
const mockClearDismissSilence = jest.fn();
jest.mock('../utils/dismissSilenceStorage', () => ({
  getDismissSilence: (...args: unknown[]) => mockGetDismissSilence(...args),
  clearDismissSilence: (...args: unknown[]) => mockClearDismissSilence(...args),
}));

const mockCancelSafetyNetByStationKind = jest.fn().mockResolvedValue(undefined);
jest.mock('../utils/safetyNetScheduler', () => ({
  cancelSafetyNetByStationKind: (...args: unknown[]) => mockCancelSafetyNetByStationKind(...args),
}));

const mockUpdateStationNotification = jest.fn();
const mockFireLocalAlarmNotification = jest.fn();
const mockFireFgAuxStationPassedNotification = jest.fn();
jest.mock('../utils/stationNotification', () => ({
  updateStationNotification: (...args: unknown[]) => mockUpdateStationNotification(...args),
  fireLocalAlarmNotification: (...args: unknown[]) => mockFireLocalAlarmNotification(...args),
  fireFgAuxStationPassedNotification: (...args: unknown[]) =>
    mockFireFgAuxStationPassedNotification(...args),
}));

const mockGetLastNotifiedStationId = jest.fn();
const mockSetLastNotifiedStationId = jest.fn();
jest.mock('../utils/notificationState', () => ({
  getLastNotifiedStationId: (...args: unknown[]) => mockGetLastNotifiedStationId(...args),
  setLastNotifiedStationId: (...args: unknown[]) => mockSetLastNotifiedStationId(...args),
}));

const mockLogFiredAlarm = jest.fn();
const mockLogFiredStationPassed = jest.fn();
const mockLogSuppressedDedupStation = jest.fn();
const mockLogSuppressedDedupAlarm = jest.fn();
const mockLogSuppressedSleepFirstTransfer = jest.fn();
const mockLogSuppressedSleepStationPassed = jest.fn();
const mockLogSuppressedDismissSilence = jest.fn();
const mockLogSuppressedCrossCategoryDedup = jest.fn();
const mockLogSuppressedCrossCategoryRecent = jest.fn();
const mockLogSuppressedPhaseToPhaseDedup = jest.fn();
const mockLogSuppressedChannelAgnosticDedup = jest.fn();
const mockLogSuppressedMovement = jest.fn();
jest.mock('../utils/alarmLog', () => ({
  logFiredAlarm: (...args: unknown[]) => mockLogFiredAlarm(...args),
  logFiredStationPassed: (...args: unknown[]) => mockLogFiredStationPassed(...args),
  logSuppressedDedupStation: (...args: unknown[]) => mockLogSuppressedDedupStation(...args),
  logSuppressedDedupAlarm: (...args: unknown[]) => mockLogSuppressedDedupAlarm(...args),
  logSuppressedSleepFirstTransfer: (...args: unknown[]) =>
    mockLogSuppressedSleepFirstTransfer(...args),
  logSuppressedSleepStationPassed: (...args: unknown[]) =>
    mockLogSuppressedSleepStationPassed(...args),
  logSuppressedDismissSilence: (...args: unknown[]) => mockLogSuppressedDismissSilence(...args),
  logSuppressedMovement: (...args: unknown[]) => mockLogSuppressedMovement(...args),
  logSuppressedCrossCategoryDedup: (...args: unknown[]) =>
    mockLogSuppressedCrossCategoryDedup(...args),
  logSuppressedCrossCategoryRecent: (...args: unknown[]) =>
    mockLogSuppressedCrossCategoryRecent(...args),
  logSuppressedPhaseToPhaseDedup: (...args: unknown[]) =>
    mockLogSuppressedPhaseToPhaseDedup(...args),
  logSuppressedChannelAgnosticDedup: (...args: unknown[]) =>
    mockLogSuppressedChannelAgnosticDedup(...args),
}));

// ==========================================================================
// Import (mocks after setup)
// ==========================================================================
import { processLocationUpdate } from '../utils/stationPipeline';

const mockNearestResult: NearestStationResult = {
  station: PHANTOM_NEAREST_STATION,
  distanceKm: 0.15,
};

const mockRoute: DirectRoute = makeDirectRoute(3, '2');

describe('#2483 — movement 게이트 우회를 arvlCd-확증(fusionSource=position-train)으로 좁힘', () => {
  const originalFlag = process.env.EXPO_PUBLIC_MINIMAL_ALARM;

  beforeEach(async () => {
    jest.clearAllMocks();
    // #2373 hop-window state는 AsyncStorage 영속 — 4개 테스트가 같은 destinationId를 재사용하므로
    // 매 테스트 "첫 tick(기준 없음)" 상태로 초기화해야 getStationsOnLine 경로(실 미모킹)로 새지 않는다.
    await AsyncStorage.clear();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../utils/crossCategoryStationDedup')._resetCrossCategoryDedupForTests();
    mockUpdateStationNotification.mockResolvedValue(undefined);
    mockFireLocalAlarmNotification.mockResolvedValue(undefined);
    mockFireFgAuxStationPassedNotification.mockResolvedValue(undefined);
    mockCalculateStaticETA.mockReturnValue(10);
    mockIsStationOnRoute.mockReturnValue(true);
    mockGetLastNotifiedStationId.mockResolvedValue(null);
    mockSetLastNotifiedStationId.mockResolvedValue(undefined);
    mockGetBoardingLock.mockResolvedValue(null);
    mockResolveAllTargets.mockReturnValue([
      { name: PHANTOM_DESTINATION.name, stops: 1, alarmType: 'destination', approachLine: '2' },
    ]);
    mockGetFirstLeg.mockReturnValue({ line: '2', endName: PHANTOM_DESTINATION.name });
    mockGetDismissSilence.mockResolvedValue(null);
    mockClearDismissSilence.mockResolvedValue(undefined);
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);
    mockEvaluateAlarmPhase.mockReturnValue(PHANTOM_ALARM_EVENT);
  });

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.EXPO_PUBLIC_MINIMAL_ALARM;
    } else {
      process.env.EXPO_PUBLIC_MINIMAL_ALARM = originalFlag;
    }
  });

  it('flag ON + 정적 + fusionSource=gps → destination-early 억제 (phantom 차단, #2483 본 fix)', async () => {
    process.env.EXPO_PUBLIC_MINIMAL_ALARM = 'true';

    await processLocationUpdate({
      lat: PHANTOM_NEAREST_STATION.lat,
      lng: PHANTOM_NEAREST_STATION.lng,
      destination: PHANTOM_DESTINATION,
      firedAlarms: new Set(),
      sleepMode: false,
      source: 'bg',
      speedMps: PHANTOM_STATIONARY_SPEED_MPS,
      fusionSource: 'gps',
    });

    expect(mockLogFiredAlarm).not.toHaveBeenCalled();
    expect(mockFireLocalAlarmNotification).not.toHaveBeenCalled();
  });

  it('flag OFF + 정적 + fusionSource=gps → 억제 (불변, #2200)', async () => {
    delete process.env.EXPO_PUBLIC_MINIMAL_ALARM;

    await processLocationUpdate({
      lat: PHANTOM_NEAREST_STATION.lat,
      lng: PHANTOM_NEAREST_STATION.lng,
      destination: PHANTOM_DESTINATION,
      firedAlarms: new Set(),
      sleepMode: false,
      source: 'bg',
      speedMps: PHANTOM_STATIONARY_SPEED_MPS,
      fusionSource: 'gps',
    });

    expect(mockLogFiredAlarm).not.toHaveBeenCalled();
  });

  it('flag ON + 정적 + fusionSource=position-train → 발사 (불변, arvlCd 확증 우회)', async () => {
    process.env.EXPO_PUBLIC_MINIMAL_ALARM = 'true';

    await processLocationUpdate({
      lat: PHANTOM_NEAREST_STATION.lat,
      lng: PHANTOM_NEAREST_STATION.lng,
      destination: PHANTOM_DESTINATION,
      firedAlarms: new Set(),
      sleepMode: false,
      source: 'bg',
      speedMps: PHANTOM_STATIONARY_SPEED_MPS,
      fusionSource: 'position-train',
    });

    expect(mockLogFiredAlarm).toHaveBeenCalled();
    expect(mockFireLocalAlarmNotification).toHaveBeenCalled();
  });

  it('flag ON + moving + fusionSource=gps → 발사 (불변)', async () => {
    process.env.EXPO_PUBLIC_MINIMAL_ALARM = 'true';

    await processLocationUpdate({
      lat: PHANTOM_NEAREST_STATION.lat,
      lng: PHANTOM_NEAREST_STATION.lng,
      destination: PHANTOM_DESTINATION,
      firedAlarms: new Set(),
      sleepMode: false,
      source: 'bg',
      speedMps: 10,
      fusionSource: 'gps',
    });

    expect(mockLogFiredAlarm).toHaveBeenCalled();
  });
});
