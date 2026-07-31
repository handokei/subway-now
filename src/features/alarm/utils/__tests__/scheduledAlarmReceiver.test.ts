import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';

jest.mock('expo-notifications', () => ({
  addNotificationReceivedListener: jest.fn(),
  getPresentedNotificationsAsync: jest.fn(),
  cancelScheduledNotificationAsync: jest.fn(),
  // #1924 — suppress 분기가 delivered tray entry도 정리해 다음 FG 복귀 drain이
  // 같은 stale identifier를 다시 read 하지 않게 한다.
  dismissNotificationAsync: jest.fn(),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
}));

jest.mock('../notificationState', () => ({
  getFiredAlarms: jest.fn(),
  setFiredAlarms: jest.fn(),
  setLastFiredAlarmStationName: jest.fn(),
}));

const mockRecordFiredAlarm = jest.fn();
jest.mock('../prescheduledMetrics', () => ({
  recordFiredAlarm: (...args: unknown[]) => mockRecordFiredAlarm(...args),
}));

const mockGetTripStartedAt = jest.fn();
jest.mock('../tripStartStorage', () => ({
  getTripStartedAt: (...args: unknown[]) => mockGetTripStartedAt(...args),
}));

// #2089 — safetyNetScheduler의 waypoint 산출/알림 데이터 파싱은 mock으로 대체해 revalidate 로직만
// 검증한다. deriveSafetyNetWaypoints는 route/destination을 실제로 walk하지 않고 테스트가 직접
// 반환값을 제어 — waypoint mismatch 게이트를 결정적으로 테스트하기 위함.
const mockDeriveSafetyNetWaypoints = jest.fn();
const mockReadSafetyNetData = jest.fn();
jest.mock('../safetyNetScheduler', () => ({
  deriveSafetyNetWaypoints: (...args: unknown[]) => mockDeriveSafetyNetWaypoints(...args),
  readSafetyNetData: (...args: unknown[]) => mockReadSafetyNetData(...args),
}));

const mockLogSuppressedSafetyNetRevalidation = jest.fn();
jest.mock('../alarmLog', () => ({
  logSuppressedSafetyNetRevalidation: (...args: unknown[]) =>
    mockLogSuppressedSafetyNetRevalidation(...args),
}));

// #1704 — position-mismatch 게이트가 backend SSoT mirror를 read해 사용자 currentStation을 결정.
// 기본은 null 반환(mirror 부재 → 게이트 skip)으로 기존 테스트 동작 보존.
const mockReadBackendSsotMirror = jest.fn();
jest.mock('../backendSsotMirror', () => ({
  readBackendSsotMirror: (...args: unknown[]) => mockReadBackendSsotMirror(...args),
}));

const mockErrorSpy = jest.fn();
jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: (...args: unknown[]) => mockErrorSpy(...args),
  }),
}));

import {
  reconcileScheduledAlarmDelivery,
  registerScheduledAlarmListener,
  awaitInitialScheduledAlarmDrain,
} from '../scheduledAlarmReceiver';
import {
  getFiredAlarms,
  setFiredAlarms,
  setLastFiredAlarmStationName,
} from '../notificationState';
import type { SafetyNetNotificationData } from '../safetyNetScheduler';

const mockGetFiredAlarms = getFiredAlarms as jest.Mock;
const mockSetFiredAlarms = setFiredAlarms as jest.Mock;
const mockSetLastFiredAlarmStationName = setLastFiredAlarmStationName as jest.Mock;
const mockAddListener = Notifications.addNotificationReceivedListener as jest.Mock;
const mockGetPresented = Notifications.getPresentedNotificationsAsync as jest.Mock;
const mockCancelScheduled = Notifications.cancelScheduledNotificationAsync as jest.Mock;
const mockDismissNotification = Notifications.dismissNotificationAsync as jest.Mock;
const mockAsyncGetItem = AsyncStorage.getItem as jest.Mock;

const DEST_JSON = JSON.stringify({ id: 'dest-1', name: '강남' });
const ROUTE_JSON = JSON.stringify({ type: 'direct', stops: 1, line: '2', travelSeconds: 60 });
const TRIP_TOKEN = 'TOK-A';

const DEFAULT_PARSED: SafetyNetNotificationData = {
  channel: 'safety-net',
  tripToken: TRIP_TOKEN,
  station: '시청',
  kind: 'transfer',
  occurrenceIdx: 0,
};

const DEFAULT_WAYPOINTS = [
  { stationName: '시청', kind: 'transfer' as const, stops: 3, legMs: 60_000 },
  { stationName: '강남', kind: 'destination' as const, stops: 5, legMs: 60_000 },
];

function makeRequest(
  identifier: string,
  parsed: SafetyNetNotificationData | null,
): Notifications.NotificationRequest {
  return { identifier, content: { data: parsed } } as unknown as Notifications.NotificationRequest;
}

