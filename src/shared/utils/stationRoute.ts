import stations from '../../data/stations.json';
import stationTravelTimesJson from '../../data/stationTravelTimes.json';
import stationDistancesJson from '../../data/stationDistances.json';
import type { Station } from '../types/station';
import { LINE_COLORS } from '../constants/lineColors';
import { WALKING_SPEED_M_PER_S, ARRIVAL_FRESHNESS_MS } from '../constants/eta';
import type { LineNumber } from '../types/station';
import { applyStationAlias } from '../../data/stationAliases';
import { createLogger } from './logger';
import { normalizeStationName as baseNormalizeStationName } from './normalizeStationName';
import { distanceMetersBetween, estimateEtaSeconds } from './stationEta';
import { getTransferSeconds } from './transferTimes';
import { getStopSecondsFromDistance } from './lineSpeeds';
import { shortestLinePathIndices } from './lineLoopPath';

const logger = createLogger('StationRoute');

const allStations = stations as Station[];
const stationTravelTimes = stationTravelTimesJson as Record<string, number>;
const stationDistances = stationDistancesJson as Record<string, number>;

// 실측 운행시간이 누락된 hop의 fallback (예: 9호선/공항철도 등 #655 미커버 노선).
const STOP_FALLBACK_SECONDS = 120;

/**
 * line의 fromId → toId 단일 hop 운행 시간(초). #655.
 * 우선순위:
 *   1) `stationTravelTimes.json` 실측 (서울 열린데이터, 1~8호선)
 *   2) #1472 — `stationDistances.json` 거리 × 노선 평균 속도 (KRRIC + 운영사 표정속도)
 *   3) `STOP_FALLBACK_SECONDS`(=120, 2분) 최종 fallback
 * miss는 logger.debug로 노출해 향후 데이터 보강(9호선/공항철도 등) 추적에 사용.
 */
export function getStopSeconds(line: LineNumber, fromId: string, toId: string): number {
  const key = `${line}|${fromId}|${toId}`;
  const hit = stationTravelTimes[key];
  if (hit !== undefined) return hit;
  const distM = stationDistances[key];
  if (distM !== undefined) {
    const seconds = getStopSecondsFromDistance(line, distM);
    logger.debug(`getStopSeconds distance fallback: ${key} → ${seconds.toFixed(0)}s (${distM}m)`);
    return seconds;
  }
  logger.debug(`getStopSeconds miss: ${key} → fallback ${STOP_FALLBACK_SECONDS}s`);
  return STOP_FALLBACK_SECONDS;
}

/**
 * #1111 PoC: line의 fromId → toId 인접 hop 실측 트랙 거리(미터).
 * 서울 열린데이터 StationDstncReqreTimeHm의 DIST_KM을 km→m로 변환해 저장.
 * 양방향 동일 값. 미커버 노선(9호선/공항철도 등)은 `null` 반환 — 호출자가 haversine fallback 선택.
 *
 * 활용 후보: fusion ETA(`stationEta.ts`)가 haversine 직선거리를 쓰는데, 실측은 전체 평균 1.04x,
 * p90 1.15x, 최대 1.40x(1호선 시청↔종각) 더 길다. 트랙 거리 사용 시 곡선·우회 구간 ETA 정확도 향상.
 */
export function getStopDistanceMeters(line: LineNumber, fromId: string, toId: string): number | null {
  const key = `${line}|${fromId}|${toId}`;
  const hit = stationDistances[key];
  return hit !== undefined ? hit : null;
}

// line 위 fromIdx → toIdx 구간을 한 hop씩 누적한 운행 시간(초). 환승 대기 미포함.
// #1698 — 2호선 본선 closed loop은 shortestLinePathIndices가 짧은 쪽 path를 반환한다.
function computeSegmentSeconds(
  line: LineNumber,
  fromIdx: number,
  toIdx: number,
  lineStations: Station[],
): number {
  const path = shortestLinePathIndices(lineStations, fromIdx, toIdx, line);
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    total += getStopSeconds(line, lineStations[path[i]].id, lineStations[path[i + 1]].id);
  }
  return total;
}

// #1698 — line 위 fromIdx → toIdx hop 수 (closed loop 짧은 쪽 awareness).
function computeSegmentHops(
  line: LineNumber,
  fromIdx: number,
  toIdx: number,
  lineStations: Station[],
): number {
  return shortestLinePathIndices(lineStations, fromIdx, toIdx, line).length - 1;
}

// O(1) 룩업 테이블 (성능 최적화)
const stationById = new Map<string, Station>(allStations.map((s) => [s.id, s]));
const lineStationsCache = new Map<string, Station[]>();

function getLineStationsCached(line: LineNumber): Station[] {
  let cached = lineStationsCache.get(line);
  if (!cached) {
    cached = allStations.filter((s) => s.line === line).sort((a, b) => a.id.localeCompare(b.id));
    lineStationsCache.set(line, cached);
  }
  return cached;
}

// 노선별 name→index 캐시 (성능 최적화: buildNameIndex 중복 호출 제거)
const lineNameIndexCache = new Map<string, Map<string, number>>();

function getLineNameIndexCached(line: LineNumber): Map<string, number> {
  let cached = lineNameIndexCache.get(line);
  if (!cached) {
    cached = buildNameIndex(getLineStationsCached(line));
    lineNameIndexCache.set(line, cached);
  }
  return cached;
}

// 노선별 표기 불일치를 흡수하는 인덱스 조회 헬퍼.
// 1차 정확 일치, 실패 시 정규화 후 재시도.
function lookupNameIdx(idx: Map<string, number>, name: string): number | undefined {
  const hit = idx.get(name);
  if (hit !== undefined) return hit;
  return idx.get(normalizeStationName(name));
}

export interface DirectRoute {
  type: 'direct';
  stops: number;
  line: LineNumber;
  /** #655: 실측 운행 시간(초). findRoutes/updateRouteFromPosition가 lookup으로 채운다. */
  travelSeconds: number;
}

export interface TransferRoute {
  type: 'transfer';
  transferName: string;
  fromLine: LineNumber;
  toLine: LineNumber;
  stopsToTransfer: number;
  stopsFromTransfer: number;
  /** #655: 실측 운행 시간(초). 의미는 {@link DirectRoute.travelSeconds} 참고. */
  secondsToTransfer: number;
  /** #655: 실측 운행 시간(초). 의미는 {@link DirectRoute.travelSeconds} 참고. */
  secondsFromTransfer: number;
}

export interface TransferSegment {
  transferName: string;
  fromLine: LineNumber;
  toLine: LineNumber;
  stopsToTransfer: number;
  /** #655: 실측 운행 시간(초). 의미는 {@link DirectRoute.travelSeconds} 참고. */
  secondsToTransfer: number;
}

export interface MultiTransferRoute {
  type: 'multi-transfer';
  transfers: TransferSegment[];
  stopsAfterLastTransfer: number;
  /** #655: 실측 운행 시간(초). 의미는 {@link DirectRoute.travelSeconds} 참고. */
  secondsAfterLastTransfer: number;
}

