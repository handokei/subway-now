import { findLineByStationName, findStationByName } from '../stationLookup';

jest.mock('../../data/stations.json', () => [
  { id: '1-001', name: '서울역', line: '1', lineColor: '#0052A4', lat: 37.5547, lng: 126.9706 },
  { id: '4-001', name: '서울역', line: '4', lineColor: '#00A5DE', lat: 37.5547, lng: 126.9706 },
  { id: '2-001', name: '강남', line: '2', lineColor: '#00A84D', lat: 37.4979, lng: 127.0276 },
]);

describe('findLineByStationName', () => {
  it('returns the line of the first matching station', () => {
    expect(findLineByStationName('강남')).toBe('2');
  });

  it('returns the first registered line for transfer stations', () => {
    expect(findLineByStationName('서울역')).toBe('1');
  });

  it('returns null for unknown station names', () => {
    expect(findLineByStationName('없는역')).toBeNull();
  });
});

describe('findStationByName', () => {
  it('역명으로 첫 매칭 Station(좌표 포함) 반환', () => {
    const result = findStationByName('강남');
    expect(result).toMatchObject({ id: '2-001', name: '강남', lat: 37.4979, lng: 127.0276 });
  });

  it('환승역은 등록 순서상 첫 호선 반환', () => {
    const result = findStationByName('서울역');
    expect(result?.line).toBe('1');
  });

  it('없는 역명은 null', () => {
    expect(findStationByName('없는역')).toBeNull();
  });
});
