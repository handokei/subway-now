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
});