export type Route = DirectRoute | TransferRoute | MultiTransferRoute | null;

/**
 * #1436 / #1449 — trip route에 포함된 노선 집합.
 * fusion 후보 단계(#1436)와 BoardingLock 채택 단계(#1449, ADR-015 §9 frontend)에서
 * trip route 외 노선을 차단하는 SSOT.
 * route 형태별로 leg의 line을 모두 모은다. trip 비활성/route null이면 undefined —
 * 호출자는 undefined를 "필터 미적용"으로 해석한다.
 */
export function allowedLinesFromRoute(
  route: Route | null | undefined,
): Set<LineNumber> | undefined {
  if (!route) return undefined;
  const lines = new Set<LineNumber>();
  if (route.type === 'direct') {
    lines.add(route.line);
  } else if (route.type === 'transfer') {
    lines.add(route.fromLine);
    lines.add(route.toLine);
  } else {
    for (const t of route.transfers) {
      lines.add(t.fromLine);
      lines.add(t.toLine);
    }
  }
  return lines;
}

export type RoutePreference = 'optimal' | 'minTransfer';

export interface RouteCandidate {
  route: NonNullable<Route>;
  totalStops: number;
  transferCount: number;
  travelMinutes: number;
}

export interface RouteCategory {
  key: RoutePreference;
  label: string;
  comparator: (a: RouteCandidate, b: RouteCandidate) => number;
}

export interface CategorizedRoute {
  category: RouteCategory;
  candidate: RouteCandidate;
}

export const ROUTE_CATEGORIES: readonly RouteCategory[] = [
  {
    key: 'optimal',
    label: '최적경로',
    comparator: (a, b) =>
      a.travelMinutes - b.travelMinutes || a.transferCount - b.transferCount,
  },
  {
    key: 'minTransfer',
    label: '최소환승',
    comparator: (a, b) =>
      a.transferCount - b.transferCount || a.travelMinutes - b.travelMinutes,
  },
];

export interface JourneySegment {
  line: LineNumber;
  lineColor: string;
  fromName: string;
  toName: string;
  stops: number;
}

export interface JourneyDisplay {
  segments: JourneySegment[];
  totalStops: number;
}

// 괄호 부제 제거는 ./normalizeStationName.js (SSOT — 빌드 스크립트와 공유)에 위임하고,
// 그 위에 노선별 공식 표기 차이(예: "이수" ↔ "총신대입구")를 흡수하는 별칭을 한 번 더 적용한다.
// Alias는 transferGraph 매칭 + transferTimes 키 생성 양쪽에 적용 — build-transfer-times.js도 동일 로직 사용.
export function normalizeStationName(name: string): string {
  return applyStationAlias(baseNormalizeStationName(name));
}

// 노선별 표기 차이를 흡수한 역 이름 동일성 비교.
// 예: "상봉" === "상봉(시외버스터미널)" (각각 7호선/경의중앙선 등록명)
export function isSameStationName(a: string, b: string): boolean {
  if (a === b) return true;
  return normalizeStationName(a) === normalizeStationName(b);
}

// 환승 그래프: fromLine → toLine → 환승역 이름 목록 (fromLine 쪽 실제 station.name)
const transferGraph = new Map<LineNumber, Map<LineNumber, string[]>>();

function buildTransferGraph(): void {
  const normalizedToStations = new Map<string, Station[]>();
  for (const s of allStations) {
    const key = normalizeStationName(s.name);
    let group = normalizedToStations.get(key);
    if (!group) {
      group = [];
      normalizedToStations.set(key, group);
    }
    group.push(s);
  }

  for (const group of normalizedToStations.values()) {
    const distinctLines = new Set(group.map((s) => s.line));
    if (distinctLines.size < 2) continue;
    for (const from of group) {
      for (const to of group) {
        if (from.line === to.line) continue;
        let toMap = transferGraph.get(from.line);
        if (!toMap) {
          toMap = new Map();
          transferGraph.set(from.line, toMap);
        }
        let names = toMap.get(to.line);
        if (!names) {
          names = [];
          toMap.set(to.line, names);
        }
        // fromLine 쪽 실제 이름을 저장 → findRoutes가 fromLine에서 candidate를 찾을 때 그대로 매칭.
        // 반대편 toLine 쪽 조회는 findStationByNameAndLine의 정규화 fallback이 처리.
        names.push(from.name);
      }
    }
  }
}

buildTransferGraph();

export function getStationsOnLine(line: LineNumber): Station[] {
  return getLineStationsCached(line);
}

/** stations.json id로 단일 Station 조회. 미존재 시 undefined. */
export function getStationById(id: string): Station | undefined {
  return stationById.get(id);
}

export function findStationByNameAndLine(name: string, line: LineNumber): Station | undefined {
  const stations = getLineStationsCached(line);
  const exact = stations.find((s) => s.name === name);
  if (exact) return exact;
  // 정규화 fallback: 노선별 표기 불일치(예: "상봉" vs "상봉(시외버스터미널)") 흡수.
  const normalized = normalizeStationName(name);
  return stations.find((s) => normalizeStationName(s.name) === normalized);
}

