import { describe, expect, it } from 'vitest';
import { filterCandidateDirection, filterCandidateLine } from '../legCandidateFilters';
import type { Route, Waypoint } from '../types';

describe('#2328 — legCandidateFilters (consensus-B 오매칭 필터)', () => {
  describe('filterCandidateLine (①)', () => {
    const route: Route = { type: 'direct', line: '2', stops: 5 };

    it('passes candidate line within route allowedLines', () => {
      expect(filterCandidateLine('2', route)).toEqual({ kind: 'pass' });
    });

    it('rejects candidate line outside route allowedLines', () => {
      expect(filterCandidateLine('bundang', route)).toEqual({
        kind: 'reject',
        reason: 'line-not-allowed',
      });
    });

    it('passes candidate line covered only via waypoints union', () => {
      const waypoints: Waypoint[] = [{ stationName: '왕십리', line: 'bundang', kind: 'transfer' }];
      expect(filterCandidateLine('bundang', route, waypoints)).toEqual({ kind: 'pass' });
    });
  });

  describe('filterCandidateDirection (②) — 7호선 방향 필터 fixture', () => {
    // 7호선 monotonic(장암=low → 석남=high). 태릉입구(7-009) → 노원(7-005)는 id 감소 → 'up'.
    it('rejects candidate whose isUp mismatches inferred leg direction', () => {
      const verdict = filterCandidateDirection('7', false, '태릉입구', '노원');
      expect(verdict).toEqual({ kind: 'reject', reason: 'direction-mismatch' });
    });

    it('passes candidate whose isUp matches inferred leg direction', () => {
      const verdict = filterCandidateDirection('7', true, '태릉입구', '노원');
      expect(verdict).toEqual({ kind: 'pass' });
    });

    it('passes (dormant) when line direction is not inferable (null)', () => {
      // 1호선은 비단조 — inferLegDirection이 항상 null.
      const verdict = filterCandidateDirection('1', true, '서울역', '시청');
      expect(verdict).toEqual({ kind: 'pass' });
    });
  });

});
