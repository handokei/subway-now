import {
  __resetRouteGraphCache,
  buildRouteGraph,
} from '../buildRouteGraph';

describe('buildRouteGraph (#1499)', () => {
  beforeEach(() => {
    __resetRouteGraphCache();
  });

  it('builds nodes from stations.json (533 entries)', () => {
    const graph = buildRouteGraph();
    expect(graph.stats.nodeCount).toBe(533);
  });

  it('builds line edges from stationDistances and computes duration via lineSpeeds', () => {
    const graph = buildRouteGraph();
    // 2호선 2-001 → 2-002 (1호선 시청 인근, 700m)
    const edges = graph.adjacency.get('2-001') ?? [];
    const lineEdge = edges.find(
      (e) => e.kind === 'line' && e.toId === '2-002',
    );
    expect(lineEdge).toBeDefined();
    if (lineEdge && lineEdge.kind === 'line') {
      expect(lineEdge.distanceMeters).toBe(700);
      expect(lineEdge.line).toBe('2');
      // 700m @ 32 km/h = 700 / (32000/3600) ≈ 78.75s
      expect(lineEdge.durationSeconds).toBeCloseTo(78.75, 1);
    }
  });

  it('builds bidirectional line edges', () => {
    const graph = buildRouteGraph();
    const forward = (graph.adjacency.get('2-001') ?? []).some(
      (e) => e.kind === 'line' && e.toId === '2-002',
    );
    const backward = (graph.adjacency.get('2-002') ?? []).some(
      (e) => e.kind === 'line' && e.toId === '2-001',
    );
    expect(forward).toBe(true);
    expect(backward).toBe(true);
  });

  it('builds transfer edges from transferTimes (동대문역사문화공원 2/4/5)', () => {
    const graph = buildRouteGraph();
    // 2-005 (동대문역사문화공원, 2호선) → 5-027 (5호선)
    const edges = graph.adjacency.get('2-005') ?? [];
    const transfer = edges.find(
      (e) =>
        e.kind === 'transfer' && e.toId === '5-027' && e.stationName === '동대문역사문화공원',
    );
    expect(transfer).toBeDefined();
    if (transfer && transfer.kind === 'transfer') {
      expect(transfer.walkingSeconds).toBeGreaterThan(0);
      expect(transfer.fromLine).toBe('2');
      expect(transfer.toLine).toBe('5');
    }
  });

  it('caches the graph across calls', () => {
    const g1 = buildRouteGraph();
    const g2 = buildRouteGraph();
    expect(g1).toBe(g2);
  });

  it('resets cache via __resetRouteGraphCache', () => {
    const g1 = buildRouteGraph();
    __resetRouteGraphCache();
    const g2 = buildRouteGraph();
    expect(g1).not.toBe(g2);
  });

  it('exposes edge counts > 0', () => {
    const graph = buildRouteGraph();
    expect(graph.stats.lineEdgeCount).toBeGreaterThan(800);
    expect(graph.stats.transferEdgeCount).toBeGreaterThan(0);
  });

  // 이름 정규화 drift 회귀: stations.json은 후행 괄호 부제("왕십리(성동구청)")를,
  // transferTimes.json 키는 정규화된 base("왕십리")를 사용한다. buildRouteGraph가
  // raw name으로 그룹/조회하면 42개(전체 21%) 허브 환승 엣지가 통째로 사라져
  // 해당 허브 통과 경로가 NULL이 된다. 생성기와 동일한 2단 정규화로 흡수해야 한다.
  it.each([
    ['왕십리(성동구청)', '2-008', '5-031', '2', '5'],
    ['교대(법원.검찰청)', '2-023', '3-032', '2', '3'],
    ['잠실(송파구청)', '2-016', '8-005', '2', '8'],
  ])(
    'builds transfer edge across 부제-mismatch hub %s (%s↔%s)',
    (_name, fromId, toId, fromLine, toLine) => {
      const graph = buildRouteGraph();
      const edge = (graph.adjacency.get(fromId) ?? []).find(
        (e) => e.kind === 'transfer' && e.toId === toId,
      );
      expect(edge).toBeDefined();
      if (edge && edge.kind === 'transfer') {
        expect(edge.walkingSeconds).toBeGreaterThan(0);
        expect(edge.fromLine).toBe(fromLine);
        expect(edge.toLine).toBe(toLine);
      }
    },
  );

  it('연결성: 부제-mismatch 허브 통과 경로가 끊기지 않는다 (모든 transferTimes 키에 엣지 존재)', () => {
    const graph = buildRouteGraph();
    // transfer edge 총수는 transferTimes 양방향 키 수와 일치해야 한다(누락 0).
    const stations = graph.stats.nodeCount;
    expect(stations).toBe(533);
    // 42개 허브가 살아나면 transfer edge가 대폭 증가(> 200 양방향 키 수준).
    expect(graph.stats.transferEdgeCount).toBeGreaterThanOrEqual(200);
  });
});
