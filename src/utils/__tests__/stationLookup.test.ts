import { findLineByStationName } from '../stationLookup';

jest.mock('../../data/stations.json', () => [
  { id: '1-001', name: '서울역', line: '1', lineColor: '#0052A4', lat: 0, lng: 0 },
  { id: '4-001', name: '서울역', line: '4', lineColor: '#00A5DE', lat: 0, lng: 0 },
  { id: '2-001', name: '강남', line: '2', lineColor: '#00A84D', lat: 0, lng: 0 },
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
