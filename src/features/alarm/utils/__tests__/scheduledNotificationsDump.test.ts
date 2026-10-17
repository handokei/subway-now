import * as Notifications from 'expo-notifications';
import {
  dumpScheduledNotifications,
  formatScheduledNotificationLine,
} from '../scheduledNotificationsDump';

jest.mock('expo-notifications', () => ({
  getAllScheduledNotificationsAsync: jest.fn(),
}));

const mockGetAll = Notifications.getAllScheduledNotificationsAsync as jest.MockedFunction<
  typeof Notifications.getAllScheduledNotificationsAsync
>;

/**
 * scheduleNotificationAsync({ trigger: { type: DATE, date: ... } })로 등록해도 iOS native는
 * UNTimeIntervalNotificationTrigger로 변환하고 dump 시점에 `EXNotificationSerializer`가
 * `{ type: 'timeInterval', seconds, repeats }` 형태로 직렬화한다.
 * 본 helper는 production OS 동작을 그대로 시뮬레이션 (#1422 — `lesson_test_mock_must_validate_runtime`).
 *
 * `fireAtMs`(절대 시각)를 받아 dump 호출 시점(`nowMs`)으로부터의 잔여 초로 환산해 mock.
 */
function makeTimeIntervalRequest(args: {
  identifier: string;
  fireAtMs: number;
  nowMs: number;
  title?: string;
  body?: string;
}): Notifications.NotificationRequest {
  const { identifier, fireAtMs, nowMs, title, body } = args;
  return makeRequest({
    identifier,
    title,
    body,
    trigger: {
      type: 'timeInterval',
      seconds: (fireAtMs - nowMs) / 1000,
      repeats: false,
    } as unknown as Notifications.NotificationTrigger,
  });
}

/**
 * `DateTriggerInput` 형태(`{ type: 'date', date: Date | number }`)를 보존하는 환경
 * (테스트 mock, 일부 플랫폼) 시뮬레이션. iOS native와는 다른 경로이지만 본 dump는 둘 다 흡수.
 */
function makeDateRequest(args: {
  identifier: string;
  date: number | Date;
  title?: string;
  body?: string;
}): Notifications.NotificationRequest {
  const { identifier, date, title, body } = args;
  return makeRequest({
    identifier,
    title,
    body,
    trigger: {
      type: 'date',
      date,
    } as unknown as Notifications.NotificationTrigger,
  });
}

function makeRequest(overrides: {
  identifier: string;
  trigger: Notifications.NotificationTrigger | null;
  title?: string;
  body?: string;
}): Notifications.NotificationRequest {
  const { identifier, trigger, title, body } = overrides;
  return {
    identifier,
    content: {
      title: title ?? null,
      body: body ?? null,
      data: {},
      sound: null,
      subtitle: null,
      launchImageName: null,
      badge: null,
      attachments: [],
      categoryIdentifier: null,
      autoDismiss: true,
      sticky: false,
      interruptionLevel: undefined,
      threadIdentifier: null,
    } as unknown as Notifications.NotificationContent,
    trigger,
  };
}

