/**
 * #1499 — 자체 Dijkstra 최단경로 알고리즘.
 *
 * 2종 type:
 *   - `min-transfer`: 환승 횟수 최소화. line edge=1, transfer edge=1000.
 *   - `min-time`: 운행 + 환승 도보 시간(초) 합산 최단.
 *
 * 결과는 `Route` 객체로 leg + transfer 정보를 모두 포함, downstream
 * stationRoute.ts / DebugModal에서 cross-check 가능하게 한다.
 */
import { buildRouteGraph, type RouteEdge } from './buildRouteGraph';
import type { LineNumber } from '../types/station';

export type RouteOptimizationType = 'min-transfer' | 'min-time';

export const ROUTE_OPTIMIZATION_TYPES: readonly RouteOptimizationType[] = [
  'min-transfer',
  'min-time',
];

export interface RouteLeg {
  /** 같은 호선에서 연속된 line edge의 시작 역 id. */
  readonly fromId: string;
  /** 같은 호선에서 마지막 역 id. */
  readonly toId: string;
  readonly line: LineNumber;
  readonly distanceMeters: number;
  readonly durationSeconds: number;
  /** 본 leg가 지나는 모든 역 id(시작 포함, 끝 포함). */
  readonly stationIds: readonly string[];
}

export interface RouteTransfer {
  readonly stationName: string;
  readonly fromLine: LineNumber;
  readonly toLine: LineNumber;
  readonly walkingSeconds: number;
}

export interface Route {
  readonly fromId: string;
  readonly toId: string;
  readonly type: RouteOptimizationType;
  readonly legs: readonly RouteLeg[];
  readonly transfers: readonly RouteTransfer[];
  readonly totalDistanceMeters: number;
  readonly totalDurationSeconds: number;
  readonly totalWalkingSeconds: number;
  readonly transferCount: number;
}

/**
 * Min-heap (binary) — node 수 500+ 규모에서 array shift O(n)보다 우수.
 */
class MinHeap<T> {
  private readonly data: Array<{ key: number; value: T }> = [];

  get size(): number {
    return this.data.length;
  }

  push(key: number, value: T): void {
    this.data.push({ key, value });
    this.bubbleUp(this.data.length - 1);
  }

