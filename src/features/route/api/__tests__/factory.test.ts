import { createTimetableProvider } from '../factory';
import { StaticTimetableProvider } from '../StaticTimetableProvider';

describe('createTimetableProvider', () => {
  it('returns StaticTimetableProvider as 1차 default (#1480 1순위 — endpoint stub은 follow-up)', () => {
    const provider = createTimetableProvider();
    expect(provider).toBeInstanceOf(StaticTimetableProvider);
    expect(provider.source).toBe('static');
  });
});
