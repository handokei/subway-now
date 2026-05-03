import { buildMapConfig, buildInjectedJS } from '../buildMapConfig';
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
  apiKey: 'test-key',
  userLat: 37.498,
  userLng: 127.027,
  nearestStation: station,
  nearbyStations: [station, another],
};

describe('buildMapConfig', () => {
  it('설정 객체를 생성한다', () => {
    const config = buildMapConfig(base);
    expect(config.apiKey).toBe('test-key');
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

describe('buildInjectedJS', () => {
  it('SDK script src 설정 코드를 포함한다', () => {
    const config = buildMapConfig(base);
    const js = buildInjectedJS(config);
    expect(js).toContain('dapi.kakao.com/v2/maps/sdk.js?appkey=test-key');
    expect(js).toContain('libraries=clusterer');
  });

  it('initMap 호출 코드를 포함한다', () => {
    const config = buildMapConfig(base);
    const js = buildInjectedJS(config);
    expect(js).toContain('window.initMap');
  });

  it('좌표 데이터를 JSON으로 포함한다', () => {
    const config = buildMapConfig(base);
    const js = buildInjectedJS(config);
    expect(js).toContain('"userLat":37.498');
    expect(js).toContain('"userLng":127.027');
  });

  it('역 데이터를 JSON으로 포함한다', () => {
    const config = buildMapConfig(base);
    const js = buildInjectedJS(config);
    expect(js).toContain('"name":"강남"');
    expect(js).toContain('"name":"선릉"');
  });

  it('SDK 로드 대기 로직을 포함한다', () => {
    const config = buildMapConfig(base);
    const js = buildInjectedJS(config);
    expect(js).toContain('setInterval');
    expect(js).toContain('clearInterval');
  });

  it('true를 반환하여 injectedJavaScript 규약을 준수한다', () => {
    const config = buildMapConfig(base);
    const js = buildInjectedJS(config);
    expect(js.trim().endsWith('true;')).toBe(true);
  });
});
