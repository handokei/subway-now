import {
  FUSION_DEBUG_BUFFER_CAPACITY,
  clearFusionDebugEntries,
  getFusionDebugEntries,
  pushFusionDebugEntry,
  subscribeFusionDebug,
  type FusionDebugEntry,
} from '../fusionDebugBuffer';

function makeFusionEntry(overrides: Partial<FusionDebugEntry> = {}): FusionDebugEntry {
  return {
    kind: 'fusion',
    ts: Date.now(),
    source: 'gps',
    confidence: 'gps-only',
    stationName: '용마산',
    line: '7',
    distanceKm: 0.05,
    gpsAccuracyAtPushMeters: 30,
    candidates: [],
    ...(overrides as object),
  } as FusionDebugEntry;
}

describe('fusionDebugBuffer', () => {
  beforeEach(() => {
    clearFusionDebugEntries();
  });

  it('pushes and reads entries in order', () => {
    pushFusionDebugEntry(makeFusionEntry({ stationName: 'A' }));
    pushFusionDebugEntry(makeFusionEntry({ stationName: 'B' }));
    const entries = getFusionDebugEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].kind).toBe('fusion');
    expect((entries[0] as { stationName: string }).stationName).toBe('A');
  });

  it('caps at capacity, dropping oldest', () => {
    for (let i = 0; i < FUSION_DEBUG_BUFFER_CAPACITY + 5; i++) {
      pushFusionDebugEntry(makeFusionEntry({ stationName: `S${i}` }));
    }
    const entries = getFusionDebugEntries();
    expect(entries).toHaveLength(FUSION_DEBUG_BUFFER_CAPACITY);
    expect((entries[0] as { stationName: string }).stationName).toBe('S5');
  });

  it('clears entries', () => {
    pushFusionDebugEntry(makeFusionEntry());
    clearFusionDebugEntries();
    expect(getFusionDebugEntries()).toHaveLength(0);
  });

  it('no-ops clear when already empty (no listener fire)', () => {
    const listener = jest.fn();
    const unsub = subscribeFusionDebug(listener);
    clearFusionDebugEntries();
    expect(listener).not.toHaveBeenCalled();
    unsub();
  });

  it('notifies subscribers on push and clear, unsubscribe stops notifications', () => {
    const listener = jest.fn();
    const unsub = subscribeFusionDebug(listener);
    pushFusionDebugEntry(makeFusionEntry());
    expect(listener).toHaveBeenCalledTimes(1);
    pushFusionDebugEntry(makeFusionEntry());
    expect(listener).toHaveBeenCalledTimes(2);
    clearFusionDebugEntries();
    expect(listener).toHaveBeenCalledTimes(3);
    unsub();
    pushFusionDebugEntry(makeFusionEntry());
    expect(listener).toHaveBeenCalledTimes(3);
  });

  // #1902 (RC-18) — candidate-reject 별 buffer(candidateRejectBuffer.ts)로 이전.
  // fusionDebugBuffer는 fusion/gps/sticky 3 kind만 다룬다. candidate-reject 테스트는
  // utils/__tests__/candidateRejectBuffer.test.ts 참조.

  it('accepts gps-fix and gps-drop entries', () => {
    pushFusionDebugEntry({
      kind: 'gps',
      event: 'gps-fix',
      ts: 1,
      lat: 37.5,
      lng: 127.0,
      accuracyMeters: 20,
      speedMps: 0,
      nearestStation: '용마산',
      nearestLine: '7',
      nearestDistanceKm: 0.03,
    });
    pushFusionDebugEntry({
      kind: 'gps',
      event: 'gps-drop',
      ts: 2,
      lat: 37.5,
      lng: 127.0,
      accuracyMeters: 1500,
      speedMps: null,
      nearestStation: null,
      nearestLine: null,
      nearestDistanceKm: null,
      dropReason: 'low-accuracy-display',
    });
    const entries = getFusionDebugEntries();
    expect(entries).toHaveLength(2);
    expect((entries[0] as { event: string }).event).toBe('gps-fix');
    expect((entries[1] as { event: string }).event).toBe('gps-drop');
  });

  // #1896 (RC-8) boarding-lock-drift entries는 별 buffer(`boardingLockDriftBuffer`)로 분리됐다.
  // 해당 테스트는 `boardingLockDriftBuffer.test.ts` 참조.
});
