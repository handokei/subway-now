jest.mock('expo-task-manager', () => ({
  defineTask: (name: string, callback: Function) => {
    (global as any).__silentPushTaskName = name;
    (global as any).__silentPushTaskCb = callback;
  },
}));

// #1768 — 권한별 ack permissionMode. 기본: foreground=granted, background=granted → 'always'.
const mockGetForegroundPermissions = jest.fn().mockResolvedValue({ status: 'granted' });
const mockGetBackgroundPermissions = jest.fn().mockResolvedValue({ status: 'granted' });
jest.mock('expo-location', () => ({
  getForegroundPermissionsAsync: () => mockGetForegroundPermissions(),
  getBackgroundPermissionsAsync: () => mockGetBackgroundPermissions(),
}));

// #1772 — battery state. 기본: lowPowerMode=false → 'normal'.
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
const mockLogBoardingPromptFired = jest.fn();
const mockLogSleepTransferAlarmFired = jest.fn();
const mockFlushAlarmLog = jest.fn().mockResolvedValue(undefined);
jest.mock('../../utils/alarmLog', () => ({
  logSilentPushReceived: (...args: unknown[]) => mockLogSilentPushReceived(...args),
  logSilentPushRescheduleReceived: (...args: unknown[]) =>
    mockLogSilentPushRescheduleReceived(...args),
  logSilentPushTripEndedReceived: (...args: unknown[]) =>
    mockLogSilentPushTripEndedReceived(...args),
  logSilentPushFired: (...args: unknown[]) => mockLogSilentPushFired(...args),
  logSilentPushSkipped: (...args: unknown[]) => mockLogSilentPushSkipped(...args),
  logCrossTripMirrorSkip: (...args: unknown[]) => mockLogCrossTripMirrorSkip(...args),
  logSuppressedChannelAgnosticDedup: (...args: unknown[]) =>
    mockLogSuppressedChannelAgnosticDedup(...args),
  logBoardingPromptFired: (...args: unknown[]) => mockLogBoardingPromptFired(...args),
  logSleepTransferAlarmFired: (...args: unknown[]) => mockLogSleepTransferAlarmFired(...args),
  flushAlarmLog: () => mockFlushAlarmLog(),
}));

// #2036 (Issue I γ) — sleep-transfer-alarm 발사 시 vibrateAlarm(true) 호출. mock으로 호출 횟수 검증.
const mockVibrateAlarm = jest.fn();
jest.mock('../../utils/alarmSound', () => ({
  vibrateAlarm: (...args: unknown[]) => mockVibrateAlarm(...args),
}));

// #1901/#1900 (RC-7/RC-10a) — channel-agnostic 8분 backstop. silent push fire 직전 gate +
// fire 직후 markStationFired. FG fireAndLog / stationPipeline과 lastFire Map 공유.
const mockIsAnyChannelRecentlyFired = jest.fn<boolean, unknown[]>(() => false);
const mockMarkStationFired = jest.fn<void, unknown[]>();
jest.mock('../../utils/crossCategoryStationDedup', () => ({
  isAnyChannelRecentlyFired: (...args: unknown[]) =>
    mockIsAnyChannelRecentlyFired(...args),
  markStationFired: (...args: unknown[]) => mockMarkStationFired(...args),
}));

// #868 — trip-ended payload 수신 시 trip-bound storage cleanup.
const mockRunTripBoundCleanups = jest.fn().mockResolvedValue(undefined);
// #1370 L4 — trip-ended 수신 즉시 OS queue cancel.
const mockCancelTripBoundOsQueue = jest.fn().mockResolvedValue(undefined);
jest.mock('../../store/tripBoundCleanups', () => ({
  runTripBoundCleanups: () => mockRunTripBoundCleanups(),
  cancelTripBoundOsQueue: () => mockCancelTripBoundOsQueue(),
}));

// #899 (Seam C) — trip-ended 분기는 FG 복귀를 위한 sentinel을 작성한다.
// #2018 γ' — FG 상태 시 sentinel 처리 완료 후 clearTripEndedSentinel 즉시 호출.
const mockSetTripEndedSentinel = jest.fn().mockResolvedValue(undefined);
const mockClearTripEndedSentinel = jest.fn().mockResolvedValue(undefined);
jest.mock('../../utils/tripEndedSentinel', () => ({
  setTripEndedSentinel: (...args: unknown[]) => mockSetTripEndedSentinel(...args),
  clearTripEndedSentinel: (...args: unknown[]) =>
    mockClearTripEndedSentinel(...args),
}));

// #2045 (Signal 4) — silent push 수신 시각 stamp. handleSilentPush가 유효 payload 진입 시점에 write.
const mockSetLastSilentPushReceivedAt = jest.fn().mockResolvedValue(undefined);
jest.mock('../../utils/lastSilentPushReceivedAt', () => ({
  setLastSilentPushReceivedAt: (...args: unknown[]) =>
    mockSetLastSilentPushReceivedAt(...args),
  getLastSilentPushReceivedAt: jest.fn(),
  clearLastSilentPushReceivedAt: jest.fn(),
}));

// #919 — trip-ended 분기는 cleanup 직전에 recall trigger를 호출한다.
const mockTriggerTripEndRecall = jest.fn().mockResolvedValue({ uploaded: false });
jest.mock('../../utils/triggerTripEndRecall', () => ({
  triggerTripEndRecall: (...args: unknown[]) => mockTriggerTripEndRecall(...args),
}));

// #1597 — trip-ended 경로에서 cleanup 직전에 corrId snapshot 캡처 + cleanup 후 prompt enqueue.
const mockGetCurrentTripCorrIdSync = jest.fn(() => null);
jest.mock('../../../observability/utils/tripCorrId', () => ({
  getCurrentTripCorrIdSync: () => mockGetCurrentTripCorrIdSync(),
}));
const mockTriggerTripGroundTruthPrompt = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../debug/utils/triggerTripGroundTruthPrompt', () => ({
  triggerTripGroundTruthPrompt: (...args: unknown[]) =>
    mockTriggerTripGroundTruthPrompt(...args),
}));

const mockCheckGate = jest.fn();
jest.mock('../../utils/silentPushLocationGate', () => ({
  checkSilentPushLocationGate: (...args: unknown[]) => mockCheckGate(...args),
}));

// #1307 — BG에서 stale 되는 로컬 subsurface stamp. 기본 false(미지하).
const mockGetSubsurfaceState = jest.fn();
jest.mock('../../../../shared/utils/subsurfaceState', () => ({
  getSubsurfaceState: (...args: unknown[]) => mockGetSubsurfaceState(...args),
}));

const mockGetFiredAlarms = jest.fn();
const mockSetFiredAlarms = jest.fn();
jest.mock('../../utils/notificationState', () => ({
  getFiredAlarms: (...args: unknown[]) => mockGetFiredAlarms(...args),
  setFiredAlarms: (...args: unknown[]) => mockSetFiredAlarms(...args),
}));

const mockBuildAlarmContent = jest.fn((event: { stationName: string; type: string; phaseId: string }, _source?: string) => ({
  title: `[${event.type}/${event.phaseId}]`,
  body: `${event.stationName} 알람`,
}));
// #1323 — trip 종료 user-facing surface. mock으로 호출 인자/횟수만 검증.
const mockSendTripEndedNotification = jest.fn().mockResolvedValue(undefined);
jest.mock('../../utils/stationNotification', () => ({
  buildAlarmContent: (...args: unknown[]) => mockBuildAlarmContent(...(args as Parameters<typeof mockBuildAlarmContent>)),
  sendTripEndedNotification: (...args: unknown[]) => mockSendTripEndedNotification(...args),
}));

// #574 P2e / #1323 — fired pushId dedup store. trip-ended surface dedup도 이 store 공유.
const mockAddFiredPushId = jest.fn().mockResolvedValue(undefined);
const mockHasFiredPushId = jest.fn().mockResolvedValue(false);
jest.mock('../../utils/firedPushIds', () => ({
  addFiredPushId: (...args: unknown[]) => mockAddFiredPushId(...args),
  hasFiredPushId: (...args: unknown[]) => mockHasFiredPushId(...args),
}));

// #900 Seam D — silent push finally에서 호출하는 LA refresh. mock로 호출 횟수만 검증.
const mockRefreshLa = jest.fn().mockResolvedValue(undefined);
jest.mock('../../utils/refreshLiveActivityFromBackgroundContext', () => ({
  refreshLiveActivityFromBackgroundContext: () => mockRefreshLa(),
}));

// #1935 — silent push finally에서 호출하는 widget update wire. mock로 호출 인자/횟수 검증.
const mockUpdateWidget = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../widget/utils/updateWidgetFromSilentPush', () => ({
  updateWidgetFromSilentPush: (...args: unknown[]) => mockUpdateWidget(...args),
}));

// #1935 — widget update 호출 전 storage context read. mock로 read 결과만 격리.
const mockReadWidgetCtx = jest.fn().mockResolvedValue({
  destination: null,
  route: null,
  bgContext: null,
});
jest.mock('../../utils/widgetRefreshContext', () => ({
  readWidgetRefreshContext: () => mockReadWidgetCtx(),
}));

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const mockSendPushAck = jest.fn();
jest.mock('../../api/alarmBackend', () => ({
  sendPushAck: (...args: unknown[]) => mockSendPushAck(...args),
}));

// #728 — motionActivity 신호. 기본 false (=== "stationary 아님"), 특정 테스트에서만 true로 override.
const mockGetMotionStationary = jest.fn(() => false);
jest.mock('../../../nearest-station/utils/motionActivity', () => ({
  getCurrentMotionStationary: () => mockGetMotionStationary(),
}));

const mockGetBoardingLock = jest.fn();
jest.mock('../../utils/boardingLockStorage', () => ({
  getBoardingLock: (...args: unknown[]) => mockGetBoardingLock(...args),
}));

// #1438 (E5) — backend → device lock release sync. handleSilentPush가 payload.lockReleasedReason을
// 보고 호출하는 store action만 mock으로 가로채 호출 여부/인자 검증.
const mockStoreReleaseLock = jest.fn().mockResolvedValue(undefined);
jest.mock('../../store/useBoardingLockStore', () => ({
  useBoardingLockStore: {
    getState: () => ({ releaseLock: mockStoreReleaseLock }),
  },
}));

// #2018 γ' — FG 상태에서 즉시 destination store setState. mock으로 호출 인자 검증.
const mockDestinationSetState = jest.fn();
jest.mock('../../../route/store/useDestinationStore', () => ({
  useDestinationStore: {
    setState: (...args: unknown[]) => mockDestinationSetState(...args),
  },
}));

// #2018 γ' — FG/BG 조건 분기 검증을 위해 AppState.currentState를 테스트에서 조작한다.
// 기본값 'background' — 기존 테스트가 γ' 분기에 진입하지 않도록 보수적 초기화.
const mockAppStateHolder: { currentState: 'active' | 'background' | 'inactive' } = {
  currentState: 'background',
};
jest.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return mockAppStateHolder.currentState;
    },
  },
}));

// #698 — reschedule silent push 분기에서 호출. mock으로 호출 인자/횟수만 검증.
const mockRescheduleHopForLock = jest.fn();
// #1356 E1 — suppress 분기에서 같은 station+phase의 bl: 사전 예약을 cancel.
// #1355 D1 — cross-channel cancel helper (reschedule 분기에서 반대 채널 stale 사전 예약 정리).
const mockCancelBlByStationPhase = jest.fn().mockResolvedValue(undefined);
jest.mock('../../utils/boardingLockScheduler', () => ({
  rescheduleHopForLock: (...args: unknown[]) => mockRescheduleHopForLock(...args),
  cancelBlByStationPhase: (...args: unknown[]) => mockCancelBlByStationPhase(...args),
}));

// #918 A3 PR4 — tba 채널 reschedule. mock으로 호출 인자/횟수만 검증.
const mockRescheduleTripBoundAlarm = jest.fn();
// #1356 E1 — suppress 분기에서 같은 station+phase의 tba: 사전 예약을 cancel.
// #1355 D1 — cross-channel cancel helper (reschedule 분기에서 반대 채널 stale 사전 예약 정리).
const mockCancelTbaByStationPhase = jest.fn().mockResolvedValue(undefined);
jest.mock('../../utils/tripBoundScheduler', () => ({
  rescheduleTripBoundAlarm: (...args: unknown[]) => mockRescheduleTripBoundAlarm(...args),
  cancelTbaByStationPhase: (...args: unknown[]) => mockCancelTbaByStationPhase(...args),
}));

const mockGetDismissSilence = jest.fn();
const mockClearDismissSilence = jest.fn();
jest.mock('../../utils/dismissSilenceStorage', () => ({
  getDismissSilence: (...args: unknown[]) => mockGetDismissSilence(...args),
  clearDismissSilence: (...args: unknown[]) => mockClearDismissSilence(...args),
}));

const mockFindStationByNameAndLine = jest.fn();
const mockFindStationByName = jest.fn();
jest.mock('../../../../shared/utils/stationLookup', () => ({
  findStationByNameAndLine: (...args: unknown[]) => mockFindStationByNameAndLine(...args),
  findStationByName: (...args: unknown[]) => mockFindStationByName(...args),
}));

const mockAddDomainBreadcrumb = jest.fn();
jest.mock('../../../../shared/infra/monitoring/breadcrumb', () => ({
  addLogBreadcrumb: jest.fn(),
  addDomainBreadcrumb: (...args: unknown[]) => mockAddDomainBreadcrumb(...args),
}));

// i18next는 키 그대로 반환 (intermediate 본문 빌더 검증용).
jest.mock('i18next', () => ({
  __esModule: true,
  default: {
    t: (key: string, opts?: { name?: string }) =>
      opts?.name ? `${key}:${opts.name}` : key,
  },
  t: (key: string, opts?: { name?: string }) =>
    opts?.name ? `${key}:${opts.name}` : key,
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  __resetBoardingPromptSilentPushDedup,
  __resetSleepTransferAlarmSilentPushDedup,
  extractPayload,
  getSilentPushRegistrationStatus,
  handleSilentPush,
  persistBackendSsotMirror,
  readBackendSsotMirror,
  registerSilentPushTask,
  SILENT_PUSH_TASK,
  validSsotMirror,
} from '../silentPushTask';
import {
  APNS_TOKEN_KEY,
  ACTIVE_TRIP_KEY,
  BACKEND_SSOT_MIRROR_KEY,
  DESTINATION_KEY,
  ROUTE_KEY,
  SLEEP_MODE_KEY,
} from '../../../../shared/constants/storageKeys';

const DEFAULT_APNS_TOKEN = 'apns-tok-hex';

// #1370 L5 — sendPushAck 호출 매칭 헬퍼. ack outcome별로 같은 token/pushId 페이로드를 반복 검증하는
// 패턴이 다발해 SonarCloud 중복으로 잡힘. 호출 한 줄로 압축해 중복 차단.
// #1768 — permissionMode 기본값 'always' (기본 mock: foreground+background 모두 granted).
// #1772 — 'received' outcome은 batteryState 포함. latencyMs는 expect.any(Number)로 유연 검증.
function ackCall(
  pushId: string,
  outcome: 'received' | 'fired' | 'skipped',
  reason?: string,
  permissionMode: 'always' | 'whileInUse' | 'denied' | undefined = 'always',
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    pushId,
    token: DEFAULT_APNS_TOKEN,
    outcome,
    permissionMode,
  };
  if (reason !== undefined) base.reason = reason;
  // #1772 — 'received' ack는 batteryState 포함 (기본 mock: lowPowerMode=false → 'normal').
  // latencyMs는 테스트 실행 타이밍에 따라 달라지므로 expect.objectContaining으로 검증.
  if (outcome === 'received') {
    base.batteryState = 'normal';
  }
  return base;
}

const destStation = { id: '0228', name: '강남', line: '2', lat: 37.5, lng: 127.0 };

/**
 * #1399 — silentPushTask 테스트는 AsyncStorage.getItem을 mockImplementation으로 분기시키는
 * 패턴이 다발한다(SonarCloud cpd + nested function code smell). 하나의 헬퍼로 압축.
 *
 * - `DESTINATION_KEY` / `APNS_TOKEN_KEY`는 항상 기본값 반환(테스트 기본 환경).
 * - 추가 key는 `overrides` 맵으로 주입. value가 `Error`면 해당 key 조회 시 throw(read 오류 시뮬).
 * - 그 외 key는 null.
 */
const THROW = Symbol('throw');
function setAsyncStorageMap(
  overrides: Record<string, string | null | typeof THROW>,
): void {
  (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
    if (key === DESTINATION_KEY) return JSON.stringify(destStation);
    if (key === APNS_TOKEN_KEY) return DEFAULT_APNS_TOKEN;
    if (key in overrides) {
      const v = overrides[key];
      if (v === THROW) throw new Error('storage-fail');
      return v;
    }
    return null;
  });
}

/**
 * expo-notifications iOS BG task payload 모양을 그대로 재현 (#641).
 * Swift `BackgroundEventTransformer`가 `{aps, data:{fields}}` → `{data:{data:{fields}, dataString}, notification:null, aps}`
 * 로 변환하므로 실기기에서는 fields가 `taskData.data.data.<field>`에 위치한다.
 */
function bgFields(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nextWaypoint: '강남',
    etaSeconds: 300,
    phase: 'early',
    kind: 'destination',
    ...extra,
  };
}
function payload(extra: Record<string, unknown> = {}) {
  return {
    data: {
      data: { data: bgFields(extra), dataString: null },
      notification: null,
      aps: { 'content-available': 1 },
    },
  };
}
/** extractPayload 단위 테스트용 — handleSilentPush input 전체가 아니라 taskData만 빌드. */
function bgTaskData(fields: Record<string, unknown>) {
  return {
    data: { data: fields, dataString: null },
    notification: null,
    aps: { 'content-available': 1 },
  };
}

const PASSING_GATE = {
  pass: true,
  distanceM: 150,
  thresholdM: 800,
  locationSource: 'cache' as const,
  locationAgeMs: 10_000,
};