export function updateRouteFromPosition(
  storedRoute: NonNullable<Route>,
  nearestStation: Station,
  destinationId: string,
): Route | null {
  if (storedRoute.type === 'direct') {
    // getRemainingStops는 다른 노선이면 null을 반환하므로 노선 이탈 시 자동 fallback
    const dest = stationById.get(destinationId);
    if (!dest || nearestStation.line !== dest.line) return null;
    const remaining = getRemainingStops(nearestStation.id, destinationId);
    if (remaining === null) return null;
    // dest.line을 채택해 stored가 invariant를 깨고 들어와도 자가 치유되도록 한다.
    const lineStations = getLineStationsCached(dest.line);
    const nIdx = lineStations.findIndex((s) => s.id === nearestStation.id);
    const dIdx = lineStations.findIndex((s) => s.id === destinationId);
    return {
      type: 'direct',
      stops: remaining,
      line: dest.line,
      travelSeconds: computeSegmentSeconds(dest.line, nIdx, dIdx, lineStations),
    };
  }

  if (storedRoute.type === 'transfer') {
    if (nearestStation.line === storedRoute.fromLine) {
      const transfer = findStationByNameAndLine(storedRoute.transferName, storedRoute.fromLine);
      if (!transfer) return null;
      const stopsToTransfer = getRemainingStops(nearestStation.id, transfer.id);
      if (stopsToTransfer === null) return null;
      const lineStations = getLineStationsCached(storedRoute.fromLine);
      const nIdx = lineStations.findIndex((s) => s.id === nearestStation.id);
      const tIdx = lineStations.findIndex((s) => s.id === transfer.id);
      return {
        ...storedRoute,
        stopsToTransfer,
        secondsToTransfer: computeSegmentSeconds(storedRoute.fromLine, nIdx, tIdx, lineStations),
      };
    }
    if (nearestStation.line === storedRoute.toLine) {
      const stopsFromTransfer = getRemainingStops(nearestStation.id, destinationId);
      if (stopsFromTransfer === null) return null;
      const lineStations = getLineStationsCached(storedRoute.toLine);
      const nIdx = lineStations.findIndex((s) => s.id === nearestStation.id);
      const dIdx = lineStations.findIndex((s) => s.id === destinationId);
      return {
        ...storedRoute,
        stopsToTransfer: 0,
        stopsFromTransfer,
        secondsToTransfer: 0,
        secondsFromTransfer: computeSegmentSeconds(storedRoute.toLine, nIdx, dIdx, lineStations),
      };
    }
    return null;
  }

  // multi-transfer: transfers 배열을 순회하여 현재 구간 탐색
  const { transfers } = storedRoute;

  for (let i = 0; i < transfers.length; i++) {
    const segment = transfers[i];
    if (nearestStation.line === segment.fromLine) {
      const station = findStationByNameAndLine(segment.transferName, segment.fromLine);
      if (!station) return null;
      const stops = getRemainingStops(nearestStation.id, station.id);
      if (stops === null) return null;
      const lineStations = getLineStationsCached(segment.fromLine);
      const nIdx = lineStations.findIndex((s) => s.id === nearestStation.id);
      const tIdx = lineStations.findIndex((s) => s.id === station.id);
      const secondsToCurrent = computeSegmentSeconds(segment.fromLine, nIdx, tIdx, lineStations);
      const updatedTransfers = transfers.map((t, j) =>
        j < i
          ? { ...t, stopsToTransfer: 0, secondsToTransfer: 0 }
          : j === i
            ? { ...t, stopsToTransfer: stops, secondsToTransfer: secondsToCurrent }
            : t,
      );
      return { ...storedRoute, transfers: updatedTransfers };
    }
  }

  // 마지막 환승 이후 구간 (목적지 방향)
  const lastTransfer = transfers[transfers.length - 1];
  if (lastTransfer && nearestStation.line === lastTransfer.toLine) {
    const stops = getRemainingStops(nearestStation.id, destinationId);
    if (stops === null) return null;
    const lineStations = getLineStationsCached(lastTransfer.toLine);
    const nIdx = lineStations.findIndex((s) => s.id === nearestStation.id);
    const dIdx = lineStations.findIndex((s) => s.id === destinationId);
    const lastSegSeconds = computeSegmentSeconds(lastTransfer.toLine, nIdx, dIdx, lineStations);
    const updatedTransfers = transfers.map((t) => ({
      ...t,
      stopsToTransfer: 0,
      secondsToTransfer: 0,
    }));
    return {
      ...storedRoute,
      transfers: updatedTransfers,
      stopsAfterLastTransfer: stops,
      secondsAfterLastTransfer: lastSegSeconds,
    };
  }

  return null;
}

/**
 * 경로의 첫 leg(=탑승 단계)의 노선과 종점 역 이름을 반환한다.
 *
 *   - direct       → { line, endName: destinationName }
 *   - transfer     → { line: fromLine, endName: transferName }
 *   - multiTransfer→ { line: transfers[0].fromLine, endName: transfers[0].transferName }
 *
 * "endName"은 첫 leg에서 사용자가 향하는 노선상 종점(다음 환승 지점 또는 최종 목적지) 이름.
 * tripDirection / boardingPromptContext가 공통으로 사용 — #1028 follow-up (#1065).
 */
export function getFirstLeg(
  route: NonNullable<Route>,
  destinationName: string,
): { line: LineNumber; endName: string } {
  if (route.type === 'direct') {
    return { line: route.line, endName: destinationName };
  }
  if (route.type === 'transfer') {
    return { line: route.fromLine, endName: route.transferName };
  }
  const first = route.transfers[0];
  return { line: first.fromLine, endName: first.transferName };
}

/**
 * Lockless trip의 station-passed 게이트(#1208, Epic #1204 D2) 기본 hop window 반경.
 * D1 estimator가 추정한 currentHopIndex 기준 ±N hop 안의 candidate만 통과.
 * 1이면 이전 hop, 현재 hop, 다음 hop만 fire 허용 — false positive 차단(이미 지나간 hop)
 * 과 false negative 차단(미래 hop) 사이 보수적 균형.
 */
export const LOCKLESS_HOP_WINDOW_DEFAULT = 1;

/**
 * #1208 (Epic #1204 D2) — station-passed 게이트.
 * arcStations 위에서 candidate station이 currentHopIndex ± windowSize 범위에 있는지 검사.
 *
 * 호출자(useStationAlarm)는 `isStationOnRoute` 다음에 본 함수로 trip 진행도 hop window를 추가 가드한다.
 * - true: route 위에 있고 hop window 안 → station-passed 발사 허용
 * - false: route 밖 또는 hop window 밖 → 발사 차단 (caller가 logSuppressedHopWindow로 기록)
 *
 * arc 밖 station(arcIndex === -1)이거나 currentHopIndex가 음수면 false.
 */
export function isStationWithinHopWindow(
  station: Station,
  arcStations: readonly Station[],
  currentHopIndex: number,
  windowSize: number = LOCKLESS_HOP_WINDOW_DEFAULT,
): boolean {
  if (currentHopIndex < 0) return false;
  const candidateIndex = arcStations.findIndex((s) => s.id === station.id);
  if (candidateIndex === -1) return false;
  return (
    candidateIndex >= currentHopIndex - windowSize &&
    candidateIndex <= currentHopIndex + windowSize
  );
}

/**
 * #1208 — arcStations에서 station의 인덱스. 미발견 -1.
 * useStationAlarm이 fallback hop 추정(firedAlarms max+1) 시 사용.
 */
export function arcIndexOf(arcStations: readonly Station[], station: Station): number {
  return arcStations.findIndex((s) => s.id === station.id);
}

export function isStationOnRoute(station: Station, route: NonNullable<Route>): boolean {
  if (route.type === 'direct') {
    return station.line === route.line;
  }
  if (route.type === 'transfer') {
    return station.line === route.fromLine || station.line === route.toLine;
  }
  // multi-transfer: transfers[i].toLine === transfers[i+1].fromLine 이므로
  // fromLine+toLine 합집합 검사로 중간 노선까지 누락 없이 모두 커버한다.
  for (const t of route.transfers) {
    if (station.line === t.fromLine || station.line === t.toLine) return true;
  }
  return false;
}

export function getRemainingStops(
  currentId: string,
  destinationId: string,
): number | null {
  const current = stationById.get(currentId);
  const destination = stationById.get(destinationId);

  if (!current || !destination) return null;
  if (current.line !== destination.line) return null;

  const lineStations = getLineStationsCached(current.line);
  const currentIdx = lineStations.findIndex((s) => s.id === currentId);
  const destIdx = lineStations.findIndex((s) => s.id === destinationId);

  // #1698 — 2호선 본선 closed loop은 shortestLinePathIndices가 짧은 쪽 path 반환.
  // trip 진행 중 매 update마다 호출되는 hot path이므로 wraparound도 정합 필수.
  const path = shortestLinePathIndices(lineStations, currentIdx, destIdx, current.line);
  return path.length - 1;
}

