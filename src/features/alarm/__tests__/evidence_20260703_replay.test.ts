/**
 * 2026-07-03 08:24 KST 중곡→성수 trip replay test — device side (Issue #2024).
 *
 * Backend replay test 의 device side 자매. Backend 가 발사한 silent push 를 device 가
 * silentPushTask.handleSilentPush 로 처리한 결과 (fire/skip) 를 재현/검증한다.
 *
 * 원칙:
 *   1. 오늘 evidence 재현 → 현재 코드에서 회귀 재현되어야 함 (fire=1 for 성수 station-passed).
 *   2. Wave 1 완결 후 payload shape (boardingLine=undefined) 로 재구성하면 skip 되어야 함.
 *   3. **미구현 이슈** 는 `it.failing` 으로 마킹 — 이슈 fix PR 이 마킹을 벗기며 그린 전환.
 *
 * 검증 대상:
 *   - Issue B (#2021) — payload.boardingLine=undefined 상태에서 lockless-opt-out skip 정상 동작
 *   - Issue B 재발 재현 — payload.boardingLine 실은 상태에서 device 통과 (오늘 evidence)
 *
 * silentPushTask.test.ts 의 mock 패턴을 그대로 재사용해 격리.
 */

// ==========================================================================
// Mock 정의 — silentPushTask.test.ts 의 pattern 을 최소 subset 으로 재현.
// silentPushTask.ts 의 side-effect 모듈 (expo-location, AsyncStorage, etc.) 은 모두 mock.
// ==========================================================================

jest.mock('expo-task-manager', () => ({
  defineTask: (name: string, callback: unknown) => {
    (global as unknown as { __silentPushTaskName?: string; __silentPushTaskCb?: unknown }).__silentPushTaskName = name;
    (global as unknown as { __silentPushTaskName?: string; __silentPushTaskCb?: unknown }).__silentPushTaskCb = callback;
  },
}));

const mockGetForegroundPermissions = jest.fn().mockResolvedValue({ status: 'granted' });
const mockGetBackgroundPermissions = jest.fn().mockResolvedValue({ status: 'granted' });
jest.mock('expo-location', () => ({
  getForegroundPermissionsAsync: () => mockGetForegroundPermissions(),
  getBackgroundPermissionsAsync: () => mockGetBackgroundPermissions(),
}));

const mockGetPowerStateAsync = jest.fn().mockResolvedValue({ lowPowerMode: false });
jest.mock('expo-battery', () => ({
  getPowerStateAsync: () => mockGetPowerStateAsync(),
}));

