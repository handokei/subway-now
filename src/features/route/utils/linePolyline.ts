import { getStationsOnLine } from '../../../shared/utils/stationRoute';
import type { LineNumber, Station } from '../../../shared/types/station';

/**
 * Phase 2 — Map matching.
 *
 * GPS 좌표를 노선 polyline(인접 정거장 간 직선 segment 시퀀스)에 사영하여
 *   - 어느 노선의 어느 segment 위인지
 *   - 그 segment의 진행 비율(0~1)
 *   - 사영점과 GPS 사이 수직 거리
 * 를 산출한다. 환승역 disambiguate / silent push station 정확도 / 한 정거장 전 알람
 * 시점 정확도 회귀(#662, #796, #798) 해소용 utility.
 *
 * 본 PR은 utility만 export. fusion(`fusedSpeed.mapMatchedKmh`)와의 통합은 #819에서.
 */

// 위도 1° ≒ 111.32km (적도 기준). 서울 위도(~37.5°)에서도 위도 방향 거리는 변하지 않음.
// 경도 1°는 위도에 따라 cos(lat)배. 서울 시내 수십 km 범위에서 등각도 평면 근사는
// 오차 1m 이하라 polyline snap에 충분히 정확하다. (routeProgress.ts와 동일 근사)
const METERS_PER_DEG_LAT = 111_320;

function metersPerDegLng(lat: number): number {
  return 111_320 * Math.cos((lat * Math.PI) / 180);
}

/**
 * snap을 matched 로 간주할 perpendicular 거리 상한(미터).
 * 50m는 도시 도로 폭 + GPS accuracy 일반 수준을 감안한 값.
 * 도로/실내(노선에서 멀리 떨어진 좌표)는 unmatched 로 거부한다.
 */
export const MAX_SNAP_DISTANCE_M = 50;

/** 노선별 polyline (정거장 ordered + 누적 segment 길이 테이블). 캐시된다. */
export interface LinePolyline {
  line: LineNumber;
  /** 노선 데이터 정렬 순(stationRoute.getStationsOnLine). 단조 노선은 종점→종점. */
  stations: Station[];
  /** segment[i] = stations[i] → stations[i+1] 길이(m). length === stations.length - 1. */
  segmentLengthsM: number[];
  /** stations[i] 까지의 polyline 시작점 기준 누적 거리(m). length === stations.length. */
  cumulativeArcM: number[];
  /** polyline 전체 길이(m). cumulativeArcM[last] === totalLengthM. */
  totalLengthM: number;
}

/** snap 결과 — matched 인 경우 segment 정보 + arc 위치. unmatched 인 경우 reason. */
export type SnapResult =
  | {
      matched: true;
      line: LineNumber;
      /** 사영이 일어난 segment의 시작 station id (stations.json의 id). */
      segmentStartId: string;
      /** 사영이 일어난 segment의 끝 station id. */
      segmentEndId: string;
      /** segment 시작점=0 ~ 끝점=1 사이 진행 비율. */
      progress: number;
      /** 사영점과 입력 좌표 사이 수직 거리(m). */
      snapDistanceM: number;
      /** polyline 시작점 기준 사영점의 누적 arc 거리(m). mapMatchedKmh 계산용. */
      arcM: number;
    }
  | { matched: false };

/** mapMatchedKmh 계산을 위한 두 snapped 좌표 표현. */
export interface SnappedPosition {
  line: LineNumber;
  arcM: number;
}

// 노선별 polyline lazy-cache. 533역을 매 snap 호출마다 재빌드하지 않는다.
const polylineCache = new Map<LineNumber, LinePolyline>();

/**
 * 두 좌표 사이 평면 근사 미터 거리. haversine 보다 빠르고
 * 서울 시내 segment 길이(수 km) 범위에서 오차 1m 이하.
 */
function planarDistanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const mPerLng = metersPerDegLng((lat1 + lat2) / 2);
  const dx = (lng2 - lng1) * mPerLng;
  const dy = (lat2 - lat1) * METERS_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

/**
 * 특정 노선의 polyline 빌드 또는 캐시 반환.
 *
 * LineNumber 타입과 stations.json 데이터 정합성상 모든 노선은 ≥ 13 정거장으로 보장된다.
 * (1호선 63, sinbundang 16 등) 별도 short-circuit 가드 없이 빌드한다.
 */
