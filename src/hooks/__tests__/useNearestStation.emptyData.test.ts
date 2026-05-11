import { renderHook, waitFor } from '@testing-library/react-native';
import * as Location from 'expo-location';

jest.mock('expo-location');
jest.mock('../../../src/data/stations.json', () => []);

import { useNearestStation } from '../useNearestStation';

describe('useNearestStation - 역 데이터 없는 경우', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    (Location.requestForegroundPermissionsAsync as jest.Mock).mockResolvedValue({
      status: 'granted',
    });
    (Location.getCurrentPositionAsync as jest.Mock).mockResolvedValue({
      coords: { latitude: 37.4980, longitude: 127.0277 },
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('역 데이터가 없으면 null을 반환한다', async () => {
    const { result } = renderHook(() => useNearestStation());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.result).toBeNull();
  });
});
