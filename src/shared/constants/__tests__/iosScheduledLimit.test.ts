import {
  IOS_NOTIFICATION_HARD_LIMIT,
  IOS_NOTIFICATION_SAFETY_BUFFER,
  IOS_NOTIFICATION_USABLE_QUOTA,
  BL_QUOTA,
  TBA_QUOTA,
  TBA_WINDOW_SIZE,
  TRANSFER_QUOTA,
  BL_MAX_WAYPOINTS,
} from '../iosScheduledLimit';

describe('iosScheduledLimit (#1757, #1538 Sub 2)', () => {
  it('iOS 한도 상수는 Apple 문서 기준 64', () => {
    expect(IOS_NOTIFICATION_HARD_LIMIT).toBe(64);
  });

  it('safety buffer는 4', () => {
    expect(IOS_NOTIFICATION_SAFETY_BUFFER).toBe(4);
  });

  it('분배 가능 quota = 한도 - 버퍼', () => {
    expect(IOS_NOTIFICATION_USABLE_QUOTA).toBe(
      IOS_NOTIFICATION_HARD_LIMIT - IOS_NOTIFICATION_SAFETY_BUFFER,
    );
    expect(IOS_NOTIFICATION_USABLE_QUOTA).toBe(60);
  });

  it('BL_QUOTA + TBA_QUOTA + TRANSFER_QUOTA = 분배 가능 quota', () => {
    expect(BL_QUOTA + TBA_QUOTA + TRANSFER_QUOTA).toBe(IOS_NOTIFICATION_USABLE_QUOTA);
  });

  it('BL_QUOTA는 30', () => {
    expect(BL_QUOTA).toBe(30);
  });

  it('TBA_QUOTA는 24', () => {
    expect(TBA_QUOTA).toBe(24);
  });

  it('TRANSFER_QUOTA는 나머지 6', () => {
    expect(TRANSFER_QUOTA).toBe(6);
  });

  it('TBA_WINDOW_SIZE = TBA_QUOTA / 2 (stop 단위 환산)', () => {
    expect(TBA_WINDOW_SIZE).toBe(TBA_QUOTA / 2);
    expect(TBA_WINDOW_SIZE).toBe(12);
  });

  it('BL_MAX_WAYPOINTS = BL_QUOTA / 2 (waypoint 단위 환산)', () => {
    expect(BL_MAX_WAYPOINTS).toBe(BL_QUOTA / 2);
    expect(BL_MAX_WAYPOINTS).toBe(15);
  });

  it('BL_MAX_WAYPOINTS × 2 phase ≤ BL_QUOTA (OS 예약 건수 초과 불가)', () => {
    expect(BL_MAX_WAYPOINTS * 2).toBeLessThanOrEqual(BL_QUOTA);
  });

  it('TBA_WINDOW_SIZE × 2 phase ≤ TBA_QUOTA (OS 예약 건수 초과 불가)', () => {
    expect(TBA_WINDOW_SIZE * 2).toBeLessThanOrEqual(TBA_QUOTA);
  });

  it('모든 채널 합산 × 2 phase ≤ IOS_NOTIFICATION_HARD_LIMIT', () => {
    const maxNotifications =
      BL_MAX_WAYPOINTS * 2 + TBA_WINDOW_SIZE * 2 + TRANSFER_QUOTA;
    expect(maxNotifications).toBeLessThanOrEqual(IOS_NOTIFICATION_HARD_LIMIT);
  });
});
