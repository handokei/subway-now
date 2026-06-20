/**
 * #1604 — Backend Dijkstra. Device(`src/features/route/utils/dijkstraRoute.ts`)와 구조 동일하지만
 * backend는 `min-time`(운행 + 환승 도보 시간) 단일 옵션만 사용한다 — POST /trips infer 경로에서
 * "사용자가 가장 빨리 갈 수 있는 경로"를 추론하면 충분(min-transfer/min-distance UI 비교 필요 없음).
 *
 * 사용처: `src/index.ts` POST /trips 핸들러에서 `waypoints = [destination only]` 케이스의
 * 자동 경로 추론 (옵션 (B), S1 #1534 spirit과 정합 — backend = decider).
 */
import {
  buildRouteGraph,
  findStationIdByNameAndLine,
  type RouteEdge,
} from './buildRouteGraph';
import type { LineNumber, Waypoint } from './types';

export interface RouteLeg {
  readonly fromId: string;
  readonly toId: string;
  readonly line: LineNumber;
  readonly stationIds: readonly string[];
}

export interface RouteTransfer {
  readonly stationName: string;
  readonly fromLine: LineNumber;
  readonly toLine: LineNumber;
}

export interface InferredRoute {
  readonly fromId: string;
  readonly toId: string;
  readonly legs: readonly RouteLeg[];
  readonly transfers: readonly RouteTransfer[];
}

/**
 * Binary min-heap — 533 노드 규모에서 array shift O(n)보다 우수. Device 코드와 동일 구조.
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

function edgeWeight(edge: RouteEdge): number {
  // min-time: line edge는 운행 시간, transfer edge는 도보 시간.
  return edge.kind === 'line' ? edge.durationSeconds : edge.walkingSeconds;
}

interface PrevPointer {
  readonly nodeId: string;
  readonly edge: RouteEdge;
}

/**
 * Dijkstra (min-time): from→to 최단경로.
 * 도달 불가 또는 from/to invalid 시 null.
 */
export function findRoute(fromId: string, toId: string): InferredRoute | null {
  const graph = buildRouteGraph();
  if (!graph.nodes.has(fromId) || !graph.nodes.has(toId)) {
    return null;
  }
  if (fromId === toId) {
    return { fromId, toId, legs: [], transfers: [] };
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
      const w = edgeWeight(edge);
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
  return reconstructRoute(fromId, toId, prev);
}

function reconstructRoute(
  fromId: string,
  toId: string,
  prev: Map<string, PrevPointer>,
): InferredRoute {
  const reversedEdges: RouteEdge[] = [];
  const reversedFromNodes: string[] = [];
  let cursor = toId;
  while (cursor !== fromId) {
    // Dijkstra invariant: prev.has(toId) 이고 back-path 모든 노드에 predecessor.
    const p = prev.get(cursor) as PrevPointer;
    reversedEdges.push(p.edge);
    reversedFromNodes.push(p.nodeId);
    cursor = p.nodeId;
  }
  reversedEdges.reverse();
  reversedFromNodes.reverse();

  const legs: RouteLeg[] = [];
  const transfers: RouteTransfer[] = [];

  let legStartId: string | null = null;
  let legLine: LineNumber | null = null;
  let legStations: string[] = [];

  const flushLeg = (endId: string): void => {
    /* istanbul ignore next — legStartId/legLine은 동시 set/unset (pair invariant). */
    if (legLine === null || legStartId === null) {
      return;
    }
    legs.push({
      fromId: legStartId,
      toId: endId,
      line: legLine,
      stationIds: [...legStations],
    });
    legStartId = null;
    legLine = null;
    legStations = [];
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
      legStations.push(edge.toId);
    } else {
      flushLeg(from);
      transfers.push({
        stationName: edge.stationName,
        fromLine: edge.fromLine,
        toLine: edge.toLine,
      });
    }
  }
  flushLeg(toId);

  return { fromId, toId, legs, transfers };
}

/**
 * `InferredRoute` → backend Waypoint[]. routeWaypoints(device)와 형태 정합.
 *
 * 규칙:
 *  - 각 leg는 시작역(=출발역 또는 환승역) 제외, 나머지 station을 `intermediate`로 펼친다.
 *    마지막 leg의 마지막 station은 `destination`으로 swap.
 *  - 각 transfer는 fromLine 컨텍스트의 `transfer` waypoint로 표현 (device routeWaypoints와 동일).
 *  - 결과 시퀀스는 backend의 `validateTrip`이 occurrenceIdx/hopIndex를 stamp한다.
 *
 * destinationName: 목적지 역 표시명 (device `promptDisplay`/route 의도 보존용).
 */
export function inferredRouteToWaypoints(
  route: InferredRoute,
  destinationName: string,
): Array<Pick<Waypoint, 'stationName' | 'line' | 'kind'>> {
  const result: Array<Pick<Waypoint, 'stationName' | 'line' | 'kind'>> = [];
  const graph = buildRouteGraph();
  const stationName = (id: string): string => graph.nodes.get(id)?.name ?? id;

  const legCount = route.legs.length;
  for (let i = 0; i < legCount; i += 1) {
    const leg = route.legs[i];
    const isLastLeg = i === legCount - 1;
    // leg.stationIds[0] = 출발역(직전 transfer 또는 fromId) — push 안 함.
    for (let j = 1; j < leg.stationIds.length; j += 1) {
      const stationId = leg.stationIds[j];
      const isLastStationOfLeg = j === leg.stationIds.length - 1;
      // 마지막 leg의 마지막 station = destination. 표시명은 destinationName 우선(device 의도).
      if (isLastLeg && isLastStationOfLeg) {
        result.push({ stationName: destinationName, line: leg.line, kind: 'destination' });
      } else if (isLastStationOfLeg) {
        // 환승역 — 다음 transfer가 같은 fromLine의 같은 stationName으로 처리.
        const transfer = route.transfers[i];
        const name = transfer ? transfer.stationName : stationName(stationId);
        result.push({ stationName: name, line: leg.line, kind: 'transfer' });
      } else {
        result.push({ stationName: stationName(stationId), line: leg.line, kind: 'intermediate' });
      }
    }
  }
  return result;
}

/**
 * POST /trips infer 진입점. device의 `promptDisplay`(originStation + line) + `destination`(station id)
 * 만으로 backend가 Dijkstra 경로를 계산해 `Waypoint[]`를 반환한다.
 *
 *  - origin 미해소 / destination 미해소 / 도달 불가 / 동일역 → null (caller가 incoming waypoints 유지).
 *  - 정상 시 device routeWaypoints와 동형 시퀀스 반환.
 */
export function inferWaypointsFromOriginAndDestination(args: {
  originName: string;
  originLine: LineNumber;
  destinationId: string;
  destinationName: string;
}): Array<Pick<Waypoint, 'stationName' | 'line' | 'kind'>> | null {
  const fromId = findStationIdByNameAndLine(args.originName, args.originLine);
  if (fromId === null) return null;
  const graph = buildRouteGraph();
  if (!graph.nodes.has(args.destinationId)) return null;
  const route = findRoute(fromId, args.destinationId);
  if (route === null) return null;
  // 동일역(degenerate) — legs/transfers 모두 빈 배열. 호출자가 incoming 그대로 유지하도록 null.
  if (route.legs.length === 0 && route.transfers.length === 0) return null;
  return inferredRouteToWaypoints(route, args.destinationName);
}

/** 테스트/디버그 — 그래프 stats 노출. */
export function getRouteGraphStats(): { nodeCount: number; lineEdgeCount: number; transferEdgeCount: number } {
  return buildRouteGraph().stats;
}
