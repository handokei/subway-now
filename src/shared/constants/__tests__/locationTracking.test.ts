import {
  LOCATION_TRACKING_OPTIONS,
  LOCATION_TRACKING_OPTIONS_STATIONARY,
  locationTrackingOptionsForProfile,
} from '../locationTracking';

describe('locationTracking profiles', () => {
  it('surface 프로파일은 기본 LOCATION_TRACKING_OPTIONS(30s)를 반환한다', () => {
    expect(locationTrackingOptionsForProfile('surface')).toBe(LOCATION_TRACKING_OPTIONS);
    expect(LOCATION_TRACKING_OPTIONS.timeInterval).toBe(30_000);
  });

  it('stationary 프로파일은 완화된 timeInterval을 반환하고 accuracy는 동일(High)하다', () => {
    expect(locationTrackingOptionsForProfile('stationary')).toBe(LOCATION_TRACKING_OPTIONS_STATIONARY);
    expect(LOCATION_TRACKING_OPTIONS_STATIONARY.timeInterval).toBeGreaterThan(
      LOCATION_TRACKING_OPTIONS.timeInterval,
    );
    expect(LOCATION_TRACKING_OPTIONS_STATIONARY.accuracy).toBe(LOCATION_TRACKING_OPTIONS.accuracy);
    expect(LOCATION_TRACKING_OPTIONS_STATIONARY.distanceInterval).toBe(
      LOCATION_TRACKING_OPTIONS.distanceInterval,
    );
  });
});
