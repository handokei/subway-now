import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';

jest.mock('expo-notifications', () => ({
  addNotificationReceivedListener: jest.fn(),
  getPresentedNotificationsAsync: jest.fn(),
  cancelScheduledNotificationAsync: jest.fn(),
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

// #918 A3 PR2 — revalidation helpers. 기본값은 'pass' 경로(re-validation 통과 시 기존 동작 유지).
// 각 테스트에서 mockResolvedValueOnce로 override.
const mockGetTripStartedAt = jest.fn();
jest.mock('../tripStartStorage', () => ({
  getTripStartedAt: (...args: unknown[]) => mockGetTripStartedAt(...args),
}));

const mockGetRegisteredTripRouteSig = jest.fn();
jest.mock('../tripBoundScheduler', () => {
  // 실제 모듈의 TRIP_BOUND_ALARM_PREFIX/parseTripBoundAlarmIdentifier는 그대로 사용해야 한다.
  const actual = jest.requireActual('../tripBoundScheduler');
  return {
    ...actual,
    getRegisteredTripRouteSig: (...args: unknown[]) => mockGetRegisteredTripRouteSig(...args),
  };
});

const mockRouteSignature = jest.fn();
const mockGetRegisteredBlRouteSig = jest.fn();
jest.mock('../boardingLockScheduler', () => {
  const actual = jest.requireActual('../boardingLockScheduler');
  return {
    ...actual,
    routeSignature: (...args: unknown[]) => mockRouteSignature(...args),
    getRegisteredBlRouteSig: (...args: unknown[]) => mockGetRegisteredBlRouteSig(...args),
  };
});

const mockResolveAllTargets = jest.fn();
jest.mock('../stationAlarm', () => ({
  resolveAllTargets: (...args: unknown[]) => mockResolveAllTargets(...args),
  // #1367 — silent push 채널과 unified dedup key 공간. occurrenceIdx>0면 `#n` suffix.
  alarmKey: ({ phaseId, stationName, occurrenceIdx }: { phaseId: string; stationName: string; occurrenceIdx?: number }) => {
    const occ = occurrenceIdx ?? 0;
    const base = `${phaseId}:${stationName}`;
    return occ > 0 ? `${base}#${occ}` : base;
  },
}));

const mockLogSuppressedTbaRevalidation = jest.fn();
jest.mock('../alarmLog', () => ({
  logSuppressedTbaRevalidation: (...args: unknown[]) => mockLogSuppressedTbaRevalidation(...args),
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

const mockGetFiredAlarms = getFiredAlarms as jest.Mock;
const mockSetFiredAlarms = setFiredAlarms as jest.Mock;
const mockSetLastFiredAlarmStationName = setLastFiredAlarmStationName as jest.Mock;
const mockAddListener = Notifications.addNotificationReceivedListener as jest.Mock;
const mockGetPresented = Notifications.getPresentedNotificationsAsync as jest.Mock;
const mockCancelScheduled = Notifications.cancelScheduledNotificationAsync as jest.Mock;
const mockAsyncGetItem = AsyncStorage.getItem as jest.Mock;

const DEST_JSON = JSON.stringify({ id: 'dest-1', name: '강남' });
const ROUTE_JSON = JSON.stringify({ type: 'direct', stops: 1, line: '2', travelSeconds: 60 });

function flushAsync(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

/**
 * AsyncStorage.getItem이 키별로 다른 값을 반환하도록 셋업한다 — 재검증 path는 ROUTE_KEY/
 * DESTINATION_KEY 두 키를 모두 읽기 때문.
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
  mockAsyncGetItem.mockResolvedValue(DEST_JSON);
  // #918 A3 PR2 — 기본 mocks: tba 재검증 'pass' 경로 (tripStart 존재 + sig 일치 + waypoint 매칭).
  mockGetTripStartedAt.mockReset();
  mockGetTripStartedAt.mockResolvedValue(1_000_000);
  mockGetRegisteredTripRouteSig.mockReset();
  mockGetRegisteredTripRouteSig.mockResolvedValue('SIG-A');
  mockGetRegisteredBlRouteSig.mockReset();
  mockGetRegisteredBlRouteSig.mockResolvedValue('SIG-A');
  mockRouteSignature.mockReset();
  mockRouteSignature.mockReturnValue('SIG-A');
  mockResolveAllTargets.mockReset();
  mockResolveAllTargets.mockReturnValue([{ name: '강남' }, { name: '시청' }, { name: '서울역' }]);
  mockLogSuppressedTbaRevalidation.mockReset();
  // #1704 — 기본은 mirror null (위치 게이트 skip → 기존 동작 유지). 새 테스트는 mockResolvedValue로 override.
  mockReadBackendSsotMirror.mockReset();
  mockReadBackendSsotMirror.mockResolvedValue(null);
  // 기본 AppState 스파이 — 각 테스트는 mockImplementationOnce로 추가 override 가능.
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
  mockAsyncGetItem.mockResolvedValue(DEST_JSON);
  mockCancelScheduled.mockReset();
  mockCancelScheduled.mockResolvedValue(undefined);
  // 모든 케이스 공통: addNotificationReceivedListener 기본 핸들. 콜백 캡쳐가 필요한 케이스는 mockImplementationOnce로 override.
  mockAddListener.mockReturnValue({ remove: jest.fn() });
});

afterEach(() => {
  appStateSpy.mockRestore();
});

describe('reconcileScheduledAlarmDelivery', () => {
  it('alarm: prefix가 아닌 identifier는 무시한다', async () => {
    await reconcileScheduledAlarmDelivery('current-station');
    expect(mockSetFiredAlarms).not.toHaveBeenCalled();
    expect(mockSetLastFiredAlarmStationName).not.toHaveBeenCalled();
  });

  it('잘못된 포맷은 무시한다', async () => {
    await reconcileScheduledAlarmDelivery('alarm:onlyphase');
    expect(mockSetFiredAlarms).not.toHaveBeenCalled();
  });

  it('FIRED_ALARMS에 phase:station을 추가하고 LAST_FIRED_ALARM_STATION_NAME을 갱신한다', async () => {
    mockGetFiredAlarms.mockResolvedValueOnce(new Set(['early:시청']));

    await reconcileScheduledAlarmDelivery('alarm:early:강남');

    expect(mockGetFiredAlarms).toHaveBeenCalledWith('dest-1');
    expect(mockSetFiredAlarms).toHaveBeenCalledWith('dest-1', new Set(['early:시청', 'early:강남']));
    expect(mockSetLastFiredAlarmStationName).toHaveBeenCalledWith('강남');
  });

  it('destination 미설정(trip 종료)이면 firedAlarms는 갱신하지 않고 lastStationName만 갱신한다 (#462)', async () => {
    mockAsyncGetItem.mockResolvedValueOnce(null);

    await reconcileScheduledAlarmDelivery('alarm:early:강남');

    expect(mockGetFiredAlarms).not.toHaveBeenCalled();
    expect(mockSetFiredAlarms).not.toHaveBeenCalled();
    expect(mockSetLastFiredAlarmStationName).toHaveBeenCalledWith('강남');
  });

  it('destination JSON 파싱 실패도 firedAlarms 갱신 스킵 처리한다', async () => {
    mockAsyncGetItem.mockResolvedValueOnce('not-json');

    await reconcileScheduledAlarmDelivery('alarm:early:강남');

    expect(mockSetFiredAlarms).not.toHaveBeenCalled();
    expect(mockSetLastFiredAlarmStationName).toHaveBeenCalledWith('강남');
  });

  it('destination JSON에 id 필드가 없으면 firedAlarms 갱신 스킵', async () => {
    mockAsyncGetItem.mockResolvedValueOnce(JSON.stringify({ name: '강남' }));

    await reconcileScheduledAlarmDelivery('alarm:early:강남');

    expect(mockSetFiredAlarms).not.toHaveBeenCalled();
    expect(mockSetLastFiredAlarmStationName).toHaveBeenCalledWith('강남');
  });
});

describe('registerScheduledAlarmListener', () => {
  function captureAppStateHandler(): { getHandler: () => (state: string) => void } {
    let handler: ((state: string) => void) | undefined;
    appStateSpy.mockImplementation(((event, cb) => {
      if (event === 'change') handler = cb as (s: string) => void;
      return { remove: jest.fn() };
    }) as typeof AppState.addEventListener);
    return { getHandler: () => handler! };
  }

  it('등록 시점에 delivered 알람을 batch drain하고 fired set + last station을 한 번만 write한다', async () => {
    mockGetPresented.mockResolvedValueOnce([
      { request: { identifier: 'alarm:early:강남' } },
      { request: { identifier: 'current-station' } },
      { request: { identifier: 'alarm:imminent:강남' } },
    ]);

    const handle = registerScheduledAlarmListener();
    await awaitInitialScheduledAlarmDrain();
    await flushAsync();

    expect(mockGetFiredAlarms).toHaveBeenCalledWith('dest-1');
    expect(mockSetFiredAlarms).toHaveBeenCalledTimes(1);
    expect(mockSetFiredAlarms).toHaveBeenCalledWith('dest-1', new Set(['early:강남', 'imminent:강남']));
    expect(mockSetLastFiredAlarmStationName).toHaveBeenCalledTimes(1);
    expect(mockSetLastFiredAlarmStationName).toHaveBeenCalledWith('강남');

    handle.remove();
  });

  it('drain에 매칭되는 alarm이 없으면 write를 생략한다', async () => {
    mockGetPresented.mockResolvedValueOnce([{ request: { identifier: 'current-station' } }]);

    const handle = registerScheduledAlarmListener();
    await awaitInitialScheduledAlarmDrain();

    expect(mockSetFiredAlarms).not.toHaveBeenCalled();
    expect(mockSetLastFiredAlarmStationName).not.toHaveBeenCalled();

    handle.remove();
  });

  it('이미 fired set에 있는 키는 firedChanged를 트리거하지 않는다', async () => {
    mockGetPresented.mockResolvedValueOnce([{ request: { identifier: 'alarm:early:강남' } }]);
    mockGetFiredAlarms.mockResolvedValueOnce(new Set(['early:강남']));

    const handle = registerScheduledAlarmListener();
    await awaitInitialScheduledAlarmDrain();

    expect(mockSetFiredAlarms).not.toHaveBeenCalled();
    // lastStationName은 매칭되어 갱신.
    expect(mockSetLastFiredAlarmStationName).toHaveBeenCalledWith('강남');

    handle.remove();
  });

  it('알림 수신 콜백이 reconcile을 호출한다', async () => {
    mockAddListener.mockImplementationOnce((cb) => {
      void cb({ request: { identifier: 'alarm:imminent:시청' } });
      return { remove: jest.fn() };
    });

    const handle = registerScheduledAlarmListener();
    await flushAsync();

    expect(mockSetFiredAlarms).toHaveBeenCalledWith('dest-1', new Set(['imminent:시청']));
    expect(mockSetLastFiredAlarmStationName).toHaveBeenCalledWith('시청');

    handle.remove();
  });


  it('destinationId 미설정이면 drain은 fired set 갱신을 스킵하고 lastStationName만 갱신한다 (#462)', async () => {
    mockAsyncGetItem.mockResolvedValue(null);
    mockGetPresented.mockResolvedValueOnce([
      { request: { identifier: 'current-station' } },
      { request: { identifier: 'alarm:early:강남' } },
      { request: { identifier: 'alarm:imminent:시청' } },
    ]);

    const handle = registerScheduledAlarmListener();
    await awaitInitialScheduledAlarmDrain();

    expect(mockGetFiredAlarms).not.toHaveBeenCalled();
    expect(mockSetFiredAlarms).not.toHaveBeenCalled();
    expect(mockSetLastFiredAlarmStationName).toHaveBeenCalledWith('시청');

    handle.remove();
  });

  it('AppState change "active" 진입 시 delivered 알람을 다시 drain한다', async () => {
    const cap = captureAppStateHandler();

    const handle = registerScheduledAlarmListener();
    await awaitInitialScheduledAlarmDrain();
    mockGetPresented.mockResolvedValueOnce([{ request: { identifier: 'alarm:early:서울역' } }]);
    cap.getHandler()('active');
    await flushAsync();

    expect(mockSetLastFiredAlarmStationName).toHaveBeenCalledWith('서울역');

    handle.remove();
  });

  it('AppState change가 active가 아니면 drain하지 않는다', async () => {
    const cap = captureAppStateHandler();

    const handle = registerScheduledAlarmListener();
    await awaitInitialScheduledAlarmDrain();
    mockGetPresented.mockClear();
    cap.getHandler()('background');
    await flushAsync();

    expect(mockGetPresented).not.toHaveBeenCalled();

    handle.remove();
  });

  it('getPresentedNotificationsAsync가 던지면 error 로그를 남기고 계속한다', async () => {
    mockGetPresented.mockRejectedValueOnce(new Error('os 오류'));

    const handle = registerScheduledAlarmListener();
    await awaitInitialScheduledAlarmDrain();

    expect(mockErrorSpy).toHaveBeenCalled();
    expect(mockSetFiredAlarms).not.toHaveBeenCalled();

    handle.remove();
  });

  it('중복 호출은 idempotent — 첫 핸들을 그대로 반환한다', async () => {
    const h1 = registerScheduledAlarmListener();
    const h2 = registerScheduledAlarmListener();

    expect(h1).toBe(h2);
    expect(mockAddListener).toHaveBeenCalledTimes(1);

    h1.remove();
  });
});

describe('awaitInitialScheduledAlarmDrain', () => {
  it('리스너가 등록되지 않았으면 즉시 resolve한다', async () => {
    await expect(awaitInitialScheduledAlarmDrain()).resolves.toBeUndefined();
  });
});

describe('#918 A3 prescheduled fire ledger 기록', () => {
  it('drain 시 Notification.date를 actualFireMs로 전달 (BG 발사 시점 보존)', async () => {
    mockGetPresented.mockResolvedValueOnce([
      { date: 1234567890, request: { identifier: 'tba:early:강남' } },
    ]);

    const handle = registerScheduledAlarmListener();
    await awaitInitialScheduledAlarmDrain();

    expect(mockRecordFiredAlarm).toHaveBeenCalledWith({
      identifier: 'tba:early:강남',
      actualFireMs: 1234567890,
    });
    handle.remove();
  });

  it('drain 시 date가 number 아니면 Date.now() 폴백', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(999_999);
    mockGetPresented.mockResolvedValueOnce([
      { date: undefined, request: { identifier: 'tba:early:A' } },
    ]);

    const handle = registerScheduledAlarmListener();
    await awaitInitialScheduledAlarmDrain();

    expect(mockRecordFiredAlarm).toHaveBeenCalledWith({
      identifier: 'tba:early:A',
      actualFireMs: 999_999,
    });
    handle.remove();
    (Date.now as jest.Mock).mockRestore();
  });

  it('FG 수신 시 notification.date를 그대로 전달', async () => {
    mockAddListener.mockImplementationOnce((cb) => {
      cb({ date: 7777, request: { identifier: 'tba:early:Foo' } });
      return { remove: jest.fn() };
    });

    const handle = registerScheduledAlarmListener();
    await flushAsync();

    expect(mockRecordFiredAlarm).toHaveBeenCalledWith({
      identifier: 'tba:early:Foo',
      actualFireMs: 7777,
    });
    handle.remove();
  });

  it('FG 수신 시 date가 number 아니면 Date.now() 폴백', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(555);
    mockAddListener.mockImplementationOnce((cb) => {
      // date 누락
      cb({ request: { identifier: 'tba:early:Bar' } });
      return { remove: jest.fn() };
    });

    const handle = registerScheduledAlarmListener();
    await flushAsync();

    expect(mockRecordFiredAlarm).toHaveBeenCalledWith({
      identifier: 'tba:early:Bar',
      actualFireMs: 555,
    });
    handle.remove();
    (Date.now as jest.Mock).mockRestore();
  });
});

// #918 A3 PR2 (#729 흡수) — `tba:` 알람 fire-time 재검증.
describe('tba: fire-time 재검증 (#918 A3 PR2)', () => {
  beforeEach(() => {
    // ROUTE_KEY + DESTINATION_KEY 두 키 모두 읽기 — 매핑된 default를 셋업.
    setStorageMap({
      'subway-now:destination': DEST_JSON,
      'subway-now:route': ROUTE_JSON,
    });
  });

  describe('reconcileScheduledAlarmDelivery — `tba:` 단건', () => {
    it('재검증 통과 시 alarm: 경로와 동일하게 fired set + lastStationName을 갱신한다', async () => {
      mockGetFiredAlarms.mockResolvedValueOnce(new Set());

      await reconcileScheduledAlarmDelivery('tba:early:강남');

      expect(mockGetFiredAlarms).toHaveBeenCalledWith('dest-1');
      expect(mockSetFiredAlarms).toHaveBeenCalledWith('dest-1', new Set(['early:강남']));
      expect(mockSetLastFiredAlarmStationName).toHaveBeenCalledWith('강남');
      expect(mockLogSuppressedTbaRevalidation).not.toHaveBeenCalled();
    });

    // #1367 — occurrenceIdx>=1인 `tba:phase:station:n` identifier는 fired set에 `phase:station#n` 형식으로 등록.
    // silent push 채널과 unified dedup key 공간 공유 → 같은 hopIndex의 silent push가 dedup 적중.
    it('#1367 occurrenceIdx>=1 (`tba:phase:station:n`) → fired set에 `phase:station#n` 형식으로 등록', async () => {
      mockGetFiredAlarms.mockResolvedValueOnce(new Set());

      await reconcileScheduledAlarmDelivery('tba:early:강남:2');

      expect(mockSetFiredAlarms).toHaveBeenCalledWith('dest-1', new Set(['early:강남#2']));
      expect(mockSetLastFiredAlarmStationName).toHaveBeenCalledWith('강남');
    });

    it('tripStart 미존재 시 revalidate-no-trip 적재 후 상태 갱신 skip', async () => {
      mockGetTripStartedAt.mockResolvedValueOnce(null);

      await reconcileScheduledAlarmDelivery('tba:early:강남');

      expect(mockLogSuppressedTbaRevalidation).toHaveBeenCalledWith({
        reason: 'revalidate-no-trip',
        stationName: '강남',
        phaseId: 'early',
      });
      expect(mockSetFiredAlarms).not.toHaveBeenCalled();
      expect(mockSetLastFiredAlarmStationName).not.toHaveBeenCalled();
    });

    it('등록 시점 sig와 현재 sig 불일치 시 revalidate-route-sig-mismatch + skip', async () => {
      mockGetRegisteredTripRouteSig.mockResolvedValueOnce('SIG-OLD');
      mockRouteSignature.mockReturnValueOnce('SIG-NEW');

      await reconcileScheduledAlarmDelivery('tba:imminent:강남');

      expect(mockLogSuppressedTbaRevalidation).toHaveBeenCalledWith({
        reason: 'revalidate-route-sig-mismatch',
        stationName: '강남',
        phaseId: 'imminent',
      });
      expect(mockSetFiredAlarms).not.toHaveBeenCalled();
      expect(mockSetLastFiredAlarmStationName).not.toHaveBeenCalled();
    });

    it('등록된 sig가 null이면 sig-mismatch로 분류', async () => {
      mockGetRegisteredTripRouteSig.mockResolvedValueOnce(null);

      await reconcileScheduledAlarmDelivery('tba:early:강남');

      expect(mockLogSuppressedTbaRevalidation).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'revalidate-route-sig-mismatch' }),
      );
    });

    it('현재 sig가 null(route/destination 미설정)이면 sig-mismatch로 분류', async () => {
      mockRouteSignature.mockReturnValueOnce(null);

      await reconcileScheduledAlarmDelivery('tba:early:강남');

      expect(mockLogSuppressedTbaRevalidation).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'revalidate-route-sig-mismatch' }),
      );
    });

    it('stationName이 현재 waypoint 시퀀스에 없으면 revalidate-waypoint-mismatch + skip', async () => {
      // sig는 일치하지만 targets에 없는 역. 방어 검증 경로.
      mockResolveAllTargets.mockReturnValueOnce([{ name: '시청' }, { name: '서울역' }]);

      await reconcileScheduledAlarmDelivery('tba:early:강남');

      expect(mockLogSuppressedTbaRevalidation).toHaveBeenCalledWith({
        reason: 'revalidate-waypoint-mismatch',
        stationName: '강남',
        phaseId: 'early',
      });
      expect(mockSetFiredAlarms).not.toHaveBeenCalled();
      expect(mockSetLastFiredAlarmStationName).not.toHaveBeenCalled();
    });

    it('ROUTE_KEY JSON 파싱 실패 시 currentSig=null → sig-mismatch', async () => {
      setStorageMap({
        'subway-now:destination': DEST_JSON,
        'subway-now:route': 'not-json',
      });
      mockRouteSignature.mockReturnValueOnce(null);

      await reconcileScheduledAlarmDelivery('tba:early:강남');

      expect(mockLogSuppressedTbaRevalidation).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'revalidate-route-sig-mismatch' }),
      );
    });

    it('DESTINATION_KEY JSON 파싱 실패 시 currentSig=null → sig-mismatch', async () => {
      setStorageMap({
        'subway-now:destination': 'not-json',
        'subway-now:route': ROUTE_JSON,
      });
      mockRouteSignature.mockReturnValueOnce(null);

      await reconcileScheduledAlarmDelivery('tba:early:강남');

      expect(mockLogSuppressedTbaRevalidation).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'revalidate-route-sig-mismatch' }),
      );
    });

    it('ROUTE_KEY 미설정(null) → safeParseRoute=null → sig-mismatch', async () => {
      setStorageMap({
        'subway-now:destination': DEST_JSON,
        'subway-now:route': null,
      });
      mockRouteSignature.mockReturnValueOnce(null);

      await reconcileScheduledAlarmDelivery('tba:early:강남');

      expect(mockLogSuppressedTbaRevalidation).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'revalidate-route-sig-mismatch' }),
      );
    });

    it('tba: prefix는 매칭되지만 포맷 파손 시 parseAlarmIdentifier=null → no-op', async () => {
      // "tba:onlyphase" — 콜론 1개로 phaseId만 있고 stationName 부재. parseTripBoundAlarmIdentifier가
      // null을 반환해 reconcile 자체가 early return.
      await reconcileScheduledAlarmDelivery('tba:onlyphase');

      expect(mockGetTripStartedAt).not.toHaveBeenCalled();
      expect(mockLogSuppressedTbaRevalidation).not.toHaveBeenCalled();
      expect(mockSetFiredAlarms).not.toHaveBeenCalled();
    });

    it('DESTINATION_KEY에 name 필드가 없으면 currentSig=null → sig-mismatch', async () => {
      setStorageMap({
        'subway-now:destination': JSON.stringify({ id: 'x' }),
        'subway-now:route': ROUTE_JSON,
      });
      mockRouteSignature.mockReturnValueOnce(null);

      await reconcileScheduledAlarmDelivery('tba:early:강남');

      expect(mockLogSuppressedTbaRevalidation).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'revalidate-route-sig-mismatch' }),
      );
    });

    it('재검증 통과 + destinationId 미설정이면 lastStationName만 갱신', async () => {
      setStorageMap({
        'subway-now:destination': null,
        'subway-now:route': ROUTE_JSON,
      });

      await reconcileScheduledAlarmDelivery('tba:early:강남');

      expect(mockSetFiredAlarms).not.toHaveBeenCalled();
      expect(mockSetLastFiredAlarmStationName).toHaveBeenCalledWith('강남');
    });
  });

  describe('drainDeliveredScheduledAlarms — `tba:` 항목 재검증', () => {
    it('suppress된 tba 항목은 fired set/lastStationName 갱신에서 제외된다', async () => {
      // 첫 tba는 sig-mismatch로 suppress, 두 번째 tba는 pass.
      mockGetTripStartedAt.mockResolvedValue(1_000_000);
      mockGetRegisteredTripRouteSig
        .mockResolvedValueOnce('SIG-OLD') // 첫 항목 재검증
        .mockResolvedValueOnce('SIG-A'); // 두 번째 항목 재검증
      mockRouteSignature
        .mockReturnValueOnce('SIG-NEW')
        .mockReturnValueOnce('SIG-A');
      mockGetPresented.mockResolvedValueOnce([
        { date: 1, request: { identifier: 'tba:early:잘못된역' } },
        { date: 2, request: { identifier: 'tba:imminent:강남' } },
      ]);
      mockGetFiredAlarms.mockResolvedValueOnce(new Set());

      const handle = registerScheduledAlarmListener();
      await awaitInitialScheduledAlarmDrain();

      // suppress된 첫 항목 + pass된 두 번째 항목 — fired set엔 두 번째만.
      expect(mockSetFiredAlarms).toHaveBeenCalledWith('dest-1', new Set(['imminent:강남']));
      expect(mockSetLastFiredAlarmStationName).toHaveBeenCalledWith('강남');
      expect(mockLogSuppressedTbaRevalidation).toHaveBeenCalledWith(
        expect.objectContaining({ stationName: '잘못된역' }),
      );
      handle.remove();
    });

    it('모든 tba 항목이 suppress면 fired set/lastStationName 모두 갱신 안 함', async () => {
      mockGetTripStartedAt.mockResolvedValue(null);
      mockGetPresented.mockResolvedValueOnce([
        { date: 1, request: { identifier: 'tba:early:A' } },
        { date: 2, request: { identifier: 'tba:imminent:B' } },
      ]);

      const handle = registerScheduledAlarmListener();
      await awaitInitialScheduledAlarmDrain();

      expect(mockSetFiredAlarms).not.toHaveBeenCalled();
      expect(mockSetLastFiredAlarmStationName).not.toHaveBeenCalled();
      handle.remove();
    });

    it('`alarm:` 항목은 재검증 없이 그대로 통과한다', async () => {
      // tba가 섞여 있어도 alarm 경로는 재검증 우회.
      mockGetPresented.mockResolvedValueOnce([
        { date: 1, request: { identifier: 'alarm:early:강남' } },
      ]);
      mockGetFiredAlarms.mockResolvedValueOnce(new Set());

      const handle = registerScheduledAlarmListener();
      await awaitInitialScheduledAlarmDrain();

      expect(mockSetFiredAlarms).toHaveBeenCalledWith('dest-1', new Set(['early:강남']));
      expect(mockGetTripStartedAt).not.toHaveBeenCalled();
      expect(mockLogSuppressedTbaRevalidation).not.toHaveBeenCalled();
      handle.remove();
    });

    // #1367 — drain 경로도 occurrenceIdx>=1을 보존해 fired set에 `phase:station#n` 등록.
    it('#1367 drain — `tba:phase:station:n` (n>=1) → fired set에 `phase:station#n` 형식 등록', async () => {
      mockGetPresented.mockResolvedValueOnce([
        { date: 1, request: { identifier: 'tba:early:강남:3' } },
      ]);
      mockGetFiredAlarms.mockResolvedValueOnce(new Set());

      const handle = registerScheduledAlarmListener();
      await awaitInitialScheduledAlarmDrain();

      expect(mockSetFiredAlarms).toHaveBeenCalledWith('dest-1', new Set(['early:강남#3']));
      expect(mockSetLastFiredAlarmStationName).toHaveBeenCalledWith('강남');
      handle.remove();
    });

    it('재검증 통과 + destinationId 미설정 — pass된 tba 항목으로 lastStationName 갱신', async () => {
      setStorageMap({
        'subway-now:destination': null,
        'subway-now:route': ROUTE_JSON,
      });
      mockGetPresented.mockResolvedValueOnce([
        { date: 1, request: { identifier: 'tba:imminent:강남' } },
      ]);

      const handle = registerScheduledAlarmListener();
      await awaitInitialScheduledAlarmDrain();

      expect(mockSetFiredAlarms).not.toHaveBeenCalled();
      expect(mockSetLastFiredAlarmStationName).toHaveBeenCalledWith('강남');
      handle.remove();
    });
  });
});

// #1282 — `bl:` 사전 예약 알람 수신 재검증. tba:와 동형 게이트를 공유하므로 채널 config를
// 인자로 둔 it.each로 통합해 셋업 중복을 제거한다([[lesson_sonarcloud_dup_prevention]]).
describe('bl: fire-time 재검증 (#1282)', () => {
  // 채널별 차이만 캡슐화: identifier 빌더 + 등록 sig mock. waypoint/route-sig 게이트는 공통.
  const blChannel = {
    id: (phase: string, station: string) => `bl:T-100:0:${phase}:${station}`,
    registeredSigMock: mockGetRegisteredBlRouteSig,
  };

  beforeEach(() => {
    setStorageMap({
      'subway-now:destination': DEST_JSON,
      'subway-now:route': ROUTE_JSON,
    });
  });

  describe('reconcileScheduledAlarmDelivery — `bl:` 단건', () => {
    it('재검증 통과 시 alarm: 경로와 동일하게 fired set + lastStationName을 갱신한다', async () => {
      mockGetFiredAlarms.mockResolvedValueOnce(new Set());

      await reconcileScheduledAlarmDelivery(blChannel.id('early', '강남'));

      expect(mockGetFiredAlarms).toHaveBeenCalledWith('dest-1');
      expect(mockSetFiredAlarms).toHaveBeenCalledWith('dest-1', new Set(['early:강남']));
      expect(mockSetLastFiredAlarmStationName).toHaveBeenCalledWith('강남');
      expect(mockLogSuppressedTbaRevalidation).not.toHaveBeenCalled();
    });

    // suppress 분기 — reason별 셋업만 다르고 단언 패턴은 동일하므로 it.each로 통합.
    it.each([
      {
        name: 'bl sig와 현재 sig 불일치 → route-sig-mismatch',
        phase: 'imminent',
        setup: () => {
          blChannel.registeredSigMock.mockResolvedValueOnce('SIG-OLD');
          mockRouteSignature.mockReturnValueOnce('SIG-NEW');
        },
        reason: 'revalidate-route-sig-mismatch',
      },
      {
        name: '등록된 bl sig=null → route-sig-mismatch',
        phase: 'early',
        setup: () => blChannel.registeredSigMock.mockResolvedValueOnce(null),
        reason: 'revalidate-route-sig-mismatch',
      },
      {
        name: '현재 sig=null(route/destination 미설정) → route-sig-mismatch',
        phase: 'early',
        setup: () => mockRouteSignature.mockReturnValueOnce(null),
        reason: 'revalidate-route-sig-mismatch',
      },
      {
        name: 'stationName이 waypoint 시퀀스에 없음 → waypoint-mismatch',
        phase: 'early',
        setup: () => mockResolveAllTargets.mockReturnValueOnce([{ name: '시청' }, { name: '서울역' }]),
        reason: 'revalidate-waypoint-mismatch',
      },
    ])('$name → 적재 + 상태 갱신 skip', async ({ phase, setup, reason }) => {
      setup();

      await reconcileScheduledAlarmDelivery(blChannel.id(phase, '강남'));

      expect(mockLogSuppressedTbaRevalidation).toHaveBeenCalledWith({
        reason,
        stationName: '강남',
        phaseId: phase,
      });
      expect(mockSetFiredAlarms).not.toHaveBeenCalled();
      expect(mockSetLastFiredAlarmStationName).not.toHaveBeenCalled();
    });

    it('bl: prefix는 매칭되지만 포맷 파손 시 parseAlarmIdentifier=null → no-op', async () => {
      // "bl:T-100:0:bad:강남" — phase가 'bad'라 parseBoardingLockAlarmIdentifier가 null 반환.
      await reconcileScheduledAlarmDelivery('bl:T-100:0:bad:강남');

      expect(blChannel.registeredSigMock).not.toHaveBeenCalled();
      expect(mockSetFiredAlarms).not.toHaveBeenCalled();
    });

    it('재검증 통과 + destinationId 미설정이면 lastStationName만 갱신', async () => {
      setStorageMap({
        'subway-now:destination': null,
        'subway-now:route': ROUTE_JSON,
      });

      await reconcileScheduledAlarmDelivery(blChannel.id('early', '강남'));

      expect(mockSetFiredAlarms).not.toHaveBeenCalled();
      expect(mockSetLastFiredAlarmStationName).toHaveBeenCalledWith('강남');
    });

    // #1415/#1353 R1 — `bl:` 채널도 tripStart 게이트 적용 (revalidateBlAlarm requireTripStart=true).
    // 6/22 14:19 애오개 / 6/22 14:25 아현 / 6/19 15:51 용마산 stale fire 회귀의 핵심 backstop.
    it('R1 (#1415/#1353) tripStart 미존재 시 bl: 재검증은 revalidate-no-trip + skip', async () => {
      mockGetTripStartedAt.mockResolvedValueOnce(null);

      await reconcileScheduledAlarmDelivery(blChannel.id('imminent', '애오개'));

      expect(mockLogSuppressedTbaRevalidation).toHaveBeenCalledWith({
        reason: 'revalidate-no-trip',
        stationName: '애오개',
        phaseId: 'imminent',
      });
      expect(mockSetFiredAlarms).not.toHaveBeenCalled();
      expect(mockSetLastFiredAlarmStationName).not.toHaveBeenCalled();
      // suppress 결정 시 OS scheduled queue cancel(#1354)도 함께 트리거되어 영구 misfire 차단.
      expect(mockCancelScheduled).toHaveBeenCalledWith(blChannel.id('imminent', '애오개'));
    });

    it('R1 (#1415/#1353) tripStart 미존재 시 sig 검증보다 먼저 차단된다', async () => {
      // tripStart=null이면 sig 일치 여부와 무관하게 revalidate-no-trip 결정.
      mockGetTripStartedAt.mockResolvedValueOnce(null);
      blChannel.registeredSigMock.mockResolvedValueOnce('SIG-A');
      mockRouteSignature.mockReturnValueOnce('SIG-A');

      await reconcileScheduledAlarmDelivery(blChannel.id('early', '용마산'));

      expect(mockLogSuppressedTbaRevalidation).toHaveBeenCalledWith({
        reason: 'revalidate-no-trip',
        stationName: '용마산',
        phaseId: 'early',
      });
    });
  });

  describe('drainDeliveredScheduledAlarms — `bl:` 항목 재검증', () => {
    it('suppress된 bl 항목은 fired set/lastStationName 갱신에서 제외된다', async () => {
      // 첫 bl은 sig-mismatch로 suppress, 두 번째 bl은 pass.
      blChannel.registeredSigMock
        .mockResolvedValueOnce('SIG-OLD')
        .mockResolvedValueOnce('SIG-A');
      mockRouteSignature
        .mockReturnValueOnce('SIG-NEW')
        .mockReturnValueOnce('SIG-A');
      mockGetPresented.mockResolvedValueOnce([
        { date: 1, request: { identifier: blChannel.id('early', '잘못된역') } },
        { date: 2, request: { identifier: blChannel.id('imminent', '강남') } },
      ]);
      mockGetFiredAlarms.mockResolvedValueOnce(new Set());

      const handle = registerScheduledAlarmListener();
      await awaitInitialScheduledAlarmDrain();

      expect(mockSetFiredAlarms).toHaveBeenCalledWith('dest-1', new Set(['imminent:강남']));
      expect(mockSetLastFiredAlarmStationName).toHaveBeenCalledWith('강남');
      expect(mockLogSuppressedTbaRevalidation).toHaveBeenCalledWith(
        expect.objectContaining({ stationName: '잘못된역' }),
      );
      handle.remove();
    });

    it('모든 bl 항목이 suppress면 fired set/lastStationName 모두 갱신 안 함', async () => {
      blChannel.registeredSigMock.mockResolvedValue(null);
      mockGetPresented.mockResolvedValueOnce([
        { date: 1, request: { identifier: blChannel.id('early', 'A') } },
        { date: 2, request: { identifier: blChannel.id('imminent', 'B') } },
      ]);

      const handle = registerScheduledAlarmListener();
      await awaitInitialScheduledAlarmDrain();

      expect(mockSetFiredAlarms).not.toHaveBeenCalled();
      expect(mockSetLastFiredAlarmStationName).not.toHaveBeenCalled();
      handle.remove();
    });

    // #1415/#1353 R1 — drain 경로에서도 bl 채널의 tripStart 게이트 적용.
    it('R1 (#1415/#1353) drain — tripStart=null이면 모든 bl 항목 suppress + lastStationName 갱신 안 함', async () => {
      mockGetTripStartedAt.mockResolvedValue(null);
      mockGetPresented.mockResolvedValueOnce([
        { date: 1, request: { identifier: blChannel.id('imminent', '애오개') } },
        { date: 2, request: { identifier: blChannel.id('imminent', '아현') } },
      ]);

      const handle = registerScheduledAlarmListener();
      await awaitInitialScheduledAlarmDrain();

      expect(mockSetFiredAlarms).not.toHaveBeenCalled();
      expect(mockSetLastFiredAlarmStationName).not.toHaveBeenCalled();
      expect(mockLogSuppressedTbaRevalidation).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'revalidate-no-trip', stationName: '애오개' }),
      );
      expect(mockLogSuppressedTbaRevalidation).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'revalidate-no-trip', stationName: '아현' }),
      );
      handle.remove();
    });

    // 다른 prefix는 bl 재검증을 거치지 않아야 한다 — regression 방지를 it.each로 통합.
    it.each([
      { prefix: 'alarm:', identifier: 'alarm:early:강남' },
      { prefix: 'tba:', identifier: 'tba:early:강남' },
    ])('`$prefix` 항목은 bl 재검증과 무관하게 처리된다 — regression 방지', async ({ identifier }) => {
      mockGetPresented.mockResolvedValueOnce([{ date: 1, request: { identifier } }]);
      mockGetFiredAlarms.mockResolvedValueOnce(new Set());

      const handle = registerScheduledAlarmListener();
      await awaitInitialScheduledAlarmDrain();

      expect(mockSetFiredAlarms).toHaveBeenCalledWith('dest-1', new Set(['early:강남']));
      expect(blChannel.registeredSigMock).not.toHaveBeenCalled();
      handle.remove();
    });
  });
});

// #1704 — position-mismatch 게이트: 사용자 currentStation 대비 fire 대상이 N hop 이상
// 미래면 suppress. 2026-06-23 사용자 trip evidence(14:04 신촌 trip 중 종로3가/충정로 BG misfire,
// 14:18 합정 trip 등록 직후 공덕/군자 미리 fire)의 backstop.
describe('#1704 position-mismatch 게이트', () => {
  // 강남(2-022) → 시청(2-001) direct route on line 2 (21 hops via 외선/외부 순환).
  // 시청·강남·역삼·선릉 등 실 stations.json 데이터로 routeToWaypoints가 intermediate 시퀀스를 생성.
  const LONG_ROUTE_JSON = JSON.stringify({ type: 'direct', stops: 21, line: '2', travelSeconds: 1260 });
  const SIHCEONG_DEST_JSON = JSON.stringify({ id: '2-001', name: '시청' });

  // mirror fixture factory. dedup overhead 없이 source별 차이만 입력.
  // fresh=현재 시각 기준 receivedAt, stale=5+ min 이전 receivedAt.
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
      'subway-now:destination': SIHCEONG_DEST_JSON,
      'subway-now:route': LONG_ROUTE_JSON,
    });
    // 본 블록은 routeToWaypoints만 호출하는 위치 게이트를 검증.
    // resolveAllTargets mock은 waypoint mismatch 게이트가 통과되도록 fire 대상이 포함된 list로 변경.
    mockResolveAllTargets.mockReturnValue([
      { name: '시청' },
      { name: '강남' }, // 강남도 통과시켜 waypoint mismatch 차단 우회 (위치 게이트 검증 목적)
    ]);
  });

  // it.each + factory로 같은 패턴(mirror+identifier→expected reason) 반복 코드 dedup (SonarCloud).
  // pass 케이스는 reason 미발사 검증, suppress 케이스는 reason 검증 + cancel(#1354) 동반 검증.
  describe('reconcileScheduledAlarmDelivery — `tba:` 단건', () => {
    it.each([
      {
        label: '사용자 강남(2-022) + fire=시청(시청은 21 hop 미래) → suppress',
        mirrorStationId: '2-022',
        identifier: 'tba:early:시청',
        expectedReason: 'revalidate-position-mismatch' as const,
        expectedStationName: '시청',
        expectedPhase: 'early',
      },
      {
        label: '사용자 시청(2-001) + fire=시청 → currentName==targetName 즉시 pass',
        mirrorStationId: '2-001',
        identifier: 'tba:imminent:시청',
        expectedReason: null,
      },
      {
        label: '사용자 을지로4가(2-004, 시청 직전 3 hop) + fire=시청 → threshold 미만 pass',
        // 을지로4가=2-004 → 을지로3가(2-003) → 을지로입구(2-002) → 시청(2-001) = 3 hop.
        // POSITION_MISMATCH_HOP_THRESHOLD=5 미만이므로 pass.
        mirrorStationId: '2-004',
        identifier: 'tba:imminent:시청',
        expectedReason: null,
      },
    ])('$label', async ({ mirrorStationId, identifier, expectedReason, expectedStationName, expectedPhase }) => {
      mockReadBackendSsotMirror.mockResolvedValueOnce(makeMirror(mirrorStationId));

      await reconcileScheduledAlarmDelivery(identifier);

      if (expectedReason === null) {
        expect(mockLogSuppressedTbaRevalidation).not.toHaveBeenCalled();
        expect(mockCancelScheduled).not.toHaveBeenCalled();
      } else {
        expect(mockLogSuppressedTbaRevalidation).toHaveBeenCalledWith({
          reason: expectedReason,
          stationName: expectedStationName,
          phaseId: expectedPhase,
        });
        expect(mockCancelScheduled).toHaveBeenCalledWith(identifier);
      }
    });

    it('mirror가 5분+ stale이고 sticky 부재 → 게이트 skip (보수 fallback)', async () => {
      // mirror receivedAt이 6분 전 → POSITION_MISMATCH_MIRROR_STALE_MS(5분) 초과로 skip.
      // sticky storage 키도 부재.
      mockReadBackendSsotMirror.mockResolvedValueOnce(
        makeMirror('2-022', 6 * 60 * 1_000),
      );
      // 강남 위치 + 시청 fire는 원래라면 suppress 대상. mirror stale로 게이트 skip이라 pass.
      await reconcileScheduledAlarmDelivery('tba:early:시청');

      expect(mockLogSuppressedTbaRevalidation).not.toHaveBeenCalled();
      expect(mockCancelScheduled).not.toHaveBeenCalled();
    });

    it('mirror 부재 + sticky 부재 → 게이트 skip (보수 fallback)', async () => {
      // mockReadBackendSsotMirror 기본값 = null. sticky storage 키도 setStorageMap에 부재.
      await reconcileScheduledAlarmDelivery('tba:early:시청');

      expect(mockLogSuppressedTbaRevalidation).not.toHaveBeenCalled();
      expect(mockCancelScheduled).not.toHaveBeenCalled();
    });

    it('mirror stale이고 sticky 있으면 sticky로 fallback해 게이트 적용', async () => {
      // mirror stale + sticky=강남 → 강남 위치 fallback. fire=시청은 21 hop 미래 → suppress.
      setStorageMap({
        'subway-now:destination': SIHCEONG_DEST_JSON,
        'subway-now:route': LONG_ROUTE_JSON,
        'subway-now:sticky-station': JSON.stringify({
          station: { id: '2-022', name: '강남', line: '2', lat: 37.5, lng: 127.0 },
          lockedAt: Date.now() - 1_000,
        }),
      });
      mockReadBackendSsotMirror.mockResolvedValueOnce(
        makeMirror('2-022', 10 * 60 * 1_000), // 10 min stale
      );

      await reconcileScheduledAlarmDelivery('tba:early:시청');

      expect(mockLogSuppressedTbaRevalidation).toHaveBeenCalledWith({
        reason: 'revalidate-position-mismatch',
        stationName: '시청',
        phaseId: 'early',
      });
    });

    it('mirror 부재 + sticky JSON 파손 → 게이트 skip (graceful)', async () => {
      setStorageMap({
        'subway-now:destination': SIHCEONG_DEST_JSON,
        'subway-now:route': LONG_ROUTE_JSON,
        'subway-now:sticky-station': '{not json',
      });
      // mirror null + sticky parse fail → currentStation null → 게이트 skip.
      await reconcileScheduledAlarmDelivery('tba:early:시청');

      expect(mockLogSuppressedTbaRevalidation).not.toHaveBeenCalled();
    });

    it('sticky에 station.id 필드 누락 → 게이트 skip (graceful)', async () => {
      setStorageMap({
        'subway-now:destination': SIHCEONG_DEST_JSON,
        'subway-now:route': LONG_ROUTE_JSON,
        'subway-now:sticky-station': JSON.stringify({ station: { name: '강남' }, lockedAt: 0 }),
      });

      await reconcileScheduledAlarmDelivery('tba:early:시청');

      expect(mockLogSuppressedTbaRevalidation).not.toHaveBeenCalled();
    });

    it('sticky에 station.id가 있지만 stations.json에 미존재 → 게이트 skip (graceful)', async () => {
      // readStickyStation의 getStationById(id) ?? null 분기 cover.
      // 사용자 환경에서 stations.json 갱신으로 옛 sticky id가 무효화된 케이스.
      setStorageMap({
        'subway-now:destination': SIHCEONG_DEST_JSON,
        'subway-now:route': LONG_ROUTE_JSON,
        'subway-now:sticky-station': JSON.stringify({
          station: { id: '__deleted_station__', name: '폐역', line: '2', lat: 0, lng: 0 },
          lockedAt: Date.now() - 1_000,
        }),
      });

      await reconcileScheduledAlarmDelivery('tba:early:시청');

      // currentStation null → 게이트 skip → suppress 없음.
      expect(mockLogSuppressedTbaRevalidation).not.toHaveBeenCalled();
    });

    it('mirror.currentStationId가 stations.json에 없으면 sticky로 fallback', async () => {
      setStorageMap({
        'subway-now:destination': SIHCEONG_DEST_JSON,
        'subway-now:route': LONG_ROUTE_JSON,
        'subway-now:sticky-station': JSON.stringify({
          station: { id: '2-022', name: '강남', line: '2', lat: 37.5, lng: 127.0 },
          lockedAt: Date.now() - 1_000,
        }),
      });
      // mirror fresh이지만 currentStationId가 stations.json에 없는 ID — getStationById null → fallback.
      mockReadBackendSsotMirror.mockResolvedValueOnce(makeMirror('__no_such_id__'));

      await reconcileScheduledAlarmDelivery('tba:early:시청');

      // sticky=강남으로 fallback → 21 hop suppress.
      expect(mockLogSuppressedTbaRevalidation).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'revalidate-position-mismatch' }),
      );
    });

    it('fire 대상이 route waypoint 시퀀스에 없으면 게이트 skip (route 외 역은 별 게이트 담당)', async () => {
      // 사용자 강남, fire 대상은 route에 없는 '서울대입구' — routeToWaypoints에서 안 나옴 → null → skip.
      // 단 waypoint mismatch 게이트가 먼저 차단할 수 있으므로 mockResolveAllTargets에 '서울대입구' 포함.
      mockResolveAllTargets.mockReturnValueOnce([{ name: '서울대입구' }, { name: '시청' }]);
      mockReadBackendSsotMirror.mockResolvedValueOnce(makeMirror('2-022'));

      await reconcileScheduledAlarmDelivery('tba:early:서울대입구');

      // route는 강남→시청. 서울대입구는 line 2이지만 시청과 정반대 방향 (외선). routeToWaypoints는
      // currentStation=강남 → 시청 방향만 펼침 → 서울대입구는 시퀀스에 없음 → null → skip.
      expect(mockLogSuppressedTbaRevalidation).not.toHaveBeenCalled();
    });
  });

  describe('drainDeliveredScheduledAlarms — `tba:` 항목 위치 게이트', () => {
    it('suppress된 position-mismatch 항목은 fired set/lastStationName 갱신에서 제외', async () => {
      // 첫 항목 suppress (강남 위치+시청 fire, 21 hop), 두 번째 항목 pass (을지로4가 위치+시청 fire, 3 hop).
      mockReadBackendSsotMirror
        .mockResolvedValueOnce(makeMirror('2-022')) // 강남
        .mockResolvedValueOnce(makeMirror('2-004')); // 을지로4가
      mockGetPresented.mockResolvedValueOnce([
        { date: 1, request: { identifier: 'tba:early:시청' } },
        { date: 2, request: { identifier: 'tba:imminent:시청' } },
      ]);
      mockGetFiredAlarms.mockResolvedValueOnce(new Set());

      const handle = registerScheduledAlarmListener();
      await awaitInitialScheduledAlarmDrain();

      // 첫 항목(강남 위치) suppress + cancel. 두 번째 항목(을지로4가 위치) pass → fired set에 등록.
      expect(mockLogSuppressedTbaRevalidation).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'revalidate-position-mismatch', stationName: '시청' }),
      );
      expect(mockCancelScheduled).toHaveBeenCalledWith('tba:early:시청');
      // 두 번째(pass)만 fired set에 등록. destinationId='2-001' (SIHCEONG_DEST_JSON).
      expect(mockSetFiredAlarms).toHaveBeenCalledWith('2-001', new Set(['imminent:시청']));
      expect(mockSetLastFiredAlarmStationName).toHaveBeenCalledWith('시청');
      handle.remove();
    });
  });

  describe('revalidate 순서: position-mismatch는 다른 게이트 통과 후 진입', () => {
    it('tripStart 미존재면 position 게이트보다 먼저 revalidate-no-trip', async () => {
      mockGetTripStartedAt.mockResolvedValueOnce(null);
      // mirror도 fresh이지만 tripStart 없음이 우선 차단.
      mockReadBackendSsotMirror.mockResolvedValueOnce(makeMirror('2-022'));

      await reconcileScheduledAlarmDelivery('tba:early:시청');

      expect(mockLogSuppressedTbaRevalidation).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'revalidate-no-trip' }),
      );
      // position-mismatch는 발사 안 함.
      expect(mockLogSuppressedTbaRevalidation).not.toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'revalidate-position-mismatch' }),
      );
    });

    it('route-sig mismatch면 position 게이트보다 먼저 revalidate-route-sig-mismatch', async () => {
      mockGetRegisteredTripRouteSig.mockResolvedValueOnce('SIG-OLD');
      mockRouteSignature.mockReturnValueOnce('SIG-NEW');
      mockReadBackendSsotMirror.mockResolvedValueOnce(makeMirror('2-022'));

      await reconcileScheduledAlarmDelivery('tba:early:시청');

      expect(mockLogSuppressedTbaRevalidation).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'revalidate-route-sig-mismatch' }),
      );
      expect(mockLogSuppressedTbaRevalidation).not.toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'revalidate-position-mismatch' }),
      );
    });

    it('waypoint mismatch면 position 게이트보다 먼저 revalidate-waypoint-mismatch', async () => {
      // mockResolveAllTargets에 '시청' 누락 → waypoint mismatch 먼저 차단.
      mockResolveAllTargets.mockReturnValueOnce([{ name: '강남' }, { name: '역삼' }]);
      mockReadBackendSsotMirror.mockResolvedValueOnce(makeMirror('2-022'));

      await reconcileScheduledAlarmDelivery('tba:early:시청');

      expect(mockLogSuppressedTbaRevalidation).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'revalidate-waypoint-mismatch' }),
      );
      expect(mockLogSuppressedTbaRevalidation).not.toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'revalidate-position-mismatch' }),
      );
    });
  });

  describe('bl: 채널도 동일 게이트 적용', () => {
    it('bl: identifier에도 position-mismatch 적용 (revalidateBlAlarm 공유 helper)', async () => {
      mockReadBackendSsotMirror.mockResolvedValueOnce(makeMirror('2-022'));
      // bl: identifier 포맷은 `bl:trainCode:hopIdx:phase:stationName`.
      await reconcileScheduledAlarmDelivery('bl:T-100:0:early:시청');

      expect(mockLogSuppressedTbaRevalidation).toHaveBeenCalledWith({
        reason: 'revalidate-position-mismatch',
        stationName: '시청',
        phaseId: 'early',
      });
    });
  });
});

// #1354 — suppress 결정 시 OS scheduled queue cancel. 안 그러면 같은 identifier가 잔존해
// 다음 ETA마다 다시 fire → 영구 misfire 재발 (dump A/B evidence).
describe('#1354 suppress 시 OS scheduled queue cancel', () => {
  beforeEach(() => {
    setStorageMap({
      'subway-now:destination': DEST_JSON,
      'subway-now:route': ROUTE_JSON,
    });
  });

  it('reconcileScheduledAlarmDelivery suppress 시 cancelScheduledNotificationAsync(identifier) 1회 호출', async () => {
    mockGetRegisteredTripRouteSig.mockResolvedValueOnce('SIG-OLD');
    mockRouteSignature.mockReturnValueOnce('SIG-NEW');

    await reconcileScheduledAlarmDelivery('tba:imminent:강남');

    expect(mockCancelScheduled).toHaveBeenCalledTimes(1);
    expect(mockCancelScheduled).toHaveBeenCalledWith('tba:imminent:강남');
  });

  it('drainDeliveredScheduledAlarms 5건 중 3건 suppress 시 cancel 3회 + accepted 2건', async () => {
    // 첫 3건 suppress (sig mismatch), 마지막 2건 pass.
    mockGetRegisteredTripRouteSig
      .mockResolvedValueOnce('SIG-OLD') // suppress
      .mockResolvedValueOnce('SIG-OLD') // suppress
      .mockResolvedValueOnce('SIG-OLD') // suppress
      .mockResolvedValueOnce('SIG-A') // pass
      .mockResolvedValueOnce('SIG-A'); // pass
    mockRouteSignature
      .mockReturnValueOnce('SIG-NEW')
      .mockReturnValueOnce('SIG-NEW')
      .mockReturnValueOnce('SIG-NEW')
      .mockReturnValueOnce('SIG-A')
      .mockReturnValueOnce('SIG-A');
    mockGetPresented.mockResolvedValueOnce([
      { date: 1, request: { identifier: 'tba:early:성수' } },
      { date: 2, request: { identifier: 'tba:imminent:성수' } },
      { date: 3, request: { identifier: 'tba:early:왕십리' } },
      { date: 4, request: { identifier: 'tba:imminent:강남' } },
      { date: 5, request: { identifier: 'tba:early:시청' } },
    ]);
    mockGetFiredAlarms.mockResolvedValueOnce(new Set());

    const handle = registerScheduledAlarmListener();
    await awaitInitialScheduledAlarmDrain();

    expect(mockCancelScheduled).toHaveBeenCalledTimes(3);
    expect(mockCancelScheduled).toHaveBeenCalledWith('tba:early:성수');
    expect(mockCancelScheduled).toHaveBeenCalledWith('tba:imminent:성수');
    expect(mockCancelScheduled).toHaveBeenCalledWith('tba:early:왕십리');
    // accepted 2건만 fired set에 적재.
    expect(mockSetFiredAlarms).toHaveBeenCalledWith(
      'dest-1',
      new Set(['imminent:강남', 'early:시청']),
    );
    handle.remove();
  });

  it("'pass' 경로에는 cancel 호출 0회 (회귀 가드)", async () => {
    // reconcile pass.
    await reconcileScheduledAlarmDelivery('tba:early:강남');
    expect(mockCancelScheduled).not.toHaveBeenCalled();

    // drain pass.
    mockGetPresented.mockResolvedValueOnce([
      { date: 1, request: { identifier: 'tba:early:강남' } },
      { date: 2, request: { identifier: 'alarm:imminent:시청' } },
    ]);
    mockGetFiredAlarms.mockResolvedValueOnce(new Set());

    const handle = registerScheduledAlarmListener();
    await awaitInitialScheduledAlarmDrain();

    expect(mockCancelScheduled).not.toHaveBeenCalled();
    handle.remove();
  });

  it('기존 fired set / lastStationName 동작은 회귀 없음 (suppress된 항목은 fired set/lastStationName에 영향 X)', async () => {
    mockGetRegisteredTripRouteSig.mockResolvedValueOnce('SIG-OLD');
    mockRouteSignature.mockReturnValueOnce('SIG-NEW');

    await reconcileScheduledAlarmDelivery('tba:imminent:강남');

    // suppress 시 fired set/lastStationName 갱신 없음.
    expect(mockSetFiredAlarms).not.toHaveBeenCalled();
    expect(mockSetLastFiredAlarmStationName).not.toHaveBeenCalled();
    // cancel만 발생.
    expect(mockCancelScheduled).toHaveBeenCalledWith('tba:imminent:강남');
  });
});
