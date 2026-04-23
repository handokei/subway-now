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
  it('Kakao Maps SDK 스크립트를 API 키와 함께 포함한다', () => {
    const html = buildMapHtml(base);
    expect(html).toContain('dapi.kakao.com/v2/maps/sdk.js?appkey=test-key');
  });

  it('사용자 위치를 중심 좌표로 설정한다', () => {
    const html = buildMapHtml(base);
    expect(html).toContain('new kakao.maps.LatLng(37.498, 127.027)');
  });

  it('사용자 위치 마커를 포함한다', () => {
    const html = buildMapHtml(base);
    expect(html).toContain('background:#4A90D9');
  });

  it('각 역의 마커를 생성한다', () => {
    const html = buildMapHtml(base);
    expect(html).toContain('addMarker(map, 37.4979, 127.0276');
    expect(html).toContain('addMarker(map, 37.5044, 127.0491');
  });

  it('nearestStation 마커는 크기 36, 나머지는 24이다', () => {
    const html = buildMapHtml(base);
    expect(html).toContain('addMarker(map, 37.4979, 127.0276, "#009D3E", 36, 3');
    expect(html).toContain('addMarker(map, 37.5044, 127.0491, "#009D3E", 24, 2');
  });

  it('nearestStation이 null이면 모든 마커 크기가 24이다', () => {
    const html = buildMapHtml({ ...base, nearestStation: null });
    expect(html).toContain('addMarker(map, 37.4979, 127.0276, "#009D3E", 24, 2');
    expect(html).toContain('addMarker(map, 37.5044, 127.0491, "#009D3E", 24, 2');
  });

  it('nearbyStations가 빈 배열이면 역 마커 호출이 없다', () => {
    const html = buildMapHtml({ ...base, nearbyStations: [] });
    expect(html).not.toContain('addMarker(map, 37');
    expect(html).toContain('kakao.maps.load');
  });

  it('역 lineColor가 마커에 적용된다', () => {
    const custom: Station = { ...station, lineColor: '#FF0000' };
    const html = buildMapHtml({ ...base, nearbyStations: [custom], nearestStation: null });
    expect(html).toContain('"#FF0000"');
  });

  it('마커 클릭 시 postMessage에 stationPress 타입과 station 데이터가 포함된다', () => {
    const html = buildMapHtml(base);
    expect(html).toContain('ReactNativeWebView.postMessage');
    expect(html).toContain("'stationPress'");
  });

  it('역 이름이 마커 캡션에 포함된다', () => {
    const html = buildMapHtml(base);
    expect(html).toContain('"강남"');
    expect(html).toContain('"선릉"');
  });
});
