import {
  CROSS_CATEGORY_DEDUP_WINDOW_MS,
  _resetCrossCategoryDedupForTests,
  isStationRecentlyFired,
  markStationFired,
} from '../crossCategoryStationDedup';

type Category = Parameters<typeof markStationFired>[2];

describe('crossCategoryStationDedup (#1515)', () => {
  beforeEach(() => {
    _resetCrossCategoryDedupForTests();
  });

  it('returns false when no fire has been recorded', () => {
    expect(isStationRecentlyFired('dest-1', '성수', 'station-passed', 1_000)).toBe(false);
  });

  // (firstFired, secondQuery, expectedBlocked, label)
  // - cross-category within window → blocked
  // - same-category phase progression (destination→destination, destination→transfer) → NOT blocked
  // - station-passed → station-passed → blocked (FG GPS path / fast-path race fix)
  it.each<[Category, Category, boolean, string]>([
    ['destination', 'station-passed', true, 'cross-cat: destination → station-passed blocked'],
    ['station-passed', 'destination', true, 'cross-cat: station-passed → destination blocked'],
    ['station-passed', 'transfer', true, 'cross-cat: station-passed → transfer blocked'],
    ['destination', 'destination', false, 'same-cat phase progression: destination → destination NOT blocked'],
    ['destination', 'transfer', false, 'same-cat phase group: destination → transfer NOT blocked'],
    ['station-passed', 'station-passed', true, 'station-passed → station-passed blocked (FG fast-path race fix)'],
  ])('%s → %s within window: blocked=%s (%s)', (first, second, blocked) => {
    markStationFired('dest-1', '성수', first, 1_000);
    expect(isStationRecentlyFired('dest-1', '성수', second, 1_500)).toBe(blocked);
  });

  it('returns false once the window has elapsed', () => {
    markStationFired('dest-1', '성수', 'destination', 1_000);
    expect(
      isStationRecentlyFired(
        'dest-1',
        '성수',
        'station-passed',
        1_000 + CROSS_CATEGORY_DEDUP_WINDOW_MS,
      ),
    ).toBe(false);
  });

  it('isolates entries by destinationId', () => {
    markStationFired('dest-1', '성수', 'destination', 1_000);
    expect(isStationRecentlyFired('dest-2', '성수', 'station-passed', 1_500)).toBe(false);
  });

  it('isolates entries by stationName', () => {
    markStationFired('dest-1', '성수', 'destination', 1_000);
    expect(isStationRecentlyFired('dest-1', '왕십리', 'station-passed', 1_500)).toBe(false);
  });

  it('normalizes station name (parenthetical suffix)', () => {
    markStationFired('dest-1', '왕십리(성동구청)', 'destination', 1_000);
    expect(isStationRecentlyFired('dest-1', '왕십리', 'station-passed', 1_500)).toBe(true);
  });

  it('accepts custom window override', () => {
    markStationFired('dest-1', '성수', 'destination', 1_000);
    expect(isStationRecentlyFired('dest-1', '성수', 'station-passed', 1_500, 100)).toBe(false);
    expect(isStationRecentlyFired('dest-1', '성수', 'station-passed', 1_050, 100)).toBe(true);
  });

  it('updates the record on subsequent markStationFired (category overwrite)', () => {
    markStationFired('dest-1', '성수', 'destination', 1_000);
    // station-passed fired after — cross-cat with destination dedup'd by previous mark.
    markStationFired('dest-1', '성수', 'station-passed', 1_100);
    // Subsequent destination call must now see station-passed (latest) as previous → cross-cat block.
    expect(isStationRecentlyFired('dest-1', '성수', 'destination', 1_200)).toBe(true);
  });

  it('sweeps expired entries once the map exceeds the cap', () => {
    for (let i = 0; i < 260; i += 1) {
      markStationFired(`dest-${i}`, '역', 'destination', 0);
    }
    expect(isStationRecentlyFired('dest-0', '역', 'station-passed', 1)).toBe(true);
    markStationFired('dest-new', '역', 'destination', CROSS_CATEGORY_DEDUP_WINDOW_MS + 1);
    expect(
      isStationRecentlyFired(
        'dest-0',
        '역',
        'station-passed',
        CROSS_CATEGORY_DEDUP_WINDOW_MS + 1,
      ),
    ).toBe(false);
    expect(
      isStationRecentlyFired(
        'dest-new',
        '역',
        'station-passed',
        CROSS_CATEGORY_DEDUP_WINDOW_MS + 2,
      ),
    ).toBe(true);
  });
});