/**
 * AsyncStorage.getItem이 키별로 다른 값을 반환하도록 셋업한다 — 재검증 path는 ROUTE_KEY/
 * DESTINATION_KEY/ACTIVE_TRIP_KEY 세 키를 모두 읽기 때문.
 */
function setStorageMap(map: Record<string, string | null>): void {
  mockAsyncGetItem.mockImplementation(async (key: string) =>
    Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null,
  );
}

let appStateSpy: jest.SpyInstance;

beforeEach(async () => {
  jest.clearAllMocks();
  mockErrorSpy.mockClear();
  mockRecordFiredAlarm.mockReset();
  mockRecordFiredAlarm.mockResolvedValue(undefined);
  mockGetFiredAlarms.mockResolvedValue(new Set());
  mockSetFiredAlarms.mockResolvedValue(undefined);
  mockSetLastFiredAlarmStationName.mockResolvedValue(undefined);
  mockGetPresented.mockResolvedValue([]);
  setStorageMap({
    'subway-now:destination': DEST_JSON,
    'subway-now:route': ROUTE_JSON,
    'subway-now:active-trip': TRIP_TOKEN,
  });
  mockGetTripStartedAt.mockReset();
  mockGetTripStartedAt.mockResolvedValue(1_000_000);
  mockDeriveSafetyNetWaypoints.mockReset();
  mockDeriveSafetyNetWaypoints.mockReturnValue(DEFAULT_WAYPOINTS);
  mockReadSafetyNetData.mockReset();
  mockReadSafetyNetData.mockImplementation(
    (req: Notifications.NotificationRequest) =>
      (req.content.data as unknown as SafetyNetNotificationData | undefined) ?? null,
  );
  mockLogSuppressedSafetyNetRevalidation.mockReset();
  // #1704 — 기본은 mirror null (위치 게이트 skip → 기존 동작 유지). 새 테스트는 mockResolvedValue로 override.
  mockReadBackendSsotMirror.mockReset();
  mockReadBackendSsotMirror.mockResolvedValue(null);
  appStateSpy = jest
    .spyOn(AppState, 'addEventListener')
    .mockReturnValue({ remove: jest.fn() } as ReturnType<typeof AppState.addEventListener>);

  // singleton 가드 리셋: 이전 테스트의 모듈 등록 상태를 해제한다.
  mockAddListener.mockReturnValueOnce({ remove: jest.fn() });
  const handle = registerScheduledAlarmListener();
  await awaitInitialScheduledAlarmDrain();
  handle.remove();
  mockAddListener.mockReset();
  mockGetPresented.mockReset();
  mockGetFiredAlarms.mockReset();
  mockSetFiredAlarms.mockReset();
  mockSetLastFiredAlarmStationName.mockReset();
  mockErrorSpy.mockClear();
  mockGetFiredAlarms.mockResolvedValue(new Set());
  mockSetFiredAlarms.mockResolvedValue(undefined);
  mockSetLastFiredAlarmStationName.mockResolvedValue(undefined);
  mockGetPresented.mockResolvedValue([]);
  mockCancelScheduled.mockReset();
  mockCancelScheduled.mockResolvedValue(undefined);
  mockDismissNotification.mockReset();
  mockDismissNotification.mockResolvedValue(undefined);
  mockAddListener.mockReturnValue({ remove: jest.fn() });
});

afterEach(() => {
  appStateSpy.mockRestore();
});

