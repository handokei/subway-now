import { forwardWaypointStations } from '../forwardWaypointStations';

const S0 = { id: 'S0', name: 'A', line: '2' as const, lat: 0, lng: 0, lineColor: '#000000' };
const S1 = { id: 'S1', name: 'B', line: '2' as const, lat: 0, lng: 0, lineColor: '#000000' };
const S2 = { id: 'S2', name: 'C', line: '2' as const, lat: 0, lng: 0, lineColor: '#000000' };
const S3 = { id: 'S3', name: 'D', line: '2' as const, lat: 0, lng: 0, lineColor: '#000000' };
const ARC = [S0, S1, S2, S3];

describe('forwardWaypointStations', () => {
  it('anchor 다음 N개 station을 반환한다', () => {
    expect(forwardWaypointStations(ARC, 'S0', 2)).toEqual([S1, S2]);
  });

  it('anchor가 마지막 station이면 빈 배열을 반환한다', () => {
    expect(forwardWaypointStations(ARC, 'S3', 2)).toEqual([]);
  });

  it('anchor가 arcStations에서 발견되지 않으면 빈 배열을 반환한다', () => {
    expect(forwardWaypointStations(ARC, 'UNKNOWN', 2)).toEqual([]);
  });

  it('남은 station 수가 count보다 적으면 있는 만큼만 반환한다', () => {
    expect(forwardWaypointStations(ARC, 'S2', 2)).toEqual([S3]);
  });

  it('count가 0이면 빈 배열을 반환한다', () => {
    expect(forwardWaypointStations(ARC, 'S0', 0)).toEqual([]);
  });

  it('count가 음수여도 예외 없이 빈 배열을 반환한다', () => {
    expect(forwardWaypointStations(ARC, 'S0', -1)).toEqual([]);
  });
});
