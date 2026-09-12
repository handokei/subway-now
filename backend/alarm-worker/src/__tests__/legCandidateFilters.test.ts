import { describe, expect, it } from 'vitest';
import {
  filterCandidateBranchTerminus,
  filterCandidateDirection,
  filterCandidateExpressStop,
  filterCandidateLine,
} from '../legCandidateFilters';
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

  describe('filterCandidateBranchTerminus (③)', () => {
    it('2호선 성수지선 reject — mainRange 안 leg2 waypoint인데 terminus가 지선(신설동)', () => {
      const leg2: Waypoint[] = [
        { stationName: '뚝섬', line: '2', kind: 'intermediate' },
        { stationName: '건대입구', line: '2', kind: 'destination' },
      ];
      const verdict = filterCandidateBranchTerminus('2', '신설동', leg2);
      expect(verdict).toEqual({ kind: 'reject', reason: 'branch-terminus-diverges' });
    });

    it('2호선 본선 terminus는 leg2 waypoint 커버 시 pass', () => {
      const leg2: Waypoint[] = [
        { stationName: '뚝섬', line: '2', kind: 'intermediate' },
        { stationName: '건대입구', line: '2', kind: 'destination' },
      ];
      const verdict = filterCandidateBranchTerminus('2', '잠실나루', leg2);
      expect(verdict).toEqual({ kind: 'pass' });
    });

    it('5호선 마천·하남 분기 reject — leg2가 마천행인데 terminus가 stations.json 미매핑 하남 지선', () => {
      const leg2: Waypoint[] = [
        { stationName: '개롱', line: '5', kind: 'intermediate' },
        { stationName: '마천', line: '5', kind: 'destination' },
      ];
      // 하남검단산/하남풍산은 stations.json에 없는 5호선 하남 지선 종점 — 미해소 hard reject.
      const verdict = filterCandidateBranchTerminus('5', '하남검단산', leg2);
      expect(verdict).toEqual({ kind: 'reject', reason: 'branch-terminus-unresolved' });
    });

    it('5호선 마천 지선 — leg2와 같은 지선 terminus는 pass', () => {
      const leg2: Waypoint[] = [
        { stationName: '개롱', line: '5', kind: 'intermediate' },
        { stationName: '마천', line: '5', kind: 'destination' },
      ];
      const verdict = filterCandidateBranchTerminus('5', '마천', leg2);
      expect(verdict).toEqual({ kind: 'pass' });
    });

    it('단축 운행 — 같은 경로 안에서 leg2 최종 waypoint 전에 멈추면 soft-penalty', () => {
      const leg2: Waypoint[] = [
        { stationName: '개롱', line: '5', kind: 'intermediate' },
        { stationName: '거여', line: '5', kind: 'intermediate' },
        { stationName: '마천', line: '5', kind: 'destination' },
      ];
      const verdict = filterCandidateBranchTerminus('5', '개롱', leg2);
      expect(verdict).toEqual({ kind: 'soft-penalty', reason: 'branch-shortened-service' });
    });

    it('terminus가 leg2 진행 방향 반대편(같은 노선이지만 지나온 구간)이면 reject', () => {
      const leg2: Waypoint[] = [
        { stationName: '개롱', line: '5', kind: 'intermediate' },
        { stationName: '마천', line: '5', kind: 'destination' },
      ];
      // 천호(5-038)는 개롱(5-044)보다 앞선 역 — leg2 진행 방향 반대편.
      const verdict = filterCandidateBranchTerminus('5', '천호(풍납토성)', leg2);
      expect(verdict).toEqual({ kind: 'reject', reason: 'branch-terminus-diverges' });
    });

    it('역방향(id 감소) leg2 — terminus가 furthest까지 커버하면 pass', () => {
      // 잠실새내(2-017)→잠실(2-016)→잠실나루(2-015): id 감소 방향으로 진행하는 leg.
      const leg2: Waypoint[] = [
        { stationName: '잠실새내', line: '2', kind: 'intermediate' },
        { stationName: '잠실(송파구청)', line: '2', kind: 'intermediate' },
        { stationName: '잠실나루', line: '2', kind: 'destination' },
      ];
      const verdict = filterCandidateBranchTerminus('2', '잠실나루', leg2);
      expect(verdict).toEqual({ kind: 'pass' });
    });

    it('역방향(id 감소) leg2 — terminus가 중간에 멈추면 soft-penalty', () => {
      const leg2: Waypoint[] = [
        { stationName: '잠실새내', line: '2', kind: 'intermediate' },
        { stationName: '잠실(송파구청)', line: '2', kind: 'intermediate' },
        { stationName: '잠실나루', line: '2', kind: 'destination' },
      ];
      const verdict = filterCandidateBranchTerminus('2', '잠실(송파구청)', leg2);
      expect(verdict).toEqual({ kind: 'soft-penalty', reason: 'branch-shortened-service' });
    });

    it('mainRange 안 leg2인데 terminus가 stations.json에 없으면 reject(unresolved)', () => {
      const leg2: Waypoint[] = [
        { stationName: '뚝섬', line: '2', kind: 'intermediate' },
        { stationName: '건대입구', line: '2', kind: 'destination' },
      ];
      const verdict = filterCandidateBranchTerminus('2', '존재하지않는역이름', leg2);
      expect(verdict).toEqual({ kind: 'reject', reason: 'branch-terminus-unresolved' });
    });

    it('terminus 정보 없으면 pass (보수적)', () => {
      const leg2: Waypoint[] = [{ stationName: '마천', line: '5', kind: 'destination' }];
      expect(filterCandidateBranchTerminus('5', null, leg2)).toEqual({ kind: 'pass' });
    });

    it('leg2 waypoint에 해당 line이 없으면 pass', () => {
      const leg2: Waypoint[] = [{ stationName: '왕십리', line: 'bundang', kind: 'transfer' }];
      expect(filterCandidateBranchTerminus('5', '마천', leg2)).toEqual({ kind: 'pass' });
    });
  });

  describe('filterCandidateExpressStop (④) — 9호선 급행 fixture', () => {
    it('급행 후보가 정차하는 waypoint는 pass', () => {
      const verdict = filterCandidateExpressStop('9', 'express', '고속터미널');
      expect(verdict).toEqual({ kind: 'pass' });
    });

    it('급행 후보가 통과(미정차)하는 waypoint는 not-applicable — mismatch로 오집계되면 안 됨', () => {
      // 고속터미널↔신논현 사이 사평은 완행 전용역 — 9호선 express set에 없음.
      const verdict = filterCandidateExpressStop('9', 'express', '사평');
      expect(verdict).toEqual({ kind: 'not-applicable' });
    });

    it('일반(normal) 후보는 모든 waypoint에 pass', () => {
      expect(filterCandidateExpressStop('9', 'normal', '사평')).toEqual({ kind: 'pass' });
    });

    it('데이터 미보유 노선/타입은 보수적으로 pass', () => {
      expect(filterCandidateExpressStop('3', 'express', '아무역')).toEqual({ kind: 'pass' });
    });
  });
});
