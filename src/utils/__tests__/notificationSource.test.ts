import {
  resolveNotificationSource,
  notificationSourceI18nKey,
} from '../notificationSource';

describe('resolveNotificationSource', () => {
  it('position-train → positionTrain', () => {
    expect(resolveNotificationSource('position-train')).toBe('positionTrain');
  });

  it('position(fused) → positionTrain 그룹', () => {
    expect(resolveNotificationSource('position')).toBe('positionTrain');
  });

  it('arrival(fused) → positionTrain 그룹', () => {
    expect(resolveNotificationSource('arrival')).toBe('positionTrain');
  });

  it('route-progress → routeProgress', () => {
    expect(resolveNotificationSource('route-progress')).toBe('routeProgress');
  });

  it('gps → gpsOnly', () => {
    expect(resolveNotificationSource('gps')).toBe('gpsOnly');
  });

  it('locationUncertain=true → source와 무관하게 uncertain', () => {
    expect(resolveNotificationSource('position-train', true)).toBe('uncertain');
    expect(resolveNotificationSource('gps', true)).toBe('uncertain');
    expect(resolveNotificationSource('route-progress', true)).toBe('uncertain');
  });

  it('locationUncertain 기본값 false', () => {
    expect(resolveNotificationSource('gps')).toBe('gpsOnly');
  });
});

describe('notificationSourceI18nKey', () => {
  it('source. prefix 부착', () => {
    expect(notificationSourceI18nKey('positionTrain')).toBe('source.positionTrain');
    expect(notificationSourceI18nKey('routeProgress')).toBe('source.routeProgress');
    expect(notificationSourceI18nKey('gpsOnly')).toBe('source.gpsOnly');
    expect(notificationSourceI18nKey('uncertain')).toBe('source.uncertain');
  });
});
