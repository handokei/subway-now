import {
  resolveNotificationSource,
  notificationSourceI18nKey,
  shouldDiscloseNotificationSource,
  type NotificationSource,
} from '../notificationSource';
import type { FusionSource } from '../../../../shared/types/fusion';

const mockIsDebugModalEnabled = jest.fn();
jest.mock('../../../../shared/constants/debugFlags', () => ({
  isDebugModalEnabled: () => mockIsDebugModalEnabled(),
}));

describe('resolveNotificationSource', () => {
  it.each<[FusionSource, NotificationSource]>([
    ['backend-ssot', 'positionTrain'],
    ['boarding-lock', 'positionTrain'],
    ['boarding-lock-interp', 'positionTrain'],
    ['position-train', 'positionTrain'],
    ['position', 'positionTrain'],
    ['arrival', 'positionTrain'],
    ['wifi-ssid', 'positionTrain'],
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

describe('shouldDiscloseNotificationSource', () => {
  describe('debug 빌드(isDebugModalEnabled=true)', () => {
    beforeEach(() => mockIsDebugModalEnabled.mockReturnValue(true));
    it.each<[NotificationSource, boolean]>([
      ['gpsOnly', true],
      ['uncertain', true],
      ['positionTrain', false],
      ['routeProgress', false],
    ])('%s → %s (사용자 자백 대상 여부)', (key, expected) => {
      expect(shouldDiscloseNotificationSource(key)).toBe(expected);
    });
  });

  describe('production 빌드(isDebugModalEnabled=false) — #1327', () => {
    beforeEach(() => mockIsDebugModalEnabled.mockReturnValue(false));
    it.each<NotificationSource>(['gpsOnly', 'uncertain', 'positionTrain', 'routeProgress'])(
      '%s → false (추정-근거 debug 문구 미노출)',
      (key) => {
        expect(shouldDiscloseNotificationSource(key)).toBe(false);
      },
    );
  });
});
