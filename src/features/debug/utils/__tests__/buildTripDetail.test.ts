/**
 * buildTripDetail (#1956, S-m3-1 P0) 단위 테스트.
 *
 * 커버:
 *   - tripToken=null → null
 *   - 매칭 entries 0건 → null
 *   - tripToken='unknown' → corrId=null entries만 그룹화
 *   - 매칭 entries 1+건 → firstTs/lastTs/duration/kindCounts 정확 산출
 *   - entries 정렬 — 최신순(ts 내림차순)
 *   - DISPLAY_LIMIT 적용 — TRIP_DETAIL_RAW_SIGNAL_LIMIT 초과 시 truncate
 */
import {
  buildTripDetail,
  TRIP_DETAIL_RAW_SIGNAL_LIMIT,
  UNKNOWN_CORR_ID_BUCKET,
} from '../buildTripDetail';
import type { RawSignalEntry, RawSignalKind } from '../../../observability/utils/rawSignalBuffer';

function makeEntry(overrides?: Partial<RawSignalEntry>): RawSignalEntry {
  return {
    ts: 1_700_000_000_000,
    corrId: 'corr-abc',
    kind: 'cycle',
    gps: null,
    motion: null,
    accelPattern: null,
    cellular: null,
    subsurface: null,
    arvlCd: null,
    line: null,
    dir: null,
    arcIdx: null,
    arcProgress: null,
    stationId: null,
    source: null,
    confidence: null,
    ...overrides,
  };
}

describe('buildTripDetail', () => {
  it('returns null when tripToken is null', () => {
    expect(buildTripDetail([makeEntry()], null)).toBeNull();
  });

  it('returns null when no entries match the tripToken', () => {
    const entries = [makeEntry({ corrId: 'corr-1' })];
    expect(buildTripDetail(entries, 'corr-other')).toBeNull();
  });

  it('returns null when entries array is empty', () => {
    expect(buildTripDetail([], 'corr-abc')).toBeNull();
  });

  describe('tripToken=unknown', () => {
    it('groups entries whose corrId is null', () => {
      const entries = [
        makeEntry({ corrId: null, ts: 1_000 }),
        makeEntry({ corrId: 'corr-1', ts: 2_000 }),
        makeEntry({ corrId: null, ts: 3_000 }),
      ];
      const detail = buildTripDetail(entries, UNKNOWN_CORR_ID_BUCKET);
      expect(detail).not.toBeNull();
      expect(detail?.tripToken).toBe(UNKNOWN_CORR_ID_BUCKET);
      expect(detail?.entries).toHaveLength(2);
    });

    it('returns null if no corrId=null entries exist', () => {
      const entries = [makeEntry({ corrId: 'corr-1' })];
      expect(buildTripDetail(entries, UNKNOWN_CORR_ID_BUCKET)).toBeNull();
    });
  });

  describe('happy path', () => {
    it('computes firstTs/lastTs/durationMs correctly', () => {
      const entries = [
        makeEntry({ corrId: 'corr-1', ts: 2_000 }),
        makeEntry({ corrId: 'corr-1', ts: 1_000 }),
        makeEntry({ corrId: 'corr-1', ts: 3_000 }),
      ];
      const detail = buildTripDetail(entries, 'corr-1');
      expect(detail?.firstTs).toBe(1_000);
      expect(detail?.lastTs).toBe(3_000);
      expect(detail?.durationMs).toBe(2_000);
    });

    it('counts entries by kind correctly', () => {
      const kinds: RawSignalKind[] = ['cycle', 'enter', 'exit', 'cycle'];
      const entries = kinds.map((k, i) =>
        makeEntry({ corrId: 'corr-1', ts: i * 1_000, kind: k }),
      );
      const detail = buildTripDetail(entries, 'corr-1');
      expect(detail?.kindCounts).toEqual({ cycle: 2, enter: 1, exit: 1 });
    });

    it('sorts entries newest-first (ts descending)', () => {
      const entries = [
        makeEntry({ corrId: 'corr-1', ts: 1_000 }),
        makeEntry({ corrId: 'corr-1', ts: 3_000 }),
        makeEntry({ corrId: 'corr-1', ts: 2_000 }),
      ];
      const detail = buildTripDetail(entries, 'corr-1');
      const timestamps = detail?.entries.map((e) => e.ts) ?? [];
      expect(timestamps).toEqual([3_000, 2_000, 1_000]);
    });

    it('filters entries to only the matching tripToken', () => {
      const entries = [
        makeEntry({ corrId: 'corr-1', ts: 1_000 }),
        makeEntry({ corrId: 'corr-2', ts: 2_000 }),
        makeEntry({ corrId: 'corr-1', ts: 3_000 }),
      ];
      const detail = buildTripDetail(entries, 'corr-1');
      expect(detail?.entries).toHaveLength(2);
      detail?.entries.forEach((e) => expect(e.corrId).toBe('corr-1'));
    });

    it('preserves tripToken in the result', () => {
      const entries = [makeEntry({ corrId: 'corr-xyz' })];
      const detail = buildTripDetail(entries, 'corr-xyz');
      expect(detail?.tripToken).toBe('corr-xyz');
    });
  });

  describe('DISPLAY_LIMIT', () => {
    it('truncates entries when count exceeds TRIP_DETAIL_RAW_SIGNAL_LIMIT', () => {
      const overflowCount = TRIP_DETAIL_RAW_SIGNAL_LIMIT + 5;
      const entries = Array.from({ length: overflowCount }, (_, i) =>
        makeEntry({ corrId: 'corr-big', ts: i * 1_000 }),
      );
      const detail = buildTripDetail(entries, 'corr-big');
      expect(detail?.entries).toHaveLength(TRIP_DETAIL_RAW_SIGNAL_LIMIT);
    });

    it('keeps the most recent entries after truncation', () => {
      const overflowCount = TRIP_DETAIL_RAW_SIGNAL_LIMIT + 5;
      const entries = Array.from({ length: overflowCount }, (_, i) =>
        makeEntry({ corrId: 'corr-big', ts: i * 1_000 }),
      );
      const detail = buildTripDetail(entries, 'corr-big');
      // 가장 최신(ts=max)이 첫 번째에 있어야 함
      const expectedNewest = (overflowCount - 1) * 1_000;
      expect(detail?.entries[0].ts).toBe(expectedNewest);
    });
  });
});