// 같은 노선 위 두 역 사이의 중간역 이름 배열을 진행 방향대로 반환.
// 양 끝점은 제외. 인접 역 또는 같은 역이면 빈 배열. 다른 노선/미존재 id면 null.
export function getIntermediateStationNames(
  fromId: string,
  toId: string,
): string[] | null {
  const from = stationById.get(fromId);
  const to = stationById.get(toId);
  if (!from || !to) return null;
  if (from.line !== to.line) return null;

  const lineStations = getLineStationsCached(from.line);
  const fromIdx = lineStations.findIndex((s) => s.id === fromId);
  const toIdx = lineStations.findIndex((s) => s.id === toId);
  /* istanbul ignore next -- stationById에 존재하면 같은 line의 lineStations에도 존재한다는 invariant */
  if (fromIdx === -1 || toIdx === -1) return null;
  if (fromIdx === toIdx) return [];

  // #1698 — 2호선 본선 closed loop은 shortestLinePathIndices가 짧은 쪽 path 반환.
  const path = shortestLinePathIndices(lineStations, fromIdx, toIdx, from.line);
  return path.slice(1, -1).map((i) => lineStations[i].name);
}

function buildNameIndex(stations: Station[]): Map<string, number> {
  const index = new Map<string, number>();
  for (let i = 0; i < stations.length; i++) {
    const { name } = stations[i];
    index.set(name, i);
    // 정규화 키도 함께 등록 → 노선별 표기 불일치 흡수.
    // 한 노선 내 동일 정규화 이름 충돌은 데이터 특성상 없음 (역명은 노선 내 유일).
    const normalized = normalizeStationName(name);
    if (normalized !== name) index.set(normalized, i);
  }
  return index;
}

function toCandidate(route: NonNullable<Route>): RouteCandidate {
  const travelMinutes = getTravelMinutes(route);
  if (route.type === 'direct') {
    return { route, totalStops: route.stops, transferCount: 0, travelMinutes };
  }
  if (route.type === 'transfer') {
    const totalStops = route.stopsToTransfer + route.stopsFromTransfer;
    return { route, totalStops, transferCount: 1, travelMinutes };
  }
  const transferStops = route.transfers.reduce((sum, t) => sum + t.stopsToTransfer, 0);
  const totalStops = transferStops + route.stopsAfterLastTransfer;
  return { route, totalStops, transferCount: route.transfers.length, travelMinutes };
}

export function findRoutes(currentId: string, destinationId: string): RouteCandidate[] {
  const start = performance.now();
  const current = stationById.get(currentId);
  const destination = stationById.get(destinationId);

  if (!current || !destination) return [];

  // 같은 노선: 직통
  if (current.line === destination.line) {
    const lineStations = getLineStationsCached(current.line);
    const cIdx = lineStations.findIndex((s) => s.id === currentId);
    const dIdx = lineStations.findIndex((s) => s.id === destinationId);
    // #1698 — 2호선 본선 closed loop은 wraparound 짧은 쪽 stops 산출.
    const path = shortestLinePathIndices(lineStations, cIdx, dIdx, current.line);
    const direct: DirectRoute = {
      type: 'direct',
      stops: path.length - 1,
      line: current.line,
      travelSeconds: computeSegmentSeconds(current.line, cIdx, dIdx, lineStations),
    };
    const duration = performance.now() - start;
    logger.debug(`findRoutes(${currentId} → ${destinationId}): ${duration.toFixed(2)}ms`);
    return [toCandidate(direct)];
  }

  // 다른 노선: 단일 환승 + 2회 환승 모두 탐색
  const currentLineStations = getLineStationsCached(current.line);
  const destLineStations = getLineStationsCached(destination.line);
  const currentIdx = currentLineStations.findIndex((s) => s.id === currentId);
  const destIdx = destLineStations.findIndex((s) => s.id === destinationId);
  const destNameIndex = getLineNameIndexCached(destination.line);

  // 단일 환승 후보
  let bestSingle: TransferRoute | null = null;
  let bestSingleTotal = Infinity;

  for (let i = 0; i < currentLineStations.length; i++) {
    const candidate = currentLineStations[i];
    const transferDestIdx = lookupNameIdx(destNameIndex, candidate.name);
    if (transferDestIdx === undefined) continue;

    // #1698 — 환승 leg도 closed loop 짧은 쪽 hop 수 사용 (stops/seconds 정합).
    const stopsToTransfer = computeSegmentHops(current.line, currentIdx, i, currentLineStations);
    const stopsFromTransfer = computeSegmentHops(destination.line, transferDestIdx, destIdx, destLineStations);
    const total = stopsToTransfer + stopsFromTransfer;

    if (total < bestSingleTotal) {
      bestSingleTotal = total;
      bestSingle = {
        type: 'transfer',
        transferName: candidate.name,
        fromLine: current.line,
        toLine: destination.line,
        stopsToTransfer,
        stopsFromTransfer,
        secondsToTransfer: computeSegmentSeconds(current.line, currentIdx, i, currentLineStations),
        secondsFromTransfer: computeSegmentSeconds(destination.line, transferDestIdx, destIdx, destLineStations),
      };
    }
  }

  // 2회 환승 후보
  const multiRoute = findMultiTransferRoute(
    current, destination, currentLineStations, destLineStations, currentIdx, destIdx,
  );

  // 후보 수집 + 정렬 — 도미네이션 필터는 적용하지 않음.
  // 카테고리별 선택은 findRouteCandidatesByCategory에서 책임진다.
  const candidates: RouteCandidate[] = [];
  if (bestSingle) candidates.push(toCandidate(bestSingle));
  /* istanbul ignore next -- 실제 서울 지하철 데이터에서 2회 환승 불가 노선 조합은 없음 */
  if (multiRoute) candidates.push(toCandidate(multiRoute));

  candidates.sort((a, b) => a.travelMinutes - b.travelMinutes);

  const duration = performance.now() - start;
  logger.debug(`findRoutes(${currentId} → ${destinationId}): ${duration.toFixed(2)}ms`);
  return candidates;
}

export function findRouteCandidatesByCategory(
  originIds: readonly string[],
  destinationId: string,
  categories: readonly RouteCategory[] = ROUTE_CATEGORIES,
): CategorizedRoute[] {
  const all = originIds.flatMap((id) => findRoutes(id, destinationId));
  if (all.length === 0) return [];
  return categories.map((category) => ({
    category,
    candidate: [...all].sort(category.comparator)[0],
  }));
}

export function findRoute(currentId: string, destinationId: string): Route {
  const candidates = findRoutes(currentId, destinationId);
  if (candidates.length === 0) return null;
  // 하위 호환: 환승 적은 경로 우선 (기존 동작)
  return pickRouteByPreference(candidates, 'minTransfer')!.route;
}

