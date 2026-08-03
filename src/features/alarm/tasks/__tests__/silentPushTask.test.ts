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
const mockLogSilentPushSkipped = jest.fn();
const mockLogCrossTripMirrorSkip = jest.fn();
const mockLogBoardingPromptFired = jest.fn();
const mockLogCompanionAlarmFired = jest.fn();
const mockFlushAlarmLog = jest.fn().mockResolvedValue(undefined);
jest.mock('../../utils/alarmLog', () => ({
  logSilentPushReceived: (...args: unknown[]) => mockLogSilentPushReceived(...args),
  logSilentPushRescheduleReceived: (...args: unknown[]) =>
    mockLogSilentPushRescheduleReceived(...args),
  logSilentPushTripEndedReceived: (...args: unknown[]) =>
    mockLogSilentPushTripEndedReceived(...args),
  logSilentPushSkipped: (...args: unknown[]) => mockLogSilentPushSkipped(...args),
  logCrossTripMirrorSkip: (...args: unknown[]) => mockLogCrossTripMirrorSkip(...args),
  logBoardingPromptFired: (...args: unknown[]) => mockLogBoardingPromptFired(...args),
  logCompanionAlarmFired: (...args: unknown[]) => mockLogCompanionAlarmFired(...args),
  flushAlarmLog: () => mockFlushAlarmLog(),
}));

// #2067 (Phase 2-device, D3) — sleep-alarm-companion 수신 시 AlarmLocalAuthority가 단일 진입점.
// 기본은 sleepMode gate 통과 + dedup 미적중(fired=true)로 동작하도록 mock.
const mockFireCompanionAlarm = jest.fn().mockResolvedValue({ fired: true });
// #2089 리뷰 P1-1 — applyReschedule의 sleepMode 게이트가 readSleepMode를 경유. 기본은
// SLEEP_MODE_KEY storage seed(setStorage)를 그대로 읽도록 실제 semantics(JSON true 비교)로 위임.
const mockReadSleepMode = jest.fn(async () => {
  const raw = await (AsyncStorage.getItem as jest.Mock)(SLEEP_MODE_KEY);
  return raw === JSON.stringify(true);
});
jest.mock('../../utils/alarmLocalAuthority', () => ({
  fireCompanionAlarm: (...args: unknown[]) => mockFireCompanionAlarm(...args),
  readSleepMode: () => mockReadSleepMode(),
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
const mockGetCurrentTripCorrIdSync = jest.fn<string | null, []>(() => null);
jest.mock('../../../observability/utils/tripCorrId', () => ({
  getCurrentTripCorrIdSync: () => mockGetCurrentTripCorrIdSync(),
}));
const mockTriggerTripGroundTruthPrompt = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../debug/utils/triggerTripGroundTruthPrompt', () => ({
  triggerTripGroundTruthPrompt: (...args: unknown[]) =>
    mockTriggerTripGroundTruthPrompt(...args),
}));

