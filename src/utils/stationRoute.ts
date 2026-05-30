import stations from '../data/stations.json';
import stationTravelTimesJson from '../data/stationTravelTimes.json';
import transferTimes from '../data/transferTimes.json';
import type { Station } from '../types/station';
import { LINE_COLORS } from '../constants/lineColors';
import type { LineNumber } from '../types/station';
import { applyStationAlias } from '../data/stationAliases';
import { createLogger } from './logger';
import { normalizeStationName as baseNormalizeStationName } from './normalizeStationName';

const logger = createLogger('StationRoute');

const allStations = stations as Station[];
const stationTravelTimes = stationTravelTimesJson as Record<string, number>;

// 실측 운행시간이 누락된 hop의 fallback (예: 9호선/공항철도 등 #655 미커버 노선).
const STOP_FALLBACK_SECONDS = 120;

/**
 * line의 fromId → toId 단일 hop 운행 시간(초). #655.
 * 실제 데이터는 서울 열린데이터 StationDstncReqreTimeHm을 양방향으로 저장하므로
 * 양 방향이 동일한 값을 돌려준다. lookup 실패 시 STOP_FALLBACK_SECONDS(=120, 2분).
 * miss는 logger.debug로 노출해 향후 데이터 보강(9호선/공항철도/경의중앙선 등) 추적에 사용.
 */
export function getStopSeconds(line: LineNumber, fromId: string, toId: string): number {
  const key = `${line}|${fromId}|${toId}`;
  const hit = stationTravelTimes[key];
  if (hit !== undefined) return hit;
  logger.debug(`getStopSeconds miss: ${key} → fallback ${STOP_FALLBACK_SECONDS}s`);
  return STOP_FALLBACK_SECONDS;
}

// line 위 fromIdx → toIdx 구간을 한 hop씩 누적한 운행 시간(초). 환승 대기 미포함.
function computeSegmentSeconds(
  line: LineNumber,
  fromIdx: number,
  toIdx: number,
  lineStations: Station[],
): number {
  if (fromIdx === toIdx) return 0;
  const step = fromIdx < toIdx ? 1 : -1;
  let total = 0;
  for (let i = fromIdx; i !== toIdx; i += step) {
    total += getStopSeconds(line, lineStations[i].id, lineStations[i + step].id);
  }
  return total;
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
  /**
   * #655: 실측 운행 시간(초). findRoutes/updateRouteFromPosition가 lookup으로 채운다.
   * 외부에서 stops만 채워 만든 route(테스트 fixture)도 허용 — getTravelMinutes에서
   * stops × STOP_FALLBACK_SECONDS로 fallback. 후속 정리는 follow-up 이슈에서 required로 승격.
   */
  travelSeconds?: number;
}

export interface TransferRoute {
  type: 'transfer';
  transferName: string;
  fromLine: LineNumber;
  toLine: LineNumber;
  stopsToTransfer: number;
  stopsFromTransfer: number;
  /** #655: 실측 운행 시간(초). 의미는 {@link DirectRoute.travelSeconds} 참고. */
  secondsToTransfer?: number;
  /** #655: 실측 운행 시간(초). 의미는 {@link DirectRoute.travelSeconds} 참고. */
  secondsFromTransfer?: number;
}

export interface TransferSegment {
  transferName: string;
  fromLine: LineNumber;
  toLine: LineNumber;
  stopsToTransfer: number;
  /** #655: 실측 운행 시간(초). 의미는 {@link DirectRoute.travelSeconds} 참고. */
  secondsToTransfer?: number;
}

export interface MultiTransferRoute {
  type: 'multi-transfer';
  transfers: TransferSegment[];
  stopsAfterLastTransfer: number;
  /** #655: 실측 운행 시간(초). 의미는 {@link DirectRoute.travelSeconds} 참고. */
  secondsAfterLastTransfer?: number;
}

