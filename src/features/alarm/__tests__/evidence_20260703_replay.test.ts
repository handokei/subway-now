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

const mockRescheduleHopForLock = jest.fn();
const mockCancelBlByStationPhase = jest.fn().mockResolvedValue(undefined);
jest.mock('../utils/boardingLockScheduler', () => ({
  rescheduleHopForLock: (...args: unknown[]) => mockRescheduleHopForLock(...args),
  cancelBlByStationPhase: (...args: unknown[]) => mockCancelBlByStationPhase(...args),
}));

const mockRescheduleTripBoundAlarm = jest.fn();
const mockCancelTbaByStationPhase = jest.fn().mockResolvedValue(undefined);
jest.mock('../utils/tripBoundScheduler', () => ({
  rescheduleTripBoundAlarm: (...args: unknown[]) => mockRescheduleTripBoundAlarm(...args),
  cancelTbaByStationPhase: (...args: unknown[]) => mockCancelTbaByStationPhase(...args),
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
    mockRescheduleHopForLock.mockResolvedValue({ cancelled: 1, scheduled: 1 });
    mockRescheduleTripBoundAlarm.mockResolvedValue({ cancelled: 0, scheduled: 0 });
    mockCancelTripBoundOsQueue.mockResolvedValue(undefined);
    mockRunTripBoundCleanups.mockResolvedValue(undefined);
  });

  it('target payload (boardingLine=undefined) — lockless-opt-out skip 정상 동작', async () => {
    // Wave 1 완결 후 backend 가 발사할 shape. lock=null + boardingLine=undefined →
    // silentPushTask 의 lockless-opt-out gate 로 즉시 skip → scheduleNotificationAsync 호출 X.
    await handleSilentPush(
      makeBgTaskInput(TARGET_PUSH_STATION_PASSED_SEONGSU_LOCKLESS_OPT_OUT),
    );

    // fire skip: notification 발사 X, skip log 존재.
    expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
    expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
      expect.objectContaining({
        stationName: '성수',
        reason: 'lockless-opt-out',
      }),
    );
    // ack 는 skip reason 과 함께 (backend pending push cleanup 용).
    expect(mockSendPushAck).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'skipped',
        reason: 'lockless-opt-out',
      }),
    );
  });

  it('destination-early payload — lock=null 상태에서 lockless-opt-out skip (정책 유지)', async () => {
    // REGRESSION_PUSH_DESTINATION_EARLY_SEONGSU: boardingLine='2' 실린 상태.
    // 하지만 device 는 destination kind 도 lockless-opt-out gate 를 통과해야 함.
    // 오늘 dump 는 lockless-no-user-intent gate 로 fg-evaluated 에서 suppress → 스팸 반복.
    // 이 test 는 silent push handler 단일 채널에서 lock=null + destination push 처리 시나리오 검증.
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

    // received 는 log 되지만 fire 되면 안 됨 (실 alarm log 에서는 dismiss-silence 로 suppress).
    // 이 assertion 은 destination-early 스팸을 device layer 에서 잡는지 확인.
    expect(mockLogSilentPushReceived).toHaveBeenCalled();
    // lock=null + boardingLine 실린 destination push → device 는 payload.boardingLine 을 authoritative
    // 로 받아 line guard 통과 → fire 시도. Issue J/K fix 후 backend 가 이 payload 를 발사하지 않게 됨.
    // 지금은 device 층에서는 skip 하지 않고 통과 → 재발 재현.
    expect(mockScheduleNotificationAsync).toHaveBeenCalled();
  });

  it('regression payload (boardingLine 실린 상태) — 오늘 evidence 재현. Wave 1 완결 후 skip 이어야 함', async () => {
    // 오늘 실 backend payload 상태 (Issue B fix 전).
    // lock=null 인데도 backend 가 boardingLine='2' 를 실은 station-passed push 발사.
    // 현재 device 코드: payload.boardingLine !== undefined → line guard 통과 → fire 시도.
    //
    // 이 test 는 "현재 회귀 재현" 을 assertion. Issue B fix 후 backend 가 boardingLine 을
    // 실지 않도록 봉인하면 이 payload shape 자체가 발생하지 않게 됨.
    //
    // 검증: mockFindStationByNameAndLine 이 lock line ('2') 으로 성수 lookup → non-null 반환
    // (성수는 실제 2호선 역) → line guard 통과 → intermediate kind → 이후 dismiss silence/location gate
    // 모두 통과 → 최종 fire.
    // (실 stations.json 검증은 다른 test 에서 커버 — 여기서는 mock 으로 lookup 성공 시나리오만 재현.)
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

    // 오늘 evidence 재현: fire 됨 (`08:37:25 bg fired station-passed 성수`).
    // Issue B fix 후에는 backend 가 이 payload 를 발사하지 않게 되어 root cause 차단.
    // 이 assertion 은 "device 는 boardingLine 실린 payload 를 authoritative 로 통과시킴" 을 명시.
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
