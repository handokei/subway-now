/**
 * stationPrescheduler (#918 → 퇴역 #2202) — OS-level 매역 사전 예약 채널 테스트.
 *
 * #2202로 로컬 발사(register/reschedule) 로직은 삭제됐다. 남은 유틸(다른 소비자 존재)만 검증:
 * - cancelAllPrescheduledAlarms: prefix 필터링 + delivered tray dismiss + 실패 graceful.
 * - readPrescheduledData: 파싱 가드(prefix/channel/필수 필드/kind enum).
 * - cancelPrescheduledByStationKind: (station, kind) 매칭 취소.
 */
import * as Notifications from 'expo-notifications';
import {
  PRESCHED_ALARM_PREFIX,
  cancelAllPrescheduledAlarms,
  readPrescheduledData,
  cancelPrescheduledByStationKind,
} from '../stationPrescheduler';

jest.mock('expo-notifications');

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const mockCancelIdentifiersWithRetry = jest.fn();
jest.mock('../safetyNetScheduler', () => ({
  cancelIdentifiersWithRetry: (...args: unknown[]) => mockCancelIdentifiersWithRetry(...args),
}));

const mockedGetAll = Notifications.getAllScheduledNotificationsAsync as jest.MockedFunction<
  typeof Notifications.getAllScheduledNotificationsAsync
>;
const mockedGetPresented = Notifications.getPresentedNotificationsAsync as jest.MockedFunction<
  typeof Notifications.getPresentedNotificationsAsync
>;
const mockedDismiss = Notifications.dismissNotificationAsync as jest.MockedFunction<
  typeof Notifications.dismissNotificationAsync
>;

const TRIP_TOKEN = 'TOKEN-ABCDEFGH-1234';

beforeEach(() => {
  jest.clearAllMocks();
  mockedGetAll.mockResolvedValue([]);
  mockedGetPresented.mockResolvedValue([]);
  mockedDismiss.mockResolvedValue(undefined);
  mockCancelIdentifiersWithRetry.mockResolvedValue(0);
});

describe('cancelAllPrescheduledAlarms', () => {
  it('prefix가 일치하는 pending만 취소한다', async () => {
    mockedGetAll.mockResolvedValue([
      { identifier: `${PRESCHED_ALARM_PREFIX}${TRIP_TOKEN.slice(0, 16)}-A역-station-passed` },
      { identifier: 'other-id' },
    ] as unknown as Notifications.NotificationRequest[]);
    mockCancelIdentifiersWithRetry.mockResolvedValue(1);

    await cancelAllPrescheduledAlarms(TRIP_TOKEN);

    expect(mockCancelIdentifiersWithRetry).toHaveBeenCalledWith([
      `${PRESCHED_ALARM_PREFIX}${TRIP_TOKEN.slice(0, 16)}-A역-station-passed`,
    ]);
  });

  it('delivered tray의 매칭 항목을 dismiss하고 성공 카운트를 집계한다', async () => {
    mockedGetAll.mockResolvedValue([]);
    const prefix = `${PRESCHED_ALARM_PREFIX}${TRIP_TOKEN.slice(0, 16)}-`;
    mockedGetPresented.mockResolvedValue([
      { request: { identifier: `${prefix}A역-station-passed` } },
      { request: { identifier: 'unrelated' } },
    ] as unknown as Notifications.Notification[]);
    mockedDismiss.mockResolvedValueOnce(undefined);

    await cancelAllPrescheduledAlarms(TRIP_TOKEN);

    expect(mockedDismiss).toHaveBeenCalledTimes(1);
    expect(mockedDismiss).toHaveBeenCalledWith(`${prefix}A역-station-passed`);
  });

  it('dismiss 실패(rejected)는 카운트에서 제외되고 전체 흐름은 정상 종료', async () => {
    const prefix = `${PRESCHED_ALARM_PREFIX}${TRIP_TOKEN.slice(0, 16)}-`;
    mockedGetPresented.mockResolvedValue([
      { request: { identifier: `${prefix}A역-station-passed` } },
    ] as unknown as Notifications.Notification[]);
    mockedDismiss.mockRejectedValueOnce(new Error('dismiss fail'));

    await expect(cancelAllPrescheduledAlarms(TRIP_TOKEN)).resolves.toBeUndefined();
  });

  it('getPresentedNotificationsAsync 실패 시 pending cancel만 적용하고 graceful 종료', async () => {
    mockedGetAll.mockResolvedValue([
      { identifier: `${PRESCHED_ALARM_PREFIX}${TRIP_TOKEN.slice(0, 16)}-A역-station-passed` },
    ] as unknown as Notifications.NotificationRequest[]);
    mockCancelIdentifiersWithRetry.mockResolvedValue(1);
    mockedGetPresented.mockRejectedValue(new Error('tray fail'));

    await expect(cancelAllPrescheduledAlarms(TRIP_TOKEN)).resolves.toBeUndefined();
  });

  it('취소도 dismiss도 없으면 조용히 종료(0/0)', async () => {
    mockedGetAll.mockResolvedValue([]);
    mockedGetPresented.mockResolvedValue([]);
    await expect(cancelAllPrescheduledAlarms(TRIP_TOKEN)).resolves.toBeUndefined();
  });
});