describe('reconcileScheduledAlarmDelivery', () => {
  it('recordFiredAlarm은 항상 identifier + actualFireMs로 호출된다', async () => {
    await reconcileScheduledAlarmDelivery(makeRequest('id-1', DEFAULT_PARSED), 5_000);
    expect(mockRecordFiredAlarm).toHaveBeenCalledWith({ identifier: 'id-1', actualFireMs: 5_000 });
  });

  it('actualFireMs 미지정 시 Date.now() fallback', async () => {
    const spy = jest.spyOn(Date, 'now').mockReturnValue(9_999);
    await reconcileScheduledAlarmDelivery(makeRequest('id-1', DEFAULT_PARSED));
    expect(mockRecordFiredAlarm).toHaveBeenCalledWith({ identifier: 'id-1', actualFireMs: 9_999 });
    spy.mockRestore();
  });

  it('safety-net 데이터가 아니면(readSafetyNetData null) 이후 처리를 skip한다', async () => {
    mockReadSafetyNetData.mockReturnValue(null);
    await reconcileScheduledAlarmDelivery(makeRequest('other-app-notif', null));
    expect(mockGetFiredAlarms).not.toHaveBeenCalled();
    expect(mockSetLastFiredAlarmStationName).not.toHaveBeenCalled();
  });

  describe('revalidate pass — fired set/lastStationName 갱신', () => {
    it('pass 시 early+imminent 두 dedup key 모두 fired set에 추가', async () => {
      await reconcileScheduledAlarmDelivery(makeRequest('id-1', DEFAULT_PARSED));

      expect(mockSetFiredAlarms).toHaveBeenCalledWith(
        'dest-1',
        new Set(['early:시청', 'imminent:시청']),
      );
      expect(mockSetLastFiredAlarmStationName).toHaveBeenCalledWith('시청');
      expect(mockCancelScheduled).not.toHaveBeenCalled();
    });

    it('occurrenceIdx > 0이면 #n suffix가 붙은 dedup key로 저장', async () => {
      await reconcileScheduledAlarmDelivery(
        makeRequest('id-1', { ...DEFAULT_PARSED, occurrenceIdx: 2 }),
      );

      expect(mockSetFiredAlarms).toHaveBeenCalledWith(
        'dest-1',
        new Set(['early:시청#2', 'imminent:시청#2']),
      );
    });

    it('destination.id 필드만 없으면(name은 존재) fired set 갱신은 skip, lastStationName은 갱신', async () => {
      // destinationName은 revalidate(waypoint 매칭)에도 쓰이므로 destination 자체를 null로 두면
      // revalidate 단계에서 route-null과 동형으로 suppress된다 — id 필드만 누락시켜 두 관심사를 분리.
      setStorageMap({
        'subway-now:destination': JSON.stringify({ name: '강남' }),
        'subway-now:route': ROUTE_JSON,
        'subway-now:active-trip': TRIP_TOKEN,
      });

      await reconcileScheduledAlarmDelivery(makeRequest('id-1', DEFAULT_PARSED));

      expect(mockSetFiredAlarms).not.toHaveBeenCalled();
      expect(mockSetLastFiredAlarmStationName).toHaveBeenCalledWith('시청');
    });

    it('destination JSON 파싱 실패 시 destinationId null 취급', async () => {
      setStorageMap({
        'subway-now:destination': '{not json',
        'subway-now:route': ROUTE_JSON,
        'subway-now:active-trip': TRIP_TOKEN,
      });

      await reconcileScheduledAlarmDelivery(makeRequest('id-1', DEFAULT_PARSED));

      expect(mockSetFiredAlarms).not.toHaveBeenCalled();
    });

    it('destination.id가 string이 아니면 destinationId null 취급', async () => {
      setStorageMap({
        'subway-now:destination': JSON.stringify({ id: 42, name: '강남' }),
        'subway-now:route': ROUTE_JSON,
        'subway-now:active-trip': TRIP_TOKEN,
      });

      await reconcileScheduledAlarmDelivery(makeRequest('id-1', DEFAULT_PARSED));

      expect(mockSetFiredAlarms).not.toHaveBeenCalled();
    });
  });

  describe('revalidate suppress — cancel + dismiss + 상태 갱신 skip', () => {
    it('tripStart 없으면 revalidate-no-trip으로 suppress', async () => {
      mockGetTripStartedAt.mockResolvedValueOnce(null);

      await reconcileScheduledAlarmDelivery(makeRequest('id-1', DEFAULT_PARSED));

      expect(mockLogSuppressedSafetyNetRevalidation).toHaveBeenCalledWith({
        reason: 'revalidate-no-trip',
        stationName: '시청',
      });
      expect(mockCancelScheduled).toHaveBeenCalledWith('id-1');
      expect(mockDismissNotification).toHaveBeenCalledWith('id-1');
      expect(mockSetFiredAlarms).not.toHaveBeenCalled();
      expect(mockSetLastFiredAlarmStationName).not.toHaveBeenCalled();
    });

    it('ACTIVE_TRIP_KEY가 없으면 revalidate-trip-token-mismatch', async () => {
      setStorageMap({
        'subway-now:destination': DEST_JSON,
        'subway-now:route': ROUTE_JSON,
        'subway-now:active-trip': null,
      });

      await reconcileScheduledAlarmDelivery(makeRequest('id-1', DEFAULT_PARSED));

      expect(mockLogSuppressedSafetyNetRevalidation).toHaveBeenCalledWith({
        reason: 'revalidate-trip-token-mismatch',
        stationName: '시청',
      });
    });

    it('ACTIVE_TRIP_KEY가 parsed.tripToken과 다르면 revalidate-trip-token-mismatch', async () => {
      setStorageMap({
        'subway-now:destination': DEST_JSON,
        'subway-now:route': ROUTE_JSON,
        'subway-now:active-trip': 'DIFFERENT-TOKEN',
      });

      await reconcileScheduledAlarmDelivery(makeRequest('id-1', DEFAULT_PARSED));

      expect(mockLogSuppressedSafetyNetRevalidation).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'revalidate-trip-token-mismatch' }),
      );
    });

    it('destination 파싱 실패 시에도 revalidate-trip-token-mismatch로 suppress', async () => {
      setStorageMap({
        'subway-now:destination': '{not json',
        'subway-now:route': ROUTE_JSON,
        'subway-now:active-trip': TRIP_TOKEN,
      });

      await reconcileScheduledAlarmDelivery(makeRequest('id-1', DEFAULT_PARSED));

      expect(mockLogSuppressedSafetyNetRevalidation).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'revalidate-trip-token-mismatch' }),
      );
    });

    it('route 파싱 실패 시에도 revalidate-trip-token-mismatch로 suppress', async () => {
      setStorageMap({
        'subway-now:destination': DEST_JSON,
        'subway-now:route': '{not json',
        'subway-now:active-trip': TRIP_TOKEN,
      });

      await reconcileScheduledAlarmDelivery(makeRequest('id-1', DEFAULT_PARSED));

      expect(mockLogSuppressedSafetyNetRevalidation).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'revalidate-trip-token-mismatch' }),
      );
    });

    it('destination 자체가 없으면(raw null) revalidate-trip-token-mismatch로 suppress', async () => {
      setStorageMap({
        'subway-now:destination': null,
        'subway-now:route': ROUTE_JSON,
        'subway-now:active-trip': TRIP_TOKEN,
      });

      await reconcileScheduledAlarmDelivery(makeRequest('id-1', DEFAULT_PARSED));

      expect(mockLogSuppressedSafetyNetRevalidation).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'revalidate-trip-token-mismatch' }),
      );
    });

    it('route 자체가 없으면(raw null) revalidate-trip-token-mismatch로 suppress', async () => {
      setStorageMap({
        'subway-now:destination': DEST_JSON,
        'subway-now:route': null,
        'subway-now:active-trip': TRIP_TOKEN,
      });

      await reconcileScheduledAlarmDelivery(makeRequest('id-1', DEFAULT_PARSED));

      expect(mockLogSuppressedSafetyNetRevalidation).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'revalidate-trip-token-mismatch' }),
      );
    });

    it('destination.name 필드만 없으면(id는 존재) revalidate-trip-token-mismatch로 suppress', async () => {
      setStorageMap({
        'subway-now:destination': JSON.stringify({ id: 'dest-1' }),
        'subway-now:route': ROUTE_JSON,
        'subway-now:active-trip': TRIP_TOKEN,
      });

      await reconcileScheduledAlarmDelivery(makeRequest('id-1', DEFAULT_PARSED));

      expect(mockLogSuppressedSafetyNetRevalidation).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'revalidate-trip-token-mismatch' }),
      );
    });

    it('waypoint 시퀀스에 station+kind 매칭이 없으면 revalidate-waypoint-mismatch', async () => {
      mockDeriveSafetyNetWaypoints.mockReturnValueOnce([
        { stationName: '역삼', kind: 'transfer' as const, stops: 1, legMs: 1000 },
      ]);

      await reconcileScheduledAlarmDelivery(makeRequest('id-1', DEFAULT_PARSED));

      expect(mockLogSuppressedSafetyNetRevalidation).toHaveBeenCalledWith({
        reason: 'revalidate-waypoint-mismatch',
        stationName: '시청',
      });
    });

    it('같은 역명이지만 kind가 다르면 revalidate-waypoint-mismatch', async () => {
      mockDeriveSafetyNetWaypoints.mockReturnValueOnce([
        { stationName: '시청', kind: 'destination' as const, stops: 1, legMs: 1000 },
      ]);

      await reconcileScheduledAlarmDelivery(makeRequest('id-1', DEFAULT_PARSED));

      expect(mockLogSuppressedSafetyNetRevalidation).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'revalidate-waypoint-mismatch' }),
      );
    });
  });
});

