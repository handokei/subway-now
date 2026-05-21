import {
  isMajorGroup,
  LINE_ENDPOINT_IDS,
  MAJOR_ONLY_LATITUDE_DELTA,
} from '../majorStation';
import type { Station } from '../../types/station';
import type { StationGroup } from '../groupStationsByName';

const mid: Station = {
  id: '2-022',
  name: '강남',
  nameEn: 'Gangnam',
  line: '2',
  lineColor: '#009D3E',
  lat: 37.4979,
  lng: 127.0276,
};
const otherLine: Station = {
  id: 'sinbundang-013',
  name: '강남',
  nameEn: 'Gangnam',
  line: 'sinbundang',
  lineColor: '#D31145',
  lat: 37.4979,
  lng: 127.0276,
};
// 2호선 종점
const endpoint: Station = {
  id: '2-001',
  name: '시청',
  nameEn: 'City Hall',
  line: '2',
  lineColor: '#009D3E',
  lat: 37.5642,
  lng: 126.9774,
};

function group(stations: Station[]): StationGroup {
  return {
    key: stations[0].name,
    representativeName: stations[0].name,
    lat: stations[0].lat,
    lng: stations[0].lng,
    stations,
  };
}

describe('majorStation', () => {
  it('환승역(멤버 2개 이상)은 major로 판정', () => {
    expect(isMajorGroup(group([mid, otherLine]))).toBe(true);
  });

  it('종착역 단일 멤버는 major로 판정', () => {
    expect(isMajorGroup(group([endpoint]))).toBe(true);
  });

  it('일반 단일역(중간역)은 major가 아님', () => {
    expect(isMajorGroup(group([mid]))).toBe(false);
  });

  it('LINE_ENDPOINT_IDS는 stations.json의 호선별 첫/마지막 id를 포함', () => {
    expect(LINE_ENDPOINT_IDS.has('2-001')).toBe(true);
    expect(LINE_ENDPOINT_IDS.has('2-043')).toBe(true);
    expect(LINE_ENDPOINT_IDS.has('2-022')).toBe(false);
  });

  it('MAJOR_ONLY_LATITUDE_DELTA는 초기 region(0.05)보다 큰 값', () => {
    expect(MAJOR_ONLY_LATITUDE_DELTA).toBeGreaterThan(0.05);
  });
});
