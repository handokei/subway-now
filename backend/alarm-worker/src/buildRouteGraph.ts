/**
 * #1604 — Backend Dijkstra graph builder. Device(`src/features/route/utils/buildRouteGraph.ts`)
 * 와 구조적으로 동일하지만, backend는 `shared/types/station.ts`를 가져오지 않고 backend-local
 * `LineNumber = string`을 사용한다(types.ts 정의 그대로).
 *
 * 데이터 SSOT (device와 공유):
 *   - `src/data/stations.json`            — 533 역 (그래프 노드)
 *   - `src/data/stationDistances.json`    — 호선 인접 edge (m)
 *   - `src/data/transferTimes.json`       — 환승 도보 edge (초)
 *
 * 본 모듈은 `dijkstraRoute.findRouteByType` 한 군데서만 사용 — POST /trips에서 device가 보낸
 * `waypoints = [destination only]`(legacy collapse) 케이스의 자동 경로 추론(Backend Infer).
 */
import stationsRaw from '../../../src/data/stations.json';
import stationDistancesRaw from '../../../src/data/stationDistances.json';
import transferTimesRaw from '../../../src/data/transferTimes.json';
import type { LineNumber } from './types';

/**
 * 노선별 평균 운행 속도(km/h). device의 `src/shared/constants/lineSpeeds.ts`와 정합.
 * backend가 device shared 모듈을 import하면 station 타입 시스템(다른 LineNumber 정의)으로
 * 끌려가므로 본 파일에 inline copy를 둔다 — drift 가능성 있으나 단위 테스트로 강제.
 */
const LINE_AVERAGE_SPEED_KMH: Record<string, number> = {
  '1': 32,
  '2': 32,
  '3': 32,
  '4': 32,
  '5': 32,
  '6': 32,
  '7': 32,
  '8': 32,
  '9': 40,
  airport: 60,
  bundang: 35,
  gyeongui: 50,
  sinbundang: 50,
};

export interface GraphStation {
  readonly id: string;
  readonly name: string;
  readonly line: LineNumber;
}

const STATIONS = stationsRaw as Array<{
  id: string;
  name: string;
  line: string;
  [k: string]: unknown;
}>;
const DISTANCES = stationDistancesRaw as Record<string, number>;
const TRANSFERS = transferTimesRaw as Record<string, number>;

export interface LineEdge {
  readonly kind: 'line';
  readonly toId: string;
  readonly line: LineNumber;
  readonly distanceMeters: number;
  readonly durationSeconds: number;
}

export interface TransferEdge {
  readonly kind: 'transfer';
  readonly toId: string;
  readonly walkingSeconds: number;
  readonly stationName: string;
  readonly fromLine: LineNumber;
  readonly toLine: LineNumber;
}

export type RouteEdge = LineEdge | TransferEdge;

export interface RouteGraph {
  readonly nodes: ReadonlyMap<string, GraphStation>;
  readonly adjacency: ReadonlyMap<string, readonly RouteEdge[]>;
  readonly stats: {
    readonly nodeCount: number;
    readonly lineEdgeCount: number;
    readonly transferEdgeCount: number;
  };
}

function computeDurationSeconds(distanceMeters: number, line: LineNumber): number {
  // 등록되지 않은 line이면 1호선 기본값(32 km/h)으로 fallback — graph 빌드 안정성 우선.
  const kmh = LINE_AVERAGE_SPEED_KMH[line] ?? 32;
  const mps = (kmh * 1000) / 3600;
  return distanceMeters / mps;
}

let cachedGraph: RouteGraph | null = null;

/**
 * 그래프를 1회 빌드 후 캐싱. stations.json 등 SSOT가 정적이므로 안전.
 * 테스트는 `__resetRouteGraphCache()`로 초기화 가능.
 */
export function buildRouteGraph(): RouteGraph {
  if (cachedGraph) {
    return cachedGraph;
  }

  const nodes = new Map<string, GraphStation>();
  for (const station of STATIONS) {
    nodes.set(station.id, { id: station.id, name: station.name, line: station.line });
  }

  const adjacency = new Map<string, RouteEdge[]>();
  const pushEdge = (fromId: string, edge: RouteEdge): void => {
    const list = adjacency.get(fromId);
    if (list) {
      list.push(edge);
    } else {
      adjacency.set(fromId, [edge]);
    }
  };

  let lineEdgeCount = 0;
  for (const [key, distanceMeters] of Object.entries(DISTANCES)) {
    const [line, fromId, toId] = key.split('|') as [LineNumber, string, string];
    const durationSeconds = computeDurationSeconds(distanceMeters, line);
    pushEdge(fromId, {
      kind: 'line',
      toId,
      line,
      distanceMeters,
      durationSeconds,
    });
    lineEdgeCount += 1;
  }

  const nameGroups = new Map<string, GraphStation[]>();
  for (const station of nodes.values()) {
    const list = nameGroups.get(station.name);
    if (list) {
      list.push(station);
    } else {
      nameGroups.set(station.name, [station]);
    }
  }

  let transferEdgeCount = 0;
  for (const [name, group] of nameGroups) {
    if (group.length < 2) {
      continue;
    }
    for (const a of group) {
      for (const b of group) {
        if (a.line === b.line) {
          continue;
        }
        const key = `${a.line}|${b.line}|${name}`;
        const walkingSeconds = TRANSFERS[key];
        if (walkingSeconds === undefined) {
          continue;
        }
        pushEdge(a.id, {
          kind: 'transfer',
          toId: b.id,
          walkingSeconds,
          stationName: name,
          fromLine: a.line,
          toLine: b.line,
        });
        transferEdgeCount += 1;
      }
    }
  }

  cachedGraph = {
    nodes,
    adjacency,
    stats: {
      nodeCount: nodes.size,
      lineEdgeCount,
      transferEdgeCount,
    },
  };
  return cachedGraph;
}

/** 테스트 전용 — 캐시 초기화. */
export function __resetRouteGraphCache(): void {
  cachedGraph = null;
}

/**
 * (name, line) → station id 조회. POST /trips에서 device의 `promptDisplay.originStation` +
 * `promptDisplay.line`로 currentStation의 id를 역추적할 때 사용한다.
 * 매치 0건 또는 ambiguity는 null.
 */
export function findStationIdByNameAndLine(name: string, line: LineNumber): string | null {
  const graph = buildRouteGraph();
  for (const station of graph.nodes.values()) {
    if (station.name === name && station.line === line) {
      return station.id;
    }
  }
  return null;
}