describe('drainDeliveredScheduledAlarms (via registerScheduledAlarmListener)', () => {
  it('presented가 비어 있으면 아무 것도 하지 않는다', async () => {
    mockGetPresented.mockResolvedValueOnce([]);
    const handle = registerScheduledAlarmListener();
    await awaitInitialScheduledAlarmDrain();

    expect(mockSetFiredAlarms).not.toHaveBeenCalled();
    expect(mockSetLastFiredAlarmStationName).not.toHaveBeenCalled();
    handle.remove();
  });

  it('getPresentedNotificationsAsync 실패 시 error 로그 후 graceful 종료', async () => {
    mockGetPresented.mockRejectedValueOnce(new Error('os fail'));
    const handle = registerScheduledAlarmListener();
    await awaitInitialScheduledAlarmDrain();

    expect(mockErrorSpy).toHaveBeenCalled();
    expect(mockRecordFiredAlarm).not.toHaveBeenCalled();
    handle.remove();
  });

  it('safety-net 데이터가 아닌 항목은 skip', async () => {
    mockGetPresented.mockResolvedValueOnce([{ date: 1, request: makeRequest('other', null) }]);
    const handle = registerScheduledAlarmListener();
    await awaitInitialScheduledAlarmDrain();

    expect(mockSetFiredAlarms).not.toHaveBeenCalled();
    handle.remove();
  });

  it('date 필드 없으면 Date.now() fallback으로 recordFiredAlarm 기록', async () => {
    const spy = jest.spyOn(Date, 'now').mockReturnValue(7_000);
    mockGetPresented.mockResolvedValueOnce([
      { request: makeRequest('id-1', DEFAULT_PARSED) } as Notifications.Notification,
    ]);
    const handle = registerScheduledAlarmListener();
    await awaitInitialScheduledAlarmDrain();

    expect(mockRecordFiredAlarm).toHaveBeenCalledWith({ identifier: 'id-1', actualFireMs: 7_000 });
    spy.mockRestore();
    handle.remove();
  });

  it('pass 항목은 fired set에 누적 후 1회 write, suppress 항목은 cancel+dismiss', async () => {
    mockGetPresented.mockResolvedValueOnce([
      { date: 1, request: makeRequest('id-suppress', { ...DEFAULT_PARSED, station: '역삼' }) },
      { date: 2, request: makeRequest('id-pass', DEFAULT_PARSED) },
    ]);
    // 역삼은 DEFAULT_WAYPOINTS에 없음 → waypoint-mismatch suppress. 시청은 있음 → pass.
    const handle = registerScheduledAlarmListener();
    await awaitInitialScheduledAlarmDrain();

    expect(mockCancelScheduled).toHaveBeenCalledWith('id-suppress');
    expect(mockDismissNotification).toHaveBeenCalledWith('id-suppress');
    expect(mockSetFiredAlarms).toHaveBeenCalledTimes(1);
    expect(mockSetFiredAlarms).toHaveBeenCalledWith(
      'dest-1',
      new Set(['early:시청', 'imminent:시청']),
    );
    expect(mockSetLastFiredAlarmStationName).toHaveBeenCalledWith('시청');
    handle.remove();
  });

  it('destination.id 필드만 없으면(name은 존재) fired set write는 skip, lastStationName만 마지막 항목으로 갱신', async () => {
    setStorageMap({
      'subway-now:destination': JSON.stringify({ name: '강남' }),
      'subway-now:route': ROUTE_JSON,
      'subway-now:active-trip': TRIP_TOKEN,
    });
    mockGetPresented.mockResolvedValueOnce([
      { date: 1, request: makeRequest('id-1', DEFAULT_PARSED) },
      { date: 2, request: makeRequest('id-2', { ...DEFAULT_PARSED, station: '강남', kind: 'destination' }) },
    ]);

    const handle = registerScheduledAlarmListener();
    await awaitInitialScheduledAlarmDrain();

    expect(mockSetFiredAlarms).not.toHaveBeenCalled();
    expect(mockSetLastFiredAlarmStationName).toHaveBeenCalledWith('강남');
    handle.remove();
  });

  it('이미 fired set에 있는 key는 재적재하지 않고, firedChanged=false면 write도 skip', async () => {
    mockGetFiredAlarms.mockResolvedValueOnce(new Set(['early:시청', 'imminent:시청']));
    mockGetPresented.mockResolvedValueOnce([{ date: 1, request: makeRequest('id-1', DEFAULT_PARSED) }]);

    const handle = registerScheduledAlarmListener();
    await awaitInitialScheduledAlarmDrain();

    expect(mockSetFiredAlarms).not.toHaveBeenCalled();
    expect(mockSetLastFiredAlarmStationName).toHaveBeenCalledWith('시청');
    handle.remove();
  });
});