export function getLinePolyline(line: LineNumber): LinePolyline {
  const cached = polylineCache.get(line);
  if (cached) return cached;

  const stations = getStationsOnLine(line);

  const segmentLengthsM: number[] = [];
  const cumulativeArcM: number[] = [0];
  let total = 0;
  for (let i = 0; i < stations.length - 1; i++) {
    const a = stations[i];
    const b = stations[i + 1];
    const segM = planarDistanceM(a.lat, a.lng, b.lat, b.lng);
    segmentLengthsM.push(segM);
    total += segM;
    cumulativeArcM.push(total);
  }

  const polyline: LinePolyline = {
    line,
    stations,
    segmentLengthsM,
    cumulativeArcM,
    totalLengthM: total,
  };
  polylineCache.set(line, polyline);
  return polyline;
}

/**
 * GPS 좌표를 특정 노선 polyline 에 사영한다.
 *
 * - 모든 segment에 대해 점-선분 사영을 수행하고 최소 perpendicular 거리를 채택.
 * - perpendicular 거리 ≤ MAX_SNAP_DISTANCE_M 이면 matched, 아니면 unmatched.
 * - 환승역 disambiguate: 호출자가 후보 노선 각각에 본 함수를 적용하면
 *   가장 작은 snapDistanceM을 가진 노선이 실제 탑승 노선이다.
 */
export function snapToLinePolyline(
  coord: { lat: number; lng: number },
  line: LineNumber,
): SnapResult {
  const polyline = getLinePolyline(line);
  const { stations, segmentLengthsM, cumulativeArcM } = polyline;

  let bestPerpM = Infinity;
  let bestSegIdx = 0;
  let bestT = 0;

  // stations.json 정합성으로 인접 정거장은 모두 서로 다른 좌표(segLenSq > 0)이므로
  // 별도 0-length segment 가드는 두지 않는다 (방어적 코드 금지).
  for (let i = 0; i < stations.length - 1; i++) {
    const a = stations[i];
    const b = stations[i + 1];
    const mPerLng = metersPerDegLng(a.lat);
    const bx = (b.lng - a.lng) * mPerLng;
    const by = (b.lat - a.lat) * METERS_PER_DEG_LAT;
    const px = (coord.lng - a.lng) * mPerLng;
    const py = (coord.lat - a.lat) * METERS_PER_DEG_LAT;
    const segLenSq = bx * bx + by * by;
    let t = (px * bx + py * by) / segLenSq;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const closestX = t * bx;
    const closestY = t * by;
    const perp = Math.hypot(px - closestX, py - closestY);
    if (perp < bestPerpM) {
      bestPerpM = perp;
      bestSegIdx = i;
      bestT = t;
    }
  }

  if (bestPerpM > MAX_SNAP_DISTANCE_M) return { matched: false };

  const segStart = stations[bestSegIdx];
  const segEnd = stations[bestSegIdx + 1];
  const arcM = cumulativeArcM[bestSegIdx] + bestT * segmentLengthsM[bestSegIdx];

  return {
    matched: true,
    line,
    segmentStartId: segStart.id,
    segmentEndId: segEnd.id,
    progress: bestT,
    snapDistanceM: bestPerpM,
    arcM,
  };
}

/**
 * 두 snapped 좌표 사이 진행거리 / 시간 = 평균 속도(km/h).
 *
 * - segment 경계를 거쳐도 cumulativeArcM 차로 자연스럽게 누적된다.
 * - 다른 노선 / Δt ≤ 0 / 거리 0 등 의미 없는 경우 null.
 * - 음의 진행(역방향)은 |Δarc|로 처리. 호출자가 방향을 알 필요 없다.
 */
export function mapMatchedSpeedKmh(
  start: SnappedPosition,
  end: SnappedPosition,
  deltaSeconds: number,
): number | null {
  if (start.line !== end.line) return null;
  if (deltaSeconds <= 0) return null;
  const deltaM = Math.abs(end.arcM - start.arcM);
  if (deltaM === 0) return null;
  const mps = deltaM / deltaSeconds;
  return mps * 3.6;
}

/**
 * 테스트에서 cross-suite cache 영향을 제거하기 위한 escape hatch.
 * 프로덕션 코드는 호출하지 않는다.
 */
export function __resetLinePolylineCacheForTests(): void {
  polylineCache.clear();
}
