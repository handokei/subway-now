/**
 * #2675 — 자동 trip 종료 알림.
 *
 * 사용자 보고(2026-09-17): "FG 진입하니 알아서 도착 후 종료돼 있음 — 도착 안내도 종료 알림도 없었다."
 * 종료 판정이 아니라 **알림 부재**가 결함이었다(문구는 i18n에 있었지만 소비처가 없었다).
 */
const mockSchedule = jest.fn().mockResolvedValue('id');
jest.mock('expo-notifications', () => ({
  scheduleNotificationAsync: (...args: unknown[]) => mockSchedule(...args),
}));
jest.mock('../../../../shared/infra/monitoring/breadcrumb', () => ({
  addDomainBreadcrumb: jest.fn(),
  // logger가 같은 모듈의 addLogBreadcrumb를 쓰므로 함께 채운다(부분 mock으로 깨지는 것 방지).
  addLogBreadcrumb: jest.fn(),
}));

import i18next from 'i18next';
import type { Station } from '../../../../shared/types/station';
import { notifyTripEnded, TRIP_ENDED_NOTIFICATION_ID } from '../tripEndedNotification';
import { TRIP_ENDED_CATEGORY } from '../notificationCategory';

const ttuksom: Station = {
  id: '2-010',
  name: '뚝섬',
  line: '2',
  lat: 37.547,
  lng: 127.047,
  lineColor: '#00A84D',
};

describe('notifyTripEnded (#2675)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSchedule.mockResolvedValue('id');
  });

  it('도착 종료 — 목적지 도착 제목 + 역명이 실린 본문으로 로컬 알림을 띄운다', async () => {
    await notifyTripEnded({ destination: ttuksom, reason: 'arrived' });
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    const arg = mockSchedule.mock.calls[0][0] as {
      identifier: string;
      content: { title: string; body: string; categoryIdentifier: string };
    };
    expect(arg.identifier).toBe(TRIP_ENDED_NOTIFICATION_ID);
    expect(arg.content.title).toBe(i18next.t('route.tripEndedArrivedTitle'));
    expect(arg.content.body).toContain('뚝섬');
    // [다음 여정 시작] 버튼이 붙도록 기존 category 재사용.
    expect(arg.content.categoryIdentifier).toBe(TRIP_ENDED_CATEGORY);
  });

  it('backstop 종료 — 도착이 아니므로 "안내 종료" 제목을 쓴다', async () => {
    await notifyTripEnded({ destination: ttuksom, reason: 'backstop' });
    const arg = mockSchedule.mock.calls[0][0] as { content: { title: string } };
    expect(arg.content.title).toBe(i18next.t('route.tripEndedTitle'));
  });

  it('destination이 없으면 역명 없이 종료 문구만', async () => {
    await notifyTripEnded({ destination: null, reason: 'arrived' });
    const arg = mockSchedule.mock.calls[0][0] as { content: { body: string } };
    expect(arg.content.body).toBe(i18next.t('route.tripEndedBody'));
  });

  it('알림 표시 실패는 swallow — 종료 cleanup 흐름을 막지 않는다', async () => {
    mockSchedule.mockRejectedValue(new Error('notification denied'));
    await expect(
      notifyTripEnded({ destination: ttuksom, reason: 'arrived' }),
    ).resolves.toBeUndefined();
  });
});