export function pickRouteByPreference(
  candidates: RouteCandidate[],
  preference: RoutePreference,
): RouteCandidate | null {
  if (candidates.length === 0) return null;
  const category = ROUTE_CATEGORIES.find((c) => c.key === preference);
  /* istanbul ignore next -- RoutePreference 유니온이 ROUTE_CATEGORIES 키와 동기화되므로 undefined 불가 */
  if (!category) return candidates[0];
  return [...candidates].sort(category.comparator)[0];
}

function findMultiTransferRoute(
  current: Station,
  destination: Station,
  currentLineStations: Station[],
  destLineStations: Station[],
  currentIdx: number,
  destIdx: number,
): MultiTransferRoute | null {
  const fromLine = current.line;
  const toLine = destination.line;
  const fromEdges = transferGraph.get(fromLine);
  /* istanbul ignore next -- 실제 역 데이터에서는 모든 노선이 환승 가능 */
  if (!fromEdges) return null;

  let best: MultiTransferRoute | null = null;
  let bestTotal = Infinity;

  const currentNameIndex = getLineNameIndexCached(current.line);
  const destNameIndex = getLineNameIndexCached(destination.line);

  // 현재 노선에서 갈 수 있는 중간 노선들
  for (const [midLine, transfer1Names] of fromEdges) {
    /* istanbul ignore next -- 직접 환승은 findRoute에서 먼저 처리됨 */
    if (midLine === toLine) continue;
    const midEdges = transferGraph.get(midLine);
    /* istanbul ignore next */
    if (!midEdges) continue;
    const transfer2Names = midEdges.get(toLine);
    /* istanbul ignore next */
    if (!transfer2Names) continue;

    const midNameIndex = getLineNameIndexCached(midLine);
    const midLineStations = getLineStationsCached(midLine);

    // 첫 번째 환승: 현재노선 → 중간노선
    for (const t1Name of transfer1Names) {
      const t1CurrentIdx = lookupNameIdx(currentNameIndex, t1Name);
      const t1MidIdx = lookupNameIdx(midNameIndex, t1Name);
      /* istanbul ignore next -- 환승 그래프가 같은 데이터에서 빌드되므로 undefined 불가 */
      if (t1CurrentIdx === undefined || t1MidIdx === undefined) continue;

      // #1698 — 환승 leg hop 수도 closed loop awareness.
      const stopsToFirst = computeSegmentHops(fromLine, currentIdx, t1CurrentIdx, currentLineStations);

      // 두 번째 환승: 중간노선 → 목적지노선
      for (const t2Name of transfer2Names) {
        const t2MidIdx = lookupNameIdx(midNameIndex, t2Name);
        const t2DestIdx = lookupNameIdx(destNameIndex, t2Name);
        /* istanbul ignore next */
        if (t2MidIdx === undefined || t2DestIdx === undefined) continue;

        const stopsToSecond = computeSegmentHops(midLine, t1MidIdx, t2MidIdx, midLineStations);
        const stopsAfter = computeSegmentHops(toLine, t2DestIdx, destIdx, destLineStations);
        const total = stopsToFirst + stopsToSecond + stopsAfter;

        if (total < bestTotal) {
          bestTotal = total;
          best = {
            type: 'multi-transfer',
            transfers: [
              {
                transferName: t1Name,
                fromLine,
                toLine: midLine,
                stopsToTransfer: stopsToFirst,
                secondsToTransfer: computeSegmentSeconds(fromLine, currentIdx, t1CurrentIdx, currentLineStations),
              },
              {
                transferName: t2Name,
                fromLine: midLine,
                toLine,
                stopsToTransfer: stopsToSecond,
                secondsToTransfer: computeSegmentSeconds(midLine, t1MidIdx, t2MidIdx, midLineStations),
              },
            ],
            stopsAfterLastTransfer: stopsAfter,
            secondsAfterLastTransfer: computeSegmentSeconds(toLine, t2DestIdx, destIdx, destLineStations),
          };
        }
      }
    }
  }

  return best;
}

// 환승 도보 시간 lookup은 `./transferTimes.ts` (ADR-015 §6 SSOT)로 추출 — 동일 데이터셋을
// `BoardingTrainList walkingBufferSeconds` 등 다른 호출자와 공유. fallback은 동일 모듈 안에서
// `TRANSFER_WALKING_BUFFER_SECONDS`(180s)로 처리. import 위치는 파일 상단.

export function buildJourneyDisplay(
  route: Route,
  current: Station,
  destination: Station,
): JourneyDisplay | null {
  if (!route) return null;

  if (route.type === 'direct') {
    // 환승역에서 출발할 경우 GPS가 가까운 호선 entry를 current로 잡지만,
    // 실제 우승 경로는 다른 호선 entry에서 시작할 수 있다. 표시 호선은 route.line이 정답.
    return {
      segments: [
        {
          line: route.line,
          lineColor: LINE_COLORS[route.line] ?? current.lineColor,
          fromName: current.name,
          toName: destination.name,
          stops: route.stops,
        },
      ],
      totalStops: route.stops,
    };
  }

  if (route.type === 'transfer') {
    return {
      segments: [
        {
          line: route.fromLine,
          lineColor: LINE_COLORS[route.fromLine] ?? current.lineColor,
          fromName: current.name,
          toName: route.transferName,
          stops: route.stopsToTransfer,
        },
        {
          line: route.toLine,
          lineColor: LINE_COLORS[route.toLine] ?? destination.lineColor,
          fromName: route.transferName,
          toName: destination.name,
          stops: route.stopsFromTransfer,
        },
      ],
      totalStops: route.stopsToTransfer + route.stopsFromTransfer,
    };
  }

  // multi-transfer: transfers 배열을 순회하여 세그먼트 생성
  const { transfers } = route;
  const segments: JourneyDisplay['segments'] = transfers.map((t, i) => {
    const prevName = i === 0 ? current.name : transfers[i - 1].transferName;
    const fallbackColor = i === 0 ? current.lineColor : '#888888';
    return {
      line: t.fromLine,
      lineColor: LINE_COLORS[t.fromLine] ?? fallbackColor,
      fromName: prevName,
      toName: t.transferName,
      stops: t.stopsToTransfer,
    };
  });
  const lastTransfer = transfers[transfers.length - 1];
  segments.push({
    line: lastTransfer.toLine,
    lineColor: LINE_COLORS[lastTransfer.toLine] ?? destination.lineColor,
    fromName: lastTransfer.transferName,
    toName: destination.name,
    stops: route.stopsAfterLastTransfer,
  });
  const totalStops = transfers.reduce((sum, t) => sum + t.stopsToTransfer, 0) + route.stopsAfterLastTransfer;
  return { segments, totalStops };
}

// 출발역 다음 열차 대기 시간 fallback(분). arrivalAtOrigin이 없거나 stale일 때 사용.
// 평시 평균값에 가깝지만 첨두/심야 편차로 실측과 2~7분 차이 가능 — #777에서 arrival 동적값으로
// 전환했고 본 상수는 데이터 부재 시 회귀 방지 fallback 역할.
const DEFAULT_WAIT_MINUTES = 3;

