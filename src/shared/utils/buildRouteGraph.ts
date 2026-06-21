/**
 * #1499 — 자체 Dijkstra 그래프 빌더.
 * #1610 — `src/features/route/utils/` → `src/shared/utils/` 이전 (backend 재사용).
 *
 * 데이터 SSOT (외부 API 의존 없음, ADR-015 §6):
 *   - `src/data/stations.json` — 533 역 (그래프 노드)
 *   - `src/data/stationDistances.json` — 호선 인접 edge (m)
 *   - `src/data/transferTimes.json` — 환승 도보 edge (초)
 *   - `src/shared/constants/lineSpeeds.ts` — 호선 평균 속도 (km/h)
 *
 * 그래프 구조:
 *   - node id = station.id (예: `2-011`)
 *   - line edge: 같은 호선 인접 역. weight = distance(m) / lineSpeed(km/h) → durationSeconds
 *   - transfer edge: 같은 name + 다른 line. weight = transferTimes 도보 초
 *
 * Sub-D 본 PR 범위. boardable wait(Sub C cascade) 합산은 Sub-E 후속.
 *
 * #1610 — backend(`backend/alarm-worker/src/index.ts` POST /trips)가 #1604 route infer에서
 * 본 모듈을 그대로 import한다. backend tsconfig.json `include`에 해당 경로 명시.
 */
import stationsRaw from '../../data/stations.json';
import stationDistancesRaw from '../../data/stationDistances.json';
import transferTimesRaw from '../../data/transferTimes.json';
import { LINE_AVERAGE_SPEED_KMH } from '../constants/lineSpeeds';
import type { LineNumber, Station } from '../types/station';

const STATIONS = stationsRaw as Station[];
const DISTANCES = stationDistancesRaw as Record<string, number>;
const TRANSFERS = transferTimesRaw as Record<string, number>;

export interface LineEdge {
  readonly kind: 'line';
  readonly toId: string;
  readonly line: LineNumber;
  /** edge 물리 거리 (m). */
  readonly distanceMeters: number;
  /** 호선 평균 속도 기반 운행 시간 (초). 정차 시간 포함 표정속도. */
  readonly durationSeconds: number;
}

export interface TransferEdge {
  readonly kind: 'transfer';
  readonly toId: string;
  /** 환승 도보 시간 (초). */
  readonly walkingSeconds: number;
  /** 환승역 이름 (디버그용). */
  readonly stationName: string;
  readonly fromLine: LineNumber;
  readonly toLine: LineNumber;
}

export type RouteEdge = LineEdge | TransferEdge;

export interface RouteGraph {
  readonly nodes: ReadonlyMap<string, Station>;
  readonly adjacency: ReadonlyMap<string, readonly RouteEdge[]>;
  readonly stats: {
    readonly nodeCount: number;
    readonly lineEdgeCount: number;
    readonly transferEdgeCount: number;
  };
}

/**
 * 거리(m) + 호선 평균 속도(km/h)로 운행 초 산출.
 * `LINE_AVERAGE_SPEED_KMH`는 모든 `LineNumber`를 망라 (타입 강제) → fallback 불필요.
 */
function computeDurationSeconds(distanceMeters: number, line: LineNumber): number {
  const kmh = LINE_AVERAGE_SPEED_KMH[line];
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

  const nodes = new Map<string, Station>();
  for (const station of STATIONS) {
    nodes.set(station.id, station);
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
    // stationDistances의 모든 node id는 stations.json에 존재한다 (CI data validation).
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

  // 같은 name 그룹별 호선 노드 매핑.
  const nameGroups = new Map<string, Station[]>();
  for (const station of STATIONS) {
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
