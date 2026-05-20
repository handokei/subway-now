import { findNextStationOnLine } from '../findNextStationOnLine';
import type { Station } from '../../types/station';

const line2: Station[] = [
  { id: '2-001', name: '시청', nameEn: 'City Hall', line: '2', lineColor: '#009D3E', lat: 37.5642, lng: 126.9770 },
  { id: '2-002', name: '을지로입구', nameEn: 'Euljiro 1-ga', line: '2', lineColor: '#009D3E', lat: 37.5660, lng: 126.9826 },
  { id: '2-003', name: '을지로3가', nameEn: 'Euljiro 3-ga', line: '2', lineColor: '#009D3E', lat: 37.5660, lng: 126.9912 },
  { id: '2-022', name: '강남', nameEn: 'Gangnam', line: '2', lineColor: '#009D3E', lat: 37.4979, lng: 127.0276 },
  { id: '2-023', name: '선릉', nameEn: 'Seolleung', line: '2', lineColor: '#009D3E', lat: 37.5044, lng: 127.0491 },
];

const line7: Station[] = [
  { id: '7-001', name: '장암', nameEn: 'Jangam', line: '7', lineColor: '#747F00', lat: 37.7444, lng: 127.0743 },
  { id: '7-002', name: '도봉산', nameEn: 'Dobongsan', line: '7', lineColor: '#747F00', lat: 37.6896, lng: 127.0467 },
];

describe('findNextStationOnLine', () => {
  it('정방향 다음 역을 반환한다', () => {
    const next = findNextStationOnLine('2', '시청', '강남', line2);
    expect(next?.name).toBe('을지로입구');
  });

  it('역방향 다음 역을 반환한다', () => {
    const next = findNextStationOnLine('2', '강남', '시청', line2);
    expect(next?.name).toBe('을지로3가');
  });

  it('한 칸씩만 전진한다 — 종착역이 멀어도', () => {
    const next = findNextStationOnLine('2', '시청', '선릉', line2);
    expect(next?.name).toBe('을지로입구');
  });

  it('현재 역과 종착역이 같으면 null', () => {
    expect(findNextStationOnLine('2', '강남', '강남', line2)).toBeNull();
  });

  it('현재 역명이 호선에 없으면 null', () => {
    expect(findNextStationOnLine('2', '없는역', '강남', line2)).toBeNull();
  });

  it('종착역명이 호선에 없으면 null', () => {
    expect(findNextStationOnLine('2', '강남', '없는역', line2)).toBeNull();
  });

  it('호선에 역이 하나도 없으면 null', () => {
    expect(findNextStationOnLine('2', '강남', '시청', [])).toBeNull();
  });

  it('다른 호선 역은 무시한다', () => {
    const mixed: Station[] = [...line2, ...line7];
    const next = findNextStationOnLine('7', '장암', '도봉산', mixed);
    expect(next?.name).toBe('도봉산');
    expect(next?.line).toBe('7');
  });

});
