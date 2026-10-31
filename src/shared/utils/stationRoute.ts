import stations from '../../data/stations.json';
import stationTravelTimesJson from '../../data/stationTravelTimes.json';
import stationDistancesJson from '../../data/stationDistances.json';
import type { Station } from '../types/station';
import { LINE_COLORS } from '../constants/lineColors';
import { WALKING_SPEED_M_PER_S, ARRIVAL_FRESHNESS_MS, DWELL_SECONDS } from '../constants/eta';
import type { LineNumber } from '../types/station';
import { applyStationAlias } from '../../data/stationAliases';
import { createLogger } from './logger';
import { normalizeStationName as baseNormalizeStationName } from './normalizeStationName';
import { distanceMetersBetween, estimateEtaSeconds } from './stationEta';
import { getTransferSeconds } from './transferTimes';
import { getStopSecondsFromDistance } from './lineSpeeds';
import { shortestLinePathIndices, isClosedLoopMainStation } from './lineLoopPath';
import { isReversedOrientationLine } from './lineOrientation';
import { computeJourneyEta } from './journeyTimeline';
import type { BoardableLookup, JourneyEta } from './journeyTimeline';

const logger = createLogger('StationRoute');

const allStations = stations as Station[];
const stationTravelTimes = stationTravelTimesJson as Record<string, number>;
const stationDistances = stationDistancesJson as Record<string, number>;

// 실측 운행시간이 누락된 hop의 fallback (예: 9호선/공항철도 등 #655 미커버 노선).
const STOP_FALLBACK_SECONDS = 120;

/**
 * line의 fromId → toId 단일 hop 운행 시간(초). #655.
 * 우선순위:
 *   1) `stationTravelTimes.json` 실측(서울 열린데이터, 1~8호선) + `DWELL_SECONDS`(#2951, 출발역 정차 30초)
 *   2) #1472 — `stationDistances.json` 거리 × 노선 평균 속도 (KRRIC + 운영사 표정속도, 이미 정차 포함 평균 — 가산 X)
 *   3) `STOP_FALLBACK_SECONDS`(=120, 2분) 최종 fallback (이미 도착간격에 근접 — 가산 X)
 *
 * #2951 — tier 1(`stationTravelTimes.json`)은 "순수 주행시간(다음역 도착 − 현재역 출발)"이고
 * 정차 시간이 빠져 있다(시각표 대조: 도착간격 기준 중앙값 -30초). `hop(A→B) = 주행(A→B) + 정차(A)`
 * 의미로 `DWELL_SECONDS`를 tier 1에만 가산한다. tier 2/3는 이미 정차 포함 값이라 가산하면 이중 가산.
 * miss는 logger.debug로 노출해 향후 데이터 보강(9호선/공항철도 등) 추적에 사용.
 */
export function getStopSeconds(line: LineNumber, fromId: string, toId: string): number {
  const key = `${line}|${fromId}|${toId}`;
  const hit = stationTravelTimes[key];
  if (hit !== undefined) return hit + DWELL_SECONDS;
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
  /** #3177: 실제 하차 승강장 역 id(stations.json). 하차문 조회는 이름이 아닌 id로 한다. */
  destinationStationId?: string;
}

/**
 * #1480 N7 — 앵커링으로 이미 지난 환승 표시. toLine/마지막 환승 이후 구간에 앵커된 route에만 stamp된다
 * (환승 전·원본 route는 필드 없음 = 0). ETA 합산(`calculateStaticETA`/`calculateETA`)만 소비하며,
 * `getRouteRemainingSeconds`(알람 clamp, ADR-042)는 이 필드를 보지 않는다.
 */
export interface CompletedTransferState {
  /** 도보까지 끝난 환승 수(transfers 배열 앞에서부터). */
  completedTransfers?: number;
  /** true면 마지막으로 완료된 환승의 도보는 끝났으나 toLine 열차 대기는 남음(환승역 toLine 위). */
  transferWaitPending?: boolean;
}

export interface TransferRoute extends CompletedTransferState {
  type: 'transfer';
  transferName: string;
  /** #3177: 환승역에서 실제로 내리는 fromLine 승강장의 역 id. */
  transferStationId?: string;
  /** #3177: 최종 목적지 승강장 역 id. */
  destinationStationId?: string;
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
  /** #3177: 이 환승에서 실제로 내리는 fromLine 승강장의 역 id. */
  transferStationId?: string;
  fromLine: LineNumber;
  toLine: LineNumber;
  stopsToTransfer: number;
  /** #655: 실측 운행 시간(초). 의미는 {@link DirectRoute.travelSeconds} 참고. */
  secondsToTransfer: number;
}