describe('silentPushTask', () => {
  // #816 C — 기본 lock을 부여해 기존 fire 테스트가 lockless 가드(lock null + non-intermediate 차단)에
  // 막히지 않도록 한다. lockless 분기는 별도 describe에서 lock=null로 명시 override해 검증.
  // line 가드는 lookup 반환값이 두 함수 모두 null이면 graceful pass (#707 — stations.json miss 케이스).
  const defaultBoardingLock = {
    destinationId: '0228',
    trainCode: 'T-default',
    boardingStationId: 'station-default',
    boardingLine: '2' as const,
    boardedAt: 1_700_000_000_000,
    expectedDurationMs: 600_000,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockScheduleNotificationAsync.mockResolvedValue('id');
    mockCheckGate.mockResolvedValue(PASSING_GATE);
    mockGetSubsurfaceState.mockResolvedValue(false);
    mockGetFiredAlarms.mockResolvedValue(new Set<string>());
    mockSetFiredAlarms.mockResolvedValue(undefined);
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
      if (key === DESTINATION_KEY) return JSON.stringify(destStation);
      if (key === APNS_TOKEN_KEY) return DEFAULT_APNS_TOKEN;
      return null;
    });
    mockSendPushAck.mockResolvedValue({ ok: true });
    // 기본: lock 활성. lockless 가드를 우회하려면 lock 부여가 필요(stations.json 미존재 가정).
    mockGetBoardingLock.mockResolvedValue(defaultBoardingLock);
    // 기본 lookup 모두 null → line 가드는 graceful pass(stations.json 어디에도 없음 가정).
    mockFindStationByNameAndLine.mockReturnValue(null);
    mockFindStationByName.mockReturnValue(null);
    // #746 — 기본 silence 없음.
    mockGetDismissSilence.mockResolvedValue(null);
    mockClearDismissSilence.mockResolvedValue(undefined);
    // #919 — recall trigger 기본 graceful skip.
    mockTriggerTripEndRecall.mockResolvedValue({ uploaded: false });
    // #698 — 기본 graceful: 1건 cancel + 1건 schedule. 개별 테스트에서 override.
    mockRescheduleHopForLock.mockResolvedValue({ cancelled: 1, scheduled: 1 });
    // #918 A3 PR4 — tba reschedule 기본 graceful.
    mockRescheduleTripBoundAlarm.mockResolvedValue({ cancelled: 0, scheduled: 0 });
    // #1370 L4 — trip-ended OS queue cancel 기본 graceful (mockImplementation 잔류 차단).
    mockCancelTripBoundOsQueue.mockResolvedValue(undefined);
    // #919 / #1370 — clearAllMocks가 mockImplementation을 reset하지 않으므로 명시 복구.
    mockRunTripBoundCleanups.mockResolvedValue(undefined);
    // #1355 D1 — cross-channel cancel 기본 0건.
    mockCancelTbaByStationPhase.mockResolvedValue(0);
    mockCancelBlByStationPhase.mockResolvedValue(0);
    // #1323 — trip-ended surface 기본값. dedup은 기본 미발사(false).
    mockSendTripEndedNotification.mockResolvedValue(undefined);
    mockHasFiredPushId.mockResolvedValue(false);
    mockAddFiredPushId.mockResolvedValue(undefined);
    // #2018 γ' — 기본 BG로 설정해 기존 테스트가 FG 분기 진입하지 않도록.
    mockAppStateHolder.currentState = 'background';
    // clearAllMocks가 mockImplementation을 reset하지 않으므로 명시 복구.
    mockSetTripEndedSentinel.mockResolvedValue(undefined);
    mockClearTripEndedSentinel.mockResolvedValue(undefined);
  });

  it('defineTask가 SILENT_PUSH_TASK 이름으로 콜백을 등록한다', () => {
    expect((global as any).__silentPushTaskName).toBe(SILENT_PUSH_TASK);
    expect(typeof (global as any).__silentPushTaskCb).toBe('function');
  });

  describe('extractPayload', () => {
    it('data 자체가 falsy면 null', () => {
      expect(extractPayload(undefined)).toBeNull();
    });

    it('비어 있는 객체면 null', () => {
      expect(extractPayload({})).toBeNull();
    });

    // #641 — production iOS BG task payload (Swift `BackgroundEventTransformer` 출력).
    it('production 모양(taskData.data.data.fields) → 필드 추출', () => {
      expect(
        extractPayload(bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early' })),
      ).toMatchObject({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early' });
    });

    // backend가 flat payload(`{aps, ...flat}`)를 보내는 경우 — Swift 변환 후 `taskData.data.flat`.
    it('flat payload 모양(taskData.data.fields) → 필드 추출', () => {
      expect(
        extractPayload({
          data: { nextWaypoint: 'B', etaSeconds: 2, phase: 'imminent' },
          notification: null,
          aps: { 'content-available': 1 },
        }),
      ).toMatchObject({ nextWaypoint: 'B', etaSeconds: 2, phase: 'imminent' });
    });

    // legacy/방어 — 일부 호출처가 fields를 root로 직접 줄 수도 있다.
    it('root 직접 모양(taskData.fields)도 fallback으로 처리', () => {
      expect(
        extractPayload({ nextWaypoint: 'C', etaSeconds: 3, phase: 'early' }),
      ).toMatchObject({ nextWaypoint: 'C', etaSeconds: 3, phase: 'early' });
    });

    it('nextWaypoint 없거나 빈 문자열이면 null', () => {
      expect(extractPayload(bgTaskData({ etaSeconds: 1, phase: 'early' }))).toBeNull();
      expect(
        extractPayload(bgTaskData({ nextWaypoint: '', etaSeconds: 1, phase: 'early' })),
      ).toBeNull();
    });

    it('data가 string 등 비객체면 null', () => {
      expect(
        extractPayload({ data: 'string' } as unknown as Record<string, unknown>),
      ).toBeNull();
    });

    it('etaSeconds 비숫자/Infinity이면 null', () => {
      expect(
        extractPayload(bgTaskData({ nextWaypoint: 'A', etaSeconds: '10', phase: 'early' })),
      ).toBeNull();
      expect(
        extractPayload(bgTaskData({ nextWaypoint: 'A', etaSeconds: Infinity, phase: 'early' })),
      ).toBeNull();
    });

    it('phase가 early/imminent가 아니면 null', () => {
      expect(
        extractPayload(bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'late' })),
      ).toBeNull();
    });

    it('kind=transfer/destination/intermediate면 그대로 전달', () => {
      const variants: ReadonlyArray<'transfer' | 'destination' | 'intermediate'> = [
        'transfer',
        'destination',
        'intermediate',
      ];
      for (const kind of variants) {
        expect(
          extractPayload(bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early', kind })),
        ).toMatchObject({ kind });
      }
    });

    it('kind가 알 수 없는 값이면 undefined로 정리 (legacy 호환)', () => {
      expect(
        extractPayload(bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early', kind: 'foo' })),
      ).toMatchObject({ kind: undefined });
    });

    it('sentAt이 number면 그대로 전달 (#478)', () => {
      expect(
        extractPayload(
          bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early', sentAt: 1_700_000_000_000 }),
        ),
      ).toMatchObject({ sentAt: 1_700_000_000_000 });
    });

    it('sentAt이 비숫자/Infinity이면 undefined (구 백엔드 호환)', () => {
      expect(
        extractPayload(
          bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early', sentAt: 'now' }),
        ),
      ).toMatchObject({ sentAt: undefined });
      expect(
        extractPayload(
          bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early', sentAt: Infinity }),
        ),
      ).toMatchObject({ sentAt: undefined });
    });

    it('pushId가 non-empty string이면 그대로 전달 (#566)', () => {
      expect(
        extractPayload(
          bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early', pushId: 'uuid-x' }),
        ),
      ).toMatchObject({ pushId: 'uuid-x' });
    });

    it('pushId가 빈 문자열/비문자열이면 undefined (구 백엔드 호환)', () => {
      expect(
        extractPayload(
          bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early', pushId: '' }),
        ),
      ).toMatchObject({ pushId: undefined });
      expect(
        extractPayload(
          bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early', pushId: 42 }),
        ),
      ).toMatchObject({ pushId: undefined });
    });

    // Epic #1204 그룹 2 D3 (#1273) — backend가 silent push payload에 hopIndex(0-based 절대 시퀀스)를 stamp.
    // 0 이상 정수만 통과. 음수/non-integer/비숫자/누락은 모두 undefined로 정규화 → gate가 widened fallback.
    describe('hopIndex (#1273 D3)', () => {
      it('non-negative integer이면 그대로 전달', () => {
        expect(
          extractPayload(
            bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early', hopIndex: 0 }),
          ),
        ).toMatchObject({ hopIndex: 0 });
        expect(
          extractPayload(
            bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early', hopIndex: 7 }),
          ),
        ).toMatchObject({ hopIndex: 7 });
      });

      it('누락/음수/non-integer/비숫자/Infinity이면 undefined (구 백엔드 호환)', () => {
        expect(
          extractPayload(bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early' })),
        ).toMatchObject({ hopIndex: undefined });
        expect(
          extractPayload(
            bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early', hopIndex: -1 }),
          ),
        ).toMatchObject({ hopIndex: undefined });
        expect(
          extractPayload(
            bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early', hopIndex: 1.5 }),
          ),
        ).toMatchObject({ hopIndex: undefined });
        expect(
          extractPayload(
            bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early', hopIndex: '3' }),
          ),
        ).toMatchObject({ hopIndex: undefined });
        expect(
          extractPayload(
            bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early', hopIndex: Infinity }),
          ),
        ).toMatchObject({ hopIndex: undefined });
      });
    });

    // #1307 — backend가 server-authoritative subsurface flag(true일 때만)를 stamp.
    describe('subsurface (#1307)', () => {
      it('subsurface=true이면 그대로 전달', () => {
        expect(
          extractPayload(
            bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early', subsurface: true }),
          ),
        ).toMatchObject({ subsurface: true });
      });

      it('누락/false/비boolean이면 undefined (게이트가 로컬 stamp fallback)', () => {
        expect(
          extractPayload(bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early' })),
        ).toMatchObject({ subsurface: undefined });
        expect(
          extractPayload(
            bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early', subsurface: false }),
          ),
        ).toMatchObject({ subsurface: undefined });
        expect(
          extractPayload(
            bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early', subsurface: 'true' }),
          ),
        ).toMatchObject({ subsurface: undefined });
      });
    });

    // #1322 — backend lock-path fire가 실어 보내는 boardingLine(server-authoritative).
    describe('boardingLine (#1322)', () => {
      it('비어있지 않은 string이면 그대로 전달', () => {
        expect(
          extractPayload(
            bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early', boardingLine: '7' }),
          ),
        ).toMatchObject({ boardingLine: '7' });
      });

      it('누락/빈문자열/비string이면 undefined (lock 없을 때 보수 동작 fallback)', () => {
        expect(
          extractPayload(bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early' })),
        ).toMatchObject({ boardingLine: undefined });
        expect(
          extractPayload(
            bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early', boardingLine: '' }),
          ),
        ).toMatchObject({ boardingLine: undefined });
        expect(
          extractPayload(
            bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early', boardingLine: 7 }),
          ),
        ).toMatchObject({ boardingLine: undefined });
      });
    });

    // #1365 — backend가 forward한 발사 시점 waypoint의 line(occupiedLine).
    describe('occupiedLine (#1365)', () => {
      it('비어있지 않은 string이면 그대로 전달', () => {
        expect(
          extractPayload(
            bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early', occupiedLine: '7' }),
          ),
        ).toMatchObject({ occupiedLine: '7' });
      });

      it('누락/빈문자열/비string이면 undefined (구 backend 호환 graceful pass)', () => {
        expect(
          extractPayload(bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early' })),
        ).toMatchObject({ occupiedLine: undefined });
        expect(
          extractPayload(
            bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early', occupiedLine: '' }),
          ),
        ).toMatchObject({ occupiedLine: undefined });
        expect(
          extractPayload(
            bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early', occupiedLine: 7 }),
          ),
        ).toMatchObject({ occupiedLine: undefined });
      });
    });

    // #1438 (E5) — backend → device lock release sync 채널.
    describe('lockReleasedReason (#1438)', () => {
      it("'transfer' 그대로 통과", () => {
        expect(
          extractPayload(
            bgTaskData({
              nextWaypoint: 'A',
              etaSeconds: 0,
              phase: 'imminent',
              lockReleasedReason: 'transfer',
            }),
          ),
        ).toMatchObject({ lockReleasedReason: 'transfer' });
      });

      it("'vanish' 그대로 통과", () => {
        expect(
          extractPayload(
            bgTaskData({
              nextWaypoint: 'A',
              etaSeconds: 0,
              phase: 'imminent',
              lockReleasedReason: 'vanish',
            }),
          ),
        ).toMatchObject({ lockReleasedReason: 'vanish' });
      });

      it('누락/unknown 문자열/비string이면 undefined (구 backend 호환)', () => {
        expect(
          extractPayload(bgTaskData({ nextWaypoint: 'A', etaSeconds: 0, phase: 'imminent' })),
        ).toMatchObject({ lockReleasedReason: undefined });
        expect(
          extractPayload(
            bgTaskData({
              nextWaypoint: 'A',
              etaSeconds: 0,
              phase: 'imminent',
              lockReleasedReason: 'arrived',
            }),
          ),
        ).toMatchObject({ lockReleasedReason: undefined });
        expect(
          extractPayload(
            bgTaskData({
              nextWaypoint: 'A',
              etaSeconds: 0,
              phase: 'imminent',
              lockReleasedReason: 1,
            }),
          ),
        ).toMatchObject({ lockReleasedReason: undefined });
      });
    });

    // #1539 (S6, Epic #1533 / ADR-016) — backend가 silent push payload에 통과 station 누적 배열을
    // forward. device는 사전 예약 큐와 diff하여 cron 1분 race로 놓친 station-passed를 backfill 발사
    // (실제 backfill wiring은 S5 머지 후 별 PR — 본 PR은 extract만).
    describe('passedStations (#1539 S6)', () => {
      it('non-empty 문자열 배열은 그대로 전달', () => {
        expect(
          extractPayload(
            bgTaskData({
              nextWaypoint: '용마산',
              etaSeconds: 0,
              phase: 'imminent',
              passedStations: ['군자', '중곡'],
            }),
          ),
        ).toMatchObject({ passedStations: ['군자', '중곡'] });
      });

      it('빈 배열은 undefined (구 backend 호환)', () => {
        expect(
          extractPayload(
            bgTaskData({
              nextWaypoint: 'A',
              etaSeconds: 0,
              phase: 'imminent',
              passedStations: [],
            }),
          ),
        ).toMatchObject({ passedStations: undefined });
      });

      it('비-배열/누락은 undefined', () => {
        expect(
          extractPayload(bgTaskData({ nextWaypoint: 'A', etaSeconds: 0, phase: 'imminent' })),
        ).toMatchObject({ passedStations: undefined });
        expect(
          extractPayload(
            bgTaskData({
              nextWaypoint: 'A',
              etaSeconds: 0,
              phase: 'imminent',
              passedStations: 'not-an-array',
            }),
          ),
        ).toMatchObject({ passedStations: undefined });
      });

      it('비-string/빈 string 항목은 필터링, 잔여만 채택', () => {
        expect(
          extractPayload(
            bgTaskData({
              nextWaypoint: 'A',
              etaSeconds: 0,
              phase: 'imminent',
              passedStations: ['군자', '', 42, '중곡', null],
            }),
          ),
        ).toMatchObject({ passedStations: ['군자', '중곡'] });
      });

      it('필터링 후 잔여 0이면 undefined', () => {
        expect(
          extractPayload(
            bgTaskData({
              nextWaypoint: 'A',
              etaSeconds: 0,
              phase: 'imminent',
              passedStations: ['', null, 42],
            }),
          ),
        ).toMatchObject({ passedStations: undefined });
      });
    });

    // #1561 (T8, ADR-017 / S2 흡수) — payload.ssot 검증 + extraction.
    describe('ssot (#1561 T8 / S2 흡수)', () => {
      const validSsotInput = {
        currentStationId: '강남',
        motionState: 'moving' as const,
        lastAdvanceEvidence: 'arvlcd-confirmed-train',
        lastAdvanceAt: 1_700_000_000_500,
        passedStations: ['교대', '서초'],
      };

      it('정상 ssot은 payload에 그대로 전달', () => {
        expect(
          extractPayload(
            bgTaskData({
              nextWaypoint: '강남',
              etaSeconds: 0,
              phase: 'imminent',
              ssot: validSsotInput,
            }),
          ),
        ).toMatchObject({ ssot: validSsotInput });
      });

      it('누락은 undefined (구 backend 호환)', () => {
        expect(
          extractPayload(
            bgTaskData({ nextWaypoint: 'A', etaSeconds: 0, phase: 'imminent' }),
          ),
        ).toMatchObject({ ssot: undefined });
      });

      it('비-객체 / null은 undefined', () => {
        expect(
          extractPayload(
            bgTaskData({ nextWaypoint: 'A', etaSeconds: 0, phase: 'imminent', ssot: null }),
          ),
        ).toMatchObject({ ssot: undefined });
        expect(
          extractPayload(
            bgTaskData({ nextWaypoint: 'A', etaSeconds: 0, phase: 'imminent', ssot: 'string' }),
          ),
        ).toMatchObject({ ssot: undefined });
      });

      it.each([
        ['currentStationId 누락', { ...validSsotInput, currentStationId: undefined }],
        ['currentStationId 빈 문자열', { ...validSsotInput, currentStationId: '' }],
        ['motionState invalid', { ...validSsotInput, motionState: 'bogus' }],
        ['lastAdvanceEvidence 누락', { ...validSsotInput, lastAdvanceEvidence: undefined }],
        ['lastAdvanceEvidence 빈 문자열', { ...validSsotInput, lastAdvanceEvidence: '' }],
        ['lastAdvanceAt 비-숫자', { ...validSsotInput, lastAdvanceAt: 'now' }],
        ['lastAdvanceAt NaN', { ...validSsotInput, lastAdvanceAt: Number.NaN }],
      ])('필수 필드 불완전 → undefined: %s', (_label, brokenSsot) => {
        expect(
          extractPayload(
            bgTaskData({
              nextWaypoint: 'A',
              etaSeconds: 0,
              phase: 'imminent',
              ssot: brokenSsot,
            }),
          ),
        ).toMatchObject({ ssot: undefined });
      });

      it('passedStations 비-string 항목은 필터링, 잔여만 채택', () => {
        const result = extractPayload(
          bgTaskData({
            nextWaypoint: 'A',
            etaSeconds: 0,
            phase: 'imminent',
            ssot: {
              ...validSsotInput,
              passedStations: ['교대', '', 42, '서초', null],
            },
          }),
        );
        expect(result).toMatchObject({ ssot: { passedStations: ['교대', '서초'] } });
      });

      it('passedStations 자체가 누락이면 빈 배열로 정규화', () => {
        const result = extractPayload(
          bgTaskData({
            nextWaypoint: 'A',
            etaSeconds: 0,
            phase: 'imminent',
            ssot: { ...validSsotInput, passedStations: undefined },
          }),
        );
        expect(result).toMatchObject({ ssot: { passedStations: [] } });
      });
    });

    // #725 — reschedule schema는 standard와 다르므로 별도 분기 검증.
    describe('reschedule kind (#725)', () => {
      it('정상 reschedule payload → RescheduleSilentPushPayload', () => {
        expect(
          extractPayload(
            bgTaskData({
              kind: 'reschedule',
              nextStation: '사가정',
              newArrivalTimeEpoch: 1_780_000_000_000,
              trainCode: '7610',
              sentAt: 1_780_000_000_000,
              pushId: 'uuid-rs',
            }),
          ),
        ).toEqual({
          kind: 'reschedule',
          nextStation: '사가정',
          newArrivalTimeEpoch: 1_780_000_000_000,
          trainCode: '7610',
          sentAt: 1_780_000_000_000,
          pushId: 'uuid-rs',
        });
      });

      it('nextStation 누락/빈 문자열이면 null', () => {
        expect(
          extractPayload(
            bgTaskData({ kind: 'reschedule', newArrivalTimeEpoch: 1, trainCode: 'X' }),
          ),
        ).toBeNull();
        expect(
          extractPayload(
            bgTaskData({
              kind: 'reschedule',
              nextStation: '',
              newArrivalTimeEpoch: 1,
              trainCode: 'X',
            }),
          ),
        ).toBeNull();
      });

      it('newArrivalTimeEpoch 비숫자/Infinity이면 null', () => {
        expect(
          extractPayload(
            bgTaskData({
              kind: 'reschedule',
              nextStation: 'A',
              newArrivalTimeEpoch: 'now',
              trainCode: 'X',
            }),
          ),
        ).toBeNull();
        expect(
          extractPayload(
            bgTaskData({
              kind: 'reschedule',
              nextStation: 'A',
              newArrivalTimeEpoch: Infinity,
              trainCode: 'X',
            }),
          ),
        ).toBeNull();
      });

      it('trainCode 누락/빈 문자열이면 null', () => {
        expect(
          extractPayload(
            bgTaskData({ kind: 'reschedule', nextStation: 'A', newArrivalTimeEpoch: 1 }),
          ),
        ).toBeNull();
        expect(
          extractPayload(
            bgTaskData({
              kind: 'reschedule',
              nextStation: 'A',
              newArrivalTimeEpoch: 1,
              trainCode: '',
            }),
          ),
        ).toBeNull();
      });

      it('sentAt/pushId 옵션 — 누락 시 undefined로 정리', () => {
        expect(
          extractPayload(
            bgTaskData({
              kind: 'reschedule',
              nextStation: 'A',
              newArrivalTimeEpoch: 1,
              trainCode: 'X',
            }),
          ),
        ).toMatchObject({ sentAt: undefined, pushId: undefined });
      });

      // #1193 — 중복역 trip의 N번째 occurrence를 정확히 정정하기 위한 인덱스.
      it.each([
        ['양의 정수', 2, 2],
        ['0(첫 등장)', 0, 0],
      ] as const)('occurrenceIdx 통과 (%s)', (_label, input, expected) => {
        expect(
          extractPayload(
            bgTaskData({
              kind: 'reschedule',
              nextStation: 'A',
              newArrivalTimeEpoch: 1,
              trainCode: 'X',
              occurrenceIdx: input,
            }),
          ),
        ).toMatchObject({ occurrenceIdx: expected });
      });

      it.each([
        ['누락', undefined],
        ['음수', -1],
        ['소수', 1.5],
        ['문자열', '2'],
      ] as const)('occurrenceIdx 비정상값(%s) → undefined', (_label, value) => {
        expect(
          extractPayload(
            bgTaskData({
              kind: 'reschedule',
              nextStation: 'A',
              newArrivalTimeEpoch: 1,
              trainCode: 'X',
              ...(value === undefined ? {} : { occurrenceIdx: value }),
            }),
          ),
        ).toMatchObject({ occurrenceIdx: undefined });
      });
    });

    // #868 — server-side trip auto-end 신호. nextWaypoint 없이 reason만 의미 있는 payload.
    describe('trip-ended kind (#868)', () => {
      it('정상 trip-ended payload → TripEndedSilentPushPayload', () => {
        expect(
          extractPayload(
            bgTaskData({
              kind: 'trip-ended',
              reason: 'eta-missing',
              sentAt: 1_780_000_000_000,
              pushId: 'uuid-te',
            }),
          ),
        ).toEqual({
          kind: 'trip-ended',
          reason: 'eta-missing',
          sentAt: 1_780_000_000_000,
          pushId: 'uuid-te',
        });
      });

      it.each([
        ['eta-missing'],
        ['seoul-outage'],
        ['destination-arrived'],
        ['expired'],
        ['push-unrecoverable'],
      ])('known reason %s → 그대로 전달', (reason) => {
        expect(
          extractPayload(bgTaskData({ kind: 'trip-ended', reason })),
        ).toMatchObject({ reason });
      });

      it('알 수 없는 reason → unknown으로 정규화 (구버전/신규 호환)', () => {
        expect(
          extractPayload(bgTaskData({ kind: 'trip-ended', reason: 'future-reason' })),
        ).toMatchObject({ reason: 'unknown' });
      });

      it('reason 누락/비문자열 → unknown', () => {
        expect(
          extractPayload(bgTaskData({ kind: 'trip-ended' })),
        ).toMatchObject({ reason: 'unknown' });
        expect(
          extractPayload(bgTaskData({ kind: 'trip-ended', reason: 42 })),
        ).toMatchObject({ reason: 'unknown' });
      });

      it('sentAt/pushId 옵션 — 누락 시 undefined로 정리', () => {
        expect(
          extractPayload(bgTaskData({ kind: 'trip-ended', reason: 'expired' })),
        ).toMatchObject({ sentAt: undefined, pushId: undefined });
      });

      it('tripToken 포함 시 그대로 전달 (race 가드용)', () => {
        expect(
          extractPayload(
            bgTaskData({ kind: 'trip-ended', reason: 'eta-missing', tripToken: 'tok-abc' }),
          ),
        ).toMatchObject({ tripToken: 'tok-abc' });
      });

      it('tripToken 누락/비문자열/빈 문자열 → undefined로 정규화 (구버전 backend 호환)', () => {
        expect(
          extractPayload(bgTaskData({ kind: 'trip-ended', reason: 'expired' })),
        ).toMatchObject({ tripToken: undefined });
        expect(
          extractPayload(bgTaskData({ kind: 'trip-ended', reason: 'expired', tripToken: 42 })),
        ).toMatchObject({ tripToken: undefined });
        expect(
          extractPayload(bgTaskData({ kind: 'trip-ended', reason: 'expired', tripToken: '' })),
        ).toMatchObject({ tripToken: undefined });
      });
    });

    // #2028 — boarding-prompt silent push payload (Layer 2 도달 채널).
    describe('boarding-prompt kind (#2028)', () => {
      it('정상 boarding-prompt payload → BoardingPromptSilentPushPayload', () => {
        expect(
          extractPayload(
            bgTaskData({
              kind: 'boarding-prompt',
              originStation: '강남',
              line: '2',
              tripToken: 'tok-bp',
              sentAt: 1_780_000_000_000,
              pushId: 'uuid-bp',
              destinationDirection: 'up',
              title: '탑승하셨나요?',
              body: '2호선 강남에서 열차가 곧 도착합니다.',
            }),
          ),
        ).toEqual({
          kind: 'boarding-prompt',
          originStation: '강남',
          line: '2',
          tripToken: 'tok-bp',
          sentAt: 1_780_000_000_000,
          pushId: 'uuid-bp',
          destinationDirection: 'up',
          title: '탑승하셨나요?',
          body: '2호선 강남에서 열차가 곧 도착합니다.',
          hopEndKind: undefined,
          nextLine: undefined,
          nextStation: undefined,
        });
      });

      it('originStation 누락/빈 문자열이면 null', () => {
        expect(
          extractPayload(
            bgTaskData({ kind: 'boarding-prompt', line: '2', tripToken: 'T' }),
          ),
        ).toBeNull();
        expect(
          extractPayload(
            bgTaskData({
              kind: 'boarding-prompt',
              originStation: '',
              line: '2',
              tripToken: 'T',
            }),
          ),
        ).toBeNull();
      });

      it('line 누락/빈 문자열이면 null', () => {
        expect(
          extractPayload(
            bgTaskData({ kind: 'boarding-prompt', originStation: '강남', tripToken: 'T' }),
          ),
        ).toBeNull();
        expect(
          extractPayload(
            bgTaskData({
              kind: 'boarding-prompt',
              originStation: '강남',
              line: '',
              tripToken: 'T',
            }),
          ),
        ).toBeNull();
      });

      it('tripToken 누락/빈 문자열이면 null (dedup key 필수)', () => {
        expect(
          extractPayload(
            bgTaskData({ kind: 'boarding-prompt', originStation: '강남', line: '2' }),
          ),
        ).toBeNull();
        expect(
          extractPayload(
            bgTaskData({
              kind: 'boarding-prompt',
              originStation: '강남',
              line: '2',
              tripToken: '',
            }),
          ),
        ).toBeNull();
      });

      it('optional 필드(sentAt/pushId/destinationDirection/title/body) 누락 시 undefined', () => {
        expect(
          extractPayload(
            bgTaskData({
              kind: 'boarding-prompt',
              originStation: '강남',
              line: '2',
              tripToken: 'T',
            }),
          ),
        ).toEqual({
          kind: 'boarding-prompt',
          originStation: '강남',
          line: '2',
          tripToken: 'T',
          sentAt: undefined,
          pushId: undefined,
          destinationDirection: undefined,
          title: undefined,
          body: undefined,
          hopEndKind: undefined,
          nextLine: undefined,
          nextStation: undefined,
        });
      });

      it('destinationDirection이 up/down이 아니면 undefined로 정규화', () => {
        expect(
          extractPayload(
            bgTaskData({
              kind: 'boarding-prompt',
              originStation: '강남',
              line: '2',
              tripToken: 'T',
              destinationDirection: 'sideways',
            }),
          ),
        ).toMatchObject({ destinationDirection: undefined });
      });

      it('title/body가 빈 문자열이면 undefined로 정규화 (fallback 트리거)', () => {
        expect(
          extractPayload(
            bgTaskData({
              kind: 'boarding-prompt',
              originStation: '강남',
              line: '2',
              tripToken: 'T',
              title: '',
              body: '',
            }),
          ),
        ).toMatchObject({ title: undefined, body: undefined });
      });

      // #2034 — hop-end (환승역 하차) payload 확장.
      it('hopEndKind + nextLine + nextStation 을 payload 로 정규화 (#2034)', () => {
        expect(
          extractPayload(
            bgTaskData({
              kind: 'boarding-prompt',
              originStation: '성수',
              line: '2',
              tripToken: 'tok-hop',
              hopEndKind: 'disembark',
              nextLine: 'K',
              nextStation: '왕십리',
            }),
          ),
        ).toMatchObject({
          hopEndKind: 'disembark',
          nextLine: 'K',
          nextStation: '왕십리',
        });
      });

      it('hopEndKind 이 disembark 이 아니면 undefined 로 정규화 (#2034)', () => {
        expect(
          extractPayload(
            bgTaskData({
              kind: 'boarding-prompt',
              originStation: '성수',
              line: '2',
              tripToken: 'tok',
              hopEndKind: 'invalid',
            }),
          ),
        ).toMatchObject({ hopEndKind: undefined });
      });

      it('nextLine/nextStation 이 빈 문자열이면 undefined 로 정규화 (#2034)', () => {
        expect(
          extractPayload(
            bgTaskData({
              kind: 'boarding-prompt',
              originStation: '성수',
              line: '2',
              tripToken: 'tok',
              hopEndKind: 'disembark',
              nextLine: '',
              nextStation: '',
            }),
          ),
        ).toMatchObject({ nextLine: undefined, nextStation: undefined });
      });
    });

    // #2036 (Issue I γ) — sleep-transfer-alarm silent push payload (취침모드 환승 알람 채널).
    describe('sleep-transfer-alarm kind (#2036)', () => {
      it('정상 sleep-transfer-alarm payload → SleepTransferAlarmSilentPushPayload', () => {
        expect(
          extractPayload(
            bgTaskData({
              kind: 'sleep-transfer-alarm',
              originStation: '성수',
              nextLine: '2',
              nextStation: '뚝섬',
              tripToken: 'tok-sta',
              sentAt: 1_780_000_000_000,
              pushId: 'uuid-sta',
              title: '곧 환승역입니다',
              body: '성수에서 2호선 뚝섬으로 환승',
            }),
          ),
        ).toEqual({
          kind: 'sleep-transfer-alarm',
          originStation: '성수',
          nextLine: '2',
          nextStation: '뚝섬',
          tripToken: 'tok-sta',
          sentAt: 1_780_000_000_000,
          pushId: 'uuid-sta',
          title: '곧 환승역입니다',
          body: '성수에서 2호선 뚝섬으로 환승',
        });
      });

      it('originStation 누락/빈 문자열이면 null', () => {
        expect(
          extractPayload(
            bgTaskData({
              kind: 'sleep-transfer-alarm',
              nextLine: '2',
              nextStation: '뚝섬',
              tripToken: 'T',
            }),
          ),
        ).toBeNull();
        expect(
          extractPayload(
            bgTaskData({
              kind: 'sleep-transfer-alarm',
              originStation: '',
              nextLine: '2',
              nextStation: '뚝섬',
              tripToken: 'T',
            }),
          ),
        ).toBeNull();
      });

      it('nextLine 누락/빈 문자열이면 null', () => {
        expect(
          extractPayload(
            bgTaskData({
              kind: 'sleep-transfer-alarm',
              originStation: '성수',
              nextStation: '뚝섬',
              tripToken: 'T',
            }),
          ),
        ).toBeNull();
        expect(
          extractPayload(
            bgTaskData({
              kind: 'sleep-transfer-alarm',
              originStation: '성수',
              nextLine: '',
              nextStation: '뚝섬',
              tripToken: 'T',
            }),
          ),
        ).toBeNull();
      });

      it('nextStation 누락/빈 문자열이면 null', () => {
        expect(
          extractPayload(
            bgTaskData({
              kind: 'sleep-transfer-alarm',
              originStation: '성수',
              nextLine: '2',
              tripToken: 'T',
            }),
          ),
        ).toBeNull();
        expect(
          extractPayload(
            bgTaskData({
              kind: 'sleep-transfer-alarm',
              originStation: '성수',
              nextLine: '2',
              nextStation: '',
              tripToken: 'T',
            }),
          ),
        ).toBeNull();
      });

      it('tripToken 누락/빈 문자열이면 null (dedup key 필수)', () => {
        expect(
          extractPayload(
            bgTaskData({
              kind: 'sleep-transfer-alarm',
              originStation: '성수',
              nextLine: '2',
              nextStation: '뚝섬',
            }),
          ),
        ).toBeNull();
        expect(
          extractPayload(
            bgTaskData({
              kind: 'sleep-transfer-alarm',
              originStation: '성수',
              nextLine: '2',
              nextStation: '뚝섬',
              tripToken: '',
            }),
          ),
        ).toBeNull();
      });

      it('optional 필드(sentAt/pushId/title/body) 누락 시 undefined', () => {
        expect(
          extractPayload(
            bgTaskData({
              kind: 'sleep-transfer-alarm',
              originStation: '성수',
              nextLine: '2',
              nextStation: '뚝섬',
              tripToken: 'T',
            }),
          ),
        ).toEqual({
          kind: 'sleep-transfer-alarm',
          originStation: '성수',
          nextLine: '2',
          nextStation: '뚝섬',
          tripToken: 'T',
          sentAt: undefined,
          pushId: undefined,
          title: undefined,
          body: undefined,
        });
      });

      it('title/body가 빈 문자열이면 undefined로 정규화 (fallback 트리거)', () => {
        expect(
          extractPayload(
            bgTaskData({
              kind: 'sleep-transfer-alarm',
              originStation: '성수',
              nextLine: '2',
              nextStation: '뚝섬',
              tripToken: 'T',
              title: '',
              body: '',
            }),
          ),
        ).toMatchObject({ title: undefined, body: undefined });
      });
    });
  });

  describe('handleSilentPush', () => {
    it('error 있으면 즉시 종료 (gate 호출 안 됨)', async () => {
      await handleSilentPush({ error: { message: 'boom' } });
      expect(mockCheckGate).not.toHaveBeenCalled();
      expect(mockLogSilentPushReceived).not.toHaveBeenCalled();
    });

    it('payload 없으면 skip', async () => {
      await handleSilentPush({ data: undefined });
      expect(mockLogSilentPushReceived).not.toHaveBeenCalled();
      expect(mockCheckGate).not.toHaveBeenCalled();
    });

    it('invalid payload면 skip', async () => {
      await handleSilentPush({
        data: bgTaskData({ trigger: 'other' }),
      });
      expect(mockLogSilentPushReceived).not.toHaveBeenCalled();
    });

    it('수신 시 logSilentPushReceived 호출 — sentAt 포함 (#478)', async () => {
      await handleSilentPush(
        payload({ kind: 'transfer', phase: 'early', sentAt: 1_700_000_000_000 }),
      );
      expect(mockLogSilentPushReceived).toHaveBeenCalledTimes(1);
      const arg = mockLogSilentPushReceived.mock.calls[0][0];
      expect(arg.sentAt).toBe(1_700_000_000_000);
      expect(typeof arg.receivedAt).toBe('number');
    });

    // #2045 (Signal 4) — 유효 payload 진입 시점에 last-received stamp 갱신 (kind 무관).
    // useLaunchTripReconciliation이 launch 시 read해 backend-timeout self-end 판정 (관찰 22 BG kill 커버).
    describe('#2045 Signal 4 — setLastSilentPushReceivedAt wire', () => {
      it('유효 standard payload → setLastSilentPushReceivedAt 1회 호출 (숫자 인자)', async () => {
        await handleSilentPush(payload({ kind: 'transfer', phase: 'early' }));
        expect(mockSetLastSilentPushReceivedAt).toHaveBeenCalledTimes(1);
        expect(typeof mockSetLastSilentPushReceivedAt.mock.calls[0][0]).toBe('number');
      });

      it('invalid payload → setLastSilentPushReceivedAt 호출 안 함 (유효 payload 진입점에서만 stamp)', async () => {
        await handleSilentPush({ data: bgTaskData({ trigger: 'other' }) });
        expect(mockSetLastSilentPushReceivedAt).not.toHaveBeenCalled();
      });

      it('input.error → setLastSilentPushReceivedAt 호출 안 함', async () => {
        await handleSilentPush({ error: { message: 'boom' } });
        expect(mockSetLastSilentPushReceivedAt).not.toHaveBeenCalled();
      });
    });

    // #1438 (E5) — backend → device lock release sync 채널 통합.
    describe('lockReleasedReason → store sync (#1438)', () => {
      it("'transfer' payload면 useBoardingLockStore.releaseLock('transfer') 호출", async () => {
        await handleSilentPush(
          payload({
            kind: 'transfer',
            phase: 'imminent',
            lockReleasedReason: 'transfer',
            sentAt: 1_700_000_000_000,
          }),
        );
        expect(mockStoreReleaseLock).toHaveBeenCalledWith('transfer');
      });

      it("'vanish' payload면 useBoardingLockStore.releaseLock('vanish') 호출", async () => {
        await handleSilentPush(
          payload({
            kind: 'intermediate',
            phase: 'imminent',
            lockReleasedReason: 'vanish',
            nextWaypoint: '중곡',
          }),
        );
        expect(mockStoreReleaseLock).toHaveBeenCalledWith('vanish');
      });

      it('lockReleasedReason 누락이면 releaseLock 호출 없음 (구 backend 호환)', async () => {
        await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));
        expect(mockStoreReleaseLock).not.toHaveBeenCalled();
      });

      it('releaseLock throw해도 본 처리 흐름은 계속 진행 (graceful)', async () => {
        mockStoreReleaseLock.mockRejectedValueOnce(new Error('store-fail'));
        await handleSilentPush(
          payload({
            kind: 'destination',
            phase: 'imminent',
            lockReleasedReason: 'transfer',
          }),
        );
        // gate 평가까지 도달 = 본 처리 흐름 차단되지 않음.
        expect(mockCheckGate).toHaveBeenCalled();
      });
    });

    it('kind 미상(구 백엔드)이면 received 적재 후 skip 적재 + 발사 안 함', async () => {
      await handleSilentPush({
        data: bgTaskData({ nextWaypoint: '강남', etaSeconds: 10, phase: 'imminent' }),
      });
      expect(mockLogSilentPushReceived).toHaveBeenCalled();
      expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'payload-missing-kind' }),
      );
      expect(mockCheckGate).not.toHaveBeenCalled();
      expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
    });

    it('게이트 통과 시 destination 즉시 발사 + fired 로그 + FIRED_ALARMS 갱신', async () => {
      await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));

      expect(mockCheckGate).toHaveBeenCalledWith({
        stationName: '강남',
        kind: 'destination',
        phase: 'imminent',
        isLockless: false,
        payloadHopIndex: undefined,
        subsurface: false,
        occupiedLine: undefined,
        // #1365 — lock 활성 시 lock.boardingLine을 estimatorLine으로 전달.
        estimatorLine: '2',
      });
      expect(mockScheduleNotificationAsync).toHaveBeenCalledTimes(1);
      const call = mockScheduleNotificationAsync.mock.calls[0][0];
      expect(call.trigger).toBeNull();
      expect(call.content.body).toContain('강남');
      expect(mockLogSilentPushFired).toHaveBeenCalledWith(
        expect.objectContaining({
          stationName: '강남',
          kind: 'destination',
          phaseId: 'imminent',
          distanceM: 150,
          thresholdM: 800,
          locationSource: 'cache',
          locationAgeMs: 10_000,
        }),
      );
      expect(mockSetFiredAlarms).toHaveBeenCalledTimes(1);
      const [, savedSet] = mockSetFiredAlarms.mock.calls[0];
      expect(Array.from(savedSet as Set<string>)).toEqual(['imminent:강남']);
    });

    it('alarm 경로(destination/transfer)는 buildAlarmContent에 positionTrain source 전달 (#327)', async () => {
      await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));
      expect(mockBuildAlarmContent).toHaveBeenCalledWith(
        expect.objectContaining({ phaseId: 'imminent', type: 'destination' }),
        'positionTrain',
      );
    });

    it('intermediate는 i18n key로 본문 생성 + FIRED_ALARMS dedup 안 씀', async () => {
      await handleSilentPush(payload({ kind: 'intermediate', phase: 'imminent', nextWaypoint: '중곡' }));

      const call = mockScheduleNotificationAsync.mock.calls[0][0];
      expect(call.content.title).toBe('route.intermediatePassedTitle');
      // positionTrain은 #327 UX 정책상 자백 대상이 아니라 suffix 미부착.
      expect(call.content.body).toBe('route.intermediatePassedBody:중곡');
      expect(mockGetFiredAlarms).not.toHaveBeenCalled();
      expect(mockSetFiredAlarms).not.toHaveBeenCalled();
      expect(mockLogSilentPushFired).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'station-passed' }),
      );
    });

    it('intermediate가 게이트 fail이면 skip 적재 kind=station-passed', async () => {
      mockCheckGate.mockResolvedValue({ pass: false, reason: 'out-of-range' });
      await handleSilentPush(payload({ kind: 'intermediate', phase: 'imminent', nextWaypoint: '중곡' }));
      expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'station-passed', reason: 'gate-out-of-range' }),
      );
    });

    it('게이트 fail(out-of-range)이면 skip 적재 + 발사 안 함', async () => {
      mockCheckGate.mockResolvedValue({
        pass: false,
        reason: 'out-of-range',
        distanceM: 5_000,
        thresholdM: 400,
        locationSource: 'cache',
        locationAgeMs: 5_000,
      });

      await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));

      expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
      expect(mockLogSilentPushFired).not.toHaveBeenCalled();
      expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'gate-out-of-range',
          distanceM: 5_000,
          thresholdM: 400,
        }),
      );
      expect(mockSetFiredAlarms).not.toHaveBeenCalled();
    });

    it.each([
      ['unknown-station', 'gate-unknown-station'],
      ['no-location', 'gate-no-location'],
      ['stale-location', 'gate-stale-location'],
      ['out-of-range', 'gate-out-of-range'],
      // #1365 — line-mismatch는 환승역 line cross-validation 실패로 차단된 케이스.
      ['line-mismatch', 'gate-line-mismatch'],
    ])('게이트 reason=%s → logSkipped reason=%s', async (gateReason, logReason) => {
      mockCheckGate.mockResolvedValue({ pass: false, reason: gateReason });
      await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));
      expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
        expect.objectContaining({ reason: logReason }),
      );
    });

    it('FIRED_ALARMS에 이미 같은 키 있으면 발사 안 함 (dedup, GPS 발화와 키 공유)', async () => {
      mockGetFiredAlarms.mockResolvedValue(new Set(['imminent:강남']));
      await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));
      expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
      expect(mockSetFiredAlarms).not.toHaveBeenCalled();
      expect(mockLogSilentPushFired).not.toHaveBeenCalled();
    });

    it('destination AsyncStorage 없으면 dedup 건너뛰고 발사 (보수적 진행)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
      await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));
      expect(mockScheduleNotificationAsync).toHaveBeenCalledTimes(1);
      expect(mockGetFiredAlarms).not.toHaveBeenCalled();
    });

    it('destination JSON 손상 시 dedup 건너뛰고 발사', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue('not-json{');
      await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));
      expect(mockScheduleNotificationAsync).toHaveBeenCalledTimes(1);
      expect(mockGetFiredAlarms).not.toHaveBeenCalled();
    });

    it('destination에 id 없으면 dedup 건너뛰고 발사', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(JSON.stringify({ name: 'x' }));
      await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));
      expect(mockScheduleNotificationAsync).toHaveBeenCalledTimes(1);
      expect(mockGetFiredAlarms).not.toHaveBeenCalled();
    });

    it('scheduleNotificationAsync throw 시 graceful (전체 throw 안 함)', async () => {
      mockScheduleNotificationAsync.mockRejectedValue(new Error('boom'));
      await expect(
        handleSilentPush(payload({ kind: 'destination', phase: 'imminent' })),
      ).resolves.toBeUndefined();
    });

    it('transfer + early — 기존 사전예약 호출(scheduleAlarmsForRoute) 없음', async () => {
      await handleSilentPush(payload({ kind: 'transfer', phase: 'early' }));
      // 발사는 됨
      expect(mockScheduleNotificationAsync).toHaveBeenCalled();
      // 사전예약은 import도 안 함 — 호출 검증은 import 부재로 충분하나, 추가 안전망:
      // alarmScheduler 모듈을 jest.mock하지 않았기 때문에 호출 시 ReferenceError가 났을 것.
    });

    describe('#707 BoardingLock line 가드', () => {
      const lockOnLine7 = {
        destinationId: '0228',
        trainCode: 'T-7',
        boardingStationId: 'station-on-7',
        boardingLine: '7' as const,
        boardedAt: 1_700_000_000_000,
        expectedDurationMs: 600_000,
      };

      it('lock 활성 + nextWaypoint가 lock.boardingLine에 정차 안 함 → skip + ack(lock-line-mismatch)', async () => {
        mockGetBoardingLock.mockResolvedValue(lockOnLine7);
        // line 7에는 없음, 다른 line에는 존재 → 라인 mismatch.
        mockFindStationByNameAndLine.mockReturnValue(null);
        mockFindStationByName.mockReturnValue({ id: 'other-line-stop', name: '강남', line: '2' });

        await handleSilentPush(
          payload({ kind: 'destination', phase: 'imminent', pushId: 'p-mismatch' }),
        );

        expect(mockFindStationByNameAndLine).toHaveBeenCalledWith('강남', '7');
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        expect(mockLogSilentPushFired).not.toHaveBeenCalled();
        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'lock-line-mismatch', kind: 'destination' }),
        );
        expect(mockSendPushAck).toHaveBeenCalledWith({
          pushId: 'p-mismatch',
          token: DEFAULT_APNS_TOKEN,
          outcome: 'skipped',
          reason: 'lock-line-mismatch',
          permissionMode: 'always',
        });
      });

      it('lock 활성 + nextWaypoint가 lock.boardingLine에 정차(환승역 양쪽 호선 stop 존재) → 통과 후 발사', async () => {
        mockGetBoardingLock.mockResolvedValue(lockOnLine7);
        // line 7 stop이 존재 → 환승역에서 line 7로도 정차하는 정상 케이스(transfer 등).
        mockFindStationByNameAndLine.mockReturnValue({
          id: 'stop-on-7',
          name: '강남',
          line: '7',
        });

        await handleSilentPush(payload({ kind: 'transfer', phase: 'early' }));

        expect(mockFindStationByNameAndLine).toHaveBeenCalledWith('강남', '7');
        expect(mockScheduleNotificationAsync).toHaveBeenCalled();
        expect(mockLogSilentPushFired).toHaveBeenCalled();
      });

      it('lock 활성 + nextWaypoint가 stations.json 어디에도 없으면 line 가드는 통과시키고 일반 게이트가 unknown-station으로 처리', async () => {
        mockGetBoardingLock.mockResolvedValue(lockOnLine7);
        mockFindStationByNameAndLine.mockReturnValue(null);
        mockFindStationByName.mockReturnValue(null);
        // 일반 게이트가 unknown-station 반환 가정.
        mockCheckGate.mockResolvedValue({ pass: false, reason: 'unknown-station' });

        await handleSilentPush(
          payload({ kind: 'destination', phase: 'imminent', pushId: 'p-unknown' }),
        );

        // line 가드의 skip 사유가 아닌, 기존 게이트 사유로 분류돼야 한다.
        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'gate-unknown-station' }),
        );
        expect(mockLogSilentPushSkipped).not.toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'lock-line-mismatch' }),
        );
      });

      it('lock 없음 + intermediate → line 가드 skip + lockless-opt-out (#1810 paradigm shift)', async () => {
        mockGetBoardingLock.mockResolvedValue(null);
        await handleSilentPush(payload({ kind: 'intermediate', phase: 'imminent' }));
        expect(mockFindStationByNameAndLine).not.toHaveBeenCalled();
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'lockless-opt-out' }),
        );
      });

      it('intermediate kind도 lock line mismatch 시 station-passed로 skip 적재', async () => {
        mockGetBoardingLock.mockResolvedValue(lockOnLine7);
        mockFindStationByNameAndLine.mockReturnValue(null);
        mockFindStationByName.mockReturnValue({ id: 'x', name: '중곡', line: '5' });

        await handleSilentPush(
          payload({ kind: 'intermediate', phase: 'imminent', nextWaypoint: '중곡' }),
        );

        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({ kind: 'station-passed', reason: 'lock-line-mismatch' }),
        );
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
      });
    });

    // #1810 — paradigm shift Phase 1+2: lockless 분기는 항상 skip
    describe('#1810 — lockless 분기 (lock 없음, 항상 skip)', () => {
      type SkipCase = {
        name: string;
        kind: 'destination' | 'transfer' | 'intermediate';
        pushId?: string;
      };

      const skipCases: SkipCase[] = [
        { name: 'intermediate', kind: 'intermediate', pushId: 'p-int' },
        { name: 'transfer', kind: 'transfer', pushId: 'p-tx' },
        { name: 'destination', kind: 'destination', pushId: 'p-dst' },
      ];

      it.each(skipCases)('lock 없음 + $name → lockless-opt-out (#1810)', async ({ kind, pushId }) => {
        mockGetBoardingLock.mockResolvedValue(null);
        await handleSilentPush(payload({ kind, phase: 'imminent', ...(pushId ? { pushId } : {}) }));
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'lockless-opt-out', kind: 'station-passed' }),
        );
        if (pushId) {
          expect(mockSendPushAck).toHaveBeenCalledWith({
            pushId,
            token: DEFAULT_APNS_TOKEN,
            outcome: 'skipped',
            reason: 'lockless-opt-out',
            permissionMode: 'always',
          });
        }
      });
    });

    // #1322 — 로컬 lock 없이 payload.boardingLine(self-describing push)으로 line 가드 수행.
    // 지하 auto-lock hydration window에서 backend lock-path push(transfer/destination)를 발사.
    describe('#1322 — self-describing push (lock 없음 + payload.boardingLine)', () => {
      beforeEach(() => {
        mockGetBoardingLock.mockResolvedValue(null);
      });

      it('lock 없음 + payload.boardingLine에 정차하는 transfer → line 가드 통과 후 발사', async () => {
        // payload.boardingLine='7'에 nextWaypoint가 정차 → 정상 lock-path fire.
        mockFindStationByNameAndLine.mockReturnValue({ id: 'stop-on-7', name: '강남', line: '7' });

        await handleSilentPush(
          payload({ kind: 'transfer', phase: 'imminent', boardingLine: '7', pushId: 'p-self' }),
        );

        expect(mockFindStationByNameAndLine).toHaveBeenCalledWith('강남', '7');
        expect(mockScheduleNotificationAsync).toHaveBeenCalled();
        expect(mockLogSilentPushFired).toHaveBeenCalled();
      });

      it('lock 없음 + payload.boardingLine line-mismatch → skip + ack(lock-line-mismatch)', async () => {
        // line 7에는 없고 다른 line에만 존재 → mismatch.
        mockFindStationByNameAndLine.mockReturnValue(null);
        mockFindStationByName.mockReturnValue({ id: 'other', name: '강남', line: '2' });

        await handleSilentPush(
          payload({ kind: 'destination', phase: 'imminent', boardingLine: '7', pushId: 'p-mm' }),
        );

        expect(mockFindStationByNameAndLine).toHaveBeenCalledWith('강남', '7');
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'lock-line-mismatch', kind: 'destination' }),
        );
        expect(mockSendPushAck).toHaveBeenCalledWith({
          pushId: 'p-mm',
          token: DEFAULT_APNS_TOKEN,
          outcome: 'skipped',
          reason: 'lock-line-mismatch',
          permissionMode: 'always',
        });
      });

      it('lock 없음 + payload.boardingLine + nextWaypoint가 stations.json 부재 → 가드 통과 후 발사', async () => {
        // 양쪽 lookup 모두 null → graceful pass(일반 게이트로 위임), 게이트 통과 가정 → 발사.
        mockFindStationByNameAndLine.mockReturnValue(null);
        mockFindStationByName.mockReturnValue(null);

        await handleSilentPush(payload({ kind: 'transfer', phase: 'imminent', boardingLine: '7' }));

        expect(mockScheduleNotificationAsync).toHaveBeenCalled();
        expect(mockLogSilentPushFired).toHaveBeenCalled();
      });

      it('lock 없음 + payload.boardingLine 통과 시 발사 (#1322 lock-path fire)', async () => {
        // backend가 lock을 보유한 lock-path fire이므로 lockless skip 없이 발사.
        mockFindStationByNameAndLine.mockReturnValue({ id: 'stop-on-7', name: '강남', line: '7' });

        await handleSilentPush(payload({ kind: 'transfer', phase: 'imminent', boardingLine: '7' }));

        expect(mockScheduleNotificationAsync).toHaveBeenCalled();
        expect(mockLogSilentPushFired).toHaveBeenCalled();
      });

      it('lock 없음 + payload.boardingLine 부재 → lockless-opt-out skip (#1810)', async () => {
        // #1810 — boardingLine 없으면 lockless 분기로 빠져 항상 skip.
        await handleSilentPush(
          payload({ kind: 'transfer', phase: 'imminent', pushId: 'p-nolock-noline' }),
        );

        expect(mockFindStationByNameAndLine).not.toHaveBeenCalled();
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'lockless-opt-out' }),
        );
      });
    });

    // #1399 — 좀비 알림 cleanup: tripToken stamp + ACTIVE_TRIP_KEY mismatch drop.
    describe('#1399 — tripToken mismatch 가드 (좀비 알림 cleanup)', () => {
      it('payload.tripToken === ACTIVE_TRIP_KEY → 가드 통과 후 발사', async () => {
        setAsyncStorageMap({ [ACTIVE_TRIP_KEY]: 'active-token-123' });
        await handleSilentPush(
          payload({
            kind: 'destination',
            phase: 'imminent',
            tripToken: 'active-token-123',
            pushId: 'p-match',
          }),
        );
        expect(mockScheduleNotificationAsync).toHaveBeenCalled();
        expect(mockLogSilentPushFired).toHaveBeenCalled();
      });

      it('payload.tripToken 다른 token → trip-token-mismatch skip', async () => {
        setAsyncStorageMap({ [ACTIVE_TRIP_KEY]: 'active-token-NEW' });
        await handleSilentPush(
          payload({
            kind: 'intermediate',
            phase: 'imminent',
            tripToken: 'stale-token-OLD',
            pushId: 'p-stale',
          }),
        );
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'trip-token-mismatch', kind: 'station-passed' }),
        );
        expect(mockSendPushAck).toHaveBeenCalledWith(
          ackCall('p-stale', 'skipped', 'trip-token-mismatch'),
        );
      });

      it('ACTIVE_TRIP_KEY null (이미 cleanup됨) + payload.tripToken 있음 → drop', async () => {
        setAsyncStorageMap({ [ACTIVE_TRIP_KEY]: null });
        await handleSilentPush(
          payload({
            kind: 'transfer',
            phase: 'imminent',
            tripToken: 'orphan-token',
            pushId: 'p-orphan',
          }),
        );
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'trip-token-mismatch', kind: 'transfer' }),
        );
      });

      it('payload.tripToken 미전달 (구 backend) → 가드 skip, 발사 진행', async () => {
        setAsyncStorageMap({ [ACTIVE_TRIP_KEY]: 'active-token-x' });
        // payload에 tripToken 미전달 → undefined → 가드 자연 skip.
        await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));
        expect(mockScheduleNotificationAsync).toHaveBeenCalled();
      });
    });

    describe('#568 P2b — push ACK', () => {
      it('fire 성공 시 sendPushAck(outcome=fired) 호출, reason 없음', async () => {
        await handleSilentPush(
          payload({ kind: 'destination', phase: 'imminent', pushId: 'p-fire' }),
        );
        expect(mockSendPushAck).toHaveBeenCalledWith(ackCall('p-fire', 'fired'));
      });

      it('게이트 fail 시 sendPushAck(outcome=skipped, reason=게이트사유)', async () => {
        mockCheckGate.mockResolvedValue({
          pass: false,
          reason: 'out-of-range',
          distanceM: 5_000,
          thresholdM: 400,
        });
        await handleSilentPush(
          payload({ kind: 'destination', phase: 'imminent', pushId: 'p-gate' }),
        );
        expect(mockSendPushAck).toHaveBeenCalledWith(
          ackCall('p-gate', 'skipped', 'gate-out-of-range'),
        );
      });

      it('FIRED_ALARMS dedup 시 sendPushAck(outcome=skipped, reason=dedup-already-fired)', async () => {
        mockGetFiredAlarms.mockResolvedValue(new Set(['imminent:강남']));
        await handleSilentPush(
          payload({ kind: 'destination', phase: 'imminent', pushId: 'p-dedup' }),
        );
        expect(mockSendPushAck).toHaveBeenCalledWith(
          ackCall('p-dedup', 'skipped', 'dedup-already-fired'),
        );
      });

      // #1367 — hopIndex>=1이면 alarmKey가 `phase:station#n` 형식이라 default(0) dedup과 collide하지 않는다.
      it('#1367 hopIndex>=1 silent push는 default dedup key(`phase:station`)와 collide하지 않음 — 발사 진행', async () => {
        mockGetFiredAlarms.mockResolvedValue(new Set(['imminent:강남']));
        await handleSilentPush(
          payload({
            kind: 'destination',
            phase: 'imminent',
            pushId: 'p-hop-1',
            hopIndex: 1,
          }),
        );
        expect(mockSendPushAck).toHaveBeenCalledWith({
          pushId: 'p-hop-1',
          token: DEFAULT_APNS_TOKEN,
          outcome: 'fired',
          permissionMode: 'always',
        });
      });

      // #1367 cross-channel — OS scheduled receiver가 hopIndex=2로 fire 후 fired set에 등록되어 있을 때
      // 같은 hopIndex의 silent push가 도달하면 dedup 적중 (silent push + OS queue 통합 공간).
      it('#1367 cross-channel — fired set에 `phase:station#n` 등록 시 같은 hopIndex silent push는 dedup', async () => {
        mockGetFiredAlarms.mockResolvedValue(new Set(['imminent:강남#2']));
        await handleSilentPush(
          payload({
            kind: 'destination',
            phase: 'imminent',
            pushId: 'p-cross-channel',
            hopIndex: 2,
          }),
        );
        expect(mockSendPushAck).toHaveBeenCalledWith({
          pushId: 'p-cross-channel',
          token: DEFAULT_APNS_TOKEN,
          outcome: 'skipped',
          reason: 'dedup-already-fired',
          permissionMode: 'always',
        });
      });

      // #1901/#1900 (RC-7/RC-10a) — channel-agnostic 8분 backstop. FIRED_ALARMS dedup이 통과해도
      // lastFire Map에 같은 station이 8분 안에 적재돼 있으면 silent push 발사 차단.
      // backend가 같은 station-pass 1건에 silent state push + LA dirty update 2채널 발사 →
      // device가 silent push로 같은 station을 2회 받는 회귀(2026-06-26 trip-3 동대문역사문화공원).
      it('#1901/#1900 isAnyChannelRecentlyFired=true 시 silent push 발사 차단 + skipped ack', async () => {
        mockGetFiredAlarms.mockResolvedValue(new Set()); // FIRED_ALARMS는 비어 있음
        mockIsAnyChannelRecentlyFired.mockReturnValueOnce(true);
        await handleSilentPush(
          payload({
            kind: 'destination',
            phase: 'imminent',
            pushId: 'p-channel-agnostic',
          }),
        );
        expect(mockLogSuppressedChannelAgnosticDedup).toHaveBeenCalledWith({
          source: 'silent-push-skipped',
          stationName: '강남',
          kind: 'destination',
          phaseId: 'imminent',
        });
        expect(mockSendPushAck).toHaveBeenCalledWith(
          ackCall('p-channel-agnostic', 'skipped', 'dedup-already-fired'),
        );
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        // markStationFired는 fire 직후에만 호출 — skip 분기에서 호출 안 됨.
        expect(mockMarkStationFired).not.toHaveBeenCalled();
      });

      // #1901/#1900 — intermediate(station-passed) 분기도 channel-agnostic gate 적용.
      // FIRED_ALARMS dedup은 dedupKey=null이라 우회되지만 8분 backstop은 차단.
      it('#1901/#1900 intermediate kind도 channel-agnostic gate로 차단됨', async () => {
        mockGetFiredAlarms.mockResolvedValue(new Set());
        mockIsAnyChannelRecentlyFired.mockReturnValueOnce(true);
        await handleSilentPush(
          payload({
            kind: 'intermediate',
            phase: 'imminent',
            pushId: 'p-intermediate-agnostic',
          }),
        );
        expect(mockLogSuppressedChannelAgnosticDedup).toHaveBeenCalledWith({
          source: 'silent-push-skipped',
          stationName: '강남',
          kind: 'station-passed',
          phaseId: 'imminent',
        });
        expect(mockSendPushAck).toHaveBeenCalledWith(
          ackCall('p-intermediate-agnostic', 'skipped', 'dedup-already-fired'),
        );
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        expect(mockMarkStationFired).not.toHaveBeenCalled();
      });

      // #1901/#1900 — channel-agnostic dedup skip branch에서 pushId 미정의 케이스. addFiredPushId
      // 조건부 호출의 falsy 분기 커버.
      it('#1901/#1900 channel-agnostic skip + pushId 부재 시 addFiredPushId 미호출', async () => {
        mockGetFiredAlarms.mockResolvedValue(new Set());
        mockIsAnyChannelRecentlyFired.mockReturnValueOnce(true);
        await handleSilentPush(
          payload({
            kind: 'destination',
            phase: 'imminent',
            // pushId 명시 안 함 — undefined.
          }),
        );
        expect(mockLogSuppressedChannelAgnosticDedup).toHaveBeenCalled();
        // pushId 부재라 addFiredPushId 미호출 검증.
        expect(mockAddFiredPushId).not.toHaveBeenCalled();
      });

      // #1901/#1900 — fire 직후 markStationFired 호출 → FG fireAndLog / stationPipeline이 같은
      // station 8분 backstop으로 cross-channel 중복 차단 (lastFire Map 공유).
      it('#1901/#1900 fire 후 markStationFired 호출 (lastFire Map 갱신)', async () => {
        mockGetFiredAlarms.mockResolvedValue(new Set());
        mockIsAnyChannelRecentlyFired.mockReturnValueOnce(false);
        await handleSilentPush(
          payload({
            kind: 'destination',
            phase: 'imminent',
            pushId: 'p-mark',
          }),
        );
        // intermediate가 아닌 destination → category='destination'으로 mark. phaseId도 stamp.
        expect(mockMarkStationFired).toHaveBeenCalledWith(
          destStation.id,
          '강남',
          'destination',
          expect.any(Number),
          'imminent',
        );
        expect(mockSendPushAck).toHaveBeenCalledWith(
          ackCall('p-mark', 'fired'),
        );
      });

      // #1901/#1900 — intermediate fire는 'station-passed' category로 mark.
      it('#1901/#1900 intermediate fire 후 markStationFired는 station-passed category로 호출', async () => {
        mockGetFiredAlarms.mockResolvedValue(new Set());
        mockIsAnyChannelRecentlyFired.mockReturnValueOnce(false);
        await handleSilentPush(
          payload({
            kind: 'intermediate',
            phase: 'imminent',
            pushId: 'p-intermediate-mark',
          }),
        );
        expect(mockMarkStationFired).toHaveBeenCalledWith(
          destStation.id,
          '강남',
          'station-passed',
          expect.any(Number),
          'imminent',
        );
      });

      it('payload-missing-kind 시 sendPushAck(outcome=skipped, reason=payload-missing-kind)', async () => {
        await handleSilentPush({
          data: bgTaskData({
            nextWaypoint: '강남',
            etaSeconds: 10,
            phase: 'imminent',
            pushId: 'p-kind',
          }),
        });
        expect(mockSendPushAck).toHaveBeenCalledWith(
          ackCall('p-kind', 'skipped', 'payload-missing-kind'),
        );
      });

      it('pushId 누락(구 백엔드)이면 ACK skip', async () => {
        await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));
        expect(mockSendPushAck).not.toHaveBeenCalled();
      });

      it('APNs token 없으면 ACK skip (token 인증 불가)', async () => {
        (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
          if (key === DESTINATION_KEY) return JSON.stringify(destStation);
          if (key === APNS_TOKEN_KEY) return null;
          return null;
        });
        await handleSilentPush(
          payload({ kind: 'destination', phase: 'imminent', pushId: 'p-no-token' }),
        );
        expect(mockSendPushAck).not.toHaveBeenCalled();
      });

      it('APNS_TOKEN_KEY 읽기 throw해도 ACK 단순 skip — 본 처리는 정상 진행', async () => {
        (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
          if (key === APNS_TOKEN_KEY) throw new Error('storage boom');
          if (key === DESTINATION_KEY) return JSON.stringify(destStation);
          return null;
        });
        await handleSilentPush(
          payload({ kind: 'destination', phase: 'imminent', pushId: 'p-throw' }),
        );
        expect(mockScheduleNotificationAsync).toHaveBeenCalled();
        expect(mockSendPushAck).not.toHaveBeenCalled();
      });

      describe('#1768 — permissionMode 권한별 ack', () => {
        it('foreground+background 모두 granted → permissionMode=always', async () => {
          mockGetForegroundPermissions.mockResolvedValueOnce({ status: 'granted' });
          mockGetBackgroundPermissions.mockResolvedValueOnce({ status: 'granted' });
          await handleSilentPush(
            payload({ kind: 'destination', phase: 'imminent', pushId: 'p-always' }),
          );
          expect(mockSendPushAck).toHaveBeenCalledWith(
            expect.objectContaining({ pushId: 'p-always', permissionMode: 'always' }),
          );
        });

        it('foreground granted + background denied → permissionMode=whileInUse', async () => {
          mockGetForegroundPermissions.mockResolvedValueOnce({ status: 'granted' });
          mockGetBackgroundPermissions.mockResolvedValueOnce({ status: 'denied' });
          await handleSilentPush(
            payload({ kind: 'destination', phase: 'imminent', pushId: 'p-whileInUse' }),
          );
          expect(mockSendPushAck).toHaveBeenCalledWith(
            expect.objectContaining({ pushId: 'p-whileInUse', permissionMode: 'whileInUse' }),
          );
        });

        it('foreground denied → permissionMode=denied (background 무관)', async () => {
          mockGetForegroundPermissions.mockResolvedValueOnce({ status: 'denied' });
          mockGetBackgroundPermissions.mockResolvedValueOnce({ status: 'granted' });
          await handleSilentPush(
            payload({ kind: 'destination', phase: 'imminent', pushId: 'p-denied' }),
          );
          expect(mockSendPushAck).toHaveBeenCalledWith(
            expect.objectContaining({ pushId: 'p-denied', permissionMode: 'denied' }),
          );
        });

        it('resolvePermissionMode throw → permissionMode 누락(undefined), ack는 계속 전송', async () => {
          // 모든 resolvePermissionMode 호출에서 throw (received + fired 양쪽 ack).
          mockGetForegroundPermissions.mockRejectedValue(new Error('location-api-fail'));
          await handleSilentPush(
            payload({ kind: 'destination', phase: 'imminent', pushId: 'p-throw-perm' }),
          );
          // fired ack가 전송됐는지 확인 — permissionMode는 undefined여야 한다.
          const call = mockSendPushAck.mock.calls.find(
            (c: unknown[]) =>
              (c[0] as { pushId?: string }).pushId === 'p-throw-perm' &&
              (c[0] as { outcome?: string }).outcome === 'fired',
          );
          expect(call).toBeDefined();
          // permissionMode가 undefined이므로 sendPushAck payload에 포함되지 않는다.
          expect((call![0] as Record<string, unknown>).permissionMode).toBeUndefined();
          // 기본 mock 복원 (다른 테스트에 영향 없도록).
          mockGetForegroundPermissions.mockResolvedValue({ status: 'granted' });
        });
      });
    });

    describe('#1370 L5 — silent push 도달 stamp (received outcome)', () => {
      it('standard payload + pushId + apnsToken 모두 있으면 gate 평가 전 received ack 발사', async () => {
        await handleSilentPush(
          payload({ kind: 'destination', phase: 'imminent', pushId: 'p-recv' }),
        );
        // #1772 — received ack는 batteryState 포함. latencyMs는 sentAt 없으면 undefined.
        expect(mockSendPushAck).toHaveBeenCalledWith(
          expect.objectContaining(ackCall('p-recv', 'received')),
        );
        // 후속 outcome(fired) ack도 그대로 발사 — 별개 호출.
        expect(mockSendPushAck).toHaveBeenCalledWith(ackCall('p-recv', 'fired'));
      });

      it('게이트 fail로 outcome=skipped여도 received ack는 먼저 발사', async () => {
        mockCheckGate.mockResolvedValue({
          pass: false,
          reason: 'out-of-range',
          distanceM: 5_000,
          thresholdM: 400,
        });
        await handleSilentPush(
          payload({ kind: 'destination', phase: 'imminent', pushId: 'p-recv-skip' }),
        );
        expect(mockSendPushAck).toHaveBeenCalledWith(
          expect.objectContaining(ackCall('p-recv-skip', 'received')),
        );
        expect(mockSendPushAck).toHaveBeenCalledWith(
          ackCall('p-recv-skip', 'skipped', 'gate-out-of-range'),
        );
      });

      it('pushId 없으면 received ack도 skip (구 backend 호환)', async () => {
        await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));
        expect(mockSendPushAck).not.toHaveBeenCalledWith(
          expect.objectContaining({ outcome: 'received' }),
        );
      });

      it('apnsToken null이면 received ack도 skip', async () => {
        (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
          if (key === DESTINATION_KEY) return JSON.stringify(destStation);
          if (key === APNS_TOKEN_KEY) return null;
          return null;
        });
        await handleSilentPush(
          payload({ kind: 'destination', phase: 'imminent', pushId: 'p-no-tok' }),
        );
        expect(mockSendPushAck).not.toHaveBeenCalledWith(
          expect.objectContaining({ outcome: 'received' }),
        );
      });

      it('reschedule payload도 received ack 발사', async () => {
        await handleSilentPush({
          data: {
            data: {
              data: {
                kind: 'reschedule',
                nextStation: '사가정',
                newArrivalTimeEpoch: Date.now() + 60_000,
                trainCode: '7610',
                pushId: 'rs-recv',
              },
            },
          },
        });
        // #1772 — received ack는 batteryState 포함. latencyMs는 sentAt 없을 때 undefined.
        expect(mockSendPushAck).toHaveBeenCalledWith(
          expect.objectContaining({
            pushId: 'rs-recv',
            token: DEFAULT_APNS_TOKEN,
            outcome: 'received',
            permissionMode: 'always',
            batteryState: 'normal',
          }),
        );
      });

      it('trip-ended payload도 received ack 발사', async () => {
        await handleSilentPush({
          data: {
            data: {
              data: {
                kind: 'trip-ended',
                reason: 'expired',
                pushId: 'te-recv',
              },
            },
          },
        });
        // #1772 — received ack는 batteryState 포함.
        expect(mockSendPushAck).toHaveBeenCalledWith(
          expect.objectContaining({
            pushId: 'te-recv',
            token: DEFAULT_APNS_TOKEN,
            outcome: 'received',
            permissionMode: 'always',
            batteryState: 'normal',
          }),
        );
      });
    });

    describe('#1772 — latencyMs + batteryState in received ack', () => {
      it('sentAt 있는 payload → latencyMs = receivedAt - sentAt (양수)', async () => {
        const sentAt = Date.now() - 2000; // 2초 전 발사
        await handleSilentPush(
          payload({ kind: 'destination', phase: 'imminent', pushId: 'p-latency', sentAt }),
        );
        const receivedCall = mockSendPushAck.mock.calls.find(
          (c: unknown[]) =>
            (c[0] as { pushId?: string }).pushId === 'p-latency' &&
            (c[0] as { outcome?: string }).outcome === 'received',
        );
        expect(receivedCall).toBeDefined();
        const ackPayload = receivedCall![0] as { latencyMs?: number };
        expect(typeof ackPayload.latencyMs).toBe('number');
        expect(ackPayload.latencyMs).toBeGreaterThanOrEqual(0);
      });

      it('sentAt 없으면 latencyMs = undefined (구 backend 호환)', async () => {
        await handleSilentPush(
          payload({ kind: 'destination', phase: 'imminent', pushId: 'p-no-sentat' }),
        );
        const receivedCall = mockSendPushAck.mock.calls.find(
          (c: unknown[]) =>
            (c[0] as { pushId?: string }).pushId === 'p-no-sentat' &&
            (c[0] as { outcome?: string }).outcome === 'received',
        );
        expect(receivedCall).toBeDefined();
        expect((receivedCall![0] as { latencyMs?: number }).latencyMs).toBeUndefined();
      });

      it('lowPowerMode=true → batteryState=lowPowerMode', async () => {
        mockGetPowerStateAsync.mockResolvedValueOnce({ lowPowerMode: true });
        await handleSilentPush(
          payload({ kind: 'destination', phase: 'imminent', pushId: 'p-lowpwr' }),
        );
        const receivedCall = mockSendPushAck.mock.calls.find(
          (c: unknown[]) =>
            (c[0] as { pushId?: string }).pushId === 'p-lowpwr' &&
            (c[0] as { outcome?: string }).outcome === 'received',
        );
        expect(receivedCall).toBeDefined();
        expect((receivedCall![0] as { batteryState?: string }).batteryState).toBe('lowPowerMode');
      });

      it('getPowerStateAsync throw → batteryState=unknown (graceful)', async () => {
        mockGetPowerStateAsync.mockRejectedValueOnce(new Error('battery-fail'));
        await handleSilentPush(
          payload({ kind: 'destination', phase: 'imminent', pushId: 'p-batt-fail' }),
        );
        const receivedCall = mockSendPushAck.mock.calls.find(
          (c: unknown[]) =>
            (c[0] as { pushId?: string }).pushId === 'p-batt-fail' &&
            (c[0] as { outcome?: string }).outcome === 'received',
        );
        expect(receivedCall).toBeDefined();
        expect((receivedCall![0] as { batteryState?: string }).batteryState).toBe('unknown');
      });

      it('fired/skipped ack에는 batteryState 포함 안 됨', async () => {
        await handleSilentPush(
          payload({ kind: 'destination', phase: 'imminent', pushId: 'p-fired-nobatt' }),
        );
        const firedCall = mockSendPushAck.mock.calls.find(
          (c: unknown[]) =>
            (c[0] as { pushId?: string }).pushId === 'p-fired-nobatt' &&
            (c[0] as { outcome?: string }).outcome === 'fired',
        );
        expect(firedCall).toBeDefined();
        expect((firedCall![0] as { batteryState?: string }).batteryState).toBeUndefined();
      });
    });

    describe('#727 정적 misfire 가드 (movement)', () => {
      it('gate가 speed=0 노출하면 movement-static-speed로 skip + 발사 안 함', async () => {
        mockCheckGate.mockResolvedValue({
          ...PASSING_GATE,
          speedMps: 0,
          accuracyM: 30,
        });

        await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));

        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        expect(mockLogSilentPushFired).not.toHaveBeenCalled();
        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({
            reason: 'movement-static-speed',
            stationName: '강남',
            kind: 'destination',
            phaseId: 'imminent',
            distanceM: 150,
            thresholdM: 800,
          }),
        );
      });

      it('gate가 accuracy=999 노출하면 movement-low-accuracy로 skip', async () => {
        mockCheckGate.mockResolvedValue({
          ...PASSING_GATE,
          speedMps: 2,
          accuracyM: 999,
        });

        await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));

        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'movement-low-accuracy' }),
        );
      });

      it('speed 미노출 + accuracy=999만 노출돼도 movement-low-accuracy로 skip', async () => {
        // speedMps undefined → log line의 ?? '-' fallback 분기 커버
        mockCheckGate.mockResolvedValue({
          ...PASSING_GATE,
          accuracyM: 999,
        });

        await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));

        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'movement-low-accuracy' }),
        );
      });

      it('movement skip은 pushId 있으면 ACK 전송', async () => {
        mockCheckGate.mockResolvedValue({
          ...PASSING_GATE,
          speedMps: 0,
        });

        await handleSilentPush(
          payload({ kind: 'destination', phase: 'imminent', pushId: 'movement-skip' }),
        );

        expect(mockSendPushAck).toHaveBeenCalledWith({
          pushId: 'movement-skip',
          token: DEFAULT_APNS_TOKEN,
          outcome: 'skipped',
          reason: 'movement-static-speed',
          permissionMode: 'always',
        });
      });

      it('gate가 speed/accuracy 미노출(undefined)이면 movement 가드 통과해 정상 발사', async () => {
        mockCheckGate.mockResolvedValue(PASSING_GATE); // speed/accuracy 없음

        await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));

        expect(mockScheduleNotificationAsync).toHaveBeenCalled();
        expect(mockLogSilentPushFired).toHaveBeenCalled();
      });

      it('intermediate도 movement-static-speed 시 kind=station-passed로 매핑되어 skip', async () => {
        mockCheckGate.mockResolvedValue({
          ...PASSING_GATE,
          speedMps: 0.1,
        });

        await handleSilentPush(
          payload({ kind: 'intermediate', phase: 'imminent', nextWaypoint: '중곡' }),
        );

        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: 'station-passed',
            reason: 'movement-static-speed',
          }),
        );
      });
    });

    // #728 — CMMotionActivity motion=stationary가 BG silent push 발사도 차단.
    // FG에서 useMotionActivity가 startUpdates를 호출했다면 native cache에 최신 activity가 있고,
    // BG handleSilentPush 진입 시 getCurrentMotionStationary가 그 값을 보고한다.
    describe('#728 motion-stationary 가드 (CMMotionActivity)', () => {
      it('motionStationary=true + speed=0.69 (임계 우회) → movement-motion-stationary로 skip', async () => {
        mockGetMotionStationary.mockReturnValue(true);
        mockCheckGate.mockResolvedValue({
          ...PASSING_GATE,
          speedMps: 0.69, // STATIC_SPEED_THRESHOLD_MPS=0.5 우회
          accuracyM: 30,
        });

        await handleSilentPush(
          payload({ kind: 'destination', phase: 'imminent', pushId: 'motion-skip' }),
        );

        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        expect(mockLogSilentPushFired).not.toHaveBeenCalled();
        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({
            reason: 'movement-motion-stationary',
            stationName: '강남',
            kind: 'destination',
            phaseId: 'imminent',
          }),
        );
        expect(mockSendPushAck).toHaveBeenCalledWith({
          pushId: 'motion-skip',
          token: DEFAULT_APNS_TOKEN,
          outcome: 'skipped',
          reason: 'movement-motion-stationary',
          permissionMode: 'always',
        });
      });

      it('motionStationary=false (default) — 기존 speed/accuracy 가드만 동작', async () => {
        // 명시적으로 false 설정 — speed/accuracy 정상이면 정상 발사
        mockGetMotionStationary.mockReturnValue(false);
        mockCheckGate.mockResolvedValue({
          ...PASSING_GATE,
          speedMps: 5,
          accuracyM: 30,
        });

        await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));

        expect(mockScheduleNotificationAsync).toHaveBeenCalled();
        expect(mockLogSilentPushFired).toHaveBeenCalled();
      });

      it('motionStationary=true는 speed 정상값보다 우선 — 차단', async () => {
        mockGetMotionStationary.mockReturnValue(true);
        mockCheckGate.mockResolvedValue({
          ...PASSING_GATE,
          speedMps: 5, // 명백한 이동 신호인데 motion=stationary
          accuracyM: 30,
        });

        await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));

        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'movement-motion-stationary' }),
        );
      });
    });

    // #1356 E1 — silent push suppress 분기에서 같은 station+phase의 사전 예약(tba: / bl:)도 cancel.
    // backend는 정적/out-of-range를 인식해 다음 silent push를 발사하지 않지만, 이미 OS queue에 있는
    // 사전 예약은 시간이 되면 자체 발사 → stale "다음 역" 알람. 단건 cancel(해당 station+phase만).
    describe('#1356 E1 — suppress 시 같은 station 사전 예약 cancel', () => {
      it('motion=stationary suppress 시 cancelTbaByStationPhase + cancelBlByStationPhase가 1회씩 호출된다', async () => {
        mockGetMotionStationary.mockReturnValue(true);
        mockCheckGate.mockResolvedValue({
          ...PASSING_GATE,
          speedMps: 0.69,
          accuracyM: 30,
        });

        await handleSilentPush(
          payload({ kind: 'destination', phase: 'imminent', pushId: 'motion-cancel' }),
        );

        expect(mockCancelTbaByStationPhase).toHaveBeenCalledTimes(1);
        expect(mockCancelTbaByStationPhase).toHaveBeenCalledWith('강남', 'imminent');
        expect(mockCancelBlByStationPhase).toHaveBeenCalledTimes(1);
        expect(mockCancelBlByStationPhase).toHaveBeenCalledWith('강남', 'imminent');
      });

      it('gate-out-of-range suppress 시 cancelTbaByStationPhase + cancelBlByStationPhase가 1회씩 호출된다', async () => {
        mockCheckGate.mockResolvedValue({
          pass: false,
          reason: 'out-of-range',
          distanceM: 1500,
          thresholdM: 800,
          locationSource: 'cache' as const,
          locationAgeMs: 10_000,
        });

        await handleSilentPush(
          payload({ kind: 'destination', phase: 'early', pushId: 'gate-cancel' }),
        );

        expect(mockCancelTbaByStationPhase).toHaveBeenCalledTimes(1);
        expect(mockCancelTbaByStationPhase).toHaveBeenCalledWith('강남', 'early');
        expect(mockCancelBlByStationPhase).toHaveBeenCalledTimes(1);
        expect(mockCancelBlByStationPhase).toHaveBeenCalledWith('강남', 'early');
      });

      it('valid silent push pass (정상 발사) 시 cancel은 호출되지 않는다 (회귀)', async () => {
        mockGetMotionStationary.mockReturnValue(false);
        mockCheckGate.mockResolvedValue({
          ...PASSING_GATE,
          speedMps: 5,
          accuracyM: 30,
        });

        await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));

        expect(mockLogSilentPushFired).toHaveBeenCalled();
        expect(mockCancelTbaByStationPhase).not.toHaveBeenCalled();
        expect(mockCancelBlByStationPhase).not.toHaveBeenCalled();
      });

      it('line 가드 suppress(lock-line-mismatch) 등 다른 분기는 cancel 미호출 (out of scope 가드)', async () => {
        // payload.boardingLine='3' 으로 lock(boardingLine='2') 노선과 mismatch.
        // findStationByNameAndLine은 null, findStationByName은 어떤 station 반환.
        mockFindStationByNameAndLine.mockReturnValue(null);
        mockFindStationByName.mockReturnValue({ name: '강남', line: '3', lat: 37.5, lng: 127.0 });

        await handleSilentPush(
          payload({ kind: 'destination', phase: 'imminent', pushId: 'line-mismatch' }),
        );

        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'lock-line-mismatch' }),
        );
        // E1 cancel은 motion/gate suppress 분기만 적용. 다른 suppress는 변경 없음.
        expect(mockCancelTbaByStationPhase).not.toHaveBeenCalled();
        expect(mockCancelBlByStationPhase).not.toHaveBeenCalled();
      });
    });

    describe('reschedule kind (#725)', () => {
      function reschedulePayload(extra: Record<string, unknown> = {}) {
        return {
          data: {
            data: {
              data: {
                kind: 'reschedule',
                nextStation: '사가정',
                newArrivalTimeEpoch: 1_780_000_000_000,
                trainCode: '7610',
                ...extra,
              },
              dataString: null,
            },
            notification: null,
            aps: { 'content-available': 1 },
          },
        };
      }

      it('reschedule 수신 시 logSilentPushRescheduleReceived 호출 + standard 발사 경로 미진입', async () => {
        await handleSilentPush(reschedulePayload({ sentAt: 1_780_000_000_000 }));
        expect(mockLogSilentPushRescheduleReceived).toHaveBeenCalledTimes(1);
        const arg = mockLogSilentPushRescheduleReceived.mock.calls[0][0];
        expect(arg.nextStation).toBe('사가정');
        expect(arg.sentAt).toBe(1_780_000_000_000);
        expect(typeof arg.receivedAt).toBe('number');
        // standard 발사 경로는 호출되지 않아야 함.
        expect(mockLogSilentPushReceived).not.toHaveBeenCalled();
        expect(mockCheckGate).not.toHaveBeenCalled();
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        expect(mockLogSilentPushFired).not.toHaveBeenCalled();
        expect(mockLogSilentPushSkipped).not.toHaveBeenCalled();
      });

      it('pushId 있으면 ack(fired, reschedule-received) 전송', async () => {
        await handleSilentPush(reschedulePayload({ pushId: 'rs-uuid' }));
        expect(mockSendPushAck).toHaveBeenCalledWith({
          pushId: 'rs-uuid',
          token: DEFAULT_APNS_TOKEN,
          outcome: 'fired',
          reason: 'reschedule-received',
          permissionMode: 'always',
        });
      });

      it('pushId 없으면 ack 호출 안 함 — 수신 통계는 그대로 적재', async () => {
        await handleSilentPush(reschedulePayload());
        expect(mockSendPushAck).not.toHaveBeenCalled();
        expect(mockLogSilentPushRescheduleReceived).toHaveBeenCalledTimes(1);
      });

      it('apnsToken null이면 pushId 있어도 ack skip — 수신 통계는 적재', async () => {
        (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
          if (key === APNS_TOKEN_KEY) return null;
          if (key === DESTINATION_KEY) return JSON.stringify(destStation);
          return null;
        });
        await handleSilentPush(reschedulePayload({ pushId: 'rs-uuid' }));
        expect(mockSendPushAck).not.toHaveBeenCalled();
        expect(mockLogSilentPushRescheduleReceived).toHaveBeenCalledTimes(1);
      });

      // #698 — reschedule kind: 사전 예약 cancel + 재예약 적용.
      describe('applyReschedule (#698)', () => {
        const route = { type: 'direct', stops: 2, line: '2', travelSeconds: 240 };
        const lockMatch = {
          destinationId: '0228',
          trainCode: '7610',
          boardingStationId: 'b',
          boardingLine: '2',
          boardedAt: 1_700_000_000_000,
          expectedDurationMs: 600_000,
        };
        function setStorage(opts: {
          lock?: unknown;
          route?: unknown;
          destination?: unknown;
        } = {}) {
          mockGetBoardingLock.mockResolvedValue(opts.lock === undefined ? lockMatch : opts.lock);
          (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
            if (key === APNS_TOKEN_KEY) return DEFAULT_APNS_TOKEN;
            if (key === DESTINATION_KEY)
              return opts.destination === undefined
                ? JSON.stringify(destStation)
                : opts.destination === null
                  ? null
                  : JSON.stringify(opts.destination);
            if (key === ROUTE_KEY)
              return opts.route === undefined
                ? JSON.stringify(route)
                : opts.route === null
                  ? null
                  : JSON.stringify(opts.route);
            return null;
          });
        }

        it('lock + route + destination 모두 있으면 rescheduleHopForLock 호출', async () => {
          setStorage();
          await handleSilentPush(
            reschedulePayload({ newArrivalTimeEpoch: 9_999_999_999_999 }),
          );
          expect(mockRescheduleHopForLock).toHaveBeenCalledTimes(1);
          const arg = mockRescheduleHopForLock.mock.calls[0][0];
          expect(arg.lock).toBe(lockMatch);
          expect(arg.nextStation).toBe('사가정');
          expect(arg.newArrivalMs).toBe(9_999_999_999_999);
          expect(arg.destinationName).toBe(destStation.name);
        });

        it('lock 없으면 호출 skip', async () => {
          setStorage({ lock: null });
          await handleSilentPush(
            reschedulePayload({ newArrivalTimeEpoch: 9_999_999_999_999 }),
          );
          expect(mockRescheduleHopForLock).not.toHaveBeenCalled();
          // 로그/ack는 그대로 진행됐는지 확인
          expect(mockLogSilentPushRescheduleReceived).toHaveBeenCalledTimes(1);
        });

        it('lock trainCode 불일치 시 skip', async () => {
          setStorage({ lock: { ...lockMatch, trainCode: '다른코드' } });
          await handleSilentPush(
            reschedulePayload({ newArrivalTimeEpoch: 9_999_999_999_999 }),
          );
          expect(mockRescheduleHopForLock).not.toHaveBeenCalled();
        });

        it('route 없으면 skip', async () => {
          setStorage({ route: null });
          await handleSilentPush(
            reschedulePayload({ newArrivalTimeEpoch: 9_999_999_999_999 }),
          );
          expect(mockRescheduleHopForLock).not.toHaveBeenCalled();
        });

        it('destination 없으면 skip', async () => {
          setStorage({ destination: null });
          await handleSilentPush(
            reschedulePayload({ newArrivalTimeEpoch: 9_999_999_999_999 }),
          );
          expect(mockRescheduleHopForLock).not.toHaveBeenCalled();
        });

        it('route JSON 파싱 실패 시 skip — 예외 전파 안 함', async () => {
          mockGetBoardingLock.mockResolvedValue(lockMatch);
          (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
            if (key === APNS_TOKEN_KEY) return DEFAULT_APNS_TOKEN;
            if (key === DESTINATION_KEY) return JSON.stringify(destStation);
            if (key === ROUTE_KEY) return 'not-json';
            return null;
          });
          await handleSilentPush(
            reschedulePayload({ newArrivalTimeEpoch: 9_999_999_999_999 }),
          );
          expect(mockRescheduleHopForLock).not.toHaveBeenCalled();
        });

        it('destination JSON 파싱 실패 시 skip', async () => {
          mockGetBoardingLock.mockResolvedValue(lockMatch);
          (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
            if (key === APNS_TOKEN_KEY) return DEFAULT_APNS_TOKEN;
            if (key === DESTINATION_KEY) return 'not-json';
            if (key === ROUTE_KEY) return JSON.stringify(route);
            return null;
          });
          await handleSilentPush(
            reschedulePayload({ newArrivalTimeEpoch: 9_999_999_999_999 }),
          );
          expect(mockRescheduleHopForLock).not.toHaveBeenCalled();
        });

        it('destination.name 없는 경우 skip', async () => {
          setStorage({ destination: { id: 'x' } });
          await handleSilentPush(
            reschedulePayload({ newArrivalTimeEpoch: 9_999_999_999_999 }),
          );
          expect(mockRescheduleHopForLock).not.toHaveBeenCalled();
        });

        it('newArrivalTimeEpoch가 과거이면 skip — rescheduleHopForLock 미호출', async () => {
          setStorage();
          await handleSilentPush(
            reschedulePayload({ newArrivalTimeEpoch: 1 }),
          );
          expect(mockRescheduleHopForLock).not.toHaveBeenCalled();
        });

        it('rescheduleHopForLock throw 해도 ack/log는 그대로 진행', async () => {
          setStorage();
          mockRescheduleHopForLock.mockRejectedValueOnce(new Error('boom'));
          await handleSilentPush(
            reschedulePayload({ pushId: 'rs-uuid', newArrivalTimeEpoch: 9_999_999_999_999 }),
          );
          expect(mockSendPushAck).toHaveBeenCalledWith(
            expect.objectContaining({ pushId: 'rs-uuid', outcome: 'fired', reason: 'reschedule-received' }),
          );
          expect(mockLogSilentPushRescheduleReceived).toHaveBeenCalledTimes(1);
        });

        // #918 A3 PR4 — channels 분기 (bl + tba).
        describe('channels (#918 A3 PR4)', () => {
          it('channels=undefined (구 backend) → bl만 호출, tba 미호출', async () => {
            setStorage();
            await handleSilentPush(
              reschedulePayload({ newArrivalTimeEpoch: 9_999_999_999_999 }),
            );
            expect(mockRescheduleHopForLock).toHaveBeenCalledTimes(1);
            expect(mockRescheduleTripBoundAlarm).not.toHaveBeenCalled();
          });

          it("channels=['bl','tba'] → bl + tba 모두 호출", async () => {
            setStorage();
            await handleSilentPush(
              reschedulePayload({
                newArrivalTimeEpoch: 9_999_999_999_999,
                channels: ['bl', 'tba'],
              }),
            );
            expect(mockRescheduleHopForLock).toHaveBeenCalledTimes(1);
            expect(mockRescheduleTripBoundAlarm).toHaveBeenCalledTimes(1);
            const tbaArg = mockRescheduleTripBoundAlarm.mock.calls[0][0];
            expect(tbaArg.stationName).toBe('사가정');
            expect(tbaArg.newArrivalMs).toBe(9_999_999_999_999);
            expect(tbaArg.destinationName).toBe(destStation.name);
          });

          it("channels=['tba'] → tba만 호출, bl 미호출 (lock skip 무관)", async () => {
            setStorage();
            await handleSilentPush(
              reschedulePayload({
                newArrivalTimeEpoch: 9_999_999_999_999,
                channels: ['tba'],
              }),
            );
            expect(mockRescheduleHopForLock).not.toHaveBeenCalled();
            expect(mockRescheduleTripBoundAlarm).toHaveBeenCalledTimes(1);
          });

          it("channels=['tba'] + lock=null → tba는 여전히 호출 (lock-free 채널)", async () => {
            setStorage({ lock: null });
            await handleSilentPush(
              reschedulePayload({
                newArrivalTimeEpoch: 9_999_999_999_999,
                channels: ['tba'],
              }),
            );
            expect(mockRescheduleTripBoundAlarm).toHaveBeenCalledTimes(1);
          });

          it('channels 빈 배열 → 구 backend 호환 default(bl)로 fallback', async () => {
            setStorage();
            await handleSilentPush(
              reschedulePayload({
                newArrivalTimeEpoch: 9_999_999_999_999,
                channels: [],
              }),
            );
            expect(mockRescheduleHopForLock).toHaveBeenCalledTimes(1);
            expect(mockRescheduleTripBoundAlarm).not.toHaveBeenCalled();
          });

          it('channels에 unknown 값만 있으면 default(bl)로 fallback', async () => {
            setStorage();
            await handleSilentPush(
              reschedulePayload({
                newArrivalTimeEpoch: 9_999_999_999_999,
                channels: ['unknown'],
              }),
            );
            expect(mockRescheduleHopForLock).toHaveBeenCalledTimes(1);
            expect(mockRescheduleTripBoundAlarm).not.toHaveBeenCalled();
          });

          it('channels에 mix(bl + unknown) → bl만 통과', async () => {
            setStorage();
            await handleSilentPush(
              reschedulePayload({
                newArrivalTimeEpoch: 9_999_999_999_999,
                channels: ['bl', 'unknown', 'tba'],
              }),
            );
            expect(mockRescheduleHopForLock).toHaveBeenCalledTimes(1);
            expect(mockRescheduleTripBoundAlarm).toHaveBeenCalledTimes(1);
          });

          it('channels가 배열이 아니면 default(bl)로 fallback', async () => {
            setStorage();
            await handleSilentPush(
              reschedulePayload({
                newArrivalTimeEpoch: 9_999_999_999_999,
                channels: 'bl',
              }),
            );
            expect(mockRescheduleHopForLock).toHaveBeenCalledTimes(1);
            expect(mockRescheduleTripBoundAlarm).not.toHaveBeenCalled();
          });

          // #1193 — 중복역 trip 정정. payload.occurrenceIdx를 그대로 forward.
          it('occurrenceIdx는 rescheduleTripBoundAlarm으로 forward (#1193)', async () => {
            setStorage();
            await handleSilentPush(
              reschedulePayload({
                newArrivalTimeEpoch: 9_999_999_999_999,
                channels: ['tba'],
                occurrenceIdx: 1,
              }),
            );
            expect(mockRescheduleTripBoundAlarm).toHaveBeenCalledTimes(1);
            const tbaArg = mockRescheduleTripBoundAlarm.mock.calls[0][0];
            expect(tbaArg.occurrenceIdx).toBe(1);
          });

          it('occurrenceIdx 누락 시 undefined로 전달 (클라가 0 fallback) (#1193)', async () => {
            setStorage();
            await handleSilentPush(
              reschedulePayload({
                newArrivalTimeEpoch: 9_999_999_999_999,
                channels: ['tba'],
              }),
            );
            expect(mockRescheduleTripBoundAlarm).toHaveBeenCalledTimes(1);
            const tbaArg = mockRescheduleTripBoundAlarm.mock.calls[0][0];
            expect(tbaArg.occurrenceIdx).toBeUndefined();
          });
        });

        // #1355 D1 — silent push reschedule cross-channel cancel.
        // bl reschedule → 반대 채널(tba) 같은 station+phase 사전 예약 cancel,
        // tba reschedule → 반대 채널(bl) 같은 station+phase 사전 예약 cancel.
        // payload 한 건당 ALARM_PHASES(early + imminent) 모두에 대해 1회씩 호출되도록 fan-out.
        describe('cross-channel cancel (#1355 D1)', () => {
          it('applyRescheduleBl 진입 시 같은 station+phase의 tba 사전 예약을 phase별 1회씩 cancel', async () => {
            setStorage();
            await handleSilentPush(
              reschedulePayload({
                newArrivalTimeEpoch: 9_999_999_999_999,
                channels: ['bl'],
              }),
            );
            // ALARM_PHASES = [early, imminent] → 2회 호출, 모두 nextStation='사가정' 대상.
            expect(mockCancelTbaByStationPhase).toHaveBeenCalledTimes(2);
            expect(mockCancelTbaByStationPhase).toHaveBeenNthCalledWith(1, '사가정', 'early');
            expect(mockCancelTbaByStationPhase).toHaveBeenNthCalledWith(2, '사가정', 'imminent');
            // 반대 채널(bl) cancel은 호출되지 않아야 함 (정밀성).
            expect(mockCancelBlByStationPhase).not.toHaveBeenCalled();
          });

          it('applyRescheduleTba 진입 시 같은 station+phase의 bl 사전 예약을 phase별 1회씩 cancel', async () => {
            setStorage();
            await handleSilentPush(
              reschedulePayload({
                newArrivalTimeEpoch: 9_999_999_999_999,
                channels: ['tba'],
              }),
            );
            expect(mockCancelBlByStationPhase).toHaveBeenCalledTimes(2);
            expect(mockCancelBlByStationPhase).toHaveBeenNthCalledWith(1, '사가정', 'early');
            expect(mockCancelBlByStationPhase).toHaveBeenNthCalledWith(2, '사가정', 'imminent');
            // 반대 채널(tba) cancel은 호출되지 않아야 함.
            expect(mockCancelTbaByStationPhase).not.toHaveBeenCalled();
          });

          it('bl skip path(lock 없음)에서는 cross-cancel도 미호출 (정밀성)', async () => {
            // lock null이면 applyRescheduleBl는 cross-cancel 전에 early-return.
            // 다른 station/phase의 사전 예약이 잘못 cancel되지 않도록 보장.
            setStorage({ lock: null });
            await handleSilentPush(
              reschedulePayload({
                newArrivalTimeEpoch: 9_999_999_999_999,
                channels: ['bl'],
              }),
            );
            expect(mockRescheduleHopForLock).not.toHaveBeenCalled();
            expect(mockCancelTbaByStationPhase).not.toHaveBeenCalled();
            expect(mockCancelBlByStationPhase).not.toHaveBeenCalled();
          });

          it('반대 채널 사전 예약이 없을 때 safe no-op (helper 0 반환에 대해 throw 없이 진행)', async () => {
            setStorage();
            // helper가 0건 cancel 반환 — 정상 reschedule 흐름이 그대로 이어져야 함.
            mockCancelTbaByStationPhase.mockResolvedValue(0);
            mockCancelBlByStationPhase.mockResolvedValue(0);
            await handleSilentPush(
              reschedulePayload({
                newArrivalTimeEpoch: 9_999_999_999_999,
                channels: ['bl', 'tba'],
              }),
            );
            // 두 채널 모두 reschedule이 정상 진행됨.
            expect(mockRescheduleHopForLock).toHaveBeenCalledTimes(1);
            expect(mockRescheduleTripBoundAlarm).toHaveBeenCalledTimes(1);
            // 각 reschedule이 두 phase에 대해 cross-cancel을 호출.
            expect(mockCancelTbaByStationPhase).toHaveBeenCalledTimes(2);
            expect(mockCancelBlByStationPhase).toHaveBeenCalledTimes(2);
          });
        });
      });
    });

    // #868 — server-side trip 자동 종료 신호 수신 → trip-bound storage cleanup.
    describe('trip-ended kind (#868)', () => {
      function tripEndedPayload(extra: Record<string, unknown> = {}) {
        return {
          data: {
            data: {
              data: { kind: 'trip-ended', reason: 'eta-missing', ...extra },
              dataString: null,
            },
            notification: null,
            aps: { 'content-available': 1 },
          },
        };
      }

      it('trip-ended 수신 → runTripBoundCleanups 호출 + 표준 발사 경로 미진입', async () => {
        await handleSilentPush(tripEndedPayload({ sentAt: 1_780_000_000_000 }));
        expect(mockRunTripBoundCleanups).toHaveBeenCalledTimes(1);
        // standard 발사 경로는 호출되지 않아야 함.
        expect(mockLogSilentPushReceived).not.toHaveBeenCalled();
        expect(mockCheckGate).not.toHaveBeenCalled();
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        expect(mockLogSilentPushFired).not.toHaveBeenCalled();
        expect(mockLogSilentPushSkipped).not.toHaveBeenCalled();
      });

      it('logSilentPushTripEndedReceived 1회 호출 + reason 보존', async () => {
        await handleSilentPush(
          tripEndedPayload({ reason: 'destination-arrived', sentAt: 1_780_000_000_000 }),
        );
        expect(mockLogSilentPushTripEndedReceived).toHaveBeenCalledTimes(1);
        const arg = mockLogSilentPushTripEndedReceived.mock.calls[0][0];
        expect(arg.reason).toBe('destination-arrived');
        expect(arg.sentAt).toBe(1_780_000_000_000);
        expect(typeof arg.receivedAt).toBe('number');
      });

      it.each([
        ['eta-missing'],
        ['destination-arrived'],
        ['expired'],
        ['push-unrecoverable'],
      ])('known reason %s에서 cleanup 트리거', async (reason) => {
        await handleSilentPush(tripEndedPayload({ reason }));
        expect(mockRunTripBoundCleanups).toHaveBeenCalledTimes(1);
        expect(mockLogSilentPushTripEndedReceived).toHaveBeenCalledWith(
          expect.objectContaining({ reason }),
        );
      });

      it('알 수 없는 reason도 정규화(unknown)되어 cleanup 트리거', async () => {
        await handleSilentPush(tripEndedPayload({ reason: 'future-reason' }));
        expect(mockRunTripBoundCleanups).toHaveBeenCalledTimes(1);
        expect(mockLogSilentPushTripEndedReceived).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'unknown' }),
        );
      });

      it('pushId 있으면 ack(fired, trip-ended:reason) 전송', async () => {
        await handleSilentPush(tripEndedPayload({ pushId: 'te-uuid', reason: 'expired' }));
        expect(mockSendPushAck).toHaveBeenCalledWith({
          pushId: 'te-uuid',
          token: DEFAULT_APNS_TOKEN,
          outcome: 'fired',
          reason: 'trip-ended:expired',
          permissionMode: 'always',
        });
      });

      it('pushId 없으면 ack 호출 안 함 — cleanup은 그대로', async () => {
        await handleSilentPush(tripEndedPayload());
        expect(mockSendPushAck).not.toHaveBeenCalled();
        expect(mockRunTripBoundCleanups).toHaveBeenCalledTimes(1);
      });

      it('apnsToken null이면 pushId 있어도 ack skip — cleanup은 그대로', async () => {
        (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
          if (key === APNS_TOKEN_KEY) return null;
          if (key === DESTINATION_KEY) return JSON.stringify(destStation);
          return null;
        });
        await handleSilentPush(tripEndedPayload({ pushId: 'te-uuid' }));
        expect(mockSendPushAck).not.toHaveBeenCalled();
        expect(mockRunTripBoundCleanups).toHaveBeenCalledTimes(1);
      });

      it('#868 P1-2 — tripToken이 ACTIVE_TRIP_KEY와 불일치하면 cleanup skip + ack는 token-mismatch reason', async () => {
        (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
          if (key === APNS_TOKEN_KEY) return DEFAULT_APNS_TOKEN;
          if (key === ACTIVE_TRIP_KEY) return 'NEW-TRIP-TOKEN';
          if (key === DESTINATION_KEY) return JSON.stringify(destStation);
          return null;
        });
        await handleSilentPush(
          tripEndedPayload({ pushId: 'te-uuid', tripToken: 'OLD-TRIP-TOKEN' }),
        );
        // cleanup은 호출되지 않아야 함 (다른 trip의 storage를 파괴하지 않음).
        expect(mockRunTripBoundCleanups).not.toHaveBeenCalled();
        // ack는 그대로 전송(backend pendingPushes 정합).
        expect(mockSendPushAck).toHaveBeenCalledWith({
          pushId: 'te-uuid',
          token: DEFAULT_APNS_TOKEN,
          outcome: 'fired',
          reason: expect.stringContaining('token-mismatch') as unknown as string,
          permissionMode: 'always',
        });
      });

      it('#868 P1-2 — tripToken이 ACTIVE_TRIP_KEY와 일치하면 cleanup 진행', async () => {
        (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
          if (key === APNS_TOKEN_KEY) return DEFAULT_APNS_TOKEN;
          if (key === ACTIVE_TRIP_KEY) return 'SAME-TRIP-TOKEN';
          if (key === DESTINATION_KEY) return JSON.stringify(destStation);
          return null;
        });
        await handleSilentPush(tripEndedPayload({ tripToken: 'SAME-TRIP-TOKEN' }));
        expect(mockRunTripBoundCleanups).toHaveBeenCalledTimes(1);
      });

      it('#868 P1-2 — tripToken이 payload에 없으면(구버전 backend) cleanup 진행 (호환)', async () => {
        (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
          if (key === APNS_TOKEN_KEY) return DEFAULT_APNS_TOKEN;
          if (key === ACTIVE_TRIP_KEY) return 'ANY-TOKEN';
          if (key === DESTINATION_KEY) return JSON.stringify(destStation);
          return null;
        });
        // tripToken 누락 = 구버전 backend
        await handleSilentPush(tripEndedPayload());
        expect(mockRunTripBoundCleanups).toHaveBeenCalledTimes(1);
      });

      // #899 (Seam C) — BG에서는 zustand에 접근 불가 → sentinel을 작성해 FG 복귀 시 store reset 트리거.
      it('#899 (Seam C) — cleanup 완료 후 setTripEndedSentinel 호출', async () => {
        await handleSilentPush(tripEndedPayload({ reason: 'expired' }));
        expect(mockRunTripBoundCleanups).toHaveBeenCalledTimes(1);
        expect(mockSetTripEndedSentinel).toHaveBeenCalledTimes(1);
        expect(mockSetTripEndedSentinel).toHaveBeenCalledWith(expect.any(Number));
      });

      // #2018 γ' — FG 상태(active)에서 trip-ended 수신 시 sentinel 저장 후 즉시 in-memory
      // store를 reset해야 한다. useStateRehydration은 AppState 'active' 이벤트 시에만 실행되므로
      // FG dogfood 시나리오(관찰 20, 성수→성수)에서 sentinel이 저장돼도 재수화가 트리거되지 않아
      // destination store가 stale로 남는 회귀 차단.
      describe('#2018 γ\' — FG 상태 즉시 in-memory store reset', () => {
        it('AppState=active 시 destination store setState({destination:null, customOrigin:null, tripOrigin:null}) 호출', async () => {
          mockAppStateHolder.currentState = 'active';
          await handleSilentPush(tripEndedPayload({ reason: 'destination-arrived' }));
          expect(mockDestinationSetState).toHaveBeenCalledTimes(1);
          expect(mockDestinationSetState).toHaveBeenCalledWith({
            destination: null,
            customOrigin: null,
            tripOrigin: null,
          });
        });

        it('AppState=active 시 boardingLockStore.releaseLock 호출', async () => {
          mockAppStateHolder.currentState = 'active';
          mockStoreReleaseLock.mockClear();
          await handleSilentPush(tripEndedPayload({ reason: 'expired' }));
          expect(mockStoreReleaseLock).toHaveBeenCalledTimes(1);
        });

        it('AppState=active 시 setTripEndedSentinel 이후 clearTripEndedSentinel 호출 (중복 처리 방지)', async () => {
          mockAppStateHolder.currentState = 'active';
          const callOrder: string[] = [];
          mockSetTripEndedSentinel.mockImplementation(async () => {
            callOrder.push('set-sentinel');
          });
          mockClearTripEndedSentinel.mockImplementation(async () => {
            callOrder.push('clear-sentinel');
          });
          await handleSilentPush(tripEndedPayload({ reason: 'expired' }));
          expect(mockSetTripEndedSentinel).toHaveBeenCalledTimes(1);
          expect(mockClearTripEndedSentinel).toHaveBeenCalledTimes(1);
          expect(callOrder).toEqual(['set-sentinel', 'clear-sentinel']);
        });

        it('AppState=background 시 setState / releaseLock / clearSentinel 호출 안 함 (기존 BG 경로 유지)', async () => {
          mockAppStateHolder.currentState = 'background';
          mockStoreReleaseLock.mockClear();
          await handleSilentPush(tripEndedPayload({ reason: 'expired' }));
          expect(mockSetTripEndedSentinel).toHaveBeenCalledTimes(1);
          expect(mockDestinationSetState).not.toHaveBeenCalled();
          expect(mockStoreReleaseLock).not.toHaveBeenCalled();
          expect(mockClearTripEndedSentinel).not.toHaveBeenCalled();
        });

        it('AppState=inactive 시 FG 분기 미진입 (active 조건 strict)', async () => {
          mockAppStateHolder.currentState = 'inactive';
          await handleSilentPush(tripEndedPayload({ reason: 'expired' }));
          expect(mockDestinationSetState).not.toHaveBeenCalled();
          expect(mockClearTripEndedSentinel).not.toHaveBeenCalled();
        });

        it('AppState=active setState throw 시 graceful — 전체 흐름 계속 (sentinel은 유지)', async () => {
          mockAppStateHolder.currentState = 'active';
          mockDestinationSetState.mockImplementation(() => {
            throw new Error('store boom');
          });
          await expect(
            handleSilentPush(tripEndedPayload({ reason: 'expired', pushId: 'te-uuid' })),
          ).resolves.toBeUndefined();
          // 다음 흐름(surface + ack)은 그대로 진행.
          expect(mockSendTripEndedNotification).toHaveBeenCalledTimes(1);
        });

        it('AppState=active tripToken mismatch 시 setState도 호출 안 함 (cleanup skip 경로)', async () => {
          mockAppStateHolder.currentState = 'active';
          (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
            if (key === APNS_TOKEN_KEY) return DEFAULT_APNS_TOKEN;
            if (key === ACTIVE_TRIP_KEY) return 'NEW-TRIP-TOKEN';
            return null;
          });
          await handleSilentPush(
            tripEndedPayload({ pushId: 'te-uuid', tripToken: 'OLD-TRIP-TOKEN' }),
          );
          expect(mockDestinationSetState).not.toHaveBeenCalled();
        });
      });

      it('#899 (Seam C) — tripToken mismatch로 cleanup skip 시 sentinel도 작성 안 함', async () => {
        (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
          if (key === APNS_TOKEN_KEY) return DEFAULT_APNS_TOKEN;
          if (key === ACTIVE_TRIP_KEY) return 'NEW-TRIP-TOKEN';
          return null;
        });
        await handleSilentPush(
          tripEndedPayload({ pushId: 'te-uuid', tripToken: 'OLD-TRIP-TOKEN' }),
        );
        expect(mockRunTripBoundCleanups).not.toHaveBeenCalled();
        expect(mockSetTripEndedSentinel).not.toHaveBeenCalled();
      });

      it('#868 P1-2 — ACTIVE_TRIP_KEY가 null(클라 이미 trip 종료)이면 cleanup 진행', async () => {
        (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
          if (key === APNS_TOKEN_KEY) return DEFAULT_APNS_TOKEN;
          if (key === ACTIVE_TRIP_KEY) return null;
          if (key === DESTINATION_KEY) return JSON.stringify(destStation);
          return null;
        });
        await handleSilentPush(tripEndedPayload({ tripToken: 'OLD-TRIP-TOKEN' }));
        expect(mockRunTripBoundCleanups).toHaveBeenCalledTimes(1);
      });

      // #919 — trip-end recall KPI 측정. cleanup *이전*에 trigger되어야 routeStops를 읽을 수 있다.
      it('#919 — trip-ended 수신 시 triggerTripEndRecall 호출 + cleanup *이전* 순서 보장', async () => {
        const callOrder: string[] = [];
        mockTriggerTripEndRecall.mockImplementation(async () => {
          callOrder.push('trigger');
          return { uploaded: false };
        });
        mockRunTripBoundCleanups.mockImplementation(async () => {
          callOrder.push('cleanup');
        });

        await handleSilentPush(tripEndedPayload({ reason: 'expired' }));

        expect(mockTriggerTripEndRecall).toHaveBeenCalledTimes(1);
        expect(callOrder).toEqual(['trigger', 'cleanup']);
      });

      // #1370 L4 — 종착역 도착 시 device 로컬 OS queue burst fire 차단.
      // trip-ended push 수신 즉시 cancelTripBoundOsQueue를 호출해 race window를 좁힌다.
      // triggerTripEndRecall은 network upload로 수 초 stall 가능 — 그 전에 OS 큐 cancel 진행.
      it('#1370 L4 — trip-ended 수신 즉시 cancelTripBoundOsQueue 호출 (trigger/cleanup *이전*)', async () => {
        const callOrder: string[] = [];
        mockCancelTripBoundOsQueue.mockImplementation(async () => {
          callOrder.push('os-cancel');
        });
        mockTriggerTripEndRecall.mockImplementation(async () => {
          callOrder.push('trigger');
          return { uploaded: false };
        });
        mockRunTripBoundCleanups.mockImplementation(async () => {
          callOrder.push('cleanup');
        });

        await handleSilentPush(tripEndedPayload({ reason: 'destination-arrived' }));

        expect(mockCancelTripBoundOsQueue).toHaveBeenCalledTimes(1);
        expect(callOrder).toEqual(['os-cancel', 'trigger', 'cleanup']);
      });

      it('#1370 L4 — tripToken mismatch 시 OS queue cancel도 호출 안 함 (다른 trip의 push)', async () => {
        (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
          if (key === APNS_TOKEN_KEY) return DEFAULT_APNS_TOKEN;
          if (key === ACTIVE_TRIP_KEY) return 'NEW-TRIP-TOKEN';
          return null;
        });
        await handleSilentPush(
          tripEndedPayload({ pushId: 'te-uuid', tripToken: 'OLD-TRIP-TOKEN' }),
        );
        expect(mockCancelTripBoundOsQueue).not.toHaveBeenCalled();
      });

      it('#919 — tripToken mismatch로 cleanup skip 시 recall trigger도 호출 안 함', async () => {
        (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
          if (key === APNS_TOKEN_KEY) return DEFAULT_APNS_TOKEN;
          if (key === ACTIVE_TRIP_KEY) return 'NEW-TRIP-TOKEN';
          return null;
        });
        await handleSilentPush(
          tripEndedPayload({ pushId: 'te-uuid', tripToken: 'OLD-TRIP-TOKEN' }),
        );
        expect(mockTriggerTripEndRecall).not.toHaveBeenCalled();
      });

      // #1323 — trip 종료 user-facing surface. backend trip-ended push가 silent라 알림이 안 뜨던
      // 회귀를 차단. sentinel/cleanup 직후 reason-gated 알림 1회 present.
      describe('#1323 — trip-ended user-facing surface', () => {
        it('trip-ended 수신 → sendTripEndedNotification(reason) 1회 호출', async () => {
          await handleSilentPush(tripEndedPayload({ reason: 'destination-arrived' }));
          expect(mockSendTripEndedNotification).toHaveBeenCalledTimes(1);
          expect(mockSendTripEndedNotification).toHaveBeenCalledWith('destination-arrived');
        });

        it.each([
          ['eta-missing'],
          ['destination-arrived'],
          ['expired'],
          ['push-unrecoverable'],
        ])('known reason %s → surface에 reason 그대로 전달', async (reason) => {
          await handleSilentPush(tripEndedPayload({ reason }));
          expect(mockSendTripEndedNotification).toHaveBeenCalledWith(reason);
        });

        it('알 수 없는 reason도 정규화(unknown)되어 surface 호출', async () => {
          await handleSilentPush(tripEndedPayload({ reason: 'future-reason' }));
          expect(mockSendTripEndedNotification).toHaveBeenCalledWith('unknown');
        });

        it('surface 후 pushId를 FIRED_PUSH_IDS에 기록(dedup용)', async () => {
          await handleSilentPush(tripEndedPayload({ pushId: 'te-uuid' }));
          expect(mockSendTripEndedNotification).toHaveBeenCalledTimes(1);
          expect(mockAddFiredPushId).toHaveBeenCalledWith('te-uuid');
        });

        it('pushId 없으면 dedup 기록 안 함 — surface는 그대로', async () => {
          await handleSilentPush(tripEndedPayload());
          expect(mockSendTripEndedNotification).toHaveBeenCalledTimes(1);
          expect(mockAddFiredPushId).not.toHaveBeenCalled();
        });

        it('동일 pushId 재도달(backend retry) → hasFiredPushId true면 surface skip', async () => {
          mockHasFiredPushId.mockResolvedValue(true);
          await handleSilentPush(tripEndedPayload({ pushId: 'te-uuid' }));
          expect(mockHasFiredPushId).toHaveBeenCalledWith('te-uuid');
          expect(mockSendTripEndedNotification).not.toHaveBeenCalled();
          // 이미 기록돼 있으므로 재기록도 하지 않음.
          expect(mockAddFiredPushId).not.toHaveBeenCalled();
          // cleanup/ack 흐름은 그대로 진행.
          expect(mockRunTripBoundCleanups).toHaveBeenCalledTimes(1);
        });

        it('tripToken mismatch로 cleanup skip 시 surface도 호출 안 함', async () => {
          (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
            if (key === APNS_TOKEN_KEY) return DEFAULT_APNS_TOKEN;
            if (key === ACTIVE_TRIP_KEY) return 'NEW-TRIP-TOKEN';
            return null;
          });
          await handleSilentPush(
            tripEndedPayload({ pushId: 'te-uuid', tripToken: 'OLD-TRIP-TOKEN' }),
          );
          expect(mockSendTripEndedNotification).not.toHaveBeenCalled();
        });

        it('surface 발사 throw 시 graceful — cleanup/ack 흐름 계속(전체 throw 안 함)', async () => {
          mockSendTripEndedNotification.mockRejectedValue(new Error('present boom'));
          await expect(
            handleSilentPush(tripEndedPayload({ pushId: 'te-uuid', reason: 'expired' })),
          ).resolves.toBeUndefined();
          expect(mockRunTripBoundCleanups).toHaveBeenCalledTimes(1);
          // surface 실패 시 dedup 기록은 건너뛴다(재시도 여지).
          expect(mockAddFiredPushId).not.toHaveBeenCalled();
          expect(mockSendPushAck).toHaveBeenCalledWith({
            pushId: 'te-uuid',
            token: DEFAULT_APNS_TOKEN,
            outcome: 'fired',
            reason: 'trip-ended:expired',
            permissionMode: 'always',
          });
        });
      });

      // #1337 PR1 — backend가 alert payload(`aps.alert`)로 trip-ended를 발사하면
      // iOS가 killed 앱에도 시스템 banner를 직접 표시한다. 디바이스는 surface skip하되
      // sentinel/cleanup/ack는 silent path와 동일하게 수행. dedup용 pushId 기록은 유지.
      describe('#1337 PR1 — alert payload trip-ended path', () => {
        function alertTripEndedPayload(extra: Record<string, unknown> = {}) {
          return {
            data: {
              data: {
                data: { kind: 'trip-ended', reason: 'eta-missing', ...extra },
                dataString: null,
              },
              // alert payload는 Swift transformer가 notification을 non-null로 채운다.
              notification: { request: { content: { title: '안내 종료', body: '경로 안내를 종료했어요' } } },
              aps: { alert: { title: '안내 종료', body: '경로 안내를 종료했어요' }, sound: 'default' },
            },
          };
        }

        it('alert payload → sendTripEndedNotification 호출 안 함(OS가 banner 표시)', async () => {
          await handleSilentPush(alertTripEndedPayload({ pushId: 'a-uuid', reason: 'expired' }));
          expect(mockSendTripEndedNotification).not.toHaveBeenCalled();
        });

        it('alert payload → setTripEndedSentinel 호출(silent path와 동일)', async () => {
          await handleSilentPush(alertTripEndedPayload({ pushId: 'a-uuid' }));
          expect(mockSetTripEndedSentinel).toHaveBeenCalledTimes(1);
          expect(mockSetTripEndedSentinel).toHaveBeenCalledWith(expect.any(Number));
        });

        it('alert payload → runTripBoundCleanups 호출(active trip clear)', async () => {
          await handleSilentPush(alertTripEndedPayload({ pushId: 'a-uuid' }));
          expect(mockRunTripBoundCleanups).toHaveBeenCalledTimes(1);
        });

        it('alert payload → triggerTripEndRecall도 cleanup 이전에 호출', async () => {
          const callOrder: string[] = [];
          mockTriggerTripEndRecall.mockImplementation(async () => {
            callOrder.push('trigger');
            return { uploaded: false };
          });
          mockRunTripBoundCleanups.mockImplementation(async () => {
            callOrder.push('cleanup');
          });
          await handleSilentPush(alertTripEndedPayload({ pushId: 'a-uuid' }));
          expect(callOrder).toEqual(['trigger', 'cleanup']);
        });

        it('alert payload → pushId를 FIRED_PUSH_IDS에 기록(silent backstop race dedup)', async () => {
          await handleSilentPush(alertTripEndedPayload({ pushId: 'a-uuid' }));
          expect(mockAddFiredPushId).toHaveBeenCalledWith('a-uuid');
        });

        it('alert payload + pushId 없으면 dedup 기록 skip — 나머지 흐름은 동일', async () => {
          await handleSilentPush(alertTripEndedPayload());
          expect(mockAddFiredPushId).not.toHaveBeenCalled();
          expect(mockRunTripBoundCleanups).toHaveBeenCalledTimes(1);
          expect(mockSetTripEndedSentinel).toHaveBeenCalledTimes(1);
        });

        it('alert payload + 동일 pushId 재도달 → dedup hasFiredPushId 경로는 surface가 아니라 skip 게이트만 적용; addFiredPushId는 무조건 호출', async () => {
          // alert path는 surface가 없으므로 hasFiredPushId 체크는 surfaceTripEnded에서만 의미가 있다.
          // 여기서는 pushId 기록이 idempotent하다는 사실(addFiredPushId 중복 호출 허용)을 검증.
          mockHasFiredPushId.mockResolvedValue(true);
          await handleSilentPush(alertTripEndedPayload({ pushId: 'a-uuid' }));
          expect(mockSendTripEndedNotification).not.toHaveBeenCalled();
          expect(mockAddFiredPushId).toHaveBeenCalledWith('a-uuid');
        });

        it.each([
          ['eta-missing'],
          ['destination-arrived'],
          ['expired'],
          ['push-unrecoverable'],
        ])('alert payload reason=%s → surface skip + cleanup/sentinel 진행', async (reason) => {
          await handleSilentPush(alertTripEndedPayload({ pushId: 'a-uuid', reason }));
          expect(mockSendTripEndedNotification).not.toHaveBeenCalled();
          expect(mockRunTripBoundCleanups).toHaveBeenCalledTimes(1);
          expect(mockSetTripEndedSentinel).toHaveBeenCalledTimes(1);
        });

        it('alert payload → ack(fired, trip-ended:reason) 전송(silent path와 동일)', async () => {
          await handleSilentPush(alertTripEndedPayload({ pushId: 'a-uuid', reason: 'destination-arrived' }));
          expect(mockSendPushAck).toHaveBeenCalledWith({
            pushId: 'a-uuid',
            token: DEFAULT_APNS_TOKEN,
            outcome: 'fired',
            reason: 'trip-ended:destination-arrived',
            permissionMode: 'always',
          });
        });

        it('alert payload + tripToken mismatch → cleanup/sentinel/surface 모두 skip(token-mismatch ack)', async () => {
          (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
            if (key === APNS_TOKEN_KEY) return DEFAULT_APNS_TOKEN;
            if (key === ACTIVE_TRIP_KEY) return 'NEW-TRIP-TOKEN';
            return null;
          });
          await handleSilentPush(
            alertTripEndedPayload({ pushId: 'a-uuid', tripToken: 'OLD-TRIP-TOKEN' }),
          );
          expect(mockRunTripBoundCleanups).not.toHaveBeenCalled();
          expect(mockSetTripEndedSentinel).not.toHaveBeenCalled();
          expect(mockSendTripEndedNotification).not.toHaveBeenCalled();
          expect(mockAddFiredPushId).not.toHaveBeenCalled();
          expect(mockSendPushAck).toHaveBeenCalledWith({
            pushId: 'a-uuid',
            token: DEFAULT_APNS_TOKEN,
            outcome: 'fired',
            reason: expect.stringContaining('token-mismatch') as unknown as string,
            permissionMode: 'always',
          });
        });
      });
    });

    // #2028 — boarding-prompt silent push: gate 무관 local notification schedule.
    describe('boarding-prompt kind (#2028) — Layer 2 도달 채널', () => {
      function boardingPromptPayload(extra: Record<string, unknown> = {}) {
        return {
          data: {
            data: {
              data: {
                kind: 'boarding-prompt',
                originStation: '강남',
                line: '2',
                tripToken: 'tok-bp',
                ...extra,
              },
              dataString: null,
            },
            notification: null,
            aps: { 'content-available': 1 },
          },
        };
      }

      beforeEach(() => {
        __resetBoardingPromptSilentPushDedup();
      });

      it('boarding-prompt 수신 → scheduleNotificationAsync 즉시 호출 (gate 무관)', async () => {
        await handleSilentPush(boardingPromptPayload({ pushId: 'bp-1' }));
        expect(mockScheduleNotificationAsync).toHaveBeenCalledTimes(1);
        // standard 발사 경로는 호출되지 않아야 함.
        expect(mockCheckGate).not.toHaveBeenCalled();
        expect(mockLogSilentPushReceived).not.toHaveBeenCalled();
        expect(mockLogSilentPushFired).not.toHaveBeenCalled();
      });

      it('scheduleNotificationAsync 호출 시 content에 title/body/sound/category/data 포함', async () => {
        await handleSilentPush(
          boardingPromptPayload({
            pushId: 'bp-1',
            title: '탑승하셨나요?',
            body: '2호선 강남 도착',
            destinationDirection: 'up',
          }),
        );
        expect(mockScheduleNotificationAsync).toHaveBeenCalledWith({
          identifier: 'boarding-prompt-silent-push',
          content: {
            title: '탑승하셨나요?',
            body: '2호선 강남 도착',
            sound: 'default',
            categoryIdentifier: 'BOARDING_PROMPT',
            data: {
              kind: 'boarding-prompt',
              originStation: '강남',
              line: '2',
              tripToken: 'tok-bp',
              destinationDirection: 'up',
            },
            interruptionLevel: 'timeSensitive',
          },
          trigger: null,
        });
      });

      it('title/body 누락 시 device fallback 문자열 사용 (도달률 우선)', async () => {
        await handleSilentPush(boardingPromptPayload({ pushId: 'bp-1' }));
        const call = mockScheduleNotificationAsync.mock.calls[0][0] as {
          content: { title: string; body: string };
        };
        expect(call.content.title).toBe('탑승하셨나요?');
        expect(call.content.body).toContain('강남');
        expect(call.content.body).toContain('2호선');
      });

      it('destinationDirection 미지정 시 data에 필드 자체가 없음 (구 backend 호환)', async () => {
        await handleSilentPush(boardingPromptPayload({ pushId: 'bp-1' }));
        const call = mockScheduleNotificationAsync.mock.calls[0][0] as {
          content: { data: Record<string, unknown> };
        };
        expect(call.content.data).not.toHaveProperty('destinationDirection');
      });

      it('같은 tripToken 세션 내 두 번째 수신은 dedup skip', async () => {
        await handleSilentPush(boardingPromptPayload({ pushId: 'bp-1' }));
        await handleSilentPush(boardingPromptPayload({ pushId: 'bp-2' }));
        expect(mockScheduleNotificationAsync).toHaveBeenCalledTimes(1);
      });

      it('다른 tripToken 수신은 각각 발사', async () => {
        await handleSilentPush(boardingPromptPayload({ pushId: 'bp-1', tripToken: 'tok-A' }));
        await handleSilentPush(boardingPromptPayload({ pushId: 'bp-2', tripToken: 'tok-B' }));
        expect(mockScheduleNotificationAsync).toHaveBeenCalledTimes(2);
      });

      it('gate/location 등 다른 mock은 호출 안 됨 (unconditional path)', async () => {
        await handleSilentPush(boardingPromptPayload({ pushId: 'bp-1' }));
        expect(mockCheckGate).not.toHaveBeenCalled();
        expect(mockGetDismissSilence).not.toHaveBeenCalled();
        expect(mockGetMotionStationary).not.toHaveBeenCalled();
        expect(mockGetFiredAlarms).not.toHaveBeenCalled();
      });

      it('pushId 있으면 ack(fired, boarding-prompt) 전송', async () => {
        await handleSilentPush(boardingPromptPayload({ pushId: 'bp-1' }));
        expect(mockSendPushAck).toHaveBeenCalledWith({
          pushId: 'bp-1',
          token: DEFAULT_APNS_TOKEN,
          outcome: 'fired',
          reason: 'boarding-prompt',
          permissionMode: 'always',
        });
      });

      it('pushId 없으면 fired ack 호출 안 함 (구 backend 호환) — schedule은 진행', async () => {
        await handleSilentPush(boardingPromptPayload());
        // received ack도 fired ack도 없음 (pushId 부재).
        const firedCalls = mockSendPushAck.mock.calls.filter(
          (call) => (call[0] as { outcome?: string }).outcome === 'fired',
        );
        expect(firedCalls).toHaveLength(0);
        expect(mockScheduleNotificationAsync).toHaveBeenCalledTimes(1);
      });

      it('dedup skip 시 ack(skipped, boarding-prompt-dedup) 전송', async () => {
        await handleSilentPush(boardingPromptPayload({ pushId: 'bp-1' }));
        mockSendPushAck.mockClear();
        await handleSilentPush(boardingPromptPayload({ pushId: 'bp-2' }));
        expect(mockSendPushAck).toHaveBeenCalledWith({
          pushId: 'bp-2',
          token: DEFAULT_APNS_TOKEN,
          outcome: 'skipped',
          reason: 'boarding-prompt-dedup',
          permissionMode: 'always',
        });
      });

      it('scheduleNotificationAsync throw해도 후속 흐름 차단 안 함 + ack skipped 전송', async () => {
        mockScheduleNotificationAsync.mockRejectedValueOnce(new Error('schedule fail'));
        await expect(
          handleSilentPush(boardingPromptPayload({ pushId: 'bp-1' })),
        ).resolves.toBeUndefined();
        expect(mockSendPushAck).toHaveBeenCalledWith({
          pushId: 'bp-1',
          token: DEFAULT_APNS_TOKEN,
          outcome: 'skipped',
          reason: 'boarding-prompt-schedule-failed',
          permissionMode: 'always',
        });
      });

      it('schedule 실패로 dedup registered 상태 — 재시도가 새 알림을 발사하지 않음', async () => {
        mockScheduleNotificationAsync.mockRejectedValueOnce(new Error('schedule fail'));
        await handleSilentPush(boardingPromptPayload({ pushId: 'bp-1' }));
        mockScheduleNotificationAsync.mockClear();
        // 두번째 backend 재시도 (같은 tripToken) → dedup으로 재발사 안 함.
        await handleSilentPush(boardingPromptPayload({ pushId: 'bp-2' }));
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
      });

      it('domain breadcrumb 발사 (dashboard 관측)', async () => {
        await handleSilentPush(boardingPromptPayload({ pushId: 'bp-1' }));
        expect(mockAddDomainBreadcrumb).toHaveBeenCalledWith(
          'push',
          'boarding-prompt-silent-fired',
          { line: '2', originStation: '강남' },
        );
      });

      // #1935 — silent push finally 블록에서 refreshLA는 항상 호출.
      it('boarding-prompt 발사 후에도 refreshLiveActivityFromBackgroundContext 1회 호출', async () => {
        await handleSilentPush(boardingPromptPayload({ pushId: 'bp-1' }));
        expect(mockRefreshLa).toHaveBeenCalledTimes(1);
      });

      // Layer 2 사용자 도달 KPI — Acceptance dashboard의 boardingPromptFired 카운트로 반영.
      it('발사 시 logBoardingPromptFired 호출 (Acceptance dashboard 반영)', async () => {
        await handleSilentPush(boardingPromptPayload({ pushId: 'bp-1' }));
        expect(mockLogBoardingPromptFired).toHaveBeenCalledWith({
          originStation: '강남',
          line: '2',
        });
      });

      it('dedup skip 시 logBoardingPromptFired 호출 안 함', async () => {
        await handleSilentPush(boardingPromptPayload({ pushId: 'bp-1' }));
        mockLogBoardingPromptFired.mockClear();
        await handleSilentPush(boardingPromptPayload({ pushId: 'bp-2' }));
        expect(mockLogBoardingPromptFired).not.toHaveBeenCalled();
      });

      it('schedule 실패 시 logBoardingPromptFired 호출 안 함 (실패는 KPI 반영 X)', async () => {
        mockScheduleNotificationAsync.mockRejectedValueOnce(new Error('schedule fail'));
        await handleSilentPush(boardingPromptPayload({ pushId: 'bp-1' }));
        expect(mockLogBoardingPromptFired).not.toHaveBeenCalled();
      });

      // #2034 — hop-end (환승역 하차) 시나리오.
      describe('#2034 hop-end (환승역 "하차했나요?")', () => {
        function hopEndPayload(extra: Record<string, unknown> = {}) {
          return boardingPromptPayload({
            hopEndKind: 'disembark',
            originStation: '성수',
            line: '2',
            tripToken: 'tok-hop',
            nextLine: 'K',
            nextStation: '왕십리',
            ...extra,
          });
        }

        it('hopEndKind=disembark → fallback title "성수에서 하차하셨나요?"', async () => {
          await handleSilentPush(hopEndPayload({ pushId: 'hop-1' }));
          const call = mockScheduleNotificationAsync.mock.calls[0][0] as {
            content: { title: string; body: string };
          };
          expect(call.content.title).toBe('성수에서 하차하셨나요?');
          expect(call.content.body).toContain('성수에서 내려주세요');
          expect(call.content.body).toContain('K호선 왕십리');
        });

        it('hopEndKind=disembark + nextStation 없음 → line 만 fallback body', async () => {
          await handleSilentPush(hopEndPayload({ pushId: 'hop-2', nextStation: undefined }));
          const call = mockScheduleNotificationAsync.mock.calls[0][0] as {
            content: { body: string };
          };
          expect(call.content.body).toContain('K호선');
          expect(call.content.body).not.toContain('왕십리');
        });

        it('hopEndKind=disembark + nextLine 없음 → 다음 leg 안내 생략', async () => {
          await handleSilentPush(
            hopEndPayload({ pushId: 'hop-3', nextLine: undefined, nextStation: undefined }),
          );
          const call = mockScheduleNotificationAsync.mock.calls[0][0] as {
            content: { body: string };
          };
          expect(call.content.body).toBe('2호선 성수에서 내려주세요.');
        });

        it('backend title/body 우선 (backend i18n resolve 정합)', async () => {
          await handleSilentPush(
            hopEndPayload({
              pushId: 'hop-4',
              title: 'Getting off at Seongsu?',
              body: 'Transfer here.',
            }),
          );
          const call = mockScheduleNotificationAsync.mock.calls[0][0] as {
            content: { title: string; body: string };
          };
          expect(call.content.title).toBe('Getting off at Seongsu?');
          expect(call.content.body).toBe('Transfer here.');
        });

        it('data payload 에 hopEndKind + nextLine + nextStation 전달', async () => {
          await handleSilentPush(hopEndPayload({ pushId: 'hop-5' }));
          const call = mockScheduleNotificationAsync.mock.calls[0][0] as {
            content: { data: Record<string, unknown> };
          };
          expect(call.content.data.hopEndKind).toBe('disembark');
          expect(call.content.data.nextLine).toBe('K');
          expect(call.content.data.nextStation).toBe('왕십리');
        });

        it('hop-end dedup 은 leg-key (tripToken|hop-end|line) — 같은 tripToken 다른 line 은 각 발사', async () => {
          await handleSilentPush(hopEndPayload({ pushId: 'hop-a', line: '2' }));
          await handleSilentPush(hopEndPayload({ pushId: 'hop-b', line: '5' }));
          expect(mockScheduleNotificationAsync).toHaveBeenCalledTimes(2);
        });

        it('hop-end 이후 승차 prompt (같은 tripToken) 은 별개 dedup 채널 → 각 발사', async () => {
          await handleSilentPush(hopEndPayload({ pushId: 'hop-x' }));
          await handleSilentPush(
            boardingPromptPayload({
              pushId: 'bp-x',
              tripToken: 'tok-hop', // 같은 trip
              // hopEndKind 없음 → 승차 prompt
            }),
          );
          expect(mockScheduleNotificationAsync).toHaveBeenCalledTimes(2);
        });

        it('같은 leg-key 두 번째 발사는 dedup skip', async () => {
          await handleSilentPush(hopEndPayload({ pushId: 'hop-p' }));
          await handleSilentPush(hopEndPayload({ pushId: 'hop-q' }));
          expect(mockScheduleNotificationAsync).toHaveBeenCalledTimes(1);
        });
      });
    });

    // #2036 (Issue I γ) — sleep-transfer-alarm silent push: gate 무관 로컬 알림 (sleepMode=true 시).
    describe('sleep-transfer-alarm kind (#2036) — 취침모드 환승 알람 채널', () => {
      function sleepTransferPayload(extra: Record<string, unknown> = {}) {
        return {
          data: {
            data: {
              data: {
                kind: 'sleep-transfer-alarm',
                originStation: '성수',
                nextLine: '2',
                nextStation: '뚝섬',
                tripToken: 'tok-sta',
                ...extra,
              },
              dataString: null,
            },
            notification: null,
            aps: { 'content-available': 1 },
          },
        };
      }

      /** sleepMode=true를 AsyncStorage에 세팅한다. 기본 destStation/APNS token 유지. */
      function setSleepMode(enabled: boolean): void {
        (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
          if (key === DESTINATION_KEY) return JSON.stringify(destStation);
          if (key === APNS_TOKEN_KEY) return DEFAULT_APNS_TOKEN;
          if (key === SLEEP_MODE_KEY) return JSON.stringify(enabled);
          return null;
        });
      }

      beforeEach(() => {
        __resetSleepTransferAlarmSilentPushDedup();
      });

      it('sleepMode=true 수신 → scheduleNotificationAsync 즉시 호출 (gate 무관)', async () => {
        setSleepMode(true);
        await handleSilentPush(sleepTransferPayload({ pushId: 'sta-1' }));
        expect(mockScheduleNotificationAsync).toHaveBeenCalledTimes(1);
        // standard 발사 경로는 호출되지 않아야 함.
        expect(mockCheckGate).not.toHaveBeenCalled();
        expect(mockLogSilentPushReceived).not.toHaveBeenCalled();
        expect(mockLogSilentPushFired).not.toHaveBeenCalled();
      });

      it('sleepMode=false 수신 → 알림 발사 안 함 + ack(skipped, not-sleep-mode)', async () => {
        setSleepMode(false);
        await handleSilentPush(sleepTransferPayload({ pushId: 'sta-1' }));
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        expect(mockVibrateAlarm).not.toHaveBeenCalled();
        expect(mockLogSleepTransferAlarmFired).not.toHaveBeenCalled();
        expect(mockSendPushAck).toHaveBeenCalledWith({
          pushId: 'sta-1',
          token: DEFAULT_APNS_TOKEN,
          outcome: 'skipped',
          reason: 'sleep-transfer-not-sleep-mode',
          permissionMode: 'always',
        });
      });

      it('SLEEP_MODE_KEY 저장값 없음 → 취침 아님으로 판정 (fail-closed)', async () => {
        // 기본 mock — SLEEP_MODE_KEY 는 null 반환.
        await handleSilentPush(sleepTransferPayload({ pushId: 'sta-1' }));
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        expect(mockSendPushAck).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: 'skipped', reason: 'sleep-transfer-not-sleep-mode' }),
        );
      });

      it('SLEEP_MODE_KEY read throw → 취침 아님으로 판정 (fail-closed graceful)', async () => {
        (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
          if (key === DESTINATION_KEY) return JSON.stringify(destStation);
          if (key === APNS_TOKEN_KEY) return DEFAULT_APNS_TOKEN;
          if (key === SLEEP_MODE_KEY) throw new Error('storage-fail');
          return null;
        });
        await handleSilentPush(sleepTransferPayload({ pushId: 'sta-1' }));
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
      });

      it('scheduleNotificationAsync content: title/body/sound/data/interruptionLevel 포함', async () => {
        setSleepMode(true);
        await handleSilentPush(
          sleepTransferPayload({
            pushId: 'sta-1',
            title: '곧 환승역입니다',
            body: '성수에서 2호선 뚝섬으로 환승',
          }),
        );
        expect(mockScheduleNotificationAsync).toHaveBeenCalledWith({
          identifier: 'sleep-transfer-alarm-silent-push',
          content: {
            title: '곧 환승역입니다',
            body: '성수에서 2호선 뚝섬으로 환승',
            sound: 'alarm.wav',
            data: {
              kind: 'sleep-transfer-alarm',
              originStation: '성수',
              nextLine: '2',
              nextStation: '뚝섬',
              tripToken: 'tok-sta',
            },
            interruptionLevel: 'timeSensitive',
          },
          trigger: null,
        });
      });

      it('title/body 누락 시 device fallback 문자열 사용', async () => {
        setSleepMode(true);
        await handleSilentPush(sleepTransferPayload({ pushId: 'sta-1' }));
        const call = mockScheduleNotificationAsync.mock.calls[0][0] as {
          content: { title: string; body: string };
        };
        expect(call.content.title).toBe('곧 환승역입니다');
        expect(call.content.body).toContain('성수');
        expect(call.content.body).toContain('2호선');
        expect(call.content.body).toContain('뚝섬');
      });

      it('발사 시 vibrateAlarm(true) 호출 (사용자 확정 flow: 소리+진동)', async () => {
        setSleepMode(true);
        await handleSilentPush(sleepTransferPayload({ pushId: 'sta-1' }));
        expect(mockVibrateAlarm).toHaveBeenCalledWith(true);
      });

      it('발사 시 logSleepTransferAlarmFired 호출 (Acceptance dashboard 반영)', async () => {
        setSleepMode(true);
        await handleSilentPush(sleepTransferPayload({ pushId: 'sta-1' }));
        expect(mockLogSleepTransferAlarmFired).toHaveBeenCalledWith({
          originStation: '성수',
          nextStation: '뚝섬',
          nextLine: '2',
        });
      });

      it('같은 tripToken + nextStation 세션 내 두 번째 수신은 dedup skip', async () => {
        setSleepMode(true);
        await handleSilentPush(sleepTransferPayload({ pushId: 'sta-1' }));
        await handleSilentPush(sleepTransferPayload({ pushId: 'sta-2' }));
        expect(mockScheduleNotificationAsync).toHaveBeenCalledTimes(1);
        expect(mockVibrateAlarm).toHaveBeenCalledTimes(1);
      });

      it('같은 tripToken + 다른 nextStation은 각각 발사 (다음 환승 hop 커버)', async () => {
        setSleepMode(true);
        await handleSilentPush(sleepTransferPayload({ pushId: 'sta-1', nextStation: '뚝섬' }));
        await handleSilentPush(sleepTransferPayload({ pushId: 'sta-2', nextStation: '한양대' }));
        expect(mockScheduleNotificationAsync).toHaveBeenCalledTimes(2);
      });

      it('다른 tripToken 수신은 각각 발사', async () => {
        setSleepMode(true);
        await handleSilentPush(sleepTransferPayload({ pushId: 'sta-1', tripToken: 'tok-A' }));
        await handleSilentPush(sleepTransferPayload({ pushId: 'sta-2', tripToken: 'tok-B' }));
        expect(mockScheduleNotificationAsync).toHaveBeenCalledTimes(2);
      });

      it('gate/location 등 다른 mock은 호출 안 됨 (unconditional path)', async () => {
        setSleepMode(true);
        await handleSilentPush(sleepTransferPayload({ pushId: 'sta-1' }));
        expect(mockCheckGate).not.toHaveBeenCalled();
        expect(mockGetDismissSilence).not.toHaveBeenCalled();
        expect(mockGetMotionStationary).not.toHaveBeenCalled();
        expect(mockGetFiredAlarms).not.toHaveBeenCalled();
      });

      it('pushId 있으면 ack(fired, sleep-transfer-alarm) 전송', async () => {
        setSleepMode(true);
        await handleSilentPush(sleepTransferPayload({ pushId: 'sta-1' }));
        expect(mockSendPushAck).toHaveBeenCalledWith({
          pushId: 'sta-1',
          token: DEFAULT_APNS_TOKEN,
          outcome: 'fired',
          reason: 'sleep-transfer-alarm',
          permissionMode: 'always',
        });
      });

      it('pushId 없으면 fired ack 호출 안 함 (구 backend 호환) — schedule은 진행', async () => {
        setSleepMode(true);
        await handleSilentPush(sleepTransferPayload());
        const firedCalls = mockSendPushAck.mock.calls.filter(
          (call) => (call[0] as { outcome?: string }).outcome === 'fired',
        );
        expect(firedCalls).toHaveLength(0);
        expect(mockScheduleNotificationAsync).toHaveBeenCalledTimes(1);
      });

      it('dedup skip 시 ack(skipped, sleep-transfer-dedup) 전송', async () => {
        setSleepMode(true);
        await handleSilentPush(sleepTransferPayload({ pushId: 'sta-1' }));
        mockSendPushAck.mockClear();
        await handleSilentPush(sleepTransferPayload({ pushId: 'sta-2' }));
        expect(mockSendPushAck).toHaveBeenCalledWith({
          pushId: 'sta-2',
          token: DEFAULT_APNS_TOKEN,
          outcome: 'skipped',
          reason: 'sleep-transfer-dedup',
          permissionMode: 'always',
        });
      });

      it('scheduleNotificationAsync throw해도 후속 흐름 차단 안 함 + ack skipped 전송', async () => {
        setSleepMode(true);
        mockScheduleNotificationAsync.mockRejectedValueOnce(new Error('schedule fail'));
        await expect(
          handleSilentPush(sleepTransferPayload({ pushId: 'sta-1' })),
        ).resolves.toBeUndefined();
        expect(mockSendPushAck).toHaveBeenCalledWith({
          pushId: 'sta-1',
          token: DEFAULT_APNS_TOKEN,
          outcome: 'skipped',
          reason: 'sleep-transfer-schedule-failed',
          permissionMode: 'always',
        });
      });

      it('schedule 실패로 dedup 등록 상태 — 재시도가 새 알림을 발사하지 않음', async () => {
        setSleepMode(true);
        mockScheduleNotificationAsync.mockRejectedValueOnce(new Error('schedule fail'));
        await handleSilentPush(sleepTransferPayload({ pushId: 'sta-1' }));
        mockScheduleNotificationAsync.mockClear();
        await handleSilentPush(sleepTransferPayload({ pushId: 'sta-2' }));
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
      });

      it('domain breadcrumb 발사 (dashboard 관측)', async () => {
        setSleepMode(true);
        await handleSilentPush(sleepTransferPayload({ pushId: 'sta-1' }));
        expect(mockAddDomainBreadcrumb).toHaveBeenCalledWith(
          'push',
          'sleep-transfer-alarm-fired',
          { nextLine: '2', originStation: '성수', nextStation: '뚝섬' },
        );
      });

      it('sleepMode=false 시 dedup 등록 안 함 → 이후 sleepMode=true 전환 재시도는 정상 발사', async () => {
        setSleepMode(false);
        await handleSilentPush(sleepTransferPayload({ pushId: 'sta-1' }));
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        // 사용자가 취침모드 ON 후 backend 재시도.
        setSleepMode(true);
        await handleSilentPush(sleepTransferPayload({ pushId: 'sta-2' }));
        expect(mockScheduleNotificationAsync).toHaveBeenCalledTimes(1);
      });

      it('sleep-transfer-alarm 발사 후에도 refreshLiveActivityFromBackgroundContext 1회 호출 (#1935 정합)', async () => {
        setSleepMode(true);
        await handleSilentPush(sleepTransferPayload({ pushId: 'sta-1' }));
        expect(mockRefreshLa).toHaveBeenCalledTimes(1);
      });

      it('sleepMode=false skip 후에도 refreshLA 1회 호출 (#1935 정합)', async () => {
        setSleepMode(false);
        await handleSilentPush(sleepTransferPayload({ pushId: 'sta-1' }));
        expect(mockRefreshLa).toHaveBeenCalledTimes(1);
      });
    });

    describe('#746 dismiss silence 게이트 (BG silent push)', () => {
      it('silence 활성이면 발사 차단 + logSilentPushSkipped(reason=dismiss-silence) + ACK skip', async () => {
        mockGetDismissSilence.mockResolvedValue({
          sinceTs: Date.now(),
          sinceLat: null,
          sinceLng: null,
        });
        await handleSilentPush(payload({ kind: 'destination', phase: 'imminent', pushId: 'p1' }));
        expect(mockCheckGate).not.toHaveBeenCalled();
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({
            reason: 'dismiss-silence',
            stationName: '강남',
            kind: 'destination',
            phaseId: 'imminent',
          }),
        );
        expect(mockSendPushAck).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: 'skipped', reason: 'dismiss-silence' }),
        );
      });

      it('silence 만료 시 clear 호출 + 정상 발사 path로 진입(checkGate 호출)', async () => {
        mockGetDismissSilence.mockResolvedValue({
          sinceTs: Date.now() - 10 * 60_000,
          sinceLat: null,
          sinceLng: null,
        });
        await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));
        expect(mockClearDismissSilence).toHaveBeenCalledTimes(1);
        expect(mockCheckGate).toHaveBeenCalled();
      });

      it('intermediate 카테고리도 silence가 차단(kind=station-passed로 log)', async () => {
        mockGetDismissSilence.mockResolvedValue({
          sinceTs: Date.now(),
          sinceLat: null,
          sinceLng: null,
        });
        await handleSilentPush(payload({ kind: 'intermediate', phase: 'early', pushId: 'p2' }));
        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({
            reason: 'dismiss-silence',
            kind: 'station-passed',
          }),
        );
      });

      it('silence state null이면 정상 path로 진입', async () => {
        mockGetDismissSilence.mockResolvedValue(null);
        await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));
        expect(mockCheckGate).toHaveBeenCalled();
      });
    });

    // #1935 — silent push finally 블록에서 widget update wire 호출 검증.
    // WhileInUse paradigm 충족 — 권한 무관 채널에서 BG widget 갱신.
    describe('#1935 — widget update wire (finally 블록)', () => {
      it('valid payload면 finally에서 updateWidgetFromSilentPush 호출 (ssot/bgContext/destination/route 전달)', async () => {
        const ctx = {
          destination: { id: 'd1', name: '잠실', line: '2', lineColor: '#0', lat: 37.5, lng: 127.1 },
          route: { type: 'direct', line: '2', stops: 3, travelSeconds: 240 },
          bgContext: { station: { id: 's1', name: '강남' }, distanceKm: 0.15, timestamp: 0 },
        };
        mockReadWidgetCtx.mockResolvedValueOnce(ctx);
        // validSsotMirror가 narrow하는 필드만 사용 — currentStationLine은 mirror entry에만 추가됨(#1705)
        // 이라 silent push payload validator는 drop. widget update는 name-only fallback으로 동작.
        const ssotPayload = {
          currentStationId: '역삼',
          motionState: 'moving',
          lastAdvanceEvidence: 'arc-overshoot',
          lastAdvanceAt: 1_700_000_000_000,
          passedStations: [],
        };
        await handleSilentPush(
          payload({ kind: 'destination', phase: 'imminent', ssot: ssotPayload }),
        );
        expect(mockReadWidgetCtx).toHaveBeenCalledTimes(1);
        expect(mockUpdateWidget).toHaveBeenCalledTimes(1);
        const [ssotArg, bgArg, destArg, routeArg] = mockUpdateWidget.mock.calls[0];
        expect(ssotArg).toEqual(ssotPayload);
        expect(bgArg).toBe(ctx.bgContext);
        expect(destArg).toBe(ctx.destination);
        expect(routeArg).toBe(ctx.route);
      });

      it('reschedule payload는 ssot 필드 없음 — undefined로 전달, BG context fallback', async () => {
        mockReadWidgetCtx.mockResolvedValueOnce({
          destination: null,
          route: null,
          bgContext: null,
        });
        await handleSilentPush({
          data: bgTaskData({
            kind: 'reschedule',
            nextStation: '잠실',
            newArrivalTimeEpoch: Date.now() + 60_000,
            trainCode: 'T-1',
            pushId: 'rs-1',
          }),
        });
        expect(mockUpdateWidget).toHaveBeenCalledTimes(1);
        expect(mockUpdateWidget.mock.calls[0][0]).toBeUndefined();
      });

      it('trip-ended payload도 ssot 없음 — undefined로 전달', async () => {
        mockReadWidgetCtx.mockResolvedValueOnce({
          destination: null,
          route: null,
          bgContext: null,
        });
        await handleSilentPush({
          data: bgTaskData({
            kind: 'trip-ended',
            reason: 'destination-arrived',
            pushId: 'te-1',
          }),
        });
        expect(mockUpdateWidget).toHaveBeenCalledTimes(1);
        expect(mockUpdateWidget.mock.calls[0][0]).toBeUndefined();
      });

      it('invalid payload (extract null)면 readWidgetRefreshContext / updateWidgetFromSilentPush 호출 안 함', async () => {
        await handleSilentPush({ data: undefined });
        expect(mockReadWidgetCtx).not.toHaveBeenCalled();
        expect(mockUpdateWidget).not.toHaveBeenCalled();
      });

      it('input.error 분기에서도 widget update 호출 안 함 (payload 미extract)', async () => {
        await handleSilentPush({ error: { message: 'boom' } });
        expect(mockReadWidgetCtx).not.toHaveBeenCalled();
        expect(mockUpdateWidget).not.toHaveBeenCalled();
      });

      it('updateWidgetFromSilentPush throw해도 본 흐름은 graceful (LA refresh도 호출됨)', async () => {
        mockReadWidgetCtx.mockResolvedValueOnce({
          destination: null,
          route: null,
          bgContext: null,
        });
        mockUpdateWidget.mockRejectedValueOnce(new Error('widget-fail'));
        await expect(
          handleSilentPush(payload({ kind: 'destination', phase: 'imminent' })),
        ).resolves.toBeUndefined();
        // LA refresh와 격리되어 둘 다 호출
        expect(mockRefreshLa).toHaveBeenCalled();
      });

      it('readWidgetRefreshContext throw해도 graceful (LA refresh 동작 보존)', async () => {
        mockReadWidgetCtx.mockRejectedValueOnce(new Error('storage-fail'));
        await expect(
          handleSilentPush(payload({ kind: 'destination', phase: 'imminent' })),
        ).resolves.toBeUndefined();
        expect(mockRefreshLa).toHaveBeenCalled();
      });
    });
  });

  describe('registerSilentPushTask', () => {
    it('Notifications.registerTaskAsync 호출', async () => {
      mockRegisterTaskAsync.mockResolvedValue(undefined);
      await registerSilentPushTask();
      expect(mockRegisterTaskAsync).toHaveBeenCalledWith(SILENT_PUSH_TASK);
    });

    it('register 실패 시 throw 안 함', async () => {
      mockRegisterTaskAsync.mockRejectedValue(new Error('not supported'));
      await expect(registerSilentPushTask()).resolves.toBeUndefined();
    });
  });

  describe('getSilentPushRegistrationStatus', () => {
    // 등록 상태는 모듈 전역이므로 success → failed 순으로 검증 (역순이면 한 번 success로 덮인 뒤
    // failed로 전이되는 정상 경로만 보고 unknown→failed 첫 케이스를 못 짚는다)
    it('등록 성공 시 success', async () => {
      mockRegisterTaskAsync.mockResolvedValue(undefined);
      await registerSilentPushTask();
      const status = getSilentPushRegistrationStatus();
      expect(status.state).toBe('success');
      expect(status.error).toBeNull();
    });

    it('등록 실패 시 failed + error 메시지', async () => {
      mockRegisterTaskAsync.mockRejectedValue(new Error('not supported'));
      await registerSilentPushTask();
      const status = getSilentPushRegistrationStatus();
      expect(status.state).toBe('failed');
      expect(status.error).toBe('not supported');
    });

    it('Error 아닌 throw도 문자열로 보존', async () => {
      mockRegisterTaskAsync.mockRejectedValue('string-rejection');
      await registerSilentPushTask();
      const status = getSilentPushRegistrationStatus();
      expect(status.state).toBe('failed');
      expect(status.error).toBe('string-rejection');
    });
  });

  describe('#900 Seam D — refreshLiveActivityFromBackgroundContext invocation', () => {
    // payload kind 전반에서 LA refresh가 정확히 1회 호출됨을 검증.
    // 데이터 주도: 각 row가 (label, taskData, mock setup)을 정의해 동일 assertion 반복.
    function lockMismatchPayload() {
      mockFindStationByNameAndLine.mockReturnValueOnce(null);
      mockFindStationByName.mockReturnValueOnce({} as never);
      return payload({ kind: 'transfer' });
    }
    function gateSkipPayload() {
      mockCheckGate.mockResolvedValueOnce({
        pass: false,
        reason: 'out-of-range',
        distanceM: 5000,
        thresholdM: 800,
        locationSource: 'cache',
        locationAgeMs: 5000,
      });
      return payload({ kind: 'transfer' });
    }
    const cases: Array<{ label: string; build: () => unknown }> = [
      { label: '정상 fire', build: () => payload({ kind: 'destination' }) },
      { label: 'reschedule kind', build: () => payload({ kind: 'reschedule', nextStation: '강남', newArrivalTimeEpoch: 1, trainCode: 'T1' }) },
      { label: 'trip-ended kind', build: () => payload({ kind: 'trip-ended', reason: 'expired' }) },
      { label: 'payload missing(invalid)', build: () => ({ data: { data: { data: {}, dataString: null }, notification: null, aps: { 'content-available': 1 } } }) },
      { label: 'lock-line-mismatch skip', build: () => lockMismatchPayload() },
      { label: 'gate skip', build: () => gateSkipPayload() },
    ];
    it.each(cases)('$label 후에도 refreshLiveActivityFromBackgroundContext 1회 호출', async ({ build }) => {
      await handleSilentPush(build() as never);
      expect(mockRefreshLa).toHaveBeenCalledTimes(1);
    });

    it('refresh가 throw해도 caller로 전파되지 않는다 (silent push 전체 흐름 보호)', async () => {
      mockRefreshLa.mockRejectedValueOnce(new Error('LA fail'));
      await expect(handleSilentPush(payload({ kind: 'destination' }) as never)).resolves.toBeUndefined();
    });

    it('error input일 때도 refresh가 호출된다', async () => {
      await handleSilentPush({ data: undefined, error: { message: 'boom' } });
      expect(mockRefreshLa).toHaveBeenCalledTimes(1);
    });
  });

  describe('domain breadcrumb (silent push 수신)', () => {
    beforeEach(() => {
      mockAddDomainBreadcrumb.mockClear();
    });

    it('payload 추출 성공 시 push 카테고리 breadcrumb', async () => {
      await handleSilentPush(
        bgTaskData({ nextWaypoint: '서울', etaSeconds: 30, phase: 'early' }),
      );
      expect(mockAddDomainBreadcrumb).toHaveBeenCalledWith('push', 'silent-push', {
        kind: 'fire',
      });
    });

    it('payload 추출 실패 시 breadcrumb 없음', async () => {
      await handleSilentPush({ data: undefined });
      expect(mockAddDomainBreadcrumb).not.toHaveBeenCalled();
    });

    it('error input 시 breadcrumb 없음', async () => {
      await handleSilentPush({ data: undefined, error: { message: 'boom' } });
      expect(mockAddDomainBreadcrumb).not.toHaveBeenCalled();
    });
  });

  // #1561 (T8, ADR-017 / S2 #1535 흡수) — backend SSoT mirror persistence + read.
  describe('backend SSoT mirror (#1561 T8 / S2 흡수)', () => {
    const validSsot = {
      currentStationId: '강남',
      motionState: 'moving' as const,
      lastAdvanceEvidence: 'arvlcd-confirmed-train',
      lastAdvanceAt: 1_700_000_000_500,
      passedStations: ['교대', '서초'],
    };

    beforeEach(() => {
      (AsyncStorage.getItem as jest.Mock).mockReset();
      (AsyncStorage.setItem as jest.Mock).mockReset();
    });

    it('persistBackendSsotMirror writes JSON with receivedAt stamp', async () => {
      (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);
      await persistBackendSsotMirror(validSsot, 1_700_000_001_000);
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        BACKEND_SSOT_MIRROR_KEY,
        JSON.stringify({ ...validSsot, receivedAt: 1_700_000_001_000 }),
      );
    });

    it('persistBackendSsotMirror swallows AsyncStorage errors (graceful)', async () => {
      (AsyncStorage.setItem as jest.Mock).mockRejectedValue(new Error('boom'));
      await expect(persistBackendSsotMirror(validSsot, 0)).resolves.toBeUndefined();
    });

    it('readBackendSsotMirror parses valid entry', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(
        JSON.stringify({ ...validSsot, receivedAt: 1_700_000_001_000 }),
      );
      await expect(readBackendSsotMirror()).resolves.toEqual({
        ...validSsot,
        receivedAt: 1_700_000_001_000,
      });
    });

    it('readBackendSsotMirror returns null when storage empty', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
      await expect(readBackendSsotMirror()).resolves.toBeNull();
    });

    it('readBackendSsotMirror returns null when JSON parse fails', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue('not-json{');
      await expect(readBackendSsotMirror()).resolves.toBeNull();
    });

    it('readBackendSsotMirror swallows AsyncStorage errors', async () => {
      (AsyncStorage.getItem as jest.Mock).mockRejectedValue(new Error('io'));
      await expect(readBackendSsotMirror()).resolves.toBeNull();
    });

    it.each([
      ['currentStationId missing', { ...validSsot, currentStationId: undefined }],
      ['motionState invalid', { ...validSsot, motionState: 'bogus' }],
      ['lastAdvanceEvidence missing', { ...validSsot, lastAdvanceEvidence: undefined }],
      ['lastAdvanceAt non-number', { ...validSsot, lastAdvanceAt: 'now' }],
      ['passedStations non-array', { ...validSsot, passedStations: 'x' }],
    ])('readBackendSsotMirror returns null when %s', async (_label, broken) => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(
        JSON.stringify({ ...broken, receivedAt: 1 }),
      );
      await expect(readBackendSsotMirror()).resolves.toBeNull();
    });

    it('readBackendSsotMirror returns null when receivedAt missing', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(JSON.stringify(validSsot));
      await expect(readBackendSsotMirror()).resolves.toBeNull();
    });

    it('readBackendSsotMirror filters non-string passedStations entries', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(
        JSON.stringify({
          ...validSsot,
          passedStations: ['교대', '', 42, '서초', null],
          receivedAt: 1,
        }),
      );
      const result = await readBackendSsotMirror();
      expect(result?.passedStations).toEqual(['교대', '서초']);
    });

    it('handleSilentPush persists SSoT mirror when payload.ssot is present', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
      (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);
      mockCheckGate.mockReturnValue({ allow: false, skip: 'gate-no-location' });
      await handleSilentPush(
        bgTaskData({
          nextWaypoint: '강남',
          etaSeconds: 0,
          phase: 'imminent',
          kind: 'intermediate',
          ssot: validSsot,
        }),
      );
      const mirrorCall = (AsyncStorage.setItem as jest.Mock).mock.calls.find(
        ([key]) => key === BACKEND_SSOT_MIRROR_KEY,
      );
      expect(mirrorCall).toBeDefined();
      const stored = JSON.parse(mirrorCall![1] as string);
      expect(stored).toMatchObject(validSsot);
      expect(typeof stored.receivedAt).toBe('number');
    });

    it('handleSilentPush does not persist mirror when payload.ssot is absent', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
      (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);
      mockCheckGate.mockReturnValue({ allow: false, skip: 'gate-no-location' });
      await handleSilentPush(
        bgTaskData({
          nextWaypoint: '강남',
          etaSeconds: 0,
          phase: 'imminent',
          kind: 'intermediate',
        }),
      );
      const mirrorCall = (AsyncStorage.setItem as jest.Mock).mock.calls.find(
        ([key]) => key === BACKEND_SSOT_MIRROR_KEY,
      );
      expect(mirrorCall).toBeUndefined();
    });

    // R11-b (#1612) — payload.tripToken mismatch 시 mirror write skip (race A 차단).
    // it.each + helper로 4 case 통합 (SonarCloud dup 회피, lesson_sonarcloud_dup_prevention).
    describe('R11-b (#1612) — trip token mismatch 시 mirror write skip', () => {
      type R11bCase = {
        label: string;
        activeTripValue: string | null;
        payloadTripToken: string | undefined;
        expectMirrorDefined: boolean;
        // #1628 — mismatch 분기에서만 logCrossTripMirrorSkip('mismatch') 1회 호출.
        expectMirrorSkipLogged: boolean;
      };

      async function runR11bCase({
        activeTripValue,
        payloadTripToken,
      }: R11bCase) {
        (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);
        (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
          if (key === ACTIVE_TRIP_KEY) return activeTripValue;
          if (key === DESTINATION_KEY) return JSON.stringify(destStation);
          if (key === APNS_TOKEN_KEY) return DEFAULT_APNS_TOKEN;
          return null;
        });
        mockCheckGate.mockReturnValue({ allow: false, skip: 'gate-no-location' });
        // tripToken undefined일 때 'tripToken' in payload는 true가 되지만 코드 가드는
        // `payload.tripToken !== undefined`로 분기 — 구 backend 호환 path 그대로 검증.
        const fields: Record<string, unknown> = {
          nextWaypoint: '강남',
          etaSeconds: 0,
          phase: 'imminent',
          kind: 'intermediate',
          ssot: validSsot,
        };
        if (payloadTripToken !== undefined) {
          fields.tripToken = payloadTripToken;
        }
        await handleSilentPush(bgTaskData(fields));
      }

      function findMirrorCall() {
        return (AsyncStorage.setItem as jest.Mock).mock.calls.find(
          ([key]) => key === BACKEND_SSOT_MIRROR_KEY,
        );
      }

      it.each<R11bCase>([
        {
          label: 'payload.tripToken === activeTripToken → mirror write 정상 진행 (정상 case)',
          activeTripValue: 'trip-token-A',
          payloadTripToken: 'trip-token-A',
          expectMirrorDefined: true,
          expectMirrorSkipLogged: false,
        },
        {
          label: 'payload.tripToken !== activeTripToken → mirror write skip (race A 차단)',
          activeTripValue: 'trip-token-NEW',
          payloadTripToken: 'trip-token-OLD',
          expectMirrorDefined: false,
          expectMirrorSkipLogged: true,
        },
        {
          label: 'activeTripToken null (cold-launch race) → mirror write 허용 (backward-compat)',
          activeTripValue: null,
          payloadTripToken: 'trip-token-X',
          expectMirrorDefined: true,
          expectMirrorSkipLogged: false,
        },
        {
          label: 'payload.tripToken undefined (구 backend 호환) → mirror write 허용',
          activeTripValue: 'trip-token-Z',
          payloadTripToken: undefined,
          expectMirrorDefined: true,
          expectMirrorSkipLogged: false,
        },
      ])('$label', async (testCase) => {
        mockLogCrossTripMirrorSkip.mockClear();
        await runR11bCase(testCase);
        const mirrorCall = findMirrorCall();
        if (testCase.expectMirrorDefined) {
          expect(mirrorCall).toBeDefined();
        } else {
          expect(mirrorCall).toBeUndefined();
        }
        // #1628 — mismatch case 1회 호출 / 그 외 0회.
        if (testCase.expectMirrorSkipLogged) {
          expect(mockLogCrossTripMirrorSkip).toHaveBeenCalledWith('mismatch');
        } else {
          expect(mockLogCrossTripMirrorSkip).not.toHaveBeenCalled();
        }
      });
    });

    it('validSsotMirror returns undefined for null/non-object', () => {
      expect(validSsotMirror(null)).toBeUndefined();
      expect(validSsotMirror(undefined)).toBeUndefined();
      expect(validSsotMirror('string')).toBeUndefined();
      expect(validSsotMirror(123)).toBeUndefined();
    });

    // #1572 (T9, ADR-017) — Path E SSoT 게이트 통합 acceptance.
    describe('Path E SSoT fire gate (#1572 T9)', () => {
      const NOW = 1_700_000_000_000;

      function makeFreshMirror(overrides: Record<string, unknown>): string {
        return JSON.stringify({
          currentStationId: '중곡',
          motionState: 'moving',
          lastAdvanceEvidence: 'arvlcd-confirmed-train',
          lastAdvanceAt: NOW,
          passedStations: [],
          receivedAt: NOW,
          ...overrides,
        });
      }

      beforeEach(() => {
        jest.spyOn(Date, 'now').mockReturnValue(NOW);
      });

      afterEach(() => {
        jest.spyOn(Date, 'now').mockRestore();
      });

      it('mirror에 같은 stationId가 station-passed로 결정됨 → silent push fire 차단 (Gate B)', async () => {
        (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
          if (key === DESTINATION_KEY) return JSON.stringify(destStation);
          if (key === APNS_TOKEN_KEY) return DEFAULT_APNS_TOKEN;
          if (key === BACKEND_SSOT_MIRROR_KEY)
            return makeFreshMirror({ passedStations: ['용마산'] });
          return null;
        });
        await handleSilentPush(
          bgTaskData({
            nextWaypoint: '용마산',
            etaSeconds: 0,
            phase: 'imminent',
            kind: 'intermediate',
            sentAt: NOW,
            pushId: 'p1',
          }),
        );
        // location gate 도달 전 SSoT gate가 block → checkSilentPushLocationGate 미호출.
        expect(mockCheckGate).not.toHaveBeenCalled();
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
      });

      it('mirror.alarmEvents에 같은 alarmId 결정됨 → fire 차단 (Gate A)', async () => {
        (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
          if (key === DESTINATION_KEY) return JSON.stringify(destStation);
          if (key === APNS_TOKEN_KEY) return DEFAULT_APNS_TOKEN;
          if (key === BACKEND_SSOT_MIRROR_KEY)
            return makeFreshMirror({
              alarmEvents: [
                {
                  alarmId: 'transfer:군자',
                  stationId: '군자',
                  type: 'transfer',
                  decidedAt: NOW,
                },
              ],
            });
          return null;
        });
        await handleSilentPush(
          bgTaskData({
            nextWaypoint: '군자',
            etaSeconds: 0,
            phase: 'imminent',
            kind: 'transfer',
            sentAt: NOW,
            pushId: 'p2',
          }),
        );
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
      });

      it('mirror 부재 → SSoT 게이트 graceful no-block → 후속 게이트로 진행', async () => {
        // 기본 mock(`(AsyncStorage.getItem ...) return null`)는 BACKEND_SSOT_MIRROR_KEY가 null이라
        // readBackendSsotMirror가 null → mirror-missing graceful pass.
        await handleSilentPush(
          bgTaskData({
            nextWaypoint: '강남',
            etaSeconds: 0,
            phase: 'imminent',
            kind: 'intermediate',
            sentAt: NOW,
            pushId: 'p3',
          }),
        );
        // 후속 location gate가 호출됐는지 — SSoT gate가 차단하지 않았다는 증거.
        expect(mockCheckGate).toHaveBeenCalled();
      });

      it('mirror stale(>180s) → SSoT 게이트 graceful no-block', async () => {
        (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
          if (key === DESTINATION_KEY) return JSON.stringify(destStation);
          if (key === APNS_TOKEN_KEY) return DEFAULT_APNS_TOKEN;
          if (key === BACKEND_SSOT_MIRROR_KEY)
            return makeFreshMirror({
              passedStations: ['용마산'],
              receivedAt: NOW - 200_000,
            });
          return null;
        });
        await handleSilentPush(
          bgTaskData({
            nextWaypoint: '용마산',
            etaSeconds: 0,
            phase: 'imminent',
            kind: 'intermediate',
            sentAt: NOW,
            pushId: 'p4',
          }),
        );
        // SSoT gate가 mirror-stale로 no-block — location gate가 호출됨.
        expect(mockCheckGate).toHaveBeenCalled();
      });
    });

    // #1572 (T9, ADR-017) — alarmEvents validator.
    describe('alarmEvents validator (#1572 T9)', () => {
      it('validSsotMirror: alarmEvents 정의된 valid 배열 → narrow 통과', () => {
        const result = validSsotMirror({
          ...validSsot,
          alarmEvents: [
            { alarmId: 'a', stationId: 'X', type: 'station-passed', decidedAt: 1 },
            { alarmId: 'b', stationId: 'Y', type: 'transfer', decidedAt: 2 },
          ],
        });
        expect(result?.alarmEvents).toHaveLength(2);
        expect(result?.alarmEvents?.[0].alarmId).toBe('a');
      });

      it('validSsotMirror: alarmEvents 비-array → undefined slot (전체 narrow는 통과)', () => {
        const result = validSsotMirror({ ...validSsot, alarmEvents: 'invalid' });
        expect(result).toBeDefined();
        expect(result?.alarmEvents).toBeUndefined();
      });

      it.each([
        ['alarmId missing', { stationId: 'X', type: 'station-passed', decidedAt: 1 }],
        ['empty alarmId', { alarmId: '', stationId: 'X', type: 'station-passed', decidedAt: 1 }],
        ['empty stationId', { alarmId: 'a', stationId: '', type: 'station-passed', decidedAt: 1 }],
        ['invalid type', { alarmId: 'a', stationId: 'X', type: 'unknown', decidedAt: 1 }],
        ['decidedAt non-number', { alarmId: 'a', stationId: 'X', type: 'station-passed', decidedAt: 'now' }],
        ['decidedAt NaN', { alarmId: 'a', stationId: 'X', type: 'station-passed', decidedAt: Number.NaN }],
        ['null entry', null],
      ])('validSsotMirror: alarmEvents 항목 mismatch %s → 항목 graceful drop', (_label, badEntry) => {
        const goodEntry = { alarmId: 'good', stationId: 'Y', type: 'transfer' as const, decidedAt: 5 };
        const result = validSsotMirror({
          ...validSsot,
          alarmEvents: [badEntry, goodEntry],
        });
        expect(result?.alarmEvents).toEqual([goodEntry]);
      });

      it('handleSilentPush persists alarmEvents in mirror when payload.ssot.alarmEvents present', async () => {
        (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
        (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);
        mockCheckGate.mockReturnValue({ allow: false, skip: 'gate-no-location' });
        const ssotWithEvents = {
          ...validSsot,
          alarmEvents: [
            { alarmId: 'aa', stationId: '교대', type: 'station-passed' as const, decidedAt: 1 },
          ],
        };
        await handleSilentPush(
          bgTaskData({
            nextWaypoint: '강남',
            etaSeconds: 0,
            phase: 'imminent',
            kind: 'intermediate',
            ssot: ssotWithEvents,
          }),
        );
        const mirrorCall = (AsyncStorage.setItem as jest.Mock).mock.calls.find(
          ([key]) => key === BACKEND_SSOT_MIRROR_KEY,
        );
        expect(mirrorCall).toBeDefined();
        const stored = JSON.parse(mirrorCall![1] as string);
        expect(stored.alarmEvents).toEqual(ssotWithEvents.alarmEvents);
      });
    });
  });
});
