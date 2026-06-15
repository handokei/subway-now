import {
  FUSION_DEBUG_BUFFER_CAPACITY,
  clearFusionDebugEntries,
  formatFusionDebugLine,
  getFusionDebugEntries,
  pushFusionDebugEntry,
  subscribeFusionDebug,
  type FusionDebugEntry,
} from '../fusionDebugBuffer';
import { getRegisteredDebugBuffers } from '../../../../shared/utils/debugBufferRegistry';

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

  // #1348 — formatter SSOT (DebugModal UI + share dump 양쪽에서 공유).
  describe('formatFusionDebugLine (#1348)', () => {
    it('fusion 결정 엔트리 — src/conf/station/distance/acc/candidates 포함', () => {
      const entry = makeFusionEntry({
        ts: new Date('2026-06-16T12:00:00Z').getTime(),
        source: 'position-train',
        confidence: 'boarding-lock',
        stationName: '용마산',
        line: '7',
        distanceKm: 0.123,
        gpsAccuracyAtPushMeters: 45,
        candidates: [
          { key: 'positionTrain', stationName: '용마산', line: '7', extra: { lockMatch: true } },
          { key: 'fused', stationName: '중곡', line: '7' },
        ],
      });
      const line = formatFusionDebugLine(entry);
      expect(line).toMatch(/src=position-train/);
      expect(line).toMatch(/conf=boarding-lock/);
      expect(line).toMatch(/용마산\(7\)/);
      // distance: 0.123km → 123m
      expect(line).toMatch(/d=123m/);
      // accuracy: 45m
      expect(line).toMatch(/acc=45m/);
      // candidate short form + LOCK marker
      expect(line).toMatch(/pt=용마산\[LOCK\]/);
      expect(line).toMatch(/fu=중곡/);
    });

    it('gps-drop 엔트리 — dropReason 포함', () => {
      const entry: FusionDebugEntry = {
        kind: 'gps',
        event: 'gps-drop',
        ts: new Date('2026-06-16T12:00:00Z').getTime(),
        lat: 37.5,
        lng: 127.0,
        accuracyMeters: 1500,
        speedMps: null,
        nearestStation: null,
        nearestLine: null,
        nearestDistanceKm: null,
        dropReason: 'low-accuracy-display',
      };
      const line = formatFusionDebugLine(entry);
      expect(line).toMatch(/gps-drop/);
      expect(line).toMatch(/reason=low-accuracy-display/);
      // nearest 없음 — '-' 표기.
      expect(line).toMatch(/\| - d=- acc=1500m/);
    });

    it('gps-fix 엔트리 — nearest 정보', () => {
      const entry: FusionDebugEntry = {
        kind: 'gps',
        event: 'gps-fix',
        ts: new Date('2026-06-16T12:00:00Z').getTime(),
        lat: 37.5,
        lng: 127.0,
        accuracyMeters: 20,
        speedMps: 0,
        nearestStation: '용마산',
        nearestLine: '7',
        nearestDistanceKm: 0.03,
      };
      const line = formatFusionDebugLine(entry);
      expect(line).toMatch(/용마산\(7\)/);
      expect(line).toMatch(/d=30m/);
      expect(line).toMatch(/acc=20m/);
      // dropReason 없으면 reason= 표기도 없음.
      expect(line).not.toMatch(/reason=/);
    });

    it('sticky 엔트리 — locked/unlocked event 포함', () => {
      const entry: FusionDebugEntry = {
        kind: 'sticky',
        event: 'locked',
        ts: new Date('2026-06-16T12:00:00Z').getTime(),
        stationName: '강남',
        line: '2',
        accuracyMeters: 15,
        speedMps: 8.5,
      };
      const line = formatFusionDebugLine(entry);
      expect(line).toMatch(/sticky:locked/);
      expect(line).toMatch(/강남\(2\)/);
      expect(line).toMatch(/acc=15m/);
      expect(line).toMatch(/sp=8\.5m\/s/);
    });

    it('fusion 결정 엔트리에서 candidates 비어있으면 - 표기', () => {
      const entry = makeFusionEntry({ candidates: [] });
      const line = formatFusionDebugLine(entry);
      expect(line).toMatch(/\| -$/);
    });

    it('fusion 결정 엔트리에서 line null이면 - 표기', () => {
      const entry = makeFusionEntry({
        stationName: '용마산',
        line: null,
        distanceKm: null,
        gpsAccuracyAtPushMeters: null,
      });
      const line = formatFusionDebugLine(entry);
      expect(line).toMatch(/용마산\(-\)/);
      expect(line).toMatch(/d=-/);
      expect(line).toMatch(/acc=-/);
    });

    it('fusion 결정 엔트리에서 stationName null이면 - 표기', () => {
      const entry = makeFusionEntry({ stationName: null, line: null });
      const line = formatFusionDebugLine(entry);
      // station 자리에 -
      expect(line).toMatch(/\| - d=/);
    });

    it('sticky 엔트리에서 accuracy/speed null이면 - 표기', () => {
      const entry: FusionDebugEntry = {
        kind: 'sticky',
        event: 'unlocked-ttl',
        ts: 0,
        stationName: '강남',
        line: '2',
        accuracyMeters: null,
        speedMps: null,
      };
      const line = formatFusionDebugLine(entry);
      expect(line).toMatch(/acc=-/);
      expect(line).toMatch(/sp=-/);
    });

    it('알 수 없는 candidate key는 그대로 표시 (확장성)', () => {
      const entry = makeFusionEntry({
        candidates: [
          { key: 'wifiSsid', stationName: '잠실', line: '2' },
        ],
      });
      const line = formatFusionDebugLine(entry);
      expect(line).toMatch(/wifiSsid=잠실/);
    });
  });

  describe('registerDebugBuffer wiring (#1348)', () => {
    it('module import 시 share dump registry에 등록된다', () => {
      const sources = getRegisteredDebugBuffers();
      const fusion = sources.find((s) => s.key === 'Fusion log');
      expect(fusion).toBeDefined();
    });

    it('등록된 dumpLines가 현재 buffer 엔트리들을 포맷한다', () => {
      pushFusionDebugEntry(makeFusionEntry({ stationName: 'X', line: '1' }));
      const sources = getRegisteredDebugBuffers();
      const fusion = sources.find((s) => s.key === 'Fusion log');
      const lines = fusion?.dumpLines() ?? [];
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/X\(1\)/);
    });
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
});
