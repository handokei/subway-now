import {
  GPS_DROP_BUFFER_CAPACITY,
  clearGpsDropEntries,
  getGpsDropEntries,
  pushGpsDropEntry,
  subscribeGpsDrop,
} from '../gpsDropBuffer';

function makeDrop(overrides: Partial<Parameters<typeof pushGpsDropEntry>[0]> = {}) {
  return {
    ts: Date.now(),
    lat: 37.5,
    lng: 127,
    accuracyMeters: 1500,
    speedMps: null,
    dropReason: 'low-accuracy-display',
    ...overrides,
  };
}

describe('gpsDropBuffer', () => {
  beforeEach(() => {
    clearGpsDropEntries();
  });

  it('pushes and reads entries in order', () => {
    pushGpsDropEntry(makeDrop({ ts: 1 }));
    pushGpsDropEntry(makeDrop({ ts: 2 }));
    const entries = getGpsDropEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].ts).toBe(1);
    expect(entries[1].ts).toBe(2);
  });

  it('caps at GPS_DROP_BUFFER_CAPACITY, dropping oldest', () => {
    for (let i = 0; i < GPS_DROP_BUFFER_CAPACITY + 3; i += 1) {
      pushGpsDropEntry(makeDrop({ ts: i }));
    }
    const entries = getGpsDropEntries();
    expect(entries).toHaveLength(GPS_DROP_BUFFER_CAPACITY);
    expect(entries[0].ts).toBe(3);
  });

  it('clears entries', () => {
    pushGpsDropEntry(makeDrop());
    clearGpsDropEntries();
    expect(getGpsDropEntries()).toHaveLength(0);
  });

  it('notifies subscribers on push and unsubscribe stops notifications', () => {
    const listener = jest.fn();
    const unsub = subscribeGpsDrop(listener);
    pushGpsDropEntry(makeDrop());
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    pushGpsDropEntry(makeDrop());
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('no-ops clear when already empty (no listener fire)', () => {
    const listener = jest.fn();
    const unsub = subscribeGpsDrop(listener);
    clearGpsDropEntries();
    expect(listener).not.toHaveBeenCalled();
    unsub();
  });
});