const mockRegisterTaskAsync = jest.fn();
const mockScheduleNotificationAsync = jest.fn();
jest.mock('expo-notifications', () => ({
  registerTaskAsync: (...args: unknown[]) => mockRegisterTaskAsync(...args),
  scheduleNotificationAsync: (...args: unknown[]) => mockScheduleNotificationAsync(...args),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

const mockLogSilentPushReceived = jest.fn();
const mockLogSilentPushRescheduleReceived = jest.fn();
const mockLogSilentPushTripEndedReceived = jest.fn();
const mockLogSilentPushFired = jest.fn();
const mockLogSilentPushSkipped = jest.fn();
const mockLogCrossTripMirrorSkip = jest.fn();
const mockLogSuppressedChannelAgnosticDedup = jest.fn();
const mockFlushAlarmLog = jest.fn().mockResolvedValue(undefined);
jest.mock('../utils/alarmLog', () => ({
  logSilentPushReceived: (...args: unknown[]) => mockLogSilentPushReceived(...args),
  logSilentPushRescheduleReceived: (...args: unknown[]) => mockLogSilentPushRescheduleReceived(...args),
  logSilentPushTripEndedReceived: (...args: unknown[]) => mockLogSilentPushTripEndedReceived(...args),
  logSilentPushFired: (...args: unknown[]) => mockLogSilentPushFired(...args),
  logSilentPushSkipped: (...args: unknown[]) => mockLogSilentPushSkipped(...args),
  logCrossTripMirrorSkip: (...args: unknown[]) => mockLogCrossTripMirrorSkip(...args),
  logSuppressedChannelAgnosticDedup: (...args: unknown[]) => mockLogSuppressedChannelAgnosticDedup(...args),
  flushAlarmLog: () => mockFlushAlarmLog(),
}));

const mockIsAnyChannelRecentlyFired = jest.fn<boolean, unknown[]>(() => false);
const mockMarkStationFired = jest.fn<void, unknown[]>();
jest.mock('../utils/crossCategoryStationDedup', () => ({
  isAnyChannelRecentlyFired: (...args: unknown[]) => mockIsAnyChannelRecentlyFired(...args),
  markStationFired: (...args: unknown[]) => mockMarkStationFired(...args),
}));

const mockRunTripBoundCleanups = jest.fn().mockResolvedValue(undefined);
const mockCancelTripBoundOsQueue = jest.fn().mockResolvedValue(undefined);
jest.mock('../store/tripBoundCleanups', () => ({
  runTripBoundCleanups: () => mockRunTripBoundCleanups(),
  cancelTripBoundOsQueue: () => mockCancelTripBoundOsQueue(),
}));

const mockSetTripEndedSentinel = jest.fn().mockResolvedValue(undefined);
jest.mock('../utils/tripEndedSentinel', () => ({
  setTripEndedSentinel: (...args: unknown[]) => mockSetTripEndedSentinel(...args),
}));

const mockTriggerTripEndRecall = jest.fn().mockResolvedValue({ uploaded: false });
jest.mock('../utils/triggerTripEndRecall', () => ({
  triggerTripEndRecall: (...args: unknown[]) => mockTriggerTripEndRecall(...args),
}));

const mockGetCurrentTripCorrIdSync = jest.fn(() => null);
jest.mock('../../observability/utils/tripCorrId', () => ({
  getCurrentTripCorrIdSync: () => mockGetCurrentTripCorrIdSync(),
}));

const mockTriggerTripGroundTruthPrompt = jest.fn().mockResolvedValue(undefined);
jest.mock('../../debug/utils/triggerTripGroundTruthPrompt', () => ({
  triggerTripGroundTruthPrompt: (...args: unknown[]) => mockTriggerTripGroundTruthPrompt(...args),
}));

const mockCheckGate = jest.fn();
jest.mock('../utils/silentPushLocationGate', () => ({
  checkSilentPushLocationGate: (...args: unknown[]) => mockCheckGate(...args),
}));

const mockGetSubsurfaceState = jest.fn();
jest.mock('../../../shared/utils/subsurfaceState', () => ({
  getSubsurfaceState: (...args: unknown[]) => mockGetSubsurfaceState(...args),
}));

const mockGetFiredAlarms = jest.fn();
const mockSetFiredAlarms = jest.fn();
jest.mock('../utils/notificationState', () => ({
  getFiredAlarms: (...args: unknown[]) => mockGetFiredAlarms(...args),
  setFiredAlarms: (...args: unknown[]) => mockSetFiredAlarms(...args),
}));

const mockBuildAlarmContent = jest.fn((event: { stationName: string; type: string; phaseId: string }) => ({
  title: `[${event.type}/${event.phaseId}]`,
  body: `${event.stationName} 알람`,
}));
const mockSendTripEndedNotification = jest.fn().mockResolvedValue(undefined);
jest.mock('../utils/stationNotification', () => ({
  buildAlarmContent: (...args: unknown[]) => mockBuildAlarmContent(...(args as Parameters<typeof mockBuildAlarmContent>)),
  sendTripEndedNotification: (...args: unknown[]) => mockSendTripEndedNotification(...args),
  // #918 — silentPushTask.ts가 standard payload 경로에서 presched(OS 사전예약) 3-소스 dedup을
  // 위해 호출. 실제 구현과 동일한 순수 매핑 로직 재현(신규 live-activity import 체인 회피).
  mapBackendKindToLocalFireKind: (backendKind: string) =>
    ({ intermediate: 'station-passed', transfer: 'transfer', destination: 'destination' } as Record<string, string>)[backendKind] ?? null,
}));

const mockCancelPrescheduledByStationKind = jest.fn().mockResolvedValue(undefined);
const mockReschedulePrescheduledAlarm = jest.fn().mockResolvedValue({ cancelled: 0, scheduled: 0 });
jest.mock('../utils/stationPrescheduler', () => ({
  cancelPrescheduledByStationKind: (...args: unknown[]) => mockCancelPrescheduledByStationKind(...args),
  reschedulePrescheduledAlarm: (...args: unknown[]) => mockReschedulePrescheduledAlarm(...args),
}));

const mockMarkLocalStationFired = jest.fn().mockResolvedValue(undefined);
jest.mock('../utils/recentLocalStationFires', () => ({
  markLocalStationFired: (...args: unknown[]) => mockMarkLocalStationFired(...args),
}));

const mockAddFiredPushId = jest.fn().mockResolvedValue(undefined);
const mockHasFiredPushId = jest.fn().mockResolvedValue(false);
jest.mock('../utils/firedPushIds', () => ({
  addFiredPushId: (...args: unknown[]) => mockAddFiredPushId(...args),
  hasFiredPushId: (...args: unknown[]) => mockHasFiredPushId(...args),
}));

const mockRefreshLa = jest.fn().mockResolvedValue(undefined);
jest.mock('../utils/refreshLiveActivityFromBackgroundContext', () => ({
  refreshLiveActivityFromBackgroundContext: () => mockRefreshLa(),
}));

const mockUpdateWidget = jest.fn().mockResolvedValue(undefined);
jest.mock('../../widget/utils/updateWidgetFromSilentPush', () => ({
  updateWidgetFromSilentPush: (...args: unknown[]) => mockUpdateWidget(...args),
}));

const mockReadWidgetCtx = jest.fn().mockResolvedValue({
  destination: null,
  route: null,
  bgContext: null,
});
jest.mock('../utils/widgetRefreshContext', () => ({
  readWidgetRefreshContext: () => mockReadWidgetCtx(),
}));

jest.mock('../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const mockSendPushAck = jest.fn();
jest.mock('../api/alarmBackend', () => ({
  sendPushAck: (...args: unknown[]) => mockSendPushAck(...args),
}));

const mockGetMotionStationary = jest.fn(() => false);
jest.mock('../../nearest-station/utils/motionActivity', () => ({
  getCurrentMotionStationary: () => mockGetMotionStationary(),
}));

const mockGetBoardingLock = jest.fn();
jest.mock('../utils/boardingLockStorage', () => ({
  getBoardingLock: (...args: unknown[]) => mockGetBoardingLock(...args),
}));

const mockStoreReleaseLock = jest.fn().mockResolvedValue(undefined);
jest.mock('../store/useBoardingLockStore', () => ({
  useBoardingLockStore: {
    getState: () => ({ releaseLock: mockStoreReleaseLock }),
  },
}));

// #2089 — 옛 boardingLockScheduler/tripBoundScheduler 3종 채널이 safetyNetScheduler 단일
// 모듈로 통합되며 reschedule/cancel-by-station 진입점도 하나로 합쳐졌다.
const mockRescheduleSafetyNetAlarm = jest.fn();
const mockCancelSafetyNetByStationKind = jest.fn().mockResolvedValue(undefined);
// #918 — applyReschedule의 presched 분기(sleepMode OFF)가 backendTripToken/tripStart로부터
// effective tripToken을 도출하는 데 사용. 실제 모듈과 동일한 동작(backend 우선, 없으면
// device-local id)을 재현.
const mockResolveEffectiveTripToken = jest.fn(
  (backendTripToken: string | null, tripStart: number | null) =>
    backendTripToken ?? (tripStart !== null ? `local-${tripStart}` : null),
);
jest.mock('../utils/safetyNetScheduler', () => ({
  rescheduleSafetyNetAlarm: (...args: unknown[]) => mockRescheduleSafetyNetAlarm(...args),
  cancelSafetyNetByStationKind: (...args: unknown[]) => mockCancelSafetyNetByStationKind(...args),
  resolveEffectiveTripToken: (backendTripToken: string | null, tripStart: number | null) =>
    mockResolveEffectiveTripToken(backendTripToken, tripStart),
}));

const mockGetDismissSilence = jest.fn();
const mockClearDismissSilence = jest.fn();
jest.mock('../utils/dismissSilenceStorage', () => ({
  getDismissSilence: (...args: unknown[]) => mockGetDismissSilence(...args),
  clearDismissSilence: (...args: unknown[]) => mockClearDismissSilence(...args),
}));

const mockEvaluateSsotFireGate = jest.fn().mockResolvedValue({ blocked: false });
jest.mock('../utils/ssotFireGate', () => ({
  evaluateSsotFireGate: (...args: unknown[]) => mockEvaluateSsotFireGate(...args),
}));

const mockFindStationByNameAndLine = jest.fn();
const mockFindStationByName = jest.fn();
jest.mock('../../../shared/utils/stationLookup', () => ({
  findStationByNameAndLine: (...args: unknown[]) => mockFindStationByNameAndLine(...args),
  findStationByName: (...args: unknown[]) => mockFindStationByName(...args),
}));

const mockAddDomainBreadcrumb = jest.fn();
jest.mock('../../../shared/infra/monitoring/breadcrumb', () => ({
  addLogBreadcrumb: jest.fn(),
  addDomainBreadcrumb: (...args: unknown[]) => mockAddDomainBreadcrumb(...args),
}));

jest.mock('i18next', () => ({
  __esModule: true,
  default: {
    t: (key: string, opts?: { name?: string }) => (opts?.name ? `${key}:${opts.name}` : key),
  },
  t: (key: string, opts?: { name?: string }) => (opts?.name ? `${key}:${opts.name}` : key),
}));

// ==========================================================================
// Import (mocks after setup)
// ==========================================================================
import AsyncStorage from '@react-native-async-storage/async-storage';
import { handleSilentPush } from '../tasks/silentPushTask';
import { APNS_TOKEN_KEY, ACTIVE_TRIP_KEY, DESTINATION_KEY } from '../../../shared/constants/storageKeys';
import {
  makeBgTaskInput,
  REGRESSION_PUSH_DESTINATION_EARLY_SEONGSU,
  REGRESSION_PUSH_STATION_PASSED_SEONGSU_WITH_LINE,
  TARGET_PUSH_STATION_PASSED_SEONGSU_LOCKLESS_OPT_OUT,
  DEVICE_REGRESSION_ASSERTIONS,
} from './fixtures/evidence_20260703_junggok_seongsu';

const DEFAULT_APNS_TOKEN = 'apns-tok-junggok-seongsu';

const PASSING_GATE = {
  pass: true,
  distanceM: 150,
  thresholdM: 800,
  locationSource: 'cache' as const,
  locationAgeMs: 10_000,
};

const destStation = { id: '2-011', name: '성수', line: '2', lat: 37.5445, lng: 127.0559 };

describe('evidence 2026-07-03 device replay — fixture 정합', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('DEVICE_REGRESSION_ASSERTIONS 는 6개 이슈 매핑 유지', () => {
    const issues = DEVICE_REGRESSION_ASSERTIONS.map((a) => a.issue).sort();
    expect(issues).toEqual(['A', 'B', 'C', 'E', 'J', 'K']);
  });

  it('makeBgTaskInput 은 undefined 값을 자연 누락 (JSON serialize 동작 재현)', () => {
    const input = makeBgTaskInput(TARGET_PUSH_STATION_PASSED_SEONGSU_LOCKLESS_OPT_OUT);
    const fields = input.data.data.data;
    // Wave 1 완결 후 shape: boardingLine 필드 자체가 없어야 함.
    expect('boardingLine' in fields).toBe(false);
    expect('occupiedLine' in fields).toBe(false);
    // 다른 필드는 그대로.
    expect(fields.nextWaypoint).toBe('성수');
    expect(fields.tripToken).toBe('apns-junggok-seongsu');
  });

  it('REGRESSION_PUSH shape 은 오늘 evidence 재현 (boardingLine 실린 상태)', () => {
    const input = makeBgTaskInput(REGRESSION_PUSH_STATION_PASSED_SEONGSU_WITH_LINE);
    const fields = input.data.data.data;
    expect(fields.boardingLine).toBe('2');
    expect(fields.nextWaypoint).toBe('성수');
  });
});

describe('Issue B (#2021) — device lockless-opt-out gate 동작 검증', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockScheduleNotificationAsync.mockResolvedValue('id');
    mockCheckGate.mockResolvedValue(PASSING_GATE);
    mockGetSubsurfaceState.mockResolvedValue(false);
    mockGetFiredAlarms.mockResolvedValue(new Set<string>());
    mockSetFiredAlarms.mockResolvedValue(undefined);
    mockSendPushAck.mockResolvedValue({ ok: true });
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
      if (key === DESTINATION_KEY) return JSON.stringify(destStation);
      if (key === APNS_TOKEN_KEY) return DEFAULT_APNS_TOKEN;
      if (key === ACTIVE_TRIP_KEY) return 'apns-junggok-seongsu';
      return null;
    });
    // 오늘 dump L69~71 재현: lock=null (BoardingLock active=no).
    mockGetBoardingLock.mockResolvedValue(null);
    mockFindStationByNameAndLine.mockReturnValue(null);
    mockFindStationByName.mockReturnValue(null);
    mockGetDismissSilence.mockResolvedValue(null);
    mockClearDismissSilence.mockResolvedValue(undefined);
    mockRescheduleSafetyNetAlarm.mockResolvedValue({ cancelled: 1, scheduled: 1 });
    mockCancelTripBoundOsQueue.mockResolvedValue(undefined);
    mockRunTripBoundCleanups.mockResolvedValue(undefined);
  });

  // #2064 (Phase 1-device) — 매역 알림 backend visible push 단일 채널 전환으로 silentPushTask의
  // fireWithGate(lockless-opt-out 포함 전체 gate 체계)가 제거됐다. transfer/destination/intermediate
  // kind는 이제 lock 상태·boardingLine 유무와 무관하게 항상 'legacy-station-kind-ignored' no-op으로
  // 처리된다 — 아래 세 테스트는 이 evidence replay가 여전히 "device 로컬 알림 0건"을 보장하는지
  // 갱신된 reason으로 재확인한다. fixture 데이터(payload shape) 자체는 evidence 원본 그대로 보존.

  it('target payload (boardingLine=undefined) — device는 로컬 알림 미발사(legacy-station-kind-ignored no-op)', async () => {
    // Wave 1 완결 후 backend 가 발사할 shape. lock=null + boardingLine=undefined.
    // #2064 이전: lockless-opt-out gate로 skip. #2064 이후: kind 유무만으로 무조건 no-op skip.
    // 결과(알림 미발사)는 동일하게 유지 — reason만 새 스펙에 맞게 갱신.
    await handleSilentPush(
      makeBgTaskInput(TARGET_PUSH_STATION_PASSED_SEONGSU_LOCKLESS_OPT_OUT),
    );

    // fire skip: notification 발사 X, skip log 존재.
    expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
    expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
      expect.objectContaining({
        stationName: '성수',
        reason: 'legacy-station-kind-ignored',
      }),
    );
    // ack 는 skip reason 과 함께 (backend pending push cleanup 용).
    expect(mockSendPushAck).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'skipped',
        reason: 'legacy-station-kind-ignored',
      }),
    );
  });

  it('destination-early payload — lock=null + boardingLine 실린 상태에서도 device는 로컬 알림 미발사 (#2064로 근본 차단)', async () => {
    // REGRESSION_PUSH_DESTINATION_EARLY_SEONGSU: boardingLine='2' 실린 상태.
    // #2064 이전(오늘 evidence): device가 payload.boardingLine을 authoritative로 받아 line guard를
    // 통과시켜 fire — Issue B의 device-side 증상이었다(재발 재현 대상).
    // #2064 이후: kind가 destination이면 lock/boardingLine 상태와 무관하게 fireWithGate 자체가
    // 없으므로 항상 no-op. Issue B의 backend 근본 원인(boardingLine을 실어 보내는 것) 수정 여부와
    // 무관하게, device 레이어의 증상(로컬 오발사)은 본 PR로 완전히 닫힌다.
    mockFindStationByNameAndLine.mockReturnValue({
      name: '성수',
      line: '2',
      id: '2-011',
    });
    mockFindStationByName.mockReturnValue({
      name: '성수',
      line: '2',
      id: '2-011',
    });

    await handleSilentPush(makeBgTaskInput(REGRESSION_PUSH_DESTINATION_EARLY_SEONGSU));

    // received 는 여전히 log 됨(상태 sync 유지) — 로컬 알림만 발사되지 않는다.
    expect(mockLogSilentPushReceived).toHaveBeenCalled();
    expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
    expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'legacy-station-kind-ignored' }),
    );
  });

  it('regression payload (boardingLine 실린 상태) — 오늘 evidence 였던 fire가 #2064로 원천 차단됨', async () => {
    // 오늘(evidence 채집 시점) 실 backend payload 상태 (Issue B fix 전, #2064 이전 device 코드).
    // 당시 device: payload.boardingLine !== undefined → line guard 통과 → fire (`08:37:25 bg fired
    // station-passed 성수` evidence). #2064로 fireWithGate 자체가 삭제되어 이 payload shape가 오늘도
    // 재발한다 해도 device는 더 이상 로컬 알림을 발사하지 않는다 — Issue B의 device-side 증상은
    // backend 근본 수정과 별개로 본 PR로 닫힌다.
    mockFindStationByNameAndLine.mockReturnValue({
      name: '성수',
      line: '2',
      id: '2-011',
    });
    mockFindStationByName.mockReturnValue({
      name: '성수',
      line: '2',
      id: '2-011',
    });

    await handleSilentPush(
      makeBgTaskInput(REGRESSION_PUSH_STATION_PASSED_SEONGSU_WITH_LINE),
    );

    // #2064 이전 evidence: fire 됨. #2064 이후: 항상 no-op skip.
    expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
    expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'legacy-station-kind-ignored' }),
    );
    expect(mockLogSilentPushSkipped).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'lockless-opt-out' }),
    );
  });
});