/**
 * 잔여 경로 전체(현재 위치 이후 모든 hop + 환승 대기)의 실측 hop 시간 합(초). #2279 —
 * 알람/알림 ETA가 haversine 직선거리÷순간속도(정거장수와 독립)로 산출되던 것을
 * hop 시간(실측 테이블) 기반 상한으로 clamp하는 데 사용한다. `route`는 findRoute/
 * updateRouteFromPosition이 매 위치 갱신마다 nIdx(현재 인접역)→dIdx(목적지)로 재계산하므로
 * 반환값은 "지금부터 남은" 시간이다(호출 시점 스냅샷, 실시간 갱신은 호출자 책임).
 */
export function getRouteRemainingSeconds(route: NonNullable<Route>): number {
  if (route.type === 'direct') {
    return route.travelSeconds;
  }

  if (route.type === 'transfer') {
    return (
      route.secondsToTransfer +
      route.secondsFromTransfer +
      getTransferSeconds(route.fromLine, route.toLine, route.transferName)
    );
  }

  const segmentSecondsSum = route.transfers.reduce(
    (sum, t) => sum + t.secondsToTransfer,
    0,
  );
  const transferSecSum = route.transfers.reduce(
    (sum, t) => sum + getTransferSeconds(t.fromLine, t.toLine, t.transferName),
    0,
  );
  return segmentSecondsSum + route.secondsAfterLastTransfer + transferSecSum;
}

// 반환값은 항상 정수 분. 호출처(메인 ETA 카운터/알림 body/Live Activity etaMinutes Swift Int? 디코딩)가
// 정수 분 contract에 의존하므로, 구간별 실측 운행시간(초)과 환승역별 실측 환승시간(초)을 합산해
// 분으로 환산한 결과를 마지막에 반올림한다. 환승 시간은 getTransferSeconds.
function getTravelMinutes(route: NonNullable<Route>): number {
  return Math.round(getRouteRemainingSeconds(route) / 60);
}