export interface MultiTransferRoute extends CompletedTransferState {
  type: 'multi-transfer';
  transfers: TransferSegment[];
  stopsAfterLastTransfer: number;
  /** #655: 실측 운행 시간(초). 의미는 {@link DirectRoute.travelSeconds} 참고. */
  secondsAfterLastTransfer: number;
  /** #3177: 최종 목적지 승강장 역 id. */
  destinationStationId?: string;
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

// #1480 N7 — 현재역이 해당 환승의 toLine 승강장(= 환승역 자체)인가. 판정은 앵커링 결과(station 노선·id)만
// 신뢰하며 GPS 승강장 구별은 하지 않는다.
function isTransferStationOnToLine(
  segment: { transferName: string; toLine: LineNumber },
  station: Station,
): boolean {
  return findStationByNameAndLine(segment.transferName, segment.toLine)?.id === station.id;
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
      destinationStationId: dest.id,
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
        completedTransfers: 1,
        transferWaitPending: isTransferStationOnToLine(storedRoute, nearestStation),
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
      return {
        ...storedRoute,
        transfers: updatedTransfers,
        completedTransfers: i,
        transferWaitPending: i > 0 && isTransferStationOnToLine(transfers[i - 1], nearestStation),
      };
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
      completedTransfers: transfers.length,
      transferWaitPending: isTransferStationOnToLine(lastTransfer, nearestStation),
    };
  }

  return null;
}

/**
 * #2811 — route를 currentStation 기준 "지금부터 남은" 경로로 재앵커링한다.
 *
 * root: `calculateStaticETA(route)`/`calculateETA(n, route)`는 route 자체를 그대로 합산하는데,
 * 일부 소비처(LA mirror sync, HomeScreen in-app 표시)는 트립 시작 시점에 고정된 route(#1883
 * RC-11 route freeze)를 그대로 쥐고 있어 트립이 진행돼도 ETA가 줄지 않는다. `updateRouteFromPosition`은
 * 이미 leg-aware(현재역이 어느 leg의 fromLine/toLine에 속하는지 판별해 지나온 구간을 0으로,
 * 남은 구간만 실측 재계산하는) remaining 계산을 제공하므로 이를 그대로 감싼다 — 새 ETA 산식을
 * 만들지 않는다(재발명 금지).
 *
 * currentStation이 route 위 어느 leg에도 속하지 않으면(GPS/fusion 오차로 노선 불일치 등)
 * `updateRouteFromPosition`은 null을 반환하는데, 이 경우 원본 route를 그대로 fallback한다 —
 * 호출자는 항상 "뭔가"를 받아 회귀 없이 기존(전체) ETA로 동작한다.
 */
