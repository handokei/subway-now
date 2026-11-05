import { isEndedMarkerOfOtherTrip } from '../tripStatusCorrId';

describe('isEndedMarkerOfOtherTrip', () => {
  it('둘 다 있고 다르면 true', () => {
    expect(isEndedMarkerOfOtherTrip('a', 'b')).toBe(true);
  });
  it('같으면 false', () => {
    expect(isEndedMarkerOfOtherTrip('a', 'a')).toBe(false);
  });
  it('marker corrId 없음(구 backend) → false', () => {
    expect(isEndedMarkerOfOtherTrip(undefined, 'b')).toBe(false);
  });
  it('현재 corrId 미상 → false', () => {
    expect(isEndedMarkerOfOtherTrip('a', null)).toBe(false);
  });
});
