/**
 * 2026-08-07 07:38 KST 건대입구→뚝섬 phantom fire replay test — device side (Issue #2200,
 * ADR-026 #2199). TDD 선행 red fixture였음 — #2204가 movement gate를 BG 채널(stationPipeline)에
 * 연결해 green으로 flip.
 *
 * ## 재현 대상 (오늘 실기기 dump evidence — fixtures/replay_20260807_phantom.ts 참고)
 * 07:38:19 GPS 22.1m/s automotive 스파이크 1개 후 급감(정지)했는데도 07:38:21
 * `bg | fired | destination | early | 뚝섬` (phantom fire) — Raw Signal L826~868, Alarm log L168~308.
 *
 * ## RCA
 * `stationPipeline.processLocationUpdate` (BG 채널)는 `movementGate.ts`의 `evaluateMovement`/
 * `isStaticSpeedSignal`을 전혀 import하지 않았다. `useStationAlarm.ts`(FG 채널)만 이 gate로
 * 'movement-static-speed'/'movement-motion-stationary' suppress를 적용해, 오늘 dump에서도 fg는
 * 반복 suppressed되는 반면 bg는 무방비로 fired — evidence L177~250 `fg | suppressed |
 * movement-static-speed / movement-motion-stationary` vs L252 `bg | fired`.
 *
 * ## Fix (#2204)
 * stationPipeline.processLocationUpdate가 이제 `evaluateMovement`를 speedMps 단독 입력으로
 * 호출해 destination/transfer phase-fire와 station-passed 발사 직전에 게이팅한다(FG와 동등).
 * 정지(GPS speed=0) 상태에서 destination-early 발사 시도 → fire=0 (green).
 */

import type { Station, NearestStationResult } from '../../../shared/types/station';
import type { DirectRoute } from '../../../shared/utils/stationRoute';
import { makeDirectRoute } from '../../../testUtils/routeFixtures';
import {
  PHANTOM_NEAREST_STATION,
  PHANTOM_DESTINATION,
  PHANTOM_ALARM_EVENT,
  PHANTOM_STATIONARY_SPEED_MPS,
} from './fixtures/replay_20260807_phantom';

// ==========================================================================
// Mock 정의 — stationPipeline.test.ts 의 mock 패턴을 그대로 재사용해 격리.
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
jest.mock('../../../shared/utils/stationRoute', () => ({
  findRoute: (...args: unknown[]) => mockFindRoute(...args),
  calculateStaticETA: (...args: unknown[]) => mockCalculateStaticETA(...args),
  updateRouteFromPosition: (...args: unknown[]) => mockUpdateRouteFromPosition(...args),
  isStationOnRoute: (...args: unknown[]) => mockIsStationOnRoute(...args),
  isSameStationName: (a: string, b: string) => mockIsSameStationName(a, b),
  getFirstLeg: (...args: unknown[]) => mockGetFirstLeg(...args),
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
jest.mock('../utils/stationNotification', () => ({
  updateStationNotification: (...args: unknown[]) => mockUpdateStationNotification(...args),
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

describe('evidence 2026-08-07 07:38 device replay — 정지 상태 destination-early phantom fire (#2200)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../utils/crossCategoryStationDedup')._resetCrossCategoryDedupForTests();
    mockUpdateStationNotification.mockResolvedValue(undefined);
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

  // #2204 — 수리 후 기대치. 정지(GPS speed=0) 상태에서는 movement gate가 destination-early
  // fire를 차단한다. (구) `it.failing` red 테스트를 여기 green으로 교체 — "BG는 movement 신호와
  // 무관하게 fire"라는 회귀 재현 테스트는 fix로 더 이상 참이 아니므로 제거.
  it('정지(GPS speed=0) 상태에서 destination-early fire=0 (뚝섬 phantom fire 회귀 차단)', async () => {
    await processLocationUpdate({
      lat: PHANTOM_NEAREST_STATION.lat,
      lng: PHANTOM_NEAREST_STATION.lng,
      destination: PHANTOM_DESTINATION,
      firedAlarms: new Set(),
      sleepMode: false,
      source: 'bg',
      speedMps: PHANTOM_STATIONARY_SPEED_MPS,
    });

    expect(mockLogFiredAlarm).not.toHaveBeenCalled();
  });
});