describe('readPrescheduledData', () => {
  const prefix = `${PRESCHED_ALARM_PREFIX}${TRIP_TOKEN.slice(0, 16)}-`;

  function makeReq(identifier: string, data: unknown): Notifications.NotificationRequest {
    return { identifier, content: { data } } as unknown as Notifications.NotificationRequest;
  }

  it('prefix가 아니면 null', () => {
    expect(readPrescheduledData(makeReq('other-id', null))).toBeNull();
  });

  it('data가 없으면 null', () => {
    expect(readPrescheduledData(makeReq(`${prefix}A역-station-passed`, null))).toBeNull();
  });

  it('channel이 presched-station이 아니면 null', () => {
    expect(
      readPrescheduledData(makeReq(`${prefix}A역-station-passed`, { channel: 'safety-net' })),
    ).toBeNull();
  });

  it('station 또는 tripToken이 문자열이 아니면 null', () => {
    expect(
      readPrescheduledData(
        makeReq(`${prefix}A역-station-passed`, {
          channel: 'presched-station',
          station: 1,
          tripToken: TRIP_TOKEN,
          kind: 'station-passed',
        }),
      ),
    ).toBeNull();
    expect(
      readPrescheduledData(
        makeReq(`${prefix}A역-station-passed`, {
          channel: 'presched-station',
          station: 'A역',
          tripToken: 1,
          kind: 'station-passed',
        }),
      ),
    ).toBeNull();
  });

  it('kind가 유효 enum이 아니면 null', () => {
    expect(
      readPrescheduledData(
        makeReq(`${prefix}A역-station-passed`, {
          channel: 'presched-station',
          station: 'A역',
          tripToken: TRIP_TOKEN,
          kind: 'unknown-kind',
        }),
      ),
    ).toBeNull();
  });

  it('occurrenceIdx가 숫자가 아니면 0으로 기본값 처리하며 정상 파싱', () => {
    const result = readPrescheduledData(
      makeReq(`${prefix}A역-station-passed`, {
        channel: 'presched-station',
        station: 'A역',
        tripToken: TRIP_TOKEN,
        kind: 'station-passed',
      }),
    );
    expect(result).toEqual({
      channel: 'presched-station',
      tripToken: TRIP_TOKEN,
      station: 'A역',
      kind: 'station-passed',
      occurrenceIdx: 0,
    });
  });

  it('occurrenceIdx가 숫자면 그대로 반영', () => {
    const result = readPrescheduledData(
      makeReq(`${prefix}A역-station-passed#1`, {
        channel: 'presched-station',
        station: 'A역',
        tripToken: TRIP_TOKEN,
        kind: 'station-passed',
        occurrenceIdx: 1,
      }),
    );
    expect(result?.occurrenceIdx).toBe(1);
  });
});

describe('cancelPrescheduledByStationKind', () => {
  it('매칭되는 항목이 없으면 cancelIdentifiersWithRetry를 호출하지 않는다', async () => {
    mockedGetAll.mockResolvedValue([
      { identifier: 'other', content: { data: null } },
    ] as unknown as Notifications.NotificationRequest[]);

    await cancelPrescheduledByStationKind('A역', 'station-passed');

    expect(mockCancelIdentifiersWithRetry).not.toHaveBeenCalled();
  });

  it('targets는 있지만 cancelIdentifiersWithRetry가 0을 반환하면 info 로그를 남기지 않는다(0 branch)', async () => {
    const prefix = `${PRESCHED_ALARM_PREFIX}${TRIP_TOKEN.slice(0, 16)}-`;
    mockedGetAll.mockResolvedValue([
      {
        identifier: `${prefix}A역-station-passed`,
        content: {
          data: { channel: 'presched-station', station: 'A역', tripToken: TRIP_TOKEN, kind: 'station-passed' },
        },
      },
    ] as unknown as Notifications.NotificationRequest[]);
    mockCancelIdentifiersWithRetry.mockResolvedValue(0);

    await expect(cancelPrescheduledByStationKind('A역', 'station-passed')).resolves.toBeUndefined();
  });

  it('(station, kind)가 일치하는 항목만 취소한다(occurrence 무관)', async () => {
    const prefix = `${PRESCHED_ALARM_PREFIX}${TRIP_TOKEN.slice(0, 16)}-`;
    mockedGetAll.mockResolvedValue([
      {
        identifier: `${prefix}A역-station-passed`,
        content: {
          data: { channel: 'presched-station', station: 'A역', tripToken: TRIP_TOKEN, kind: 'station-passed' },
        },
      },
      {
        identifier: `${prefix}A역-station-passed#1`,
        content: {
          data: {
            channel: 'presched-station',
            station: 'A역',
            tripToken: TRIP_TOKEN,
            kind: 'station-passed',
            occurrenceIdx: 1,
          },
        },
      },
      {
        identifier: `${prefix}B역-transfer`,
        content: {
          data: { channel: 'presched-station', station: 'B역', tripToken: TRIP_TOKEN, kind: 'transfer' },
        },
      },
    ] as unknown as Notifications.NotificationRequest[]);
    mockCancelIdentifiersWithRetry.mockResolvedValue(2);

    await cancelPrescheduledByStationKind('A역', 'station-passed');

    expect(mockCancelIdentifiersWithRetry).toHaveBeenCalledWith([
      `${prefix}A역-station-passed`,
      `${prefix}A역-station-passed#1`,
    ]);
  });
});
