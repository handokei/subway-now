import { isClosedLoopMainStation, shortestLinePathIndices } from '../lineLoopPath';
import { getStationsOnLine } from '../stationRoute';
import type { LineNumber } from '../../types/station';

describe('isClosedLoopMainStation', () => {
  it.each<[LineNumber, string, boolean]>([
    ['2', '2-001', true], // 시청 (본선 시작)
    ['2', '2-009', true], // 한양대
    ['2', '2-043', true], // 충정로 (본선 끝)
    ['2', '2-105', false], // 까치산 (지선)
    ['2', '2-205', false], // 신설동 (지선)
    ['1', '1-001', false], // 1호선 직선
    ['6', '6-013', false], // 6호선 (closed loop 아님)
    ['7', '7-015', false], // 7호선 (closed loop 아님)
  ])('line=%s id=%s → %s', (line, id, expected) => {
    expect(isClosedLoopMainStation(line, id)).toBe(expected);
  });
});

describe('shortestLinePathIndices', () => {
  describe('2호선 본선 closed loop (이슈 #1698)', () => {
    const line2 = getStationsOnLine('2');
    const idxOf = (id: string) => line2.findIndex((s) => s.id === id);

    it('성수(2-011) → 합정(2-038): 내선 16 hop wraparound 선택 (사용자 trip evidence)', () => {
      const from = idxOf('2-011');
      const to = idxOf('2-038');
      const path = shortestLinePathIndices(line2, from, to, '2');
      // 내선 짧은 쪽: 성수 → 뚝섬(2-010) → 한양대(2-009) → ... → 합정
      // hop 수 = 16 (path 길이 = 17)
      expect(path.length).toBe(17);
      expect(line2[path[0]].id).toBe('2-011'); // 성수
      expect(line2[path[1]].id).toBe('2-010'); // 뚝섬
      expect(line2[path[2]].id).toBe('2-009'); // 한양대
      expect(line2[path[path.length - 1]].id).toBe('2-038'); // 합정
    });

    it('시청(2-001) → 홍대입구(2-039): wraparound 4 hop', () => {
      const from = idxOf('2-001');
      const to = idxOf('2-039');
      const path = shortestLinePathIndices(line2, from, to, '2');
      // 시청 → 충정로(2-043) → 아현(2-042) → 이대(2-041) → ... → 홍대입구(2-039)
      // hop 수 = 5 (시청→충정로→아현→이대→신촌→홍대입구)
      expect(path.length).toBe(6);
      expect(line2[path[0]].id).toBe('2-001');
      expect(line2[path[1]].id).toBe('2-043'); // 충정로 (wraparound)
      expect(line2[path[path.length - 1]].id).toBe('2-039');
    });

    it('한양대(2-009) → 사당(2-026): 17 hop 정방향 (wraparound 짧지 않음)', () => {
      const from = idxOf('2-009');
      const to = idxOf('2-026');
      const path = shortestLinePathIndices(line2, from, to, '2');
      // 정방향 17 hop, wraparound 26 hop → 정방향 선택
      expect(path.length).toBe(18);
      expect(line2[path[1]].id).toBe('2-010');
    });

    it('합정(2-038) → 성수(2-011): 16 hop wraparound 역방향', () => {
      const from = idxOf('2-038');
      const to = idxOf('2-011');
      const path = shortestLinePathIndices(line2, from, to, '2');
      expect(path.length).toBe(17);
      expect(line2[path[0]].id).toBe('2-038');
      expect(line2[path[path.length - 1]].id).toBe('2-011');
    });

    it('정방향 hop == wraparound hop이면 정방향 선택 (안정성)', () => {
      // 본선 43 stations이라 21~22 hop이 경계. 시청(idx 0) → idx 21(서초) 비교
      const from = 0;
      const toForwardSubHops = 21;
      const toIdx = idxOf(line2.filter((s, i) => isClosedLoopMainStation('2', s.id))[toForwardSubHops].id);
      const path = shortestLinePathIndices(line2, from, toIdx, '2');
      // 21 vs 22 → 21 정방향 선택
      expect(path.length).toBe(22);
      expect(path[0]).toBe(from);
      expect(path[1]).toBeGreaterThan(path[0]); // 정방향 idx 증가
    });

    it('같은 idx면 [idx]', () => {
      expect(shortestLinePathIndices(line2, 5, 5, '2')).toEqual([5]);
    });
  });

  describe('2호선 지선 (wraparound 적용 X)', () => {
    const line2 = getStationsOnLine('2');

    it('까치산(2-105) → 시청(2-001): 정방향 slice (지선은 본선 closed loop 영향 X)', () => {
      const from = line2.findIndex((s) => s.id === '2-105');
      const to = line2.findIndex((s) => s.id === '2-001');
      const path = shortestLinePathIndices(line2, from, to, '2');
      // wraparound 적용 X (까치산은 본선 range 밖) → 정방향 walk
      expect(line2[path[0]].id).toBe('2-105');
      expect(line2[path[path.length - 1]].id).toBe('2-001');
      // step -1 walk이므로 fromIdx > toIdx
      expect(path[0]).toBeGreaterThan(path[path.length - 1]);
    });

    it('신설동(2-205) → 성수(2-011): 정방향 (지선)', () => {
      const from = line2.findIndex((s) => s.id === '2-205');
      const to = line2.findIndex((s) => s.id === '2-011');
      const path = shortestLinePathIndices(line2, from, to, '2');
      expect(line2[path[0]].id).toBe('2-205');
      expect(line2[path[path.length - 1]].id).toBe('2-011');
    });
  });

  describe('다른 line (closed loop 아님)', () => {
    it('1호선: 정방향 slice 그대로', () => {
      const line1 = getStationsOnLine('1');
      const from = 0;
      const to = 5;
      const path = shortestLinePathIndices(line1, from, to, '1');
      expect(path).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('6호선 합정(6-013) → 공덕(6-017): 정방향 4 hop', () => {
      const line6 = getStationsOnLine('6');
      const from = line6.findIndex((s) => s.id === '6-013');
      const to = line6.findIndex((s) => s.id === '6-017');
      const path = shortestLinePathIndices(line6, from, to, '6');
      expect(path.length).toBe(5);
      expect(line6[path[0]].id).toBe('6-013');
      expect(line6[path[path.length - 1]].id).toBe('6-017');
    });

    it('7호선 역방향: step -1 정방향', () => {
      const line7 = getStationsOnLine('7');
      const from = 10;
      const to = 3;
      const path = shortestLinePathIndices(line7, from, to, '7');
      expect(path[0]).toBe(10);
      expect(path[path.length - 1]).toBe(3);
      // 역방향 단순 walk
      expect(path.length).toBe(8);
    });
  });
});
