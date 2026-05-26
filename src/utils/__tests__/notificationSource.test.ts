import {
  resolveNotificationSource,
  notificationSourceI18nKey,
  type NotificationSource,
} from '../notificationSource';
import type { FusionSource } from '../pickFusedStation';

describe('resolveNotificationSource', () => {
  it.each<[FusionSource, NotificationSource]>([
    ['position-train', 'positionTrain'],
    ['position', 'positionTrain'],
    ['arrival', 'positionTrain'],
    ['route-progress', 'routeProgress'],
    ['gps', 'gpsOnly'],
  ])('%s → %s', (source, expected) => {
    expect(resolveNotificationSource(source)).toBe(expected);
  });

  it.each<FusionSource>(['position-train', 'gps', 'route-progress'])(
    'locationUncertain=true → %s와 무관하게 uncertain',
    (source) => {
      expect(resolveNotificationSource(source, true)).toBe('uncertain');
    },
  );

  it('locationUncertain 기본값 false', () => {
    expect(resolveNotificationSource('gps')).toBe('gpsOnly');
  });
});

describe('notificationSourceI18nKey', () => {
  it.each<NotificationSource>(['positionTrain', 'routeProgress', 'gpsOnly', 'uncertain'])(
    '%s → source.%s prefix 부착',
    (key) => {
      expect(notificationSourceI18nKey(key)).toBe(`source.${key}`);
    },
  );
});