describe('dumpScheduledNotifications', () => {
  const FIXED_NOW = 1_000_000_000_000;
  let dateNowSpy: jest.SpyInstance<number, []>;

  beforeEach(() => {
    jest.clearAllMocks();
    dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
  });

  it('returns entries sorted by fireAtMs ascending (timeInterval trigger — iOS native)', async () => {
    // boardingLockScheduler.ts:160는 DATE trigger로 등록하지만 iOS native가 timeInterval로 변환.
    // 본 케이스가 production OS와 가장 일치 — 사용자가 본 dump UI에서 보는 형태.
    mockGetAll.mockResolvedValueOnce([
      makeTimeIntervalRequest({
        identifier: 'bl:T:1:imminent:군자',
        fireAtMs: FIXED_NOW + 2000,
        nowMs: FIXED_NOW,
        title: '환승 임박',
      }),
      makeTimeIntervalRequest({
        identifier: 'bl:T:1:early:군자',
        fireAtMs: FIXED_NOW + 1000,
        nowMs: FIXED_NOW,
        title: '환승 알림',
      }),
    ]);

    const result = await dumpScheduledNotifications();
    expect(result).toEqual([
      {
        identifier: 'bl:T:1:early:군자',
        fireAtMs: FIXED_NOW + 1000,
        title: '환승 알림',
        body: '',
      },
      {
        identifier: 'bl:T:1:imminent:군자',
        fireAtMs: FIXED_NOW + 2000,
        title: '환승 임박',
        body: '',
      },
    ]);
  });

  it('parses DATE trigger with epoch ms number (DateTriggerInput-shape platform)', async () => {
    const fireAt = new Date('2026-06-02T11:30:00Z').getTime();
    mockGetAll.mockResolvedValueOnce([
      makeDateRequest({ identifier: 'bl:T:0:early:장한평', date: fireAt }),
    ]);

    const result = await dumpScheduledNotifications();
    expect(result[0].fireAtMs).toBe(fireAt);
  });

  it('parses DATE trigger with Date object (DateTriggerInput-shape platform)', async () => {
    const dateValue = new Date('2026-06-02T11:30:00Z');
    mockGetAll.mockResolvedValueOnce([
      makeDateRequest({ identifier: 'bl:T:0:early:장한평', date: dateValue }),
    ]);

    const result = await dumpScheduledNotifications();
    expect(result[0].fireAtMs).toBe(dateValue.getTime());
  });

  it('sorts entries with null fireAtMs to the end (both comparator directions)', async () => {
    // 양방향 분기 cover: [non-null, null, non-null] 순서로 만들면 insertion sort가 첫 사이클에서
    // (a=null, b=non-null) 분기를 hit한다 (`a.fireAtMs == null` early return 분기).
    // 마지막 (a=non-null, b=null) 분기도 후속 비교에서 hit.
    mockGetAll.mockResolvedValueOnce([
      makeTimeIntervalRequest({
        identifier: 'with-trigger-1',
        fireAtMs: FIXED_NOW + 3000,
        nowMs: FIXED_NOW,
      }),
      makeRequest({ identifier: 'no-trigger', trigger: null }),
      makeTimeIntervalRequest({
        identifier: 'with-trigger-2',
        fireAtMs: FIXED_NOW + 1000,
        nowMs: FIXED_NOW,
      }),
    ]);

    const result = await dumpScheduledNotifications();
    expect(result.map((e) => e.identifier)).toEqual([
      'with-trigger-2',
      'with-trigger-1',
      'no-trigger',
    ]);
  });

  it('null fireAtMs only — relative order preserved (sort returns 0 in tie)', async () => {
    mockGetAll.mockResolvedValueOnce([
      makeRequest({ identifier: 'a', trigger: null }),
      makeRequest({ identifier: 'b', trigger: null }),
    ]);

    const result = await dumpScheduledNotifications();
    expect(result.map((e) => e.identifier)).toEqual(['a', 'b']);
  });

  it('falls back to null for unknown trigger types (calendar/daily/etc)', async () => {
    mockGetAll.mockResolvedValueOnce([
      makeRequest({
        identifier: 'calendar',
        trigger: {
          type: 'calendar',
          repeats: false,
          dateComponents: {},
        } as unknown as Notifications.NotificationTrigger,
      }),
    ]);

    const result = await dumpScheduledNotifications();
    expect(result[0].fireAtMs).toBeNull();
  });

  it('falls back to null for null trigger', async () => {
    mockGetAll.mockResolvedValueOnce([makeRequest({ identifier: 'immediate', trigger: null })]);

    const result = await dumpScheduledNotifications();
    expect(result[0].fireAtMs).toBeNull();
  });

  it('falls back to null when DATE trigger date field is missing/invalid', async () => {
    mockGetAll.mockResolvedValueOnce([
      makeRequest({
        identifier: 'weird-date',
        trigger: {
          type: 'date',
          date: 'string-value',
        } as unknown as Notifications.NotificationTrigger,
      }),
    ]);

    const result = await dumpScheduledNotifications();
    expect(result[0].fireAtMs).toBeNull();
  });

  it('falls back to null when timeInterval trigger seconds field is missing/invalid', async () => {
    mockGetAll.mockResolvedValueOnce([
      makeRequest({
        identifier: 'weird-interval',
        trigger: {
          type: 'timeInterval',
          seconds: 'not-a-number',
          repeats: false,
        } as unknown as Notifications.NotificationTrigger,
      }),
    ]);

    const result = await dumpScheduledNotifications();
    expect(result[0].fireAtMs).toBeNull();
  });

  it('falls back to null for trigger object without type field', async () => {
    mockGetAll.mockResolvedValueOnce([
      makeRequest({
        identifier: 'no-type',
        trigger: { foo: 'bar' } as unknown as Notifications.NotificationTrigger,
      }),
    ]);

    const result = await dumpScheduledNotifications();
    expect(result[0].fireAtMs).toBeNull();
  });

  it('returns empty array if OS call fails (graceful)', async () => {
    mockGetAll.mockRejectedValueOnce(new Error('OS error'));

    const result = await dumpScheduledNotifications();
    expect(result).toEqual([]);
  });

  it('returns empty content fields when missing', async () => {
    mockGetAll.mockResolvedValueOnce([
      makeTimeIntervalRequest({
        identifier: 'no-content',
        fireAtMs: FIXED_NOW + 1000,
        nowMs: FIXED_NOW,
      }),
    ]);

    const result = await dumpScheduledNotifications();
    expect(result[0].title).toBe('');
    expect(result[0].body).toBe('');
  });
});

describe('formatScheduledNotificationLine', () => {
  it('formats with time + identifier + title', () => {
    const line = formatScheduledNotificationLine({
      identifier: 'bl:T:1:early:군자',
      fireAtMs: new Date('2026-06-02T11:30:00Z').getTime(),
      title: '환승 알림',
      body: '...',
    });
    expect(line).toMatch(/^\d{2}:\d{2}:\d{2} \| bl:T:1:early:군자 \| 환승 알림$/);
  });

  it('renders --:--:-- when fireAtMs is null', () => {
    const line = formatScheduledNotificationLine({
      identifier: 'no-time',
      fireAtMs: null,
      title: 'X',
      body: '',
    });
    expect(line).toBe('--:--:-- | no-time | X');
  });
});
