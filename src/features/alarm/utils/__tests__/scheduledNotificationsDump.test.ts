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

function makeRequest(overrides: {
  identifier: string;
  triggerValue?: number | Date | null;
  triggerType?: string;
  title?: string;
  body?: string;
}): Notifications.NotificationRequest {
  const { identifier, triggerValue, triggerType = 'date', title, body } = overrides;
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
    trigger:
      triggerValue == null
        ? null
        : ({
            type: triggerType,
            value: triggerValue,
          } as unknown as Notifications.NotificationTrigger),
  };
}

describe('dumpScheduledNotifications', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns entries sorted by fireAtMs ascending', async () => {
    mockGetAll.mockResolvedValueOnce([
      makeRequest({ identifier: 'bl:T:1:imminent:군자', triggerValue: 2000, title: '환승 임박' }),
      makeRequest({ identifier: 'bl:T:1:early:군자', triggerValue: 1000, title: '환승 알림' }),
    ]);

    const result = await dumpScheduledNotifications();
    expect(result).toEqual([
      {
        identifier: 'bl:T:1:early:군자',
        fireAtMs: 1000,
        title: '환승 알림',
        body: '',
      },
      {
        identifier: 'bl:T:1:imminent:군자',
        fireAtMs: 2000,
        title: '환승 임박',
        body: '',
      },
    ]);
  });

  it('parses Date trigger value as epoch ms', async () => {
    const dateValue = new Date('2026-06-02T11:30:00Z');
    mockGetAll.mockResolvedValueOnce([
      makeRequest({ identifier: 'bl:T:0:early:장한평', triggerValue: dateValue }),
    ]);

    const result = await dumpScheduledNotifications();
    expect(result[0].fireAtMs).toBe(dateValue.getTime());
  });

  it('sorts entries with null fireAtMs to the end (both comparator directions)', async () => {
    // 양방향 분기 cover: [non-null, null, non-null] 순서로 만들면 insertion sort가 첫 사이클에서
    // (a=null, b=non-null) 분기를 hit한다 (`a.fireAtMs == null` early return 분기).
    // 마지막 (a=non-null, b=null) 분기도 후속 비교에서 hit.
    mockGetAll.mockResolvedValueOnce([
      makeRequest({ identifier: 'with-trigger-1', triggerValue: 3000 }),
      makeRequest({ identifier: 'no-trigger', triggerValue: null }),
      makeRequest({ identifier: 'with-trigger-2', triggerValue: 1000 }),
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
      makeRequest({ identifier: 'a', triggerValue: null }),
      makeRequest({ identifier: 'b', triggerValue: null }),
    ]);

    const result = await dumpScheduledNotifications();
    expect(result.map((e) => e.identifier)).toEqual(['a', 'b']);
  });

  it('falls back to null for non-date trigger types', async () => {
    mockGetAll.mockResolvedValueOnce([
      makeRequest({ identifier: 'interval', triggerValue: 1000, triggerType: 'timeInterval' }),
    ]);

    const result = await dumpScheduledNotifications();
    expect(result[0].fireAtMs).toBeNull();
  });

  it('falls back to null for null trigger', async () => {
    mockGetAll.mockResolvedValueOnce([
      makeRequest({ identifier: 'immediate', triggerValue: null }),
    ]);

    const result = await dumpScheduledNotifications();
    expect(result[0].fireAtMs).toBeNull();
  });

  it('falls back to null for unrecognized trigger value type', async () => {
    mockGetAll.mockResolvedValueOnce([
      makeRequest({
        identifier: 'weird',
        triggerValue: 'string-value' as unknown as number,
        triggerType: 'date',
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
      makeRequest({ identifier: 'no-content', triggerValue: 1000 }),
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
