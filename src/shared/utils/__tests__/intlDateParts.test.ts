import { getDatePart, getDateParts, getWeekdayShort } from '../intlDateParts';

describe('intlDateParts', () => {
  const date = new Date('2026-06-10T03:00:00Z'); // KST 12:00 Wed

  describe('getDatePart', () => {
    it('extracts the requested part', () => {
      expect(getDatePart(date, { timeZone: 'Asia/Seoul', weekday: 'short' }, 'weekday')).toBe('Wed');
    });

    it('returns null when the requested part is missing from the result', () => {
      // weekday option만 줬는데 hour part를 찾으면 누락 → null.
      expect(getDatePart(date, { timeZone: 'Asia/Seoul', weekday: 'short' }, 'hour')).toBeNull();
    });

    it('returns null when DateTimeFormat throws (invalid timeZone)', () => {
      expect(getDatePart(date, { timeZone: 'Not/AZone', weekday: 'short' }, 'weekday')).toBeNull();
    });

    it('returns null when formatToParts itself throws', () => {
      const spy = jest
        .spyOn(Intl.DateTimeFormat.prototype, 'formatToParts')
        .mockImplementationOnce(() => {
          throw new Error('hermes regression');
        });
      expect(getDatePart(date, { timeZone: 'Asia/Seoul', weekday: 'short' }, 'weekday')).toBeNull();
      spy.mockRestore();
    });
  });

  describe('getDateParts', () => {
    it('extracts multiple parts in a single call', () => {
      const parts = getDateParts(
        date,
        { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false },
        ['hour', 'minute'],
      );
      expect(parts.hour).toBe('12');
      expect(parts.minute).toBe('00');
    });

    it('omits keys whose parts were not produced', () => {
      const parts = getDateParts(
        date,
        { timeZone: 'Asia/Seoul', weekday: 'short' },
        ['weekday', 'hour'],
      );
      expect(parts.weekday).toBe('Wed');
      expect(parts.hour).toBeUndefined();
    });

    it('returns an empty object when DateTimeFormat throws', () => {
      const spy = jest
        .spyOn(Intl.DateTimeFormat.prototype, 'formatToParts')
        .mockImplementationOnce(() => {
          throw new Error('hermes regression');
        });
      expect(
        getDateParts(date, { timeZone: 'Asia/Seoul', weekday: 'short' }, ['weekday']),
      ).toEqual({});
      spy.mockRestore();
    });
  });

  describe('getWeekdayShort', () => {
    it('returns short weekday in the requested timezone', () => {
      expect(getWeekdayShort(date, 'Asia/Seoul')).toBe('Wed');
    });

    it('returns null when the weekday part is missing (Hermes regression)', () => {
      const spy = jest
        .spyOn(Intl.DateTimeFormat.prototype, 'formatToParts')
        .mockImplementationOnce(() => [
          { type: 'literal', value: '' },
        ]);
      expect(getWeekdayShort(date, 'Asia/Seoul')).toBeNull();
      spy.mockRestore();
    });
  });
});
