import * as Location from 'expo-location';
import {
  LOCATION_TRACKING_OPTIONS,
  LOCATION_TRACKING_OPTIONS_STATIONARY,
  LOCATION_TRACKING_OPTIONS_UNDERGROUND,
  BG_UNDERGROUND_DEMOTE_FAIL_THRESHOLD,
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

  // #2345 — 지하 accuracy 강등 프리셋.
  it('underground 프로파일은 accuracy를 Balanced로 강등하고 timeInterval도 완화한다', () => {
    expect(locationTrackingOptionsForProfile('underground')).toBe(
      LOCATION_TRACKING_OPTIONS_UNDERGROUND,
    );
    expect(LOCATION_TRACKING_OPTIONS_UNDERGROUND.accuracy).toBe(Location.Accuracy.Balanced);
    expect(LOCATION_TRACKING_OPTIONS_UNDERGROUND.accuracy).not.toBe(LOCATION_TRACKING_OPTIONS.accuracy);
    expect(LOCATION_TRACKING_OPTIONS_UNDERGROUND.timeInterval).toBeGreaterThan(
      LOCATION_TRACKING_OPTIONS.timeInterval,
    );
    expect(LOCATION_TRACKING_OPTIONS_UNDERGROUND.distanceInterval).toBe(
      LOCATION_TRACKING_OPTIONS.distanceInterval,
    );
  });

  it('BG_UNDERGROUND_DEMOTE_FAIL_THRESHOLD는 양의 정수다', () => {
    expect(Number.isInteger(BG_UNDERGROUND_DEMOTE_FAIL_THRESHOLD)).toBe(true);
    expect(BG_UNDERGROUND_DEMOTE_FAIL_THRESHOLD).toBeGreaterThan(0);
  });
});