describe('Issue A/C/E/J/K — 미구현 확인 (fix PR 이 마킹을 벗기며 그린 전환)', () => {
  /**
   * jest 29 `it.failing` 은 test body 가 fail 해야 pass. body 가 성공하면 test 자체가 fail.
   * 이슈 fix 완료 시 `it.failing` 을 일반 `it` 로 바꾸고 assertion 을 실 검증으로 대체.
   */

  it.failing('Issue A — 새 route 등록 handler 가 trip token rotation helper 를 호출 (미구현)', () => {
    // fix 후 예상: production route entry point (POST /trips wire) 에서 rotation helper 호출.
    // 현재 코드에는 caller 자체가 없음.
    expect(true).toBe(false);
  });

  it.failing('Issue C — arvlCd=1 관측 시 boardingPrompt alert push 즉시 발사 caller (미구현)', () => {
    // fix 후 예상: scheduled.ts caller 가 archFlag=on + arvlCd=1 감지 시 즉시 sendBoardingPromptPush 호출.
    // device UX layer 는 이미 준비 (BOARDING_PROMPT category action 존재).
    expect(true).toBe(false);
  });

  it.failing('Issue E — destination arvlCd=1 감지 후 route summary UI cleanup chain 완결 (미구현)', () => {
    // fix 후 예상: destination match → trip-ended chain → route summary UI 즉시 종료.
    // 현재는 lockless-trip-end 는 발동하지만 UI 층까지 propagate 안 됨.
    expect(true).toBe(false);
  });

  it.failing('Issue J — arc(time-integration) overshoot 감지 시 hop advance pause (미구현)', () => {
    // fix 후 예상: archFlag=on + arc > hopDistance × N 감지 시 hop 진행 pause.
    // 현재 코드에는 arc guard 자체가 없음.
    expect(true).toBe(false);
  });

  it.failing('Issue K — arvlCd 관측 없는 상태 destination-early skip (미구현)', () => {
    // fix 후 예상: arvlCd 기반 early skip gate 추가. Issue J arc guard 와 연동.
    // 현재는 dismiss-silence gate 만 걸림 → 스팸 반복.
    expect(true).toBe(false);
  });
});