describe('registerScheduledAlarmListener', () => {
  it('중복 호출 시 첫 handle을 그대로 반환한다(멱등)', () => {
    const first = registerScheduledAlarmListener();
    const second = registerScheduledAlarmListener();
    expect(second).toBe(first);
    first.remove();
  });

  it('remove() 호출 시 두 구독 모두 remove + 재등록 가능', () => {
    const notifRemove = jest.fn();
    const stateRemove = jest.fn();
    mockAddListener.mockReturnValueOnce({ remove: notifRemove });
    appStateSpy.mockReturnValueOnce({ remove: stateRemove } as ReturnType<
      typeof AppState.addEventListener
    >);

    const handle = registerScheduledAlarmListener();
    handle.remove();

    expect(notifRemove).toHaveBeenCalled();
    expect(stateRemove).toHaveBeenCalled();

    // 재등록 가능 — singleton이 풀렸음을 확인.
    const next = registerScheduledAlarmListener();
    expect(next).not.toBe(handle);
    next.remove();
  });

  it('FG 수신 리스너가 notification.request로 reconcile을 호출한다', async () => {
    let capturedCb: ((n: Notifications.Notification) => void) | undefined;
    mockAddListener.mockImplementationOnce((cb: (n: Notifications.Notification) => void) => {
      capturedCb = cb;
      return { remove: jest.fn() };
    });
    const handle = registerScheduledAlarmListener();
    await awaitInitialScheduledAlarmDrain();

    capturedCb?.({
      date: 12_345,
      request: makeRequest('id-1', DEFAULT_PARSED),
    } as Notifications.Notification);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockRecordFiredAlarm).toHaveBeenCalledWith({ identifier: 'id-1', actualFireMs: 12_345 });
    handle.remove();
  });

  it('FG 수신 리스너: notification.date 없으면 Date.now() fallback', async () => {
    const spy = jest.spyOn(Date, 'now').mockReturnValue(8_888);
    let capturedCb: ((n: Notifications.Notification) => void) | undefined;
    mockAddListener.mockImplementationOnce((cb: (n: Notifications.Notification) => void) => {
      capturedCb = cb;
      return { remove: jest.fn() };
    });
    const handle = registerScheduledAlarmListener();
    await awaitInitialScheduledAlarmDrain();

    capturedCb?.({ request: makeRequest('id-1', DEFAULT_PARSED) } as Notifications.Notification);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockRecordFiredAlarm).toHaveBeenCalledWith({ identifier: 'id-1', actualFireMs: 8_888 });
    spy.mockRestore();
    handle.remove();
  });

  it("AppState 'active' 전환 시 drain을 재실행한다", async () => {
    let capturedListener: ((state: string) => void) | undefined;
    appStateSpy.mockImplementationOnce(((_event: string, cb: (state: string) => void) => {
      capturedListener = cb;
      return { remove: jest.fn() };
    }) as unknown as typeof AppState.addEventListener);
    mockGetPresented.mockResolvedValue([{ date: 1, request: makeRequest('id-1', DEFAULT_PARSED) }]);

    const handle = registerScheduledAlarmListener();
    await awaitInitialScheduledAlarmDrain();
    mockGetPresented.mockClear();

    capturedListener?.('active');
    await Promise.resolve();
    await Promise.resolve();

    expect(mockGetPresented).toHaveBeenCalledTimes(1);
    handle.remove();
  });

  it("AppState 'background' 전환 시 drain을 실행하지 않는다", async () => {
    let capturedListener: ((state: string) => void) | undefined;
    appStateSpy.mockImplementationOnce(((_event: string, cb: (state: string) => void) => {
      capturedListener = cb;
      return { remove: jest.fn() };
    }) as unknown as typeof AppState.addEventListener);

    const handle = registerScheduledAlarmListener();
    await awaitInitialScheduledAlarmDrain();
    mockGetPresented.mockClear();

    capturedListener?.('background');
    await Promise.resolve();

    expect(mockGetPresented).not.toHaveBeenCalled();
    handle.remove();
  });
});

