import { buildMapConfig } from '../buildMapConfig';
import type { Station } from '../../../../shared/types/station';

const gangnam: Station = {
  id: '2-022',
  name: '강남',
  line: '2',
  lineColor: '#009D3E',
  lat: 37.4979,
  lng: 127.0276,
};

const seolleung: Station = {
  id: '2-023',
  name: '선릉',
  line: '2',
  lineColor: '#009D3E',
  lat: 37.5044,
  lng: 127.0491,
};

const cheongguL5: Station = {
  id: '5-540',
  name: '청구',
  line: '5',
  lineColor: '#996CAC',
  lat: 37.5605,
  lng: 127.0136,
};

const cheongguL6: Station = {
  id: '6-636',
  name: '청구',
  line: '6',
  lineColor: '#CD7C2F',
  lat: 37.5605,
  lng: 127.0136,
};

const base = {
  userLat: 37.498,
  userLng: 127.027,
  nearestStation: gangnam,
  nearbyStations: [gangnam, seolleung],
};

describe('buildMapConfig', () => {
  it('userLat/Lng를 보존한다', () => {
    const config = buildMapConfig(base);
    expect(config.userLat).toBe(37.498);
    expect(config.userLng).toBe(127.027);
  });

  it('역마다 1개의 그룹을 만든다 (단일 호선)', () => {
    const config = buildMapConfig(base);
    expect(config.groups).toHaveLength(2);
  });

  it('동일 정규화 이름은 한 그룹으로 묶고 호선별 station을 stations에 담는다', () => {
    const config = buildMapConfig({
      ...base,
      nearestStation: null,
      nearbyStations: [cheongguL5, cheongguL6],
    });
    expect(config.groups).toHaveLength(1);
    expect(config.groups[0].stations).toHaveLength(2);
    expect(config.groups[0].representativeName).toBe('청구');
  });

  it('nearestStation이 속한 그룹에만 isNearest=true', () => {
    const config = buildMapConfig(base);
    const nearestGroup = config.groups.find((g) =>
      g.stations.some((s) => s.id === gangnam.id),
    );
    const otherGroup = config.groups.find((g) =>
      g.stations.some((s) => s.id === seolleung.id),
    );
    expect(nearestGroup?.isNearest).toBe(true);
    expect(otherGroup?.isNearest).toBe(false);
  });

  it('nearestStation이 null이면 모든 그룹의 isNearest는 false', () => {
    const config = buildMapConfig({ ...base, nearestStation: null });
    expect(config.groups.every((g) => !g.isNearest)).toBe(true);
  });

  it('nearbyStations가 비면 groups도 빈 배열', () => {
    const config = buildMapConfig({ ...base, nearbyStations: [] });
    expect(config.groups).toEqual([]);
  });
});