  /** 호출자는 항상 `size > 0` 확인 후 호출. */
  pop(): { key: number; value: T } {
    const top = this.data[0];
    const last = this.data.pop() as { key: number; value: T };
    if (this.data.length > 0) {
      this.data[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  private bubbleUp(index: number): void {
    let i = index;
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (this.data[parent].key <= this.data[i].key) {
        break;
      }
      [this.data[parent], this.data[i]] = [this.data[i], this.data[parent]];
      i = parent;
    }
  }

  private sinkDown(index: number): void {
    let i = index;
    const n = this.data.length;
    for (;;) {
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      let smallest = i;
      if (left < n && this.data[left].key < this.data[smallest].key) {
        smallest = left;
      }
      if (right < n && this.data[right].key < this.data[smallest].key) {
        smallest = right;
      }
      if (smallest === i) {
        break;
      }
      [this.data[i], this.data[smallest]] = [this.data[smallest], this.data[i]];
      i = smallest;
    }
  }
}

function edgeWeight(edge: RouteEdge, type: RouteOptimizationType): number {
  if (edge.kind === 'line') {
    if (type === 'min-transfer') return 1;
    return edge.durationSeconds;
  }
  // transfer
  if (type === 'min-transfer') return 1000;
  return edge.walkingSeconds;
}

interface PrevPointer {
  readonly nodeId: string;
  readonly edge: RouteEdge;
}

/**
 * Dijkstra: from→to 최단경로.
 * 도달 불가 또는 from/to invalid 시 null.
 */
export function findRouteByType(
  fromId: string,
  toId: string,
  type: RouteOptimizationType,
): Route | null {
  const graph = buildRouteGraph();
  if (!graph.nodes.has(fromId) || !graph.nodes.has(toId)) {
    return null;
  }
  if (fromId === toId) {
    return {
      fromId,
      toId,
      type,
      legs: [],
      transfers: [],
      totalDistanceMeters: 0,
      totalDurationSeconds: 0,
      totalWalkingSeconds: 0,
      transferCount: 0,
    };
  }

  const dist = new Map<string, number>();
  const prev = new Map<string, PrevPointer>();
  const heap = new MinHeap<string>();
  dist.set(fromId, 0);
  heap.push(0, fromId);

  while (heap.size > 0) {
    const { key: d, value: u } = heap.pop();
    if (u === toId) {
      break;
    }
    const currentBest = dist.get(u);
    if (currentBest !== undefined && d > currentBest) {
      continue;
    }
    const neighbors = graph.adjacency.get(u) ?? [];
    for (const edge of neighbors) {
      const w = edgeWeight(edge, type);
      const nd = d + w;
      const prevBest = dist.get(edge.toId);
      if (prevBest === undefined || nd < prevBest) {
        dist.set(edge.toId, nd);
        prev.set(edge.toId, { nodeId: u, edge });
        heap.push(nd, edge.toId);
      }
    }
  }

  if (!prev.has(toId)) {
    return null;
  }
  return reconstructRoute(fromId, toId, type, prev);
}

function reconstructRoute(
  fromId: string,
  toId: string,
  type: RouteOptimizationType,
  prev: Map<string, PrevPointer>,
): Route {
  // walk back collecting edges in reverse
  const reversedEdges: RouteEdge[] = [];
  const reversedFromNodes: string[] = [];
  let cursor = toId;
  while (cursor !== fromId) {
    // Caller guarantees prev.has(toId) and Dijkstra invariant means every
    // node on the back-path has a predecessor — non-null assertion is safe.
    const p = prev.get(cursor) as PrevPointer;
    reversedEdges.push(p.edge);
    reversedFromNodes.push(p.nodeId);
    cursor = p.nodeId;
  }
  reversedEdges.reverse();
  reversedFromNodes.reverse();

  const legs: RouteLeg[] = [];
  const transfers: RouteTransfer[] = [];
  let totalDistanceMeters = 0;
  let totalDurationSeconds = 0;
  let totalWalkingSeconds = 0;

  let legStartId: string | null = null;
  let legLine: LineNumber | null = null;
  let legStations: string[] = [];
  let legDistance = 0;
  let legDuration = 0;

  const flushLeg = (endId: string): void => {
    /* istanbul ignore next — legStartId/legLine은 동시 set/unset (pair invariant). */
    if (legLine === null || legStartId === null) {
      return;
    }
    // 마지막 line edge의 toId가 항상 push되어 있으므로 endId와 일치.
    legs.push({
      fromId: legStartId,
      toId: endId,
      line: legLine,
      distanceMeters: legDistance,
      durationSeconds: legDuration,
      stationIds: [...legStations],
    });
    legStartId = null;
    legLine = null;
    legStations = [];
    legDistance = 0;
    legDuration = 0;
  };

  for (let i = 0; i < reversedEdges.length; i += 1) {
    const edge = reversedEdges[i];
    const from = reversedFromNodes[i];
    if (edge.kind === 'line') {
      if (legStartId === null) {
        legStartId = from;
        legLine = edge.line;
        legStations = [from];
      }
      legDistance += edge.distanceMeters;
      legDuration += edge.durationSeconds;
      totalDistanceMeters += edge.distanceMeters;
      totalDurationSeconds += edge.durationSeconds;
      legStations.push(edge.toId);
    } else {
      // transfer — close current leg
      flushLeg(from);
      transfers.push({
        stationName: edge.stationName,
        fromLine: edge.fromLine,
        toLine: edge.toLine,
        walkingSeconds: edge.walkingSeconds,
      });
      totalWalkingSeconds += edge.walkingSeconds;
      totalDurationSeconds += edge.walkingSeconds;
    }
  }
  // final flush — leg ends at toId
  flushLeg(toId);

  return {
    fromId,
    toId,
    type,
    legs,
    transfers,
    totalDistanceMeters,
    totalDurationSeconds,
    totalWalkingSeconds,
    transferCount: transfers.length,
  };
}

/**
 * 2종 type 한 번에 산출. UI/DebugModal에서 비교 표시용.
 */
export function findRoutes(
  fromId: string,
  toId: string,
): Record<RouteOptimizationType, Route | null> {
  return {
    'min-transfer': findRouteByType(fromId, toId, 'min-transfer'),
    'min-time': findRouteByType(fromId, toId, 'min-time'),
  };
}
