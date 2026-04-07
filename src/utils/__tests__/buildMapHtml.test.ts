import { buildMapHtml } from '../buildMapHtml';
import { Station } from '../../types/station';

const mockStation: Station = {
  id: '2-022',
  name: '강남',
  line: '2',
  lineColor: '#009D3E',
  lat: 37.4979,
  lng: 127.0276,
};

const baseParams = {
  userLat: 37.4980,
  userLng: 127.0277,
  nearestStation: mockStation,
  nearbyStations: [mockStation],
  kakaoKey: 'test-key-123',
};

describe('buildMapHtml', () => {
  it('API 키가 없으면 안내 메시지 HTML을 반환한다', () => {
    const html = buildMapHtml({ ...baseParams, kakaoKey: '' });
    expect(html).toContain('카카오맵 API 키가 필요합니다');
    expect(html).not.toContain('dapi.kakao.com');
  });

  it('API 키가 있으면 카카오맵 SDK URL을 포함한다', () => {
    const html = buildMapHtml(baseParams);
    expect(html).toContain('dapi.kakao.com');
    expect(html).toContain('test-key-123');
  });

  it('사용자 좌표가 HTML에 포함된다', () => {
    const html = buildMapHtml(baseParams);
    expect(html).toContain('37.498');
    expect(html).toContain('127.0277');
  });

  it('주변 역 이름이 HTML에 포함된다', () => {
    const html = buildMapHtml(baseParams);
    expect(html).toContain('강남');
    expect(html).toContain('#009D3E');
  });

  it('nearbyStations가 빈 배열이면 역 마커 없이 정상 생성된다', () => {
    const html = buildMapHtml({ ...baseParams, nearbyStations: [] });
    expect(html).toContain('dapi.kakao.com');
    expect(html).toContain('[]');
  });

  it('nearestStation이 null이면 isNearest가 모두 false이다', () => {
    const html = buildMapHtml({ ...baseParams, nearestStation: null });
    expect(html).toContain('"isNearest":false');
  });

  it('nearestStation이 일치하면 isNearest가 true인 역이 포함된다', () => {
    const html = buildMapHtml(baseParams);
    expect(html).toContain('"isNearest":true');
  });
});