export type Route = DirectRoute | TransferRoute | MultiTransferRoute | null;

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
// Alias는 transferGraph 매칭 전용 — CSV 원본을 다루는 build-transfer-times.js는 적용 대상 아님.
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

  return Math.abs(destIdx - currentIdx);
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

  const step = fromIdx < toIdx ? 1 : -1;
  const names: string[] = [];
  for (let i = fromIdx + step; i !== toIdx; i += step) {
    names.push(lineStations[i].name);
  }
  return names;
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
    const direct: DirectRoute = {
      type: 'direct',
      stops: Math.abs(dIdx - cIdx),
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

    const stopsToTransfer = Math.abs(i - currentIdx);
    const stopsFromTransfer = Math.abs(transferDestIdx - destIdx);
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

      const stopsToFirst = Math.abs(t1CurrentIdx - currentIdx);

      // 두 번째 환승: 중간노선 → 목적지노선
      for (const t2Name of transfer2Names) {
        const t2MidIdx = lookupNameIdx(midNameIndex, t2Name);
        const t2DestIdx = lookupNameIdx(destNameIndex, t2Name);
        /* istanbul ignore next */
        if (t2MidIdx === undefined || t2DestIdx === undefined) continue;

        const stopsToSecond = Math.abs(t2MidIdx - t1MidIdx);
        const stopsAfter = Math.abs(destIdx - t2DestIdx);
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

// 환승역별 실제 소요시간 데이터(공공데이터포털 15044419, 보행속도 1.2 m/s 기준)에
// 미등록된 환승역에 적용하는 fallback. 기존 균일 가정값 3분(=180초)을 유지.
const FALLBACK_TRANSFER_SECONDS = 180;

const transferTimeTable = transferTimes as Record<string, number>;

// (fromLine, toLine, 환승역명) 조합에 대응하는 실제 환승 소요시간(초).
// 미등록 시 FALLBACK_TRANSFER_SECONDS.
function getTransferSeconds(
  fromLine: LineNumber,
  toLine: LineNumber,
  stationName: string,
): number {
  const key = `${fromLine}|${toLine}|${normalizeStationName(stationName)}`;
  return transferTimeTable[key] ?? FALLBACK_TRANSFER_SECONDS;
}

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

const DEFAULT_WAIT_MINUTES = 3;

// secondsXxx가 채워져 있으면 그대로, 없으면 stops × fallback(=120초). #655.
// optional은 follow-up 이슈에서 required로 승격 예정.
function segSeconds(seconds: number | undefined, stops: number): number {
  return seconds ?? stops * STOP_FALLBACK_SECONDS;
}

// 반환값은 항상 정수 분. 호출처(메인 ETA 카운터/알림 body/Live Activity etaMinutes Swift Int? 디코딩)가
// 정수 분 contract에 의존하므로, 구간별 실측 운행시간(초)과 환승역별 실측 환승시간(초)을 합산해
// 분으로 환산한 결과를 마지막에 반올림한다. 구간 시간은 segSeconds, 환승 시간은 getTransferSeconds.
function getTravelMinutes(route: NonNullable<Route>): number {
  if (route.type === 'direct') {
    return Math.round(segSeconds(route.travelSeconds, route.stops) / 60);
  }

  if (route.type === 'transfer') {
    const totalSeconds =
      segSeconds(route.secondsToTransfer, route.stopsToTransfer) +
      segSeconds(route.secondsFromTransfer, route.stopsFromTransfer) +
      getTransferSeconds(route.fromLine, route.toLine, route.transferName);
    return Math.round(totalSeconds / 60);
  }

  const segmentSecondsSum = route.transfers.reduce(
    (sum, t) => sum + segSeconds(t.secondsToTransfer, t.stopsToTransfer),
    0,
  );
  const transferSecSum = route.transfers.reduce(
    (sum, t) => sum + getTransferSeconds(t.fromLine, t.toLine, t.transferName),
    0,
  );
  const totalSeconds =
    segmentSecondsSum +
    segSeconds(route.secondsAfterLastTransfer, route.stopsAfterLastTransfer) +
    transferSecSum;
  return Math.round(totalSeconds / 60);
}

export function calculateStaticETA(route: Route): number | null {
  if (!route) return null;
  return DEFAULT_WAIT_MINUTES + getTravelMinutes(route);
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
      afterTransferSeconds: [segSeconds(route.secondsFromTransfer, route.stopsFromTransfer)],
    };
  }
  const after = route.transfers
    .slice(1)
    .map((t) => segSeconds(t.secondsToTransfer, t.stopsToTransfer));
  after.push(segSeconds(route.secondsAfterLastTransfer, route.stopsAfterLastTransfer));
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

export function calculateETA(nextTrainMinutes: number, route: Route): number {
  if (!route) return nextTrainMinutes;
  return nextTrainMinutes + getTravelMinutes(route);
}

function getNextStationOnLine(
  line: LineNumber,
  currentName: string,
  targetName: string,
): string | null {
  const nameIndex = getLineNameIndexCached(line);
  const currentIdx = lookupNameIdx(nameIndex, currentName);
  const targetIdx = lookupNameIdx(nameIndex, targetName);
  if (currentIdx === undefined || targetIdx === undefined) return null;
  if (currentIdx === targetIdx) return null;

  const lineStations = getLineStationsCached(line);
  const step = targetIdx > currentIdx ? 1 : -1;
  const nextIdx = currentIdx + step;
  /* istanbul ignore next -- 노선 데이터에서 boundary를 벗어나는 케이스는 발생 불가 */
  if (nextIdx < 0 || nextIdx >= lineStations.length) return null;
  return lineStations[nextIdx].name;
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