describe('awaitInitialScheduledAlarmDrain', () => {
  it('리스너 미등록 상태에서는 즉시 resolve', async () => {
    await expect(awaitInitialScheduledAlarmDrain()).resolves.toBeUndefined();
  });
});

// #1704 — position-mismatch 게이트: 사용자 currentStation 대비 fire 대상이 N hop 이상
// 미래면 suppress. 2026-06-23 사용자 trip evidence(14:04 신촌 trip 중 종로3가/충정로 BG misfire,
// 14:18 합정 trip 등록 직후 공덕/군자 미리 fire)의 backstop.
describe('#1704 position-mismatch 게이트', () => {
  // 강남(2-022) → 시청(2-001) direct route on line 2 (21 hops via 외선/외부 순환).
  // 시청·강남·을지로4가 등 실 stations.json 데이터로 routeToWaypoints가 intermediate 시퀀스를 생성.
  const LONG_ROUTE_JSON = JSON.stringify({ type: 'direct', stops: 21, line: '2', travelSeconds: 1260 });
  const SICHEONG_DEST_JSON = JSON.stringify({ id: '2-001', name: '시청' });

  const makeMirror = (currentStationId: string, ageMs = 0) => ({
    currentStationId,
    motionState: 'moving' as const,
    lastAdvanceEvidence: 'test',
    lastAdvanceAt: Date.now() - ageMs,
    passedStations: [] as string[],
    receivedAt: Date.now() - ageMs,
  });

  beforeEach(() => {
    setStorageMap({
      'subway-now:destination': SICHEONG_DEST_JSON,
      'subway-now:route': LONG_ROUTE_JSON,
      'subway-now:active-trip': TRIP_TOKEN,
    });
    // waypoint mismatch 게이트를 우회 — 위치 게이트 검증만 목적.
    mockDeriveSafetyNetWaypoints.mockReturnValue([
      { stationName: '시청', kind: 'transfer' as const, stops: 21, legMs: 60_000 },
      { stationName: '강남', kind: 'transfer' as const, stops: 1, legMs: 60_000 },
    ]);
  });

  it.each([
    {
      label: '사용자 강남(2-022) + fire=시청(21 hop 미래) → suppress',
      mirrorStationId: '2-022',
      expectedReason: 'revalidate-position-mismatch' as const,
    },
    {
      label: '사용자 시청(2-001) + fire=시청 → currentName==targetName 즉시 pass',
      mirrorStationId: '2-001',
      expectedReason: null,
    },
    {
      label: '사용자 을지로4가(2-004, 시청 직전 3 hop) + fire=시청 → threshold 미만 pass',
      mirrorStationId: '2-004',
      expectedReason: null,
    },
  ])('$label', async ({ mirrorStationId, expectedReason }) => {
    mockReadBackendSsotMirror.mockResolvedValueOnce(makeMirror(mirrorStationId));

    await reconcileScheduledAlarmDelivery(makeRequest('id-1', DEFAULT_PARSED));

    if (expectedReason === null) {
      expect(mockLogSuppressedSafetyNetRevalidation).not.toHaveBeenCalled();
      expect(mockCancelScheduled).not.toHaveBeenCalled();
    } else {
      expect(mockLogSuppressedSafetyNetRevalidation).toHaveBeenCalledWith({
        reason: expectedReason,
        stationName: '시청',
      });
      expect(mockCancelScheduled).toHaveBeenCalledWith('id-1');
    }
  });

  it('mirror가 5분+ stale이고 sticky 부재 → 게이트 skip (보수 fallback)', async () => {
    mockReadBackendSsotMirror.mockResolvedValueOnce(makeMirror('2-022', 6 * 60 * 1_000));

    await reconcileScheduledAlarmDelivery(makeRequest('id-1', DEFAULT_PARSED));

    expect(mockLogSuppressedSafetyNetRevalidation).not.toHaveBeenCalled();
    expect(mockCancelScheduled).not.toHaveBeenCalled();
  });

  it('mirror 부재 + sticky 부재 → 게이트 skip (보수 fallback)', async () => {
    await reconcileScheduledAlarmDelivery(makeRequest('id-1', DEFAULT_PARSED));

    expect(mockLogSuppressedSafetyNetRevalidation).not.toHaveBeenCalled();
    expect(mockCancelScheduled).not.toHaveBeenCalled();
  });

  it('mirror stale이고 sticky 있으면 sticky로 fallback해 게이트 적용', async () => {
    setStorageMap({
      'subway-now:destination': SICHEONG_DEST_JSON,
      'subway-now:route': LONG_ROUTE_JSON,
      'subway-now:active-trip': TRIP_TOKEN,
      'subway-now:sticky-station': JSON.stringify({
        station: { id: '2-022', name: '강남', line: '2', lat: 37.5, lng: 127.0 },
        lockedAt: Date.now() - 1_000,
      }),
    });
    mockReadBackendSsotMirror.mockResolvedValueOnce(makeMirror('2-022', 10 * 60 * 1_000));

    await reconcileScheduledAlarmDelivery(makeRequest('id-1', DEFAULT_PARSED));

    expect(mockLogSuppressedSafetyNetRevalidation).toHaveBeenCalledWith({
      reason: 'revalidate-position-mismatch',
      stationName: '시청',
    });
  });

  it('mirror 부재 + sticky JSON 파손 → 게이트 skip (graceful)', async () => {
    setStorageMap({
      'subway-now:destination': SICHEONG_DEST_JSON,
      'subway-now:route': LONG_ROUTE_JSON,
      'subway-now:active-trip': TRIP_TOKEN,
      'subway-now:sticky-station': '{not json',
    });

    await reconcileScheduledAlarmDelivery(makeRequest('id-1', DEFAULT_PARSED));

    expect(mockLogSuppressedSafetyNetRevalidation).not.toHaveBeenCalled();
  });

  it('sticky에 station.id 필드 누락 → 게이트 skip (graceful)', async () => {
    setStorageMap({
      'subway-now:destination': SICHEONG_DEST_JSON,
      'subway-now:route': LONG_ROUTE_JSON,
      'subway-now:active-trip': TRIP_TOKEN,
      'subway-now:sticky-station': JSON.stringify({ station: { name: '강남' }, lockedAt: 0 }),
    });

    await reconcileScheduledAlarmDelivery(makeRequest('id-1', DEFAULT_PARSED));

    expect(mockLogSuppressedSafetyNetRevalidation).not.toHaveBeenCalled();
  });

  it('sticky에 station.id가 있지만 stations.json에 미존재 → 게이트 skip (graceful)', async () => {
    setStorageMap({
      'subway-now:destination': SICHEONG_DEST_JSON,
      'subway-now:route': LONG_ROUTE_JSON,
      'subway-now:active-trip': TRIP_TOKEN,
      'subway-now:sticky-station': JSON.stringify({
        station: { id: '__deleted_station__', name: '폐역', line: '2', lat: 0, lng: 0 },
        lockedAt: Date.now() - 1_000,
      }),
    });

    await reconcileScheduledAlarmDelivery(makeRequest('id-1', DEFAULT_PARSED));

    expect(mockLogSuppressedSafetyNetRevalidation).not.toHaveBeenCalled();
  });

  it('mirror.currentStationId가 stations.json에 없으면 sticky로 fallback', async () => {
    setStorageMap({
      'subway-now:destination': SICHEONG_DEST_JSON,
      'subway-now:route': LONG_ROUTE_JSON,
      'subway-now:active-trip': TRIP_TOKEN,
      'subway-now:sticky-station': JSON.stringify({
        station: { id: '2-022', name: '강남', line: '2', lat: 37.5, lng: 127.0 },
        lockedAt: Date.now() - 1_000,
      }),
    });
    mockReadBackendSsotMirror.mockResolvedValueOnce(makeMirror('__no_such_id__'));

    await reconcileScheduledAlarmDelivery(makeRequest('id-1', DEFAULT_PARSED));

    expect(mockLogSuppressedSafetyNetRevalidation).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'revalidate-position-mismatch' }),
    );
  });

  it('fire 대상이 route waypoint 시퀀스에 없으면 게이트 skip (route 외 역은 별 게이트 담당)', async () => {
    mockDeriveSafetyNetWaypoints.mockReturnValueOnce([
      { stationName: '서울대입구', kind: 'transfer' as const, stops: 1, legMs: 1000 },
      { stationName: '시청', kind: 'transfer' as const, stops: 1, legMs: 1000 },
    ]);
    mockReadBackendSsotMirror.mockResolvedValueOnce(makeMirror('2-022'));

    await reconcileScheduledAlarmDelivery(
      makeRequest('id-1', { ...DEFAULT_PARSED, station: '서울대입구' }),
    );

    // route는 강남→시청. 서울대입구는 line 2이지만 시청과 정반대 방향(외선) — routeToWaypoints는
    // currentStation=강남 → 시청 방향만 펼침 → 서울대입구는 시퀀스에 없음 → null → skip.
    expect(mockLogSuppressedSafetyNetRevalidation).not.toHaveBeenCalled();
  });

  it('revalidate 순서: tripStart 미존재면 position 게이트보다 먼저 revalidate-no-trip', async () => {
    mockGetTripStartedAt.mockResolvedValueOnce(null);
    mockReadBackendSsotMirror.mockResolvedValueOnce(makeMirror('2-022'));

    await reconcileScheduledAlarmDelivery(makeRequest('id-1', DEFAULT_PARSED));

    expect(mockLogSuppressedSafetyNetRevalidation).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'revalidate-no-trip' }),
    );
    expect(mockLogSuppressedSafetyNetRevalidation).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'revalidate-position-mismatch' }),
    );
  });

  describe('drainDeliveredScheduledAlarms — 위치 게이트', () => {
    it('suppress된 position-mismatch 항목은 fired set/lastStationName 갱신에서 제외', async () => {
      mockReadBackendSsotMirror
        .mockResolvedValueOnce(makeMirror('2-022')) // 강남 — 21 hop 미래 → suppress
        .mockResolvedValueOnce(makeMirror('2-004')); // 을지로4가 — 3 hop → pass
      mockGetPresented.mockResolvedValueOnce([
        { date: 1, request: makeRequest('id-suppress', DEFAULT_PARSED) },
        { date: 2, request: makeRequest('id-pass', { ...DEFAULT_PARSED, kind: 'transfer' }) },
      ]);

      const handle = registerScheduledAlarmListener();
      await awaitInitialScheduledAlarmDrain();

      expect(mockLogSuppressedSafetyNetRevalidation).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'revalidate-position-mismatch', stationName: '시청' }),
      );
      expect(mockCancelScheduled).toHaveBeenCalledWith('id-suppress');
      expect(mockSetFiredAlarms).toHaveBeenCalledWith(
        '2-001',
        new Set(['early:시청', 'imminent:시청']),
      );
      expect(mockSetLastFiredAlarmStationName).toHaveBeenCalledWith('시청');
      handle.remove();
    });
  });
});
