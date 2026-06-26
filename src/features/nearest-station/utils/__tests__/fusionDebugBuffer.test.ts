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

  it('#1616 (R12-a) accepts candidate-reject entries with distance/trainNo/reason', () => {
    pushFusionDebugEntry({
      kind: 'candidate-reject',
      ts: 100,
      reason: 'candidate-distance',
      trainNo: 'T-9001',
      stationName: '강변(동서울터미널)',
      line: '2',
      distanceKm: 5.4,
    });
    const entries = getFusionDebugEntries();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.kind).toBe('candidate-reject');
    expect((entry as { trainNo: string }).trainNo).toBe('T-9001');
    expect((entry as { distanceKm: number }).distanceKm).toBe(5.4);
  });

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

  it('#1896 (RC-8) accepts boarding-lock-drift entries with branch/drift fields', () => {
    // GPS drift > 1km 시 lock 1순위 포기 이벤트 타입 회귀 방지.
    pushFusionDebugEntry({
      kind: 'boarding-lock-drift',
      ts: 1_700_000_000_000,
      branch: 'positionTrain',
      lockStationName: '동대문역사문화공원',
      lockStationLine: '2',
      driftMeters: 1020,
    });
    pushFusionDebugEntry({
      kind: 'boarding-lock-drift',
      ts: 1_700_000_001_000,
      branch: 'arvlCdArrived',
      lockStationName: '신당',
      lockStationLine: '2',
      driftMeters: null, // GPS 없는 케이스
    });
    const entries = getFusionDebugEntries();
    expect(entries).toHaveLength(2);

    const first = entries[0] as { kind: string; branch: string; driftMeters: number | null };
    expect(first.kind).toBe('boarding-lock-drift');
    expect(first.branch).toBe('positionTrain');
    expect(first.driftMeters).toBe(1020);

    const second = entries[1] as { kind: string; branch: string; driftMeters: number | null };
    expect(second.kind).toBe('boarding-lock-drift');
    expect(second.branch).toBe('arvlCdArrived');
    expect(second.driftMeters).toBeNull();
  });
});