export function anchorRouteToCurrentStation(
  route: Route,
  currentStation: Station,
  destinationId: string,
): Route {
  if (!route) return route;
  return updateRouteFromPosition(route, currentStation, destinationId) ?? route;
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

/**
 * #1922 (M1+M3) — station-passed hop window 동적 확장.
 *
 * 환승 leg에서 estimator가 시간 적분 strategy로 stuck됐을 때 (live-position이 아닌 strategy +
 * effectiveHopIndex와 candidateIndex 사이에 transfer point가 끼어 있음), 기본 windowSize(1)로는
 * 정상 진행 candidate(실측)도 reject된다. 본 helper가 동적으로 windowSize를 확장해 dump line
 * 169~244의 61회 suppress 회귀를 차단한다.
 *
 * 게이트:
 *   1. route.type이 'transfer' 또는 'multi-transfer' — direct route는 환승 없음, 동적 확장 의미 X.
 *   2. currentHopStrategy !== 'live-position' — live-position에서 격차 큰 경우는 GPS jitter / wrong
 *      train 같은 abnormal jump 신호. 확장하면 false positive 알람 발생. (M3 신뢰도 게이트)
 *   3. effectiveHopIndex와 candidateIndex 사이 arc에 transfer point가 끼어 있음 — 인접 station이
 *      같은 name + 다른 line이면 transfer point (computeRouteArc는 양쪽 노선 entry 모두 보존).
 *
 * 모두 충족 시 windowSize = max(LOCKLESS_HOP_WINDOW_DEFAULT, |candidateIndex - effectiveHopIndex|)로
 * 확장. 한 가지라도 미충족이면 기본 windowSize 유지.
 *
 * arc에 candidate가 없으면 (-1), 호출자가 어차피 isStationWithinHopWindow에서 false 반환하므로
 * 본 helper는 -1을 받아도 안전(기본 windowSize 반환).
 *
 * #2373 — useStationAlarm.ts(FG)에서 shared로 추출. BG 채널(stationPipeline.ts)도 재사용해
 * transfer-early 조기 오발사(hop-window 게이트 부재)를 차단한다. `currentHopStrategy`는
 * 원래 route feature의 `StationProgressStrategy` 타입이었으나, shared는 features를 import할 수
 * 없어(디렉토리 경계 룰) `'live-position' | string`으로 좁혔다 — 비교 로직(`=== 'live-position'`)은
 * 동일하므로 FG/BG 호출부 모두 회귀 없음.
 */
export function computeHopWindowSize(
  arcStations: readonly Station[],
  route: Route,
  effectiveHopIndex: number,
  candidateIndex: number,
  currentHopStrategy: string | null,
): number {
  // M1 게이트 1: transfer/multi-transfer route만 동적 확장 대상.
  if (!route || route.type === 'direct') return LOCKLESS_HOP_WINDOW_DEFAULT;
  // M3 신뢰도 게이트: live-position 실측 strategy에서는 확장 X (abnormal jump 신호).
  if (currentHopStrategy === 'live-position') return LOCKLESS_HOP_WINDOW_DEFAULT;
  // 인덱스 가드: candidate가 arc 밖이면 default — isStationWithinHopWindow가 어차피 false.
  if (candidateIndex < 0 || effectiveHopIndex < 0) return LOCKLESS_HOP_WINDOW_DEFAULT;
  /* istanbul ignore next -- 호출 시점 invariant: arcIndexOf 결과 candidate는 arc 내부.
     effectiveHopIndex도 currentHopIndex(estimator 또는 firedAlarms inferred, 둘 다 clamp) 후
     사용되므로 out-of-bounds 도달 불가. 방어적 가드 — 직접 호출자 추가 시 안전. */
  if (candidateIndex >= arcStations.length || effectiveHopIndex >= arcStations.length) {
    return LOCKLESS_HOP_WINDOW_DEFAULT;
  }

  // M1 게이트 3: effectiveHopIndex와 candidateIndex 사이 transfer crossover 감지.
  // computeRouteArc는 환승 시 fromLine 쪽 + toLine 쪽 entry 둘 다 push하므로
  // 인접 station이 같은 name + 다른 line이면 transfer crossover 표지다.
  const lo = Math.min(effectiveHopIndex, candidateIndex);
  const hi = Math.max(effectiveHopIndex, candidateIndex);
  let crossesTransfer = false;
  for (let i = lo; i < hi; i++) {
    const a = arcStations[i];
    const b = arcStations[i + 1];
    if (isSameStationName(a.name, b.name) && a.line !== b.line) {
      crossesTransfer = true;
      break;
    }
  }
  if (!crossesTransfer) return LOCKLESS_HOP_WINDOW_DEFAULT;

  // 모든 게이트 통과 → windowSize를 격차만큼 확장.
  const gap = hi - lo;
  return Math.max(LOCKLESS_HOP_WINDOW_DEFAULT, gap);
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

// 같은 노선 위 두 역 사이의 중간역을 진행 방향대로 반환(#3177 — 이름이 아니라 Station이라 호출부가 id를 쓴다).
// 양 끝점은 제외. 인접 역 또는 같은 역이면 빈 배열. 다른 노선/미존재 id면 null.
export function getIntermediateStations(
  fromId: string,
  toId: string,
): Station[] | null {
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
  return path.slice(1, -1).map((i) => lineStations[i]);
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

/** route가 가진 정거장 합(direct=stops, transfer=환승 전+후, multi=transfers 순회 + 마지막 환승 이후). 재앵커링된 route를 넘기면 남은 정거장. */
export function getRouteTotalStops(route: NonNullable<Route>): number {
  if (route.type === 'direct') return route.stops;
  if (route.type === 'transfer') return route.stopsToTransfer + route.stopsFromTransfer;
  const transferStops = route.transfers.reduce((sum, t) => sum + t.stopsToTransfer, 0);
  return transferStops + route.stopsAfterLastTransfer;
}

function toCandidate(route: NonNullable<Route>): RouteCandidate {
  const travelMinutes = getTravelMinutes(route);
  const transferCount = route.type === 'direct' ? 0 : route.type === 'transfer' ? 1 : route.transfers.length;
  return { route, totalStops: getRouteTotalStops(route), transferCount, travelMinutes };
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
      destinationStationId: destination.id,
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
        transferStationId: candidate.id,
        destinationStationId: destination.id,
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
                transferStationId: currentLineStations[t1CurrentIdx].id,
                fromLine,
                toLine: midLine,
                stopsToTransfer: stopsToFirst,
                secondsToTransfer: computeSegmentSeconds(fromLine, currentIdx, t1CurrentIdx, currentLineStations),
              },
              {
                transferName: t2Name,
                transferStationId: midLineStations[t2MidIdx].id,
                fromLine: midLine,
                toLine,
                stopsToTransfer: stopsToSecond,
                secondsToTransfer: computeSegmentSeconds(midLine, t1MidIdx, t2MidIdx, midLineStations),
              },
            ],
            stopsAfterLastTransfer: stopsAfter,
            destinationStationId: destination.id,
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

/**
 * #3258 — 화면에 표시되는 출발역~도착역 경로의 실제 정거장 수.
 * route.stops류는 "현재 위치" 기준으로 재계산되는데(재마운트 시 어린이대공원→건대입구 = 1),
 * journey 출발역 이름은 tripOrigin으로 고정되므로 표시 구간과 어긋난다. 표시되는 두 역 사이를
 * 노선 데이터에서 직접 세어(펼침 중간역과 동일한 shortestLinePathIndices) 일치시킨다.
 * 노선에서 두 역을 못 찾거나 동일역이면 route 값을 그대로 쓴다.
 */
function displayedSegmentStops(line: LineNumber, fromName: string, toName: string, routeStops: number): number {
  const lineStations = getStationsOnLine(line);
  const fromIdx = lineStations.findIndex((s) => isSameStationName(s.name, fromName));
  const toIdx = lineStations.findIndex((s) => isSameStationName(s.name, toName));
  if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return routeStops;
  return shortestLinePathIndices(lineStations, fromIdx, toIdx, line).length - 1;
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
          stops: displayedSegmentStops(route.line, current.name, destination.name, route.stops),
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
          stops: displayedSegmentStops(route.fromLine, current.name, route.transferName, route.stopsToTransfer),
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
      // #3258 — 첫 구간만 tripOrigin(표시 출발역) 기준으로 재계산. 이후 구간은 환승역 고정이라 route 값이 정확.
      stops: i === 0 ? displayedSegmentStops(t.fromLine, prevName, t.transferName, t.stopsToTransfer) : t.stopsToTransfer,
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
 * calculateStaticETA 옵션. 누락된 필드는 graceful fallback(도보=0, 대기=시간표 → 배차간격/2 → 하한).
 * 대기 추정 규칙의 SSoT는 `journeyTimeline.ts`다 (#1480 PR-C — 고정 3분 폐기).
 *
 * 도보 (#776):
 * - currentLocation + originStation 둘 다 있으면 출발 도보 시간 합산
 * - destination + destinationStation 둘 다 있으면 하차 도보 시간 합산
 *
 * 대기 (#777):
 * - arrivalAtOrigin이 있고 freshness(60s) 통과 → arrivalSeconds를 출발 대기로 사용
 * - 없거나 stale → 엔진이 노선 배차간격/2로 추정
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
   * 누락 또는 stale 시 엔진이 배차간격/2로 추정한다.
   */
  arrivalAtOrigin?: { arrivalSeconds: number; receivedAtMs: number };
  /**
   * #778 — 각 환승역의 다음 열차 도착 정보 (transfer 순서, 0 = 첫 환승).
   * - transfer route: [0] 한 개
   * - multi-transfer route: [0..transfers.length-1]
   * - 누락된 element나 stale은 엔진이 시간표(정규화 역명·방향·요일) → 배차간격/2 순으로 추정
   * `transferTimes.json`은 도보만 포함 — 환승 후 다음 열차 대기는 본 필드 또는 엔진 추정으로만 합산
   */
  arrivalsAtTransfers?: ReadonlyArray<{ arrivalSeconds: number; receivedAtMs: number } | null>;
  /**
   * #1480 PR-D — 환승 순서별 환승역 실시간 도착 후보 목록(toLine·진행 방향으로 이미 거른 열차).
   * 엔진이 fresh 후보 중 T_platform(도착+도보+buffer) 이후 첫 열차를 고른다. 없으면 시간표 → 배차간격/2.
   */
  boardableArrivalsAtTransfers?: BoardableArrivalsAtTransfers;
  /** freshness·시간표 조회용 현재 시각(ms). 미지정 시 Date.now() — 테스트는 KST 고정값을 주입한다. */
  nowMs?: number;
  /**
   * #2290 — 탑승 중(in-trip: boardingLock 활성 / legAdvance stamp / trip 진행 evidence)에는
   * 출발 leg의 boarding 대기를 이미 소진한 상태이므로 0으로 제외한다.
   * 잔여 환승 leg의 대기는 유지 — 아직 타지 않은 leg의 대기는 실재한다.
   * 미지정 시 기존 동작(대기+주행 합산) 동치.
   */
  excludeOriginWait?: boolean;
  /**
   * #1503/#1480 — 시간표 조회 결과 관측 콜백. 호출자(features)가 alarmLog `boardable-lookup`에 연결한다
   * (shared는 features를 import할 수 없다). 호출 빈도가 높은 렌더 경로에서는 넘기지 않는다.
   */
  onBoardableLookup?: (lookup: BoardableLookup) => void;
}

// 한 페어(사용자 좌표 + 역 좌표)의 도보 시간(초). 누락 시 0.
// estimateEtaSeconds를 재사용하되, 보행은 항상 WALKING_SPEED_M_PER_S(=1.2) 위쪽이라 null이 될 일이 없다.
function calculateWalkingSeconds(from: LatLng | undefined, to: LatLng | undefined): number {
  if (!from || !to) return 0;
  const distM = distanceMetersBetween(from.lat, from.lng, to.lat, to.lng);
  // WALKING_SPEED_M_PER_S(=1.2) >= MIN_VALID_SPEED_MPS(=0.5) 이므로 항상 number 반환.
  // 타입 narrowing을 위해 ?? 0 — 향후 상수 변경 시 회귀 차단.
  /* istanbul ignore next -- WALKING_SPEED_M_PER_S > MIN_VALID_SPEED_MPS 불변식상 null 경로 도달 불가 */
  return estimateEtaSeconds(distM, WALKING_SPEED_M_PER_S) ?? 0;
}

/** 환승역 실시간 도착 후보 한 건. arrivalSeconds=null(시간 모름)은 후보에서 제외된다. */
export interface BoardableArrival {
  arrivalSeconds: number | null;
  receivedAtMs: number;
}
export type BoardableArrivalsAtTransfers = ReadonlyArray<ReadonlyArray<BoardableArrival> | null>;

// fresh한 실시간 도착이면 arrivalSeconds, 아니면 null (엔진이 시간표/배차간격으로 추정).
// receivedAtMs<=0(mock/누락 컨벤션) / 나이>ARRIVAL_FRESHNESS_MS(stale) / arrivalSeconds<0(비정상)을 거른다.
function freshArrivalSeconds(
  arrival: { arrivalSeconds: number; receivedAtMs: number } | null | undefined,
  nowMs: number,
): number | null {
  if (!arrival) return null;
  if (arrival.receivedAtMs <= 0) return null;
  if (nowMs - arrival.receivedAtMs > ARRIVAL_FRESHNESS_MS) return null;
  if (arrival.arrivalSeconds < 0) return null;
  return arrival.arrivalSeconds;
}

// 환승 순서별 후보 → fresh한 것만 절대 도착 시각(ms)으로. 신선도 규칙은 freshArrivalSeconds 재사용.
function toBoardableEpochs(
  lists: BoardableArrivalsAtTransfers | undefined,
  nowMs: number,
): ReadonlyArray<ReadonlyArray<number> | null> | undefined {
  return lists?.map((list) =>
    list === null
      ? null
      : list.flatMap(({ arrivalSeconds, receivedAtMs }) => {
          if (arrivalSeconds === null) return [];
          const fresh = freshArrivalSeconds({ arrivalSeconds, receivedAtMs }, nowMs);
          return fresh === null ? [] : [receivedAtMs + fresh * 1000];
        }),
  );
}

function reportLookups(eta: JourneyEta, onBoardableLookup: StaticEtaOptions['onBoardableLookup']): void {
  if (onBoardableLookup) eta.lookups.forEach(onBoardableLookup);
}

/**
 * 경로 정적 ETA 상세. `journeyTimeline` 엔진에 위임하며 "N분+"(waitUnknown)/"막차 종료"(lastTrainEnded)
 * 표시 플래그를 함께 돌려준다. route=null이면 null.
 */
export function calculateStaticEtaDetail(route: Route, options: StaticEtaOptions = {}): JourneyEta | null {
  if (!route) return null;
  const nowMs = options.nowMs ?? Date.now();
  const eta = computeJourneyEta({
    route,
    nowMs,
    originWalkSeconds: calculateWalkingSeconds(options.currentLocation, options.originStation),
    destinationWalkSeconds: calculateWalkingSeconds(options.destinationStation, options.destination),
    excludeOriginWait: options.excludeOriginWait,
    originRealtimeWaitSeconds: freshArrivalSeconds(options.arrivalAtOrigin, nowMs),
    transferRealtimeWaitSeconds: options.arrivalsAtTransfers?.map((a) => freshArrivalSeconds(a, nowMs)),
    transferBoardableArrivalsMs: toBoardableEpochs(options.boardableArrivalsAtTransfers, nowMs),
  });
  reportLookups(eta, options.onBoardableLookup);
  return eta;
}

/**
 * 경로 정적 ETA(분). 반환은 분 단위 정수 — 호출처(알림 body/Live Activity etaMinutes Swift Int? 디코딩 등)가
 * 정수를 전제로 한다. 표시 플래그가 필요한 호출자는 {@link calculateStaticEtaDetail}.
 *
 * - route=null이면 null
 * - 페어가 부분적으로 누락되면 해당 도보 시간만 0 (예: currentLocation은 있는데 originStation이 없으면
 *   출발 도보 0 — 사용자 위치 권한 미확보 등 부분 정보 상황에서 graceful fallback)
 */
export function calculateStaticETA(route: Route, options: StaticEtaOptions = {}): number | null {
  return calculateStaticEtaDetail(route, options)?.minutes ?? null;
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
 * 실시간 다음 열차 분 + 운행 분 + 환승 leg별 다음 열차 대기 — 홈 화면 실시간 ETA의 상세.
 *
 * `journeyTimeline` 엔진에 위임한다(#1480 PR-C). 첫 열차 대기는 호출자가 실시간으로 측정해
 * `nextTrainMinutes`로 주입하고, 환승 leg 대기는 엔진이 시간표(정규화 역명·방향·요일, 막차 이후 제외) →
 * 배차간격/2 순으로 추정한다. 환승역별 실시간 폴링 주입은 후속(PR-D).
 *
 * #851: 환승 leg의 다음 열차 대기를 누락해 환승 경로 ETA가 과소 표기되던 회귀(용마산→건대입구
 * 환승→성수 ≈ 5분)를 막기 위해 환승 대기는 항상 합산한다.
 *
 * #2290 — `options.excludeOriginWait: true`(in-trip)면 `nextTrainMinutes`(출발 leg boarding 대기)를 제외하고
 * 주행 + 잔여 환승 leg 대기만 센다(evidence: 성수→뚝섬 1정거장 남음인데 9분 표시). route=null이면 null.
 */
export function calculateEtaDetail(
  nextTrainMinutes: number,
  route: Route,
  options: {
    excludeOriginWait?: boolean;
    nowMs?: number;
    onBoardableLookup?: StaticEtaOptions['onBoardableLookup'];
    boardableArrivalsAtTransfers?: BoardableArrivalsAtTransfers;
  } = {},
): JourneyEta | null {
  if (!route) return null;
  const nowMs = options.nowMs ?? Date.now();
  const eta = computeJourneyEta({
    route,
    nowMs,
    excludeOriginWait: options.excludeOriginWait,
    originRealtimeWaitSeconds: nextTrainMinutes * 60,
    transferBoardableArrivalsMs: toBoardableEpochs(options.boardableArrivalsAtTransfers, nowMs),
  });
  reportLookups(eta, options.onBoardableLookup);
  return eta;
}

/** {@link calculateEtaDetail}의 정수 분. route가 없으면 출발 대기(분)만 돌려준다. */
export function calculateETA(
  nextTrainMinutes: number,
  route: Route,
  options: { excludeOriginWait?: boolean; nowMs?: number } = {},
): number {
  const originWait = options.excludeOriginWait ? 0 : nextTrainMinutes;
  return calculateEtaDetail(nextTrainMinutes, route, options)?.minutes ?? originWait;
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

/**
 * #2696 — 열차 종착역(terminusName)이 사용자의 다음 목표역(targetStationName)에
 * 도달하는지(=지나치기 전에 조기 종착하지 않는지) 판정한다.
 *
 * `direction`은 (line, currId, nextId)별 `resolveTripDirection`이 산출하는 값과 동일 관례
 * ('down' = id 오름차순 방향, 'up' = 내림차순 방향)를 공유한다 — Seoul Open API의 up/down
 * bucket과도 정렬되어 있어(구 코드의 `pool = direction==='up' ? arrival.up : arrival.down`),
 * 별도 변환 없이 그대로 재사용 가능하다.
 *
 * 역명 lookup 실패(정규화 후에도 매칭 안 됨) 또는 종착역===목표역이면 "판정 불가/도달함"으로
 * 간주해 true(배제하지 않음) — 과도 필터링(후보 0건 회귀)보다 미검출 쪽이 안전하다는 기존
 * 코드베이스 관례(graceful degrade)를 따른다.
 *
 * 2호선 본선 closed loop(#1698)은 순환선이라 단순 idx 비교로는 방향을 못 살린다. 두 역이 모두
 * 본선 range 안이면 본선 subset 안에서 direction 부호(+1=down, -1=up)로 "목표역→종착역"과
 * "종착역→목표역" 각각의 forward-hop 수를 구해 비교한다 — 더 짧은 쪽(실제 단거리 단축 운행)이
 * "앞쪽"이다. 목표역은 항상 사용자의 현재역 바로 다음 역이므로, 종착역이 현재역(=목표역 바로
 * 이전 역, forward-hop 0)과 같은 경우가 실무에서 관측된 조기종착의 전형(#2696 evidence:
 * 8387/성수, 종착역이 조회 대상 역 자체).
 */
export function terminusReachesTarget(
  line: LineNumber,
  direction: 'up' | 'down',
  terminusName: string,
  targetStationName: string,
): boolean {
  const nameIndex = getLineNameIndexCached(line);
  const terminusIdx = lookupNameIdx(nameIndex, terminusName);
  const targetIdx = lookupNameIdx(nameIndex, targetStationName);
  if (terminusIdx === undefined || targetIdx === undefined) return true;
  if (terminusIdx === targetIdx) return true;

  const lineStations = getLineStationsCached(line);
  const terminusId = lineStations[terminusIdx].id;
  const targetId = lineStations[targetIdx].id;
  // #3122 — sign은 "진행 방향의 idx 증감". 역방향 노선(신분당·수인분당)은 idx 증가=상행이라 반전.
  const idxIncreasesDown = !isReversedOrientationLine(line);
  const sign = (direction === 'down') === idxIncreasesDown ? 1 : -1;

  if (!isClosedLoopMainStation(line, terminusId) || !isClosedLoopMainStation(line, targetId)) {
    // 직선 구간(또는 지선) — wraparound 없이 idx 비교만으로 충분.
    return sign === 1 ? terminusIdx >= targetIdx : terminusIdx <= targetIdx;
  }

  const mainLineIndices: number[] = [];
  for (let i = 0; i < lineStations.length; i++) {
    if (isClosedLoopMainStation(line, lineStations[i].id)) mainLineIndices.push(i);
  }
  const subLen = mainLineIndices.length;
  const terminusSub = mainLineIndices.indexOf(terminusIdx);
  const targetSub = mainLineIndices.indexOf(targetIdx);
  const forwardHops = (fromSub: number, toSub: number): number =>
    (((toSub - fromSub) * sign) % subLen + subLen) % subLen;
  // 목표역에서 순방향으로 몇 hop 만에 종착역에 닿는지 vs 그 반대 — 더 짧은 쪽이 실제 방향.
  // 종착역이 목표역보다 "뒤"(반대편)라면 순방향 hop 수가 훨씬 크다(거의 한 바퀴).
  return forwardHops(targetSub, terminusSub) <= forwardHops(terminusSub, targetSub);
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
