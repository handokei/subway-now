/* eslint-disable import/no-restricted-paths --
 * tripEndOffer는 취침모드(settings 슬라이스) 여부를 읽는 cross-feature 모듈이라 테스트도 같은
 * settings store를 직접 세팅한다.
 */
import * as Notifications from 'expo-notifications';
import { PAUSE_AUTO_END_MS } from '../../../../shared/constants/realtime';
import { useSettingsStore } from '../../../settings/store/useSettingsStore';
import { ALARM_CATEGORY } from '../notificationCategory';
import {
  TRIP_END_OFFER_ID,
  TRIP_END_OFFER_KIND,
  cancelTripEndOffer,
  rearmTripEndOfferOnRelease,
  scheduleTripEndOffer,
} from '../tripEndOffer';

const mockGetTripStartedAt = jest.fn<Promise<number | null>, []>();
jest.mock('../tripStartStorage', () => ({
  getTripStartedAt: () => mockGetTripStartedAt(),
}));

const mockGetItem = jest.fn<Promise<string | null>, [string]>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: (k: string) => mockGetItem(k) },
}));

jest.mock('expo-notifications', () => ({
  SchedulableTriggerInputTypes: { DATE: 'date' },
  scheduleNotificationAsync: jest.fn().mockResolvedValue('id'),
  cancelScheduledNotificationAsync: jest.fn().mockResolvedValue(undefined),
  dismissNotificationAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../../shared/infra/monitoring/breadcrumb', () => ({
  addDomainBreadcrumb: jest.fn(),
  addLogBreadcrumb: jest.fn(),
}));

const T0 = Date.parse('2026-10-20T09:40:11Z'); // 10/20 18:40:11 KST — 실측 목적지 설정 시각

function firstScheduleRequest(): {
  identifier: string;
  content: Record<string, any>;
  trigger: { date: Date };
} {
  return (Notifications.scheduleNotificationAsync as jest.Mock).mock.calls[0][0];
}

describe('scheduleTripEndOffer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(T0);
    mockGetItem.mockResolvedValue(null);
    useSettingsStore.setState({ sleepMode: false });
  });
  afterEach(() => jest.restoreAllMocks());

  it('fromMs + PAUSE_AUTO_END_MS(15분)에 고정 id DATE 트리거 1건을 예약한다', async () => {
    await scheduleTripEndOffer(T0);
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    const req = firstScheduleRequest();
    expect(req.identifier).toBe(TRIP_END_OFFER_ID);
    expect(req.trigger.date.getTime()).toBe(T0 + PAUSE_AUTO_END_MS);
    expect(req.trigger.date.toISOString()).toBe('2026-10-20T09:55:11.000Z'); // 18:55:11 KST
  });

  it('유령 알림이 아니다: title/body/sound/category/data.kind를 모두 가진다 (#2822)', async () => {
    await scheduleTripEndOffer(T0);
    const { content } = firstScheduleRequest();
    expect(content.title).toBeTruthy();
    expect(content.body).toBeTruthy();
    expect(content.sound).toBeTruthy();
    expect(content.categoryIdentifier).toBe(ALARM_CATEGORY);
    expect(content.data.kind).toBe(TRIP_END_OFFER_KIND);
    expect(TRIP_END_OFFER_KIND).toBe('trip-end-offer');
  });

  it('ACTIVE_TRIP_KEY가 있으면 data.tripToken에 싣는다, 없으면 키 자체를 생략', async () => {
    mockGetItem.mockResolvedValue('tok-1');
    await scheduleTripEndOffer(T0);
    expect(firstScheduleRequest().content.data.tripToken).toBe('tok-1');

    jest.clearAllMocks();
    mockGetItem.mockResolvedValue(null);
    await scheduleTripEndOffer(T0);
    expect('tripToken' in firstScheduleRequest().content.data).toBe(false);
  });

  it('ACTIVE_TRIP_KEY 조회가 reject해도 tripToken 없이 예약한다', async () => {
    mockGetItem.mockRejectedValue(new Error('storage'));
    await scheduleTripEndOffer(T0);
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    expect('tripToken' in firstScheduleRequest().content.data).toBe(false);
  });

  it('취침모드 ON이면 소리 없이 예약한다 (plan U4: ADR-023 무음·passive)', async () => {
    useSettingsStore.setState({ sleepMode: true });
    await scheduleTripEndOffer(T0);
    expect(firstScheduleRequest().content.sound).toBeFalsy();
  });

  it('발사 시각이 이미 과거면 예약하지 않는다', async () => {
    await scheduleTripEndOffer(T0 - PAUSE_AUTO_END_MS - 1);
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('OS 예약 실패는 삼킨다 (trip 시작 흐름을 깨지 않는다)', async () => {
    (Notifications.scheduleNotificationAsync as jest.Mock).mockRejectedValueOnce(new Error('os'));
    await expect(scheduleTripEndOffer(T0)).resolves.toBeUndefined();
  });
});

describe('cancelTripEndOffer', () => {
  beforeEach(() => jest.clearAllMocks());

  it('tripToken 없이 고정 id로 pending 취소 + 표시된 알림 dismiss', async () => {
    await cancelTripEndOffer();
    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenCalledWith(TRIP_END_OFFER_ID);
    expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith(TRIP_END_OFFER_ID);
  });

  it('cancel이 실패해도 dismiss를 시도하고 throw하지 않는다', async () => {
    (Notifications.cancelScheduledNotificationAsync as jest.Mock).mockRejectedValueOnce(
      new Error('x'),
    );
    await expect(cancelTripEndOffer()).resolves.toBeUndefined();
    expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith(TRIP_END_OFFER_ID);
  });

  it('dismiss가 실패해도 throw하지 않는다', async () => {
    (Notifications.dismissNotificationAsync as jest.Mock).mockRejectedValueOnce(new Error('x'));
    await expect(cancelTripEndOffer()).resolves.toBeUndefined();
  });
});

describe('rearmTripEndOfferOnRelease (A-2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(T0);
    mockGetItem.mockResolvedValue(null);
    useSettingsStore.setState({ sleepMode: false });
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    'user',
    'transfer',
    'vanish',
    'expired',
    'train-code-mismatch',
    'auto-release-transfer',
  ] as const)('trip이 살아있고 사유=%s → 지금부터 15분 뒤로 재arm', async (reason) => {
    mockGetTripStartedAt.mockResolvedValue(T0 - 60_000);
    await rearmTripEndOfferOnRelease(reason);
    expect(firstScheduleRequest().trigger.date.getTime()).toBe(T0 + PAUSE_AUTO_END_MS);
  });

  it.each([
    'trip-cleanup',
    'backend-confirmed',
    'user-clear',
    'destination-switch',
    'destination-change',
    'auto-release-destination',
    'silent-push-fg-immediate',
  ] as const)('trip 종료/전환 계열 사유=%s → 재arm 안 함', async (reason) => {
    mockGetTripStartedAt.mockResolvedValue(T0 - 60_000);
    await rearmTripEndOfferOnRelease(reason);
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('재arm 가능 사유여도 trip이 이미 없으면(tripStartedAt null) 재arm 안 함', async () => {
    mockGetTripStartedAt.mockResolvedValue(null);
    await rearmTripEndOfferOnRelease('transfer');
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });
});
