import { dayTypeToWeekTag, directionToInoutTag } from '../TimetableProvider';

describe('TimetableProvider mappings (#1480 정정 2 — getTrainSch 1순위 cascade 후속 구현용)', () => {
  describe('dayTypeToWeekTag', () => {
    it.each([
      ['weekday', 1],
      ['saturday', 2],
      ['sunday', 3],
    ] as const)('%s → %d', (dayType, expected) => {
      expect(dayTypeToWeekTag(dayType)).toBe(expected);
    });
  });

  describe('directionToInoutTag', () => {
    it.each([
      ['up', 1],
      ['down', 2],
    ] as const)('%s → %d', (direction, expected) => {
      expect(directionToInoutTag(direction)).toBe(expected);
    });
  });
});
