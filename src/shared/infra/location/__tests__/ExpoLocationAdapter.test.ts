import { expoLocationAdapter } from '../ExpoLocationAdapter';
import * as Location from 'expo-location';

jest.mock('expo-location', () => ({
  getCurrentPositionAsync: jest.fn(),
  requestForegroundPermissionsAsync: jest.fn(),
}));

const getCurrentMock = Location.getCurrentPositionAsync as jest.Mock;
const requestForegroundMock = Location.requestForegroundPermissionsAsync as jest.Mock;

beforeEach(() => {
  getCurrentMock.mockReset();
  requestForegroundMock.mockReset();
});

describe('ExpoLocationAdapter.getCurrentPosition', () => {
  it('LocationFix로 좌표/타임스탬프를 정규화한다', async () => {
    getCurrentMock.mockResolvedValueOnce({
      coords: { latitude: 37.5, longitude: 127.0, accuracy: 12, speed: 5 },
      timestamp: 1700000000000,
    });

    const fix = await expoLocationAdapter.getCurrentPosition();

    expect(fix).toEqual({
      latitude: 37.5,
      longitude: 127.0,
      accuracy: 12,
      speed: 5,
      timestamp: 1700000000000,
    });
  });

  it('accuracy/speed가 누락되면 null로 정규화한다', async () => {
    getCurrentMock.mockResolvedValueOnce({
      coords: { latitude: 37.5, longitude: 127.0 },
      timestamp: 1700000000001,
    });

    const fix = await expoLocationAdapter.getCurrentPosition();

    expect(fix.accuracy).toBeNull();
    expect(fix.speed).toBeNull();
  });
});

describe('ExpoLocationAdapter.requestForegroundPermissions', () => {
  it('status granted이면 granted=true, background=false', async () => {
    requestForegroundMock.mockResolvedValueOnce({ status: 'granted' });
    const result = await expoLocationAdapter.requestForegroundPermissions();
    expect(result).toEqual({ granted: true, background: false });
  });

  it('status가 granted가 아니면 granted=false', async () => {
    requestForegroundMock.mockResolvedValueOnce({ status: 'denied' });
    const result = await expoLocationAdapter.requestForegroundPermissions();
    expect(result).toEqual({ granted: false, background: false });
  });
});
