import { buildMapHtml } from '../buildMapHtml';
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

describe('buildMapHtml', () => {
  it('Kakao Maps SDK 스크립트를 API 키와 clusterer 라이브러리 함께 포함한다', () => {
    const html = buildMapHtml(base);
    expect(html).toContain('dapi.kakao.com/v2/maps/sdk.js?appkey=test-key');
    expect(html).toContain('libraries=clusterer');
  });

  it('사용자 위치를 중심 좌표로 설정한다', () => {
    const html = buildMapHtml(base);
    expect(html).toContain('new kakao.maps.LatLng(37.498, 127.027)');
  });

  it('사용자 위치 마커를 포함한다', () => {
    const html = buildMapHtml(base);
    expect(html).toContain('background:#4A90D9');
  });

  it('MarkerClusterer를 생성한다', () => {
    const html = buildMapHtml(base);
    expect(html).toContain('kakao.maps.MarkerClusterer');
  });

  it('역 데이터가 JSON으로 포함된다', () => {
    const html = buildMapHtml(base);
    expect(html).toContain('"name":"강남"');
    expect(html).toContain('"name":"선릉"');
  });

  it('nearestStation 표시를 위한 isNearest 플래그가 포함된다', () => {
    const html = buildMapHtml(base);
    const parsed = html.match(/var stations = (\[.*?\]);/s);
    expect(parsed).toBeTruthy();
    const stations = JSON.parse(parsed![1]);
    expect(stations[0].isNearest).toBe(true);
    expect(stations[1].isNearest).toBe(false);
  });

  it('nearestStation이 null이면 모든 역이 isNearest false이다', () => {
    const html = buildMapHtml({ ...base, nearestStation: null });
    const parsed = html.match(/var stations = (\[.*?\]);/s);
    const stations = JSON.parse(parsed![1]);
    expect(stations.every((s: { isNearest: boolean }) => !s.isNearest)).toBe(true);
  });

  it('nearbyStations가 빈 배열이면 빈 JSON 배열이 포함된다', () => {
    const html = buildMapHtml({ ...base, nearbyStations: [] });
    expect(html).toContain('var stations = [];');
    expect(html).toContain('kakao.maps.load');
  });

  it('마커 클릭 시 postMessage에 stationPress 타입이 포함된다', () => {
    const html = buildMapHtml(base);
    expect(html).toContain('stationPress');
    expect(html).toContain('ReactNativeWebView');
  });

  it('SDK 에러 핸들러가 포함된다', () => {
    const html = buildMapHtml(base);
    expect(html).toContain('window.onerror');
    expect(html).toContain('try');
    expect(html).toContain('catch');
  });

  it('mapLoaded 메시지를 전송한다', () => {
    const html = buildMapHtml(base);
    expect(html).toContain('mapLoaded');
  });
});
