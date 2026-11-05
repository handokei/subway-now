import { GPS_SPEED_INVALID, isValidGpsSpeedMps } from '../location';

describe('GPS_SPEED_INVALID', () => {
  it('iOS CoreLocation 무효값(-1)을 그대로 export한다', () => {
    expect(GPS_SPEED_INVALID).toBe(-1);
  });
});

describe('isValidGpsSpeedMps', () => {
  it('null/undefined는 invalid', () => {
    expect(isValidGpsSpeedMps(null)).toBe(false);
    expect(isValidGpsSpeedMps(undefined)).toBe(false);
  });

  it('GPS_SPEED_INVALID(-1) 등 음수는 invalid', () => {
    expect(isValidGpsSpeedMps(GPS_SPEED_INVALID)).toBe(false);
    expect(isValidGpsSpeedMps(-0.001)).toBe(false);
  });

  it('0(정지)과 양수(이동)는 valid', () => {
    expect(isValidGpsSpeedMps(0)).toBe(true);
    expect(isValidGpsSpeedMps(1.5)).toBe(true);
    expect(isValidGpsSpeedMps(20)).toBe(true);
  });
});