// #574 P2e / #2069 — fired pushId dedup store. trip-ended dedup 기록도 이 store 공유.
const mockAddFiredPushId = jest.fn().mockResolvedValue(undefined);
jest.mock('../../utils/firedPushIds', () => ({
  addFiredPushId: (...args: unknown[]) => mockAddFiredPushId(...args),
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

// #698/#918 A3 PR4 → #2089 — 옛 bl/tba 이중 채널(rescheduleHopForLock/rescheduleTripBoundAlarm +
// cancelBlByStationPhase/cancelTbaByStationPhase)이 safetyNetScheduler 단일 채널로 통합됐다.
// reschedule 분기: rescheduleSafetyNetAlarm 1회. companion 발사 후 cleanup: cancelSafetyNetByStationKind 1회.
const mockRescheduleSafetyNetAlarm = jest.fn();
const mockCancelSafetyNetByStationKind = jest.fn().mockResolvedValue(undefined);
jest.mock('../../utils/safetyNetScheduler', () => ({
  rescheduleSafetyNetAlarm: (...args: unknown[]) => mockRescheduleSafetyNetAlarm(...args),
  cancelSafetyNetByStationKind: (...args: unknown[]) => mockCancelSafetyNetByStationKind(...args),
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

describe('silentPushTask', () => {
  // #2064 (Phase 1-device) — reschedule의 applyRescheduleBl(#698)만 boardingLock을 여전히 읽는다.
  // fire-path line 가드(#707)는 제거됐지만 reschedule bl 채널의 trainCode 매칭에는 lock이 필요.
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
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
      if (key === DESTINATION_KEY) return JSON.stringify(destStation);
      if (key === APNS_TOKEN_KEY) return DEFAULT_APNS_TOKEN;
      return null;
    });
    mockSendPushAck.mockResolvedValue({ ok: true });
    mockGetBoardingLock.mockResolvedValue(defaultBoardingLock);
    // #919 — recall trigger 기본 graceful skip.
    mockTriggerTripEndRecall.mockResolvedValue({ uploaded: false });
    // #698/#2089 — 기본 graceful: 1건 cancel + 1건 schedule. 개별 테스트에서 override.
    mockRescheduleSafetyNetAlarm.mockResolvedValue({ cancelled: 1, scheduled: 1 });
    // #1370 L4 — trip-ended OS queue cancel 기본 graceful (mockImplementation 잔류 차단).
    mockCancelTripBoundOsQueue.mockResolvedValue(undefined);
    // #919 / #1370 — clearAllMocks가 mockImplementation을 reset하지 않으므로 명시 복구.
    mockRunTripBoundCleanups.mockResolvedValue(undefined);
    // #2069 — trip-ended dedup 기록 기본값.
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

    // #2036 (Issue I γ) → #2067 (Phase 2-device D3) — sleep-alarm-companion silent push payload.
    describe('sleep-alarm-companion kind (#2067)', () => {
      it('정상 sleep-alarm-companion payload → SleepAlarmCompanionSilentPushPayload', () => {
        expect(
          extractPayload(
            bgTaskData({
              kind: 'sleep-alarm-companion',
              originStation: '성수',
              targetKind: 'transfer',
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
          kind: 'sleep-alarm-companion',
          originStation: '성수',
          targetKind: 'transfer',
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
              kind: 'sleep-alarm-companion',
              targetKind: 'transfer',
              nextLine: '2',
              nextStation: '뚝섬',
              tripToken: 'T',
            }),
          ),
        ).toBeNull();
        expect(
          extractPayload(
            bgTaskData({
              kind: 'sleep-alarm-companion',
              originStation: '',
              targetKind: 'transfer',
              nextLine: '2',
              nextStation: '뚝섬',
              tripToken: 'T',
            }),
          ),
        ).toBeNull();
      });

      it('targetKind 누락/유효하지 않은 값이면 null', () => {
        expect(
          extractPayload(
            bgTaskData({
              kind: 'sleep-alarm-companion',
              originStation: '성수',
              nextLine: '2',
              nextStation: '뚝섬',
              tripToken: 'T',
            }),
          ),
        ).toBeNull();
        expect(
          extractPayload(
            bgTaskData({
              kind: 'sleep-alarm-companion',
              originStation: '성수',
              targetKind: 'unknown-kind',
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
              kind: 'sleep-alarm-companion',
              originStation: '성수',
              targetKind: 'transfer',
              nextStation: '뚝섬',
              tripToken: 'T',
            }),
          ),
        ).toBeNull();
        expect(
          extractPayload(
            bgTaskData({
              kind: 'sleep-alarm-companion',
              originStation: '성수',
              targetKind: 'transfer',
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
              kind: 'sleep-alarm-companion',
              originStation: '성수',
              targetKind: 'transfer',
              nextLine: '2',
              tripToken: 'T',
            }),
          ),
        ).toBeNull();
        expect(
          extractPayload(
            bgTaskData({
              kind: 'sleep-alarm-companion',
              originStation: '성수',
              targetKind: 'transfer',
              nextLine: '2',
              nextStation: '',
              tripToken: 'T',
            }),
          ),
        ).toBeNull();
      });

      it('tripToken 누락/빈 문자열이면 null (식별자 필수)', () => {
        expect(
          extractPayload(
            bgTaskData({
              kind: 'sleep-alarm-companion',
              originStation: '성수',
              targetKind: 'transfer',
              nextLine: '2',
              nextStation: '뚝섬',
            }),
          ),
        ).toBeNull();
        expect(
          extractPayload(
            bgTaskData({
              kind: 'sleep-alarm-companion',
              originStation: '성수',
              targetKind: 'transfer',
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
              kind: 'sleep-alarm-companion',
              originStation: '성수',
              targetKind: 'destination',
              nextLine: '2',
              nextStation: '뚝섬',
              tripToken: 'T',
            }),
          ),
        ).toEqual({
          kind: 'sleep-alarm-companion',
          originStation: '성수',
          targetKind: 'destination',
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
              kind: 'sleep-alarm-companion',
              originStation: '성수',
              targetKind: 'transfer',
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
    it('error 있으면 즉시 종료', async () => {
      await handleSilentPush({ error: { message: 'boom' } });
      expect(mockLogSilentPushReceived).not.toHaveBeenCalled();
    });

    it('payload 없으면 skip', async () => {
      await handleSilentPush({ data: undefined });
      expect(mockLogSilentPushReceived).not.toHaveBeenCalled();
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
        // #2064 — releaseLock throw 이후에도 no-op skip 경로까지 도달 = 본 처리 흐름 차단되지 않음.
        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'legacy-station-kind-ignored' }),
        );
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
      expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
    });

    // #2064 (Phase 1-device) — 매역 알림 backend visible push 단일 채널 전환.
    // transfer/destination/intermediate kind는 device가 더 이상 로컬 알림을 발사하지 않는다
    // (fireWithGate 전체 삭제 — line 가드/lockless/SSoT 게이트/location 게이트/movement 게이트/
    // motion-stationary 게이트/dismiss-silence 게이트/FIRED_ALARMS dedup/channel-agnostic dedup
    // 전부 제거). 수신 자체(logSilentPushReceived)와 상태 sync(lockReleasedReason/LA/widget)는
    // 그대로 동작 — no-op이지 early-return이 아니다.
    describe('#2064 (Phase 1-device) — legacy station kind no-op', () => {
      it.each<['transfer' | 'destination' | 'intermediate', string]>([
        ['transfer', 'transfer'],
        ['destination', 'destination'],
        ['intermediate', 'station-passed'],
      ])('kind=%s → scheduleNotificationAsync 미호출 + logSilentPushSkipped(kind=%s, reason=legacy-station-kind-ignored)', async (kind, loggedKind) => {
        await handleSilentPush(
          payload({ kind, phase: 'imminent', nextWaypoint: '강남', pushId: `p-${kind}` }),
        );
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith({
          stationName: '강남',
          kind: loggedKind,
          phaseId: 'imminent',
          reason: 'legacy-station-kind-ignored',
        });
      });

      it('pushId + apnsToken 있으면 ackOutcome(skipped, legacy-station-kind-ignored) 전송', async () => {
        await handleSilentPush(
          payload({ kind: 'destination', phase: 'imminent', pushId: 'p-legacy' }),
        );
        expect(mockSendPushAck).toHaveBeenCalledWith(
          ackCall('p-legacy', 'skipped', 'legacy-station-kind-ignored'),
        );
      });

      it('logSilentPushReceived는 no-op 이전에 그대로 적재 (수신 자체는 유지)', async () => {
        await handleSilentPush(payload({ kind: 'transfer', phase: 'early' }));
        expect(mockLogSilentPushReceived).toHaveBeenCalledTimes(1);
      });

      it('finally 블록의 LA/widget refresh는 no-op 경로에서도 그대로 호출', async () => {
        await handleSilentPush(payload({ kind: 'intermediate', phase: 'imminent' }));
        expect(mockRefreshLa).toHaveBeenCalledTimes(1);
        expect(mockUpdateWidget).toHaveBeenCalledTimes(1);
      });

      it('lockReleasedReason sync는 no-op 이전에 그대로 수행', async () => {
        await handleSilentPush(
          payload({
            kind: 'destination',
            phase: 'imminent',
            lockReleasedReason: 'transfer',
          }),
        );
        expect(mockStoreReleaseLock).toHaveBeenCalledWith('transfer');
        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'legacy-station-kind-ignored' }),
        );
      });
    });

    describe('#568 P2b — push ACK', () => {
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
        // apnsToken이 null로 fallback돼도 no-op skip 처리(로그 적재)는 그대로 진행.
        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'legacy-station-kind-ignored' }),
        );
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
          // 모든 resolvePermissionMode 호출에서 throw (received + skipped 양쪽 ack).
          mockGetForegroundPermissions.mockRejectedValue(new Error('location-api-fail'));
          try {
            await handleSilentPush(
              payload({ kind: 'destination', phase: 'imminent', pushId: 'p-throw-perm' }),
            );
            // skipped(no-op) ack가 전송됐는지 확인 — permissionMode는 undefined여야 한다.
            const call = mockSendPushAck.mock.calls.find(
              (c: unknown[]) =>
                (c[0] as { pushId?: string }).pushId === 'p-throw-perm' &&
                (c[0] as { outcome?: string }).outcome === 'skipped',
            );
            expect(call).toBeDefined();
            // permissionMode가 undefined이므로 sendPushAck payload에 포함되지 않는다.
            expect((call![0] as Record<string, unknown>).permissionMode).toBeUndefined();
          } finally {
            // 기본 mock 복원 (다른 테스트에 영향 없도록) — assertion 실패로도 반드시 실행.
            mockGetForegroundPermissions.mockResolvedValue({ status: 'granted' });
          }
        });
      });
    });

    describe('#1370 L5 — silent push 도달 stamp (received outcome)', () => {
      // #2064 — fire-with-gate가 제거돼 후속 outcome은 항상 skipped(legacy-station-kind-ignored)다.
      // received ack가 그 이전에 먼저 발사된다는 순서 보장만 검증.
      it('standard payload + pushId + apnsToken 모두 있으면 no-op 평가 전 received ack 발사', async () => {
        await handleSilentPush(
          payload({ kind: 'destination', phase: 'imminent', pushId: 'p-recv' }),
        );
        // #1772 — received ack는 batteryState 포함. latencyMs는 sentAt 없으면 undefined.
        expect(mockSendPushAck).toHaveBeenCalledWith(
          expect.objectContaining(ackCall('p-recv', 'received')),
        );
        // 후속 outcome(skipped) ack도 그대로 발사 — 별개 호출.
        expect(mockSendPushAck).toHaveBeenCalledWith(
          ackCall('p-recv', 'skipped', 'legacy-station-kind-ignored'),
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
        const skippedCall = mockSendPushAck.mock.calls.find(
          (c: unknown[]) =>
            (c[0] as { pushId?: string }).pushId === 'p-fired-nobatt' &&
            (c[0] as { outcome?: string }).outcome === 'skipped',
        );
        expect(skippedCall).toBeDefined();
        expect((skippedCall![0] as { batteryState?: string }).batteryState).toBeUndefined();
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
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
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

      // #698 → #2089 — reschedule kind: safety-net 사전 예약 cancel + 재예약 적용.
      // 옛 bl/tba 이중 채널 + lock 필수 게이트 + channels 배열은 폐기됐다 — 단일
      // rescheduleSafetyNetAlarm(tripToken 기반 lockless) 호출로 통합.
      describe('applyReschedule (#698/#2089)', () => {
        const route = { type: 'direct', stops: 2, line: '2', travelSeconds: 240 };
        const TRIP_TOKEN = 'RESCHEDULE-TRIP-TOKEN';
        function setStorage(opts: {
          tripToken?: unknown;
          route?: unknown;
          destination?: unknown;
          sleepMode?: boolean;
        } = {}) {
          (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
            if (key === APNS_TOKEN_KEY) return DEFAULT_APNS_TOKEN;
            // #2089 리뷰 P1-1 — reschedule은 sleepMode ON일 때만 적용되므로 기본 seed는 ON.
            if (key === SLEEP_MODE_KEY) return JSON.stringify(opts.sleepMode ?? true);
            if (key === ACTIVE_TRIP_KEY)
              return opts.tripToken === undefined ? TRIP_TOKEN : opts.tripToken;
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

        it('route + destination + tripToken 모두 있으면 rescheduleSafetyNetAlarm 호출', async () => {
          setStorage();
          await handleSilentPush(
            reschedulePayload({ newArrivalTimeEpoch: 9_999_999_999_999 }),
          );
          expect(mockRescheduleSafetyNetAlarm).toHaveBeenCalledTimes(1);
          const arg = mockRescheduleSafetyNetAlarm.mock.calls[0][0];
          expect(arg.tripToken).toBe(TRIP_TOKEN);
          expect(arg.stationName).toBe('사가정');
          expect(arg.newArrivalMs).toBe(9_999_999_999_999);
          expect(arg.destinationName).toBe(destStation.name);
        });

        // #2089 리뷰 P1-1 — 일반 모드(sleepMode OFF)에서는 reschedule이 신규 안전망을
        // 만들지 못하게 게이트. 취침 OFF 토글 직후 도착한 reschedule push의 재생성도 차단.
        it('sleepMode OFF면 rescheduleSafetyNetAlarm 미호출 (P1-1)', async () => {
          setStorage({ sleepMode: false });
          await handleSilentPush(
            reschedulePayload({ newArrivalTimeEpoch: 9_999_999_999_999 }),
          );
          expect(mockRescheduleSafetyNetAlarm).not.toHaveBeenCalled();
          expect(mockLogSilentPushRescheduleReceived).toHaveBeenCalledTimes(1);
        });

        // #2112 — parseRoute/parseDestinationName의 JSON.parse catch 분기 결정 커버.
        it('route가 invalid JSON이면 호출 skip (parse catch)', async () => {
          setStorage();
          // setStorage는 값을 JSON.stringify로 감싸므로 invalid raw는 직접 override.
          const base = (AsyncStorage.getItem as jest.Mock).getMockImplementation()!;
          (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) =>
            key === ROUTE_KEY ? 'not-json{{' : base(key),
          );
          await handleSilentPush(
            reschedulePayload({ newArrivalTimeEpoch: 9_999_999_999_999 }),
          );
          expect(mockRescheduleSafetyNetAlarm).not.toHaveBeenCalled();
        });

        it('destination이 invalid JSON이면 호출 skip (parse catch)', async () => {
          setStorage();
          const base = (AsyncStorage.getItem as jest.Mock).getMockImplementation()!;
          (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) =>
            key === DESTINATION_KEY ? 'not-json{{' : base(key),
          );
          await handleSilentPush(
            reschedulePayload({ newArrivalTimeEpoch: 9_999_999_999_999 }),
          );
          expect(mockRescheduleSafetyNetAlarm).not.toHaveBeenCalled();
        });

        it('tripToken 없으면 호출 skip', async () => {
          setStorage({ tripToken: null });
          await handleSilentPush(
            reschedulePayload({ newArrivalTimeEpoch: 9_999_999_999_999 }),
          );
          expect(mockRescheduleSafetyNetAlarm).not.toHaveBeenCalled();
          // 로그/ack는 그대로 진행됐는지 확인
          expect(mockLogSilentPushRescheduleReceived).toHaveBeenCalledTimes(1);
        });

        it('route 없으면 skip', async () => {
          setStorage({ route: null });
          await handleSilentPush(
            reschedulePayload({ newArrivalTimeEpoch: 9_999_999_999_999 }),
          );
          expect(mockRescheduleSafetyNetAlarm).not.toHaveBeenCalled();
        });

        it('destination 없으면 skip', async () => {
          setStorage({ destination: null });
          await handleSilentPush(
            reschedulePayload({ newArrivalTimeEpoch: 9_999_999_999_999 }),
          );
          expect(mockRescheduleSafetyNetAlarm).not.toHaveBeenCalled();
        });

        it('route JSON 파싱 실패 시 skip — 예외 전파 안 함', async () => {
          (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
            if (key === APNS_TOKEN_KEY) return DEFAULT_APNS_TOKEN;
            if (key === ACTIVE_TRIP_KEY) return TRIP_TOKEN;
            if (key === DESTINATION_KEY) return JSON.stringify(destStation);
            if (key === ROUTE_KEY) return 'not-json';
            return null;
          });
          await handleSilentPush(
            reschedulePayload({ newArrivalTimeEpoch: 9_999_999_999_999 }),
          );
          expect(mockRescheduleSafetyNetAlarm).not.toHaveBeenCalled();
        });

        it('destination JSON 파싱 실패 시 skip', async () => {
          (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
            if (key === APNS_TOKEN_KEY) return DEFAULT_APNS_TOKEN;
            if (key === ACTIVE_TRIP_KEY) return TRIP_TOKEN;
            if (key === DESTINATION_KEY) return 'not-json';
            if (key === ROUTE_KEY) return JSON.stringify(route);
            return null;
          });
          await handleSilentPush(
            reschedulePayload({ newArrivalTimeEpoch: 9_999_999_999_999 }),
          );
          expect(mockRescheduleSafetyNetAlarm).not.toHaveBeenCalled();
        });

        it('destination.name 없는 경우 skip', async () => {
          setStorage({ destination: { id: 'x' } });
          await handleSilentPush(
            reschedulePayload({ newArrivalTimeEpoch: 9_999_999_999_999 }),
          );
          expect(mockRescheduleSafetyNetAlarm).not.toHaveBeenCalled();
        });

        it('newArrivalTimeEpoch가 과거이면 skip — rescheduleSafetyNetAlarm 미호출', async () => {
          setStorage();
          await handleSilentPush(
            reschedulePayload({ newArrivalTimeEpoch: 1 }),
          );
          expect(mockRescheduleSafetyNetAlarm).not.toHaveBeenCalled();
        });

        it('rescheduleSafetyNetAlarm throw 해도 ack/log는 그대로 진행', async () => {
          setStorage();
          mockRescheduleSafetyNetAlarm.mockRejectedValueOnce(new Error('boom'));
          await handleSilentPush(
            reschedulePayload({ pushId: 'rs-uuid', newArrivalTimeEpoch: 9_999_999_999_999 }),
          );
          expect(mockSendPushAck).toHaveBeenCalledWith(
            expect.objectContaining({ pushId: 'rs-uuid', outcome: 'fired', reason: 'reschedule-received' }),
          );
          expect(mockLogSilentPushRescheduleReceived).toHaveBeenCalledTimes(1);
        });

        // #1193 — 중복역 trip 정정. payload.occurrenceIdx를 그대로 forward.
        it('occurrenceIdx는 rescheduleSafetyNetAlarm으로 forward (#1193)', async () => {
          setStorage();
          await handleSilentPush(
            reschedulePayload({
              newArrivalTimeEpoch: 9_999_999_999_999,
              occurrenceIdx: 1,
            }),
          );
          expect(mockRescheduleSafetyNetAlarm).toHaveBeenCalledTimes(1);
          const arg = mockRescheduleSafetyNetAlarm.mock.calls[0][0];
          expect(arg.occurrenceIdx).toBe(1);
        });

        it('occurrenceIdx 누락 시 undefined로 전달 (클라가 0 fallback) (#1193)', async () => {
          setStorage();
          await handleSilentPush(
            reschedulePayload({ newArrivalTimeEpoch: 9_999_999_999_999 }),
          );
          expect(mockRescheduleSafetyNetAlarm).toHaveBeenCalledTimes(1);
          const arg = mockRescheduleSafetyNetAlarm.mock.calls[0][0];
          expect(arg.occurrenceIdx).toBeUndefined();
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
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
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
        // #2114 (방안 C′) — 두번째 인자로 종료 trip의 corrId snapshot 동봉.
        expect(mockSetTripEndedSentinel).toHaveBeenCalledWith(expect.any(Number), null);
      });

      // #2114 (방안 C′) — corrId snapshot이 non-null이면 sentinel에 함께 저장.
      it('#2114 — getCurrentTripCorrIdSync가 non-null이면 setTripEndedSentinel에 corrId 동봉', async () => {
        mockGetCurrentTripCorrIdSync.mockReturnValueOnce('corr-abc');
        await handleSilentPush(tripEndedPayload({ reason: 'expired' }));
        expect(mockSetTripEndedSentinel).toHaveBeenCalledWith(expect.any(Number), 'corr-abc');
      });

      // #2120 (#2114 근본 수리 Phase 2) — corrId 인스턴스 가드.
      describe('#2120 — corrId 인스턴스 가드', () => {
        it('payload.corrId와 device corrId가 둘 다 있는데 불일치하면 cleanup 전체 skip + reason=trip-ended-corr-mismatch', async () => {
          mockGetCurrentTripCorrIdSync.mockReturnValueOnce('device-corr');
          await handleSilentPush(
            tripEndedPayload({ pushId: 'te-corr', reason: 'expired', corrId: 'payload-corr' }),
          );
          expect(mockRunTripBoundCleanups).not.toHaveBeenCalled();
          expect(mockCancelTripBoundOsQueue).not.toHaveBeenCalled();
          expect(mockTriggerTripEndRecall).not.toHaveBeenCalled();
          expect(mockSetTripEndedSentinel).not.toHaveBeenCalled();
          expect(mockLogSilentPushSkipped).toHaveBeenCalledWith({
            stationName: 'trip-ended:expired',
            kind: undefined,
            reason: 'trip-ended-corr-mismatch',
          });
          expect(mockSendPushAck).toHaveBeenCalledWith({
            pushId: 'te-corr',
            token: DEFAULT_APNS_TOKEN,
            outcome: 'skipped',
            reason: expect.stringContaining('corr-mismatch') as unknown as string,
            permissionMode: 'always',
          });
        });

        it('payload.corrId와 device corrId가 일치하면 cleanup 정상 진행', async () => {
          mockGetCurrentTripCorrIdSync.mockReturnValue('same-corr');
          await handleSilentPush(
            tripEndedPayload({ reason: 'expired', corrId: 'same-corr' }),
          );
          expect(mockRunTripBoundCleanups).toHaveBeenCalledTimes(1);
        });

        it('payload.corrId가 없으면(구버전 backend) device corrId 조회 없이 cleanup 진행', async () => {
          mockGetCurrentTripCorrIdSync.mockReturnValueOnce('device-corr-unused');
          await handleSilentPush(tripEndedPayload({ reason: 'expired' }));
          expect(mockRunTripBoundCleanups).toHaveBeenCalledTimes(1);
          // 게이트 자체가 device corrId를 조회하지 않으므로 endedCorrIdSnapshot 캡처용
          // mockReturnValueOnce가 그대로 소비돼 sentinel에 전달된다 (혼동 방지 검증).
          expect(mockSetTripEndedSentinel).toHaveBeenCalledWith(
            expect.any(Number),
            'device-corr-unused',
          );
        });

        it('payload.corrId는 있지만 device corrId가 null이면(cache 미수화) cleanup 진행', async () => {
          mockGetCurrentTripCorrIdSync.mockReturnValue(null);
          await handleSilentPush(
            tripEndedPayload({ reason: 'expired', corrId: 'payload-corr' }),
          );
          expect(mockRunTripBoundCleanups).toHaveBeenCalledTimes(1);
        });
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
          // 다음 흐름(dedup 기록 + ack)은 그대로 진행.
          expect(mockAddFiredPushId).toHaveBeenCalledWith('te-uuid');
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

      // #2069 (Phase 3) — D11(구 sendTripEndedNotification/surfaceTripEnded) 제거. B12가 원격
      // alert push 단일 채널이라 로컬 알림 재생성이 없다. sentinel/cleanup 상태 정리는 그대로
      // 유지하고, pushId는 FIRED_PUSH_IDS에 무조건 기록(dedup 흔적만 남김 — hasFiredPushId 체크 없음).
      describe('#2069 (Phase 3) — trip-ended 로컬 알림 미발사, 상태 정리만 유지', () => {
        it('trip-ended 수신 시 로컬 알림(scheduleNotificationAsync) 미발사', async () => {
          await handleSilentPush(tripEndedPayload({ reason: 'destination-arrived' }));
          expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        });

        it('pushId 있으면 FIRED_PUSH_IDS에 기록(backend retry dedup)', async () => {
          await handleSilentPush(tripEndedPayload({ pushId: 'te-uuid' }));
          expect(mockAddFiredPushId).toHaveBeenCalledWith('te-uuid');
        });

        it('pushId 없으면 dedup 기록 안 함 — cleanup은 그대로', async () => {
          await handleSilentPush(tripEndedPayload());
          expect(mockAddFiredPushId).not.toHaveBeenCalled();
          expect(mockRunTripBoundCleanups).toHaveBeenCalledTimes(1);
        });

        it('tripToken mismatch로 cleanup skip 시 dedup 기록도 안 함', async () => {
          (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
            if (key === APNS_TOKEN_KEY) return DEFAULT_APNS_TOKEN;
            if (key === ACTIVE_TRIP_KEY) return 'NEW-TRIP-TOKEN';
            return null;
          });
          await handleSilentPush(
            tripEndedPayload({ pushId: 'te-uuid', tripToken: 'OLD-TRIP-TOKEN' }),
          );
          expect(mockAddFiredPushId).not.toHaveBeenCalled();
        });

        it('ack(fired, trip-ended:reason) 전송 — 알 수 없는 reason은 unknown으로 정규화', async () => {
          await handleSilentPush(tripEndedPayload({ pushId: 'te-uuid', reason: 'future-reason' }));
          expect(mockSendPushAck).toHaveBeenCalledWith({
            pushId: 'te-uuid',
            token: DEFAULT_APNS_TOKEN,
            outcome: 'fired',
            reason: 'trip-ended:unknown',
            permissionMode: 'always',
          });
        });
      });
    });

    // #2069 (Phase 3) — B8(silent fallback) 제거로 boarding-prompt local notification 발사
    // (D2, 구 fireBoardingPromptLocalNotification)이 사라졌다. B7 원격 alert push 단일 채널이며,
    // 이 kind가 BG task에 도달해도(롤아웃 중 구버전 backend 잔여 재시도 대비) no-op + 로그만 남긴다.
    describe('boarding-prompt kind (#2069 Phase 3) — remote-only no-op', () => {
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

      it('boarding-prompt 수신 → scheduleNotificationAsync 호출 안 함 (로컬 알림 미생성)', async () => {
        await handleSilentPush(boardingPromptPayload({ pushId: 'bp-1' }));
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        // standard 발사 경로도 호출되지 않아야 함.
        expect(mockLogSilentPushReceived).not.toHaveBeenCalled();
        expect(mockLogBoardingPromptFired).not.toHaveBeenCalled();
      });

      it('pushId 있으면 ack(skipped, boarding-prompt-remote-only) 전송', async () => {
        await handleSilentPush(boardingPromptPayload({ pushId: 'bp-1' }));
        expect(mockSendPushAck).toHaveBeenCalledWith({
          pushId: 'bp-1',
          token: DEFAULT_APNS_TOKEN,
          outcome: 'skipped',
          reason: 'boarding-prompt-remote-only',
          permissionMode: 'always',
        });
      });

      it('pushId 없으면 ack 호출 자체가 없음 (구 backend 호환)', async () => {
        await handleSilentPush(boardingPromptPayload());
        const firedCalls = mockSendPushAck.mock.calls.filter(
          (call) => (call[0] as { outcome?: string }).outcome === 'fired',
        );
        expect(firedCalls).toHaveLength(0);
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
      });

      // #1935 — silent push finally 블록에서 refreshLA는 항상 호출.
      it('boarding-prompt 수신 후에도 refreshLiveActivityFromBackgroundContext 1회 호출', async () => {
        await handleSilentPush(boardingPromptPayload({ pushId: 'bp-1' }));
        expect(mockRefreshLa).toHaveBeenCalledTimes(1);
      });

      it('hopEndKind=disembark 수신도 동일하게 no-op (로컬 알림 미생성)', async () => {
        await handleSilentPush(
          boardingPromptPayload({
            pushId: 'hop-1',
            hopEndKind: 'disembark',
            nextLine: 'K',
            nextStation: '왕십리',
          }),
        );
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        expect(mockSendPushAck).toHaveBeenCalledWith({
          pushId: 'hop-1',
          token: DEFAULT_APNS_TOKEN,
          outcome: 'skipped',
          reason: 'boarding-prompt-remote-only',
          permissionMode: 'always',
        });
      });
    });

    // #2036 (Issue I γ) → #2067 (Phase 2-device D3) — sleep-alarm-companion silent push:
    // AlarmLocalAuthority가 sleepMode gate + dedup ledger를 단일 진입점으로 담당(mock).
    // 본 describe는 handleSilentPush가 그 결과를 올바르게 소비/분기하는지만 검증한다.
    describe('sleep-alarm-companion kind (#2067) — 취침모드 companion 알람 채널', () => {
      function companionPayload(extra: Record<string, unknown> = {}) {
        return {
          data: {
            data: {
              data: {
                kind: 'sleep-alarm-companion',
                originStation: '성수',
                targetKind: 'transfer',
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

      beforeEach(() => {
        (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
          if (key === DESTINATION_KEY) return JSON.stringify(destStation);
          if (key === APNS_TOKEN_KEY) return DEFAULT_APNS_TOKEN;
          return null;
        });
        mockFireCompanionAlarm.mockResolvedValue({ fired: true });
      });

      it('수신 → fireCompanionAlarm에 tripToken/station/kind/body 전달', async () => {
        await handleSilentPush(companionPayload({ pushId: 'sta-1' }));
        expect(mockFireCompanionAlarm).toHaveBeenCalledWith({
          tripToken: 'tok-sta',
          station: '뚝섬',
          kind: 'transfer',
          body: '성수에서 2호선 뚝섬으로 환승',
        });
        // standard 발사 경로는 호출되지 않아야 함.
        expect(mockLogSilentPushReceived).not.toHaveBeenCalled();
      });

      it('body 지정 시 backend 문구 그대로 전달 (device fallback 미사용)', async () => {
        await handleSilentPush(
          companionPayload({ pushId: 'sta-1', body: '커스텀 문구' }),
        );
        expect(mockFireCompanionAlarm).toHaveBeenCalledWith(
          expect.objectContaining({ body: '커스텀 문구' }),
        );
      });

      it('targetKind=destination이면 kind=destination으로 전달', async () => {
        await handleSilentPush(
          companionPayload({ pushId: 'sta-1', targetKind: 'destination' }),
        );
        expect(mockFireCompanionAlarm).toHaveBeenCalledWith(
          expect.objectContaining({ kind: 'destination' }),
        );
      });

      it('fired=true → nextStation의 safety-net 사전 예약을 cancelSafetyNetByStationKind로 cancel (#2089)', async () => {
        // #1356 E1/#1355 D1 → #2089 — 옛 tba/bl 이중 채널 × ALARM_PHASES(early/imminent) fan-out은
        // 채널 통합으로 단일 kind 기준 1회 호출로 collapse됐다(occurrence 무관 전부 cancel).
        await handleSilentPush(companionPayload({ pushId: 'sta-1' }));
        expect(mockCancelSafetyNetByStationKind).toHaveBeenCalledTimes(1);
        expect(mockCancelSafetyNetByStationKind).toHaveBeenCalledWith('뚝섬', 'transfer');
      });

      it('fired=false(not-sleep-mode) → OS 안전망 cancel 안 함 + ack(skipped, not-sleep-mode)', async () => {
        mockFireCompanionAlarm.mockResolvedValueOnce({ fired: false, reason: 'not-sleep-mode' });
        await handleSilentPush(companionPayload({ pushId: 'sta-1' }));
        expect(mockCancelSafetyNetByStationKind).not.toHaveBeenCalled();
        expect(mockLogCompanionAlarmFired).not.toHaveBeenCalled();
        expect(mockSendPushAck).toHaveBeenCalledWith({
          pushId: 'sta-1',
          token: DEFAULT_APNS_TOKEN,
          outcome: 'skipped',
          reason: 'sleep-alarm-companion-not-sleep-mode',
          permissionMode: 'always',
        });
      });

      it('fired=false(dedup) → OS 안전망 cancel 안 함 + ack(skipped, dedup)', async () => {
        mockFireCompanionAlarm.mockResolvedValueOnce({ fired: false, reason: 'dedup' });
        await handleSilentPush(companionPayload({ pushId: 'sta-1' }));
        expect(mockCancelSafetyNetByStationKind).not.toHaveBeenCalled();
        expect(mockSendPushAck).toHaveBeenCalledWith({
          pushId: 'sta-1',
          token: DEFAULT_APNS_TOKEN,
          outcome: 'skipped',
          reason: 'sleep-alarm-companion-dedup',
          permissionMode: 'always',
        });
      });

      it('fired=true → logCompanionAlarmFired 호출 (Acceptance dashboard 반영)', async () => {
        await handleSilentPush(companionPayload({ pushId: 'sta-1' }));
        expect(mockLogCompanionAlarmFired).toHaveBeenCalledWith({
          originStation: '성수',
          nextStation: '뚝섬',
          nextLine: '2',
        });
      });

      it('pushId 있으면 ack(fired, sleep-alarm-companion) 전송', async () => {
        await handleSilentPush(companionPayload({ pushId: 'sta-1' }));
        expect(mockSendPushAck).toHaveBeenCalledWith({
          pushId: 'sta-1',
          token: DEFAULT_APNS_TOKEN,
          outcome: 'fired',
          reason: 'sleep-alarm-companion',
          permissionMode: 'always',
        });
      });

      it('pushId 없으면 fired ack 호출 안 함 (구 backend 호환) — 처리는 진행', async () => {
        await handleSilentPush(companionPayload());
        const firedCalls = mockSendPushAck.mock.calls.filter(
          (call) => (call[0] as { outcome?: string }).outcome === 'fired',
        );
        expect(firedCalls).toHaveLength(0);
        expect(mockFireCompanionAlarm).toHaveBeenCalledTimes(1);
      });

      it('domain breadcrumb 발사 (dashboard 관측)', async () => {
        await handleSilentPush(companionPayload({ pushId: 'sta-1' }));
        expect(mockAddDomainBreadcrumb).toHaveBeenCalledWith(
          'push',
          'sleep-alarm-companion-fired',
          { nextLine: '2', originStation: '성수', nextStation: '뚝섬' },
        );
      });

      it('fired=false 시에는 fired breadcrumb 발사 안 함', async () => {
        mockFireCompanionAlarm.mockResolvedValueOnce({ fired: false, reason: 'not-sleep-mode' });
        await handleSilentPush(companionPayload({ pushId: 'sta-1' }));
        expect(mockAddDomainBreadcrumb).not.toHaveBeenCalledWith(
          'push',
          'sleep-alarm-companion-fired',
          expect.anything(),
        );
      });

      it('sleep-alarm-companion 발사 후에도 refreshLiveActivityFromBackgroundContext 1회 호출 (#1935 정합)', async () => {
        await handleSilentPush(companionPayload({ pushId: 'sta-1' }));
        expect(mockRefreshLa).toHaveBeenCalledTimes(1);
      });

      it('skip 후에도 refreshLA 1회 호출 (#1935 정합)', async () => {
        mockFireCompanionAlarm.mockResolvedValueOnce({ fired: false, reason: 'not-sleep-mode' });
        await handleSilentPush(companionPayload({ pushId: 'sta-1' }));
        expect(mockRefreshLa).toHaveBeenCalledTimes(1);
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
    // 데이터 주도: 각 row가 (label, taskData)를 정의해 동일 assertion 반복.
    // #2064 — transfer/destination/intermediate는 모두 동일한 no-op skip 경로를 타므로
    // 세 kind 모두 포함해 no-op이 LA refresh를 막지 않음을 증명한다.
    const cases: Array<{ label: string; build: () => unknown }> = [
      { label: 'destination kind (no-op)', build: () => payload({ kind: 'destination' }) },
      { label: 'transfer kind (no-op)', build: () => payload({ kind: 'transfer' }) },
      { label: 'intermediate kind (no-op)', build: () => payload({ kind: 'intermediate' }) },
      { label: 'reschedule kind', build: () => payload({ kind: 'reschedule', nextStation: '강남', newArrivalTimeEpoch: 1, trainCode: 'T1' }) },
      { label: 'trip-ended kind', build: () => payload({ kind: 'trip-ended', reason: 'expired' }) },
      { label: 'payload missing(invalid)', build: () => ({ data: { data: { data: {}, dataString: null }, notification: null, aps: { 'content-available': 1 } } }) },
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
      // #2092 — station kind는 no-op skip(#2064)이므로 로컬 배너 0건. alert는 OS가 직접
      // 렌더하고, task는 content-available로 깨어나 mirror write만 수행한다 (이중 배너 없음).
      expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
    });

    it('handleSilentPush does not persist mirror when payload.ssot is absent', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
      (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);
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
