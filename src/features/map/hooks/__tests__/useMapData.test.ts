import { renderHook } from '@testing-library/react-native';
import { useMapData } from '../useMapData';

describe('useMapData', () => {
  it('userLat/userLng가 null이면 nearbyStations가 빈 배열이다', () => {
    const { result } = renderHook(() => useMapData(null, null));
    expect(result.current.nearbyStations).toEqual([]);
  });

  it('userLat만 null이면 nearbyStations가 빈 배열이다', () => {
    const { result } = renderHook(() => useMapData(null, 127.0276));
    expect(result.current.nearbyStations).toEqual([]);
  });

  it('userLng만 null이면 nearbyStations가 빈 배열이다', () => {
    const { result } = renderHook(() => useMapData(37.4979, null));
    expect(result.current.nearbyStations).toEqual([]);
  });

  it('강남역 좌표에서 반경 1km 내 역이 반환된다', () => {
    // 강남역(37.4979, 127.0276) 주변에는 여러 역이 존재
    const { result } = renderHook(() => useMapData(37.4979, 127.0276, 1.0));
    expect(result.current.nearbyStations.length).toBeGreaterThan(0);
    const names = result.current.nearbyStations.map((s) => s.name);
    expect(names).toContain('강남');
  });

  it('반경을 0.01km로 매우 좁게 설정하면 역이 없거나 극히 적다', () => {
    const { result } = renderHook(() => useMapData(37.4979, 127.0276, 0.01));
    // 0.01km = 10m - 역이 정확히 그 안에 없으면 빈 배열
    expect(result.current.nearbyStations.length).toBeLessThanOrEqual(1);
  });

  it('반환된 역들은 모두 지정 반경 이내에 있다', () => {
    const { result } = renderHook(() => useMapData(37.5665, 126.9780, 1.0));
    const { haversine } = require('../../../../utils/haversine');
    for (const station of result.current.nearbyStations) {
      const dist = haversine(37.5665, 126.9780, station.lat, station.lng);
      expect(dist).toBeLessThanOrEqual(1.0);
    }
  });
});
