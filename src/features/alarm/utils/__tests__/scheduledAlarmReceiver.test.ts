import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';

jest.mock('expo-notifications', () => ({
  addNotificationReceivedListener: jest.fn(),
  getPresentedNotificationsAsync: jest.fn(),
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
const mockAsyncGetItem = AsyncStorage.getItem as jest.Mock;

const DEST_JSON = JSON.stringify({ id: 'dest-1', name: '강남' });

function flushAsync(): Promise<void> {
  return new Promise((r) => setImmediate(r));
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
