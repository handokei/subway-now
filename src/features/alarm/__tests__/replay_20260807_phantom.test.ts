/**
 * 2026-08-07 07:38 KST 건대입구→뚝섬 phantom fire replay test — device side (Issue #2200,
 * ADR-026 #2199). TDD 선행 red fixture — 하위 fix 이슈(#2201/#2202/#2204)가 green으로 flip.
 *
 * ## 재현 대상 (오늘 실기기 dump evidence — fixtures/replay_20260807_phantom.ts 참고)
 * 07:38:19 GPS 22.1m/s automotive 스파이크 1개 후 급감(정지)했는데도 07:38:21
 * `bg | fired | destination | early | 뚝섬` (phantom fire) — Raw Signal L826~868, Alarm log L168~308.
 *
 * ## RCA
 * `stationPipeline.processLocationUpdate` (BG 채널)는 `movementGate.ts`의 `evaluateMovement`/
 * `isStaticSpeedSignal`을 전혀 import하지 않는다. `useStationAlarm.ts`(FG 채널)만 이 gate로
 * 'movement-static-speed'/'movement-motion-stationary' suppress를 적용하며, 오늘 dump에서도 fg는
 * 반복 suppressed되는 반면 bg는 무방비로 fired — evidence L177~250 `fg | suppressed |
 * movement-static-speed / movement-motion-stationary` vs L252 `bg | fired`.
 *
 * ## Assert (수리 후 기대치, 지금 red)
 * 정지(GPS speed=0 + accel stationary) 상태에서 destination-early 발사 시도 → fire=0 기대
 * (현재 fire=1). `it.failing`으로 감싸 CI green 유지 — 이슈 fix가 movement gate를 BG 채널에
 * 연결하면 이 assertion이 통과하게 되고, 그 시점에 `it.failing`을 `it`로 교체한다.
 *
 * ## 금지
 * production 코드 수정 없음(테스트+fixture만). 아래 stationPipeline.test.ts의 mock 패턴을
 * 최소 subset으로 재사용해 격리.
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

  it('오늘 evidence 재현 — BG 채널은 movement 신호와 무관하게 fire (회귀 확인)', async () => {
    // evidence: 07:39:56 이후 GPS speed=0.0m/s(정지 확정) 구간 + accel pattern=stationary.
    // processLocationUpdate는 movementGate.ts를 참조하지 않으므로 speedMps=0(정지)을 넣어도
    // evaluateAlarmPhase 결과(destination/early)가 그대로 fire까지 통과한다 — 오늘 evidence의
    // "bg fired destination early 뚝섬" (dump L252) 재현.
    await processLocationUpdate({
      lat: PHANTOM_NEAREST_STATION.lat,
      lng: PHANTOM_NEAREST_STATION.lng,
      destination: PHANTOM_DESTINATION,
      firedAlarms: new Set(),
      sleepMode: false,
      source: 'bg',
      speedMps: PHANTOM_STATIONARY_SPEED_MPS,
    });

    expect(mockLogFiredAlarm).toHaveBeenCalledWith('bg', PHANTOM_ALARM_EVENT);
  });

  // Flip in #2201/#2202/#2204 — stationPipeline.processLocationUpdate가 movementGate.ts
  // (evaluateMovement/isStaticSpeedSignal)를 참조해 정지 상태에서 destination-early fire를
  // 차단하면, 아래 assertion이 통과하며 이 테스트를 `it.failing` → `it`로 교체한다.
  it.failing('수리 후 기대치 — 정지(GPS speed=0 + accel stationary) 상태에서 destination-early fire=0', async () => {
    await processLocationUpdate({
      lat: PHANTOM_NEAREST_STATION.lat,
      lng: PHANTOM_NEAREST_STATION.lng,
      destination: PHANTOM_DESTINATION,
      firedAlarms: new Set(),
      sleepMode: false,
      source: 'bg',
      speedMps: PHANTOM_STATIONARY_SPEED_MPS,
    });

    // 수리 후: 정지 상태에서는 movement gate가 fire를 차단해 logFiredAlarm이 호출되지 않아야 한다.
    // 현재(red): BG 채널에 movement gate가 없어 이 assertion이 실패한다(logFiredAlarm 호출됨) —
    // it.failing이 그 실패를 삼켜 CI green 유지.
    expect(mockLogFiredAlarm).not.toHaveBeenCalled();
  });
});
