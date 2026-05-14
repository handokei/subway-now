import * as Notifications from 'expo-notifications';
import { AppState } from 'react-native';

jest.mock('expo-notifications', () => ({
  addNotificationReceivedListener: jest.fn(),
  getPresentedNotificationsAsync: jest.fn(),
}));

jest.mock('../notificationState', () => ({
  getFiredAlarms: jest.fn(),
  setFiredAlarms: jest.fn(),
  setLastFiredAlarmStationName: jest.fn(),
}));

const mockErrorSpy = jest.fn();
jest.mock('../logger', () => ({
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

function flushAsync(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

let appStateSpy: jest.SpyInstance;

beforeEach(async () => {
  jest.clearAllMocks();
  mockErrorSpy.mockClear();
  mockGetFiredAlarms.mockResolvedValue(new Set());
  mockSetFiredAlarms.mockResolvedValue(undefined);
  mockSetLastFiredAlarmStationName.mockResolvedValue(undefined);
  mockGetPresented.mockResolvedValue([]);
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

    expect(mockSetFiredAlarms).toHaveBeenCalledWith(new Set(['early:시청', 'early:강남']));
    expect(mockSetLastFiredAlarmStationName).toHaveBeenCalledWith('강남');
  });
});

describe('registerScheduledAlarmListener', () => {
  it('등록 시점에 delivered 알람을 batch drain하고 fired set + last station을 한 번만 write한다', async () => {
    mockGetPresented.mockResolvedValueOnce([
      { request: { identifier: 'alarm:early:강남' } },
      { request: { identifier: 'current-station' } },
      { request: { identifier: 'alarm:imminent:강남' } },
    ]);
    const notifRemove = jest.fn();
    mockAddListener.mockReturnValueOnce({ remove: notifRemove });
    const appStateRemove = jest.fn();
    jest
      .spyOn(AppState, 'addEventListener')
      .mockReturnValueOnce({ remove: appStateRemove } as ReturnType<typeof AppState.addEventListener>);

    const handle = registerScheduledAlarmListener();
    await awaitInitialScheduledAlarmDrain();
    await flushAsync();

    expect(mockGetFiredAlarms).toHaveBeenCalledTimes(1);
    expect(mockSetFiredAlarms).toHaveBeenCalledTimes(1);
    expect(mockSetFiredAlarms).toHaveBeenCalledWith(new Set(['early:강남', 'imminent:강남']));
    expect(mockSetLastFiredAlarmStationName).toHaveBeenCalledTimes(1);
    expect(mockSetLastFiredAlarmStationName).toHaveBeenCalledWith('강남');

    handle.remove();
    expect(notifRemove).toHaveBeenCalled();
    expect(appStateRemove).toHaveBeenCalled();
  });

  it('drain에 매칭되는 alarm이 없으면 write를 생략한다', async () => {
    mockGetPresented.mockResolvedValueOnce([
      { request: { identifier: 'current-station' } },
    ]);
    mockAddListener.mockReturnValueOnce({ remove: jest.fn() });
    jest
      .spyOn(AppState, 'addEventListener')
      .mockReturnValueOnce({ remove: jest.fn() } as ReturnType<typeof AppState.addEventListener>);

    const handle = registerScheduledAlarmListener();
    await awaitInitialScheduledAlarmDrain();

    expect(mockSetFiredAlarms).not.toHaveBeenCalled();
    expect(mockSetLastFiredAlarmStationName).not.toHaveBeenCalled();

    handle.remove();
  });

  it('이미 fired set에 있는 키는 firedChanged를 트리거하지 않는다', async () => {
    mockGetPresented.mockResolvedValueOnce([
      { request: { identifier: 'alarm:early:강남' } },
    ]);
    mockGetFiredAlarms.mockResolvedValueOnce(new Set(['early:강남']));
    mockAddListener.mockReturnValueOnce({ remove: jest.fn() });
    jest
      .spyOn(AppState, 'addEventListener')
      .mockReturnValueOnce({ remove: jest.fn() } as ReturnType<typeof AppState.addEventListener>);

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
    jest
      .spyOn(AppState, 'addEventListener')
      .mockReturnValueOnce({ remove: jest.fn() } as ReturnType<typeof AppState.addEventListener>);

    const handle = registerScheduledAlarmListener();
    await flushAsync();

    expect(mockSetFiredAlarms).toHaveBeenCalledWith(new Set(['imminent:시청']));
    expect(mockSetLastFiredAlarmStationName).toHaveBeenCalledWith('시청');

    handle.remove();
  });

  it('AppState change "active" 진입 시 delivered 알람을 다시 drain한다', async () => {
    let appStateHandler: ((state: string) => void) | undefined;
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((event, cb) => {
      if (event === 'change') appStateHandler = cb as (s: string) => void;
      return { remove: jest.fn() };
    }) as typeof AppState.addEventListener);
    mockAddListener.mockReturnValueOnce({ remove: jest.fn() });

    const handle = registerScheduledAlarmListener();
    await awaitInitialScheduledAlarmDrain();
    mockGetPresented.mockResolvedValueOnce([
      { request: { identifier: 'alarm:early:서울역' } },
    ]);
    appStateHandler!('active');
    await flushAsync();

    expect(mockSetLastFiredAlarmStationName).toHaveBeenCalledWith('서울역');

    handle.remove();
  });

  it('AppState change가 active가 아니면 drain하지 않는다', async () => {
    let appStateHandler: ((state: string) => void) | undefined;
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((event, cb) => {
      if (event === 'change') appStateHandler = cb as (s: string) => void;
      return { remove: jest.fn() };
    }) as typeof AppState.addEventListener);
    mockAddListener.mockReturnValueOnce({ remove: jest.fn() });

    const handle = registerScheduledAlarmListener();
    await awaitInitialScheduledAlarmDrain();
    mockGetPresented.mockClear();
    appStateHandler!('background');
    await flushAsync();

    expect(mockGetPresented).not.toHaveBeenCalled();

    handle.remove();
  });

  it('getPresentedNotificationsAsync가 던지면 error 로그를 남기고 계속한다', async () => {
    mockGetPresented.mockRejectedValueOnce(new Error('os 오류'));
    mockAddListener.mockReturnValueOnce({ remove: jest.fn() });
    jest
      .spyOn(AppState, 'addEventListener')
      .mockReturnValueOnce({ remove: jest.fn() } as ReturnType<typeof AppState.addEventListener>);

    const handle = registerScheduledAlarmListener();
    await awaitInitialScheduledAlarmDrain();

    expect(mockErrorSpy).toHaveBeenCalled();
    expect(mockSetFiredAlarms).not.toHaveBeenCalled();

    handle.remove();
  });

  it('중복 호출은 idempotent — 첫 핸들을 그대로 반환한다', async () => {
    mockAddListener.mockReturnValueOnce({ remove: jest.fn() });
    jest
      .spyOn(AppState, 'addEventListener')
      .mockReturnValueOnce({ remove: jest.fn() } as ReturnType<typeof AppState.addEventListener>);

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
