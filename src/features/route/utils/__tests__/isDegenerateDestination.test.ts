import { isDegenerateDestination } from '../isDegenerateDestination';
import { Station } from '../../../../shared/types/station';

const gangnam: Station = {
  id: '2-022',
  name: '강남',
  line: '2',
  lineColor: '#009D3E',
  lat: 37.4979,
  lng: 127.0276,
};

const yeoksam: Station = {
  id: '2-021',
  name: '역삼',
  line: '2',
  lineColor: '#009D3E',
  lat: 37.5006,
  lng: 127.0365,
};

describe('isDegenerateDestination (#1324)', () => {
  it('출발역과 목적지가 같은 id면 degenerate(true)', () => {
    expect(isDegenerateDestination(gangnam, gangnam)).toBe(true);
    // 같은 역이지만 다른 객체 참조라도 id 기준으로 판정.
    expect(isDegenerateDestination({ ...gangnam }, gangnam)).toBe(true);
  });

  it('출발역과 목적지가 다른 역이면 false', () => {
    expect(isDegenerateDestination(gangnam, yeoksam)).toBe(false);
  });

  it('origin이 null이면 비교 불가 → false(통과)', () => {
    expect(isDegenerateDestination(null, gangnam)).toBe(false);
  });

  it('origin이 undefined여도 false(통과)', () => {
    expect(isDegenerateDestination(undefined, gangnam)).toBe(false);
  });
});
