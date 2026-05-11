import { buildMapConfig } from '../buildMapConfig';
import type { Station } from '../../types/station';

const station: Station = {
  id: '2-022',
  name: '강남',
  line: '2',
  lineColor: '#009D3E',
  lat: 37.4979,
  lng: 127.0276,
};

const another: Station = {
  id: '2-023',
  name: '선릉',
  line: '2',
  lineColor: '#009D3E',
  lat: 37.5044,
  lng: 127.0491,
};

const base = {
  userLat: 37.498,
  userLng: 127.027,
  nearestStation: station,
  nearbyStations: [station, another],
};

describe('buildMapConfig', () => {
  it('설정 객체를 생성한다', () => {
    const config = buildMapConfig(base);
    expect(config.userLat).toBe(37.498);
    expect(config.userLng).toBe(127.027);
    expect(config.stations).toHaveLength(2);
  });

  it('nearestStation에 isNearest 플래그를 설정한다', () => {
    const config = buildMapConfig(base);
    expect(config.stations[0].isNearest).toBe(true);
    expect(config.stations[1].isNearest).toBe(false);
  });

  it('nearestStation이 null이면 모든 역이 isNearest false이다', () => {
    const config = buildMapConfig({ ...base, nearestStation: null });
    expect(config.stations.every((s) => !s.isNearest)).toBe(true);
  });

  it('nearbyStations가 빈 배열이면 stations도 빈 배열이다', () => {
    const config = buildMapConfig({ ...base, nearbyStations: [] });
    expect(config.stations).toEqual([]);
  });

  it('역 데이터를 그대로 포함한다', () => {
    const config = buildMapConfig(base);
    expect(config.stations[0].name).toBe('강남');
    expect(config.stations[0].lineColor).toBe('#009D3E');
  });
});