/** lat/lng만 추출한 좌표 — Station 전체를 넘기지 않아 결합도를 낮춘다. */
export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * calculateStaticETA 옵션. 누락된 필드는 graceful fallback(도보=0, 대기=DEFAULT_WAIT_MINUTES).
 *
 * 도보 (#776):
 * - currentLocation + originStation 둘 다 있으면 출발 도보 시간 합산
 * - destination + destinationStation 둘 다 있으면 하차 도보 시간 합산
 *
 * 대기 (#777):
 * - arrivalAtOrigin이 있고 freshness(60s) 통과 → arrivalSeconds를 분으로 환산해 사용
 * - 없거나 stale → DEFAULT_WAIT_MINUTES fallback
 */
export interface StaticEtaOptions {
  /** 사용자 현재 위치(GPS). originStation과 함께 있을 때 출발역까지 도보 시간 계산. */
  currentLocation?: LatLng;
  /** 경로의 출발 지하철역 좌표. currentLocation 없으면 미사용. */
  originStation?: LatLng;
  /** 사용자 최종 목적지(예: 사무실 좌표). destinationStation과 함께 있을 때 하차 도보 시간 계산. */
  destination?: LatLng;
  /** 경로의 하차 지하철역 좌표. destination 없으면 미사용. */
  destinationStation?: LatLng;
  /**
   * 출발역의 다음 열차 도착 정보. realtimePosition/arrival API에서 추출.
   * `receivedAtMs <= 0`이거나 `nowMs - receivedAtMs > ARRIVAL_FRESHNESS_MS`이면 stale로 간주.
   * 누락 또는 stale 시 DEFAULT_WAIT_MINUTES fallback (회귀 없음).
   */
  arrivalAtOrigin?: { arrivalSeconds: number; receivedAtMs: number };
  /**
   * #778 — 각 환승역의 다음 열차 도착 정보 (transfer 순서, 0 = 첫 환승).
   * - transfer route: [0] 한 개
   * - multi-transfer route: [0..transfers.length-1]
   * - 누락된 element나 stale은 leg당 DEFAULT_WAIT_MINUTES fallback (회귀 없음)
   * `transferTimes.json`은 도보만 포함 — 환승 후 다음 열차 대기는 본 필드로만 합산
   */
  arrivalsAtTransfers?: ReadonlyArray<{ arrivalSeconds: number; receivedAtMs: number } | null>;
  /**
   * #1480 — 각 환승역의 timetable boardable train 대기 시간(초).
   * - features 쪽 `calculateBoardableTrainETA` 결과를 transfer 순서대로 배열로 주입.
   * - arrivalsAtTransfers가 fresh하면 그쪽이 우선 (실시간 데이터). 누락/stale + timetable 값이
   *   있으면 본 필드로 환승 leg wait 분 계산. 둘 다 부재면 DEFAULT_WAIT_MINUTES fallback.
   * - 본 필드는 timetable 부재 노선(1~9 외) 또는 station alias mismatch 시 element가 `null`.
   */
  timetableBoardableWaitSecondsByLeg?: ReadonlyArray<number | null>;
  /** freshness 계산용 현재 시각(ms). 미지정 시 Date.now() — 테스트에서 monkeypatch. */
  nowMs?: number;
  /**
   * #2290 — 탑승 중(in-trip: boardingLock 활성 / legAdvance stamp / trip 진행 evidence)에는
   * 출발 leg의 boarding 대기(originWaitMinutes)를 이미 소진한 상태이므로 0으로 제외한다.
   * 잔여 환승 leg의 대기(transferWaitMinutes)는 유지 — 아직 타지 않은 leg의 대기는 실재한다.
   * 미지정 시 기존 동작(대기+주행 합산) 동치.
   */
  excludeOriginWait?: boolean;
}

// 한 페어(사용자 좌표 + 역 좌표)의 도보 시간(분). 누락 시 0.
// estimateEtaSeconds를 재사용하되, 보행은 항상 WALKING_SPEED_M_PER_S(=1.2) 위쪽이라 null이 될 일이 없다.
function calculateWalkingMinutes(from: LatLng | undefined, to: LatLng | undefined): number {
  if (!from || !to) return 0;
  const distM = distanceMetersBetween(from.lat, from.lng, to.lat, to.lng);
  // WALKING_SPEED_M_PER_S(=1.2) >= MIN_VALID_SPEED_MPS(=0.5) 이므로 항상 number 반환.
  // 타입 narrowing을 위해 ?? 0 — 향후 상수 변경 시 회귀 차단.
  /* istanbul ignore next -- WALKING_SPEED_M_PER_S > MIN_VALID_SPEED_MPS 불변식상 null 경로 도달 불가 */
  const seconds = estimateEtaSeconds(distM, WALKING_SPEED_M_PER_S) ?? 0;
  return seconds / 60;
}

// arrivalAtOrigin이 fresh하면 arrivalSeconds(초)를 분으로, 아니면 DEFAULT_WAIT_MINUTES.
// 게이트는 isFreshArrival와 공유 — 두 분기 모두 receivedAtMs<=0(mock/누락) / 나이>ARRIVAL_FRESHNESS_MS(stale) /
// arrivalSeconds<0(비정상) 셋을 동일 의미로 거른다.
function resolveWaitMinutes(
  arrivalAtOrigin: StaticEtaOptions['arrivalAtOrigin'],
  nowMs: number,
): number {
  if (!isFreshArrival(arrivalAtOrigin, nowMs)) return DEFAULT_WAIT_MINUTES;
  return arrivalAtOrigin.arrivalSeconds / 60;
}

// transfer 횟수: direct=0, transfer=1, multi-transfer=transfers.length.
// exhaustive switch — 새 Route variant 추가 시 컴파일 시점에 누락 차단.
function getTransferCount(route: NonNullable<Route>): number {
  switch (route.type) {
    case 'direct':
      return 0;
    case 'transfer':
      return 1;
    case 'multi-transfer':
      return route.transfers.length;
    /* istanbul ignore next — Route union이 exhaustive하므로 도달 불가, 새 variant 추가 시 컴파일 차단 */
    default: {
      const _exhaustive: never = route;
      return _exhaustive;
    }
  }
}

// 환승 leg마다 fresh arrival이면 동적, 아니면 timetable boardable, 둘 다 부재면 DEFAULT_WAIT_MINUTES.
// transferCount=0 (direct)이면 0. 누락 element는 다음 fallback으로.
// #1480 — boardable timetable layer 추가 (arrivalsAtTransfers > timetable > DEFAULT cascade).
function resolveTransferWaitMinutes(
  arrivalsAtTransfers: StaticEtaOptions['arrivalsAtTransfers'],
  timetableBoardableWaitSecondsByLeg: StaticEtaOptions['timetableBoardableWaitSecondsByLeg'],
  transferCount: number,
  nowMs: number,
): number {
  let total = 0;
  for (let i = 0; i < transferCount; i++) {
    const arrival = arrivalsAtTransfers?.[i] ?? undefined;
    if (isFreshArrival(arrival, nowMs)) {
      total += arrival.arrivalSeconds / 60;
      continue;
    }
    const timetableSeconds = timetableBoardableWaitSecondsByLeg?.[i] ?? null;
    if (timetableSeconds !== null && timetableSeconds >= 0) {
      total += timetableSeconds / 60;
      continue;
    }
    total += DEFAULT_WAIT_MINUTES;
  }
  return total;
}

// fresh 판정만 (#1480 cascade에서 isFresh 단독 사용). resolveWaitMinutes는 fresh + fallback을 합쳐 처리.
function isFreshArrival(
  arrival: { arrivalSeconds: number; receivedAtMs: number } | undefined,
  nowMs: number,
): arrival is { arrivalSeconds: number; receivedAtMs: number } {
  if (!arrival) return false;
  if (arrival.receivedAtMs <= 0) return false;
  if (nowMs - arrival.receivedAtMs > ARRIVAL_FRESHNESS_MS) return false;
  if (arrival.arrivalSeconds < 0) return false;
  return true;
}

/**
 * 경로 정적 ETA(분). 다음 열차 대기 + 지하철 운행/환승 + (옵션) 출발/도착 도보 + 환승 후 대기.
 *
 * - route=null이면 null
 * - options 미지정 시 기존 동작 동치 (도보 0, 출발 대기 DEFAULT_WAIT_MINUTES, 환승 대기 leg당 DEFAULT_WAIT_MINUTES)
 * - 페어가 부분적으로 누락되면 해당 도보 시간만 0 (예: currentLocation은 있는데 originStation이 없으면
 *   출발 도보 0 — 사용자 위치 권한 미확보 등 부분 정보 상황에서 graceful fallback)
 * - arrivalAtOrigin fresh → arrivalSeconds 동적 사용, 없거나 stale → DEFAULT_WAIT_MINUTES
 * - #778: arrivalsAtTransfers[i] fresh → 해당 환승 leg wait 동적, 없거나 stale → leg당 DEFAULT_WAIT_MINUTES
 *
 * 반환은 분 단위 정수 — 호출처(메인 ETA 카운터/알림 body 등)가 정수를 전제로 한다.
 * 지하철 시간은 getTravelMinutes에서 이미 분 단위 정수, 대기(출발+환승)는 합산해 한 번 round.
 */
export function calculateStaticETA(
  route: Route,
  options: StaticEtaOptions = {},
): number | null {
  if (!route) return null;
  const nowMs = options.nowMs ?? Date.now();
  const walkingMinutes =
    calculateWalkingMinutes(options.currentLocation, options.originStation) +
    calculateWalkingMinutes(options.destinationStation, options.destination);
  // #2290 — in-trip이면 출발 leg 대기는 이미 소진했으므로 0.
  const originWaitMinutes = options.excludeOriginWait
    ? 0
    : resolveWaitMinutes(options.arrivalAtOrigin, nowMs);
  const transferWaitMinutes = resolveTransferWaitMinutes(
    options.arrivalsAtTransfers,
    options.timetableBoardableWaitSecondsByLeg,
    getTransferCount(route),
    nowMs,
  );
  const totalWaitMinutes = originWaitMinutes + transferWaitMinutes;
  return Math.round(totalWaitMinutes) + getTravelMinutes(route) + Math.round(walkingMinutes);
}

/**
 * 환승 직후 잔여 ride time(분). #584 PR E 후속(#604).
 *
 * completedTransferIdx 번째 환승을 막 끝내고 새 열차에 탑승한 시점부터 도착역까지의 잔여 시간.
 * BoardingLock의 expectedDurationMs는 boardedAt 이후 ride 시간을 의미하므로, 사용자가 list에서
 * 열차를 탭하는 순간(=새 boardedAt)부터의 시간이 산출 대상. 따라서 첫 열차 대기(DEFAULT_WAIT)는
 * 포함하지 않는다. 잔여 환승의 대기는 환승역별 실측 시간으로 포함.
 *
 * - direct: 환승 없음 → null
 * - transfer/multi-transfer: 0..transfers.length-1 범위만 유효
 *
 * 산식: 잔여 구간 운행시간(초) 합 + Σ(잔여 환승역의 실측 환승시간) → 분으로 round.
 */
export function calculateRemainingLegETA(
  route: Route,
  completedTransferIdx: number,
): number | null {
  if (!route) return null;
  if (route.type === 'direct') return null;
  const legs = getTransferLegs(route);
  if (completedTransferIdx < 0 || completedTransferIdx >= legs.transferCount) return null;
  const remainingSegmentSeconds = legs.afterTransferSeconds
    .slice(completedTransferIdx + 1)
    .reduce((s, n) => s + n, 0);
  const totalRemainingSeconds =
    legs.afterTransferSeconds[completedTransferIdx] + remainingSegmentSeconds;
  // 잔여 환승 시간 합산: completedTransferIdx 다음 환승부터. transfer 타입은 환승 1회뿐이라 잔여 0.
  let remainingTransferSec = 0;
  if (route.type === 'multi-transfer') {
    for (let i = completedTransferIdx + 1; i < route.transfers.length; i++) {
      const t = route.transfers[i];
      remainingTransferSec += getTransferSeconds(t.fromLine, t.toLine, t.transferName);
    }
  }
  // 반환값은 정수 분 — BoardingLock expectedDurationMs(ms 단위 정수 변환)와 호출처가 정수를 전제로 함.
  return Math.round((totalRemainingSeconds + remainingTransferSec) / 60);
}

/**
 * transfer/multi-transfer 라우트를 통일된 leg 표현으로 정규화. transferCount는 환승 횟수,
 * afterTransferSeconds[i]는 i번째 환승을 끝낸 후 다음 waypoint(=다음 환승 또는 도착역)까지의 운행 시간(초).
 */
function getTransferLegs(
  route: Exclude<NonNullable<Route>, DirectRoute>,
): { transferCount: number; afterTransferSeconds: number[] } {
  if (route.type === 'transfer') {
    return {
      transferCount: 1,
      afterTransferSeconds: [route.secondsFromTransfer],
    };
  }
  const after = route.transfers.slice(1).map((t) => t.secondsToTransfer);
  after.push(route.secondsAfterLastTransfer);
  return { transferCount: route.transfers.length, afterTransferSeconds: after };
}

// ASCII Unit Separator(0x1F) — 사용자 데이터(역명/노선명)에 절대 등장하지 않는
// 제어문자라 transferName 안에 구분자가 섞여도 signature 충돌이 구조적으로 불가능.
const SIG_SEP = '\x1f';

/**
 * route의 내용 동일성을 비교하기 위한 stable signature.
 * categorized recompute 등으로 route 객체 reference가 바뀌어도 내용이 같으면
 * 동일 문자열을 반환 — useEffect deps/dedup key에 사용해 불필요한 재발사를 막는다.
 */
export function routeSignature(route: Route): string {
  if (!route) return '';
  switch (route.type) {
    case 'direct':
      return ['d', route.line, route.stops].join(SIG_SEP);
    case 'transfer':
      return [
        't',
        route.fromLine,
        route.toLine,
        route.transferName,
        route.stopsToTransfer,
        route.stopsFromTransfer,
      ].join(SIG_SEP);
    case 'multi-transfer': {
      const segs = route.transfers
        .map((s) => [s.fromLine, s.toLine, s.transferName, s.stopsToTransfer].join(SIG_SEP))
        .join(SIG_SEP);
      return ['m', segs, route.stopsAfterLastTransfer].join(SIG_SEP);
    }
    /* istanbul ignore next -- exhaustiveness guard: Route 유니온에 새 variant 추가 시
       컴파일 타임 에러로 잡힘. 런타임 도달 불가. */
    default: {
      const _exhaustive: never = route;
      return _exhaustive;
    }
  }
}

/**
 * 실시간 다음 열차 분 + 운행 분 + 환승 leg별 다음 열차 대기 분.
 *
 * #851: 기존 구현은 환승 leg의 다음 열차 대기를 누락해 환승 경로 ETA가 직통 시간 수준으로 과소
 * 표기되는 회귀 (용마산→건대입구 환승→성수 ≈ 5분으로 표시). `calculateStaticETA`와 동일하게
 * leg당 `DEFAULT_WAIT_MINUTES` fallback을 합산해 정합성을 맞춘다.
 *
 * 첫 열차 대기는 호출자가 실시간으로 측정해 `nextTrainMinutes`로 주입한다.
 * 환승 leg 대기는 환승역별 폴링 인프라가 없으므로 fallback만 사용 — 후속에서 동적화 시
 * `calculateStaticETA`의 `arrivalsAtTransfers`와 동일한 옵션 시그니처로 확장.
 *
 * #2290 — `options.excludeOriginWait: true`(in-trip: boardingLock 활성 / legAdvance stamp /
 * trip 진행 evidence)면 `nextTrainMinutes`(출발 leg boarding 대기)를 0으로 제외하고 주행 +
 * 잔여 환승 leg 대기만 반환한다. 이미 탑승 중이므로 "다음 열차를 기다렸다 탄다"는 가정이 틀렸던
 * 회귀(evidence: 성수→뚝섬 1정거장 남음인데 9분 표시) 수정. 탑승 전(기본값)에는 기존 동작 유지.
 */
export function calculateETA(
  nextTrainMinutes: number,
  route: Route,
  options: { excludeOriginWait?: boolean } = {},
): number {
  const originWait = options.excludeOriginWait ? 0 : nextTrainMinutes;
  if (!route) return originWait;
  const transferWait = getTransferCount(route) * DEFAULT_WAIT_MINUTES;
  return originWait + getTravelMinutes(route) + transferWait;
}

export function getNextStationOnLine(
  line: LineNumber,
  currentName: string,
  targetName: string,
): string | null {
  const nameIndex = getLineNameIndexCached(line);
  const currentIdx = lookupNameIdx(nameIndex, currentName);
  const targetIdx = lookupNameIdx(nameIndex, targetName);
  if (currentIdx === undefined || targetIdx === undefined) return null;
  if (currentIdx === targetIdx) return null;

  // #1698 — 2호선 본선 closed loop은 shortestLinePathIndices의 path[1]이 다음 역.
  // 외선/내선 짧은 쪽 방향과 일치.
  const lineStations = getLineStationsCached(line);
  const path = shortestLinePathIndices(lineStations, currentIdx, targetIdx, line);
  /* istanbul ignore next -- currentIdx !== targetIdx invariant → path.length >= 2 */
  if (path.length < 2) return null;
  return lineStations[path[1]].name;
}

export function getNextStationName(
  currentId: string,
  destinationId: string,
  route: Route,
): string | null {
  if (!route) return null;
  const current = stationById.get(currentId);
  const destination = stationById.get(destinationId);
  if (!current || !destination) return null;

  if (route.type === 'direct') {
    return getNextStationOnLine(current.line, current.name, destination.name);
  }

  if (route.type === 'transfer') {
    if (route.stopsToTransfer > 0) {
      return getNextStationOnLine(route.fromLine, current.name, route.transferName);
    }
    // 환승 완료 후: toLine에서 목적지 방향 (환승역은 양 노선에 동일 이름으로 존재)
    return getNextStationOnLine(route.toLine, current.name, destination.name);
  }

  // multi-transfer
  // multi-transfer: 첫 번째 미완료 구간의 다음 역 반환
  const { transfers } = route;
  for (let i = 0; i < transfers.length; i++) {
    const segment = transfers[i];
    if (segment.stopsToTransfer > 0) {
      const line = i === 0 ? segment.fromLine : transfers[i - 1].toLine;
      return getNextStationOnLine(line, current.name, segment.transferName);
    }
  }
  const lastTransfer = transfers[transfers.length - 1];
  return getNextStationOnLine(lastTransfer.toLine, current.name, destination.name);
}
