/**
 * Phase 6.1 (#1836) — 지하 cold start 감지 + 후보 station 추출 (Sub-step 1+2).
 *
 * cold start 조건 3개 AND:
 *  1. GPS 정확도 > 50m  — 지하 + 5G/LTE 환경 전형적 범위
 *  2. environment = 'underground' | 'unknown'
 *  3. hasTrip = false  — 진행 중 trip 없음
 *
 * 조건 충족 시 GPS 좌표 ± 0.5km 반경 stations를 추출하여 환승 호선 dedup한 후
 * ColdStartCandidate[] 반환. 미충족 시 null.
 *
 * Sub-step 3 (#1841) — 보조 신호 weight 추가:
 *  각 후보에 0~1 normalized weight를 계산한다 (높을수록 우선 후보).
 *  가중치 source (4가지, 부분 점수 합산 후 normalize):
 *   - 시간표: hasTimetable()로 후보의 노선 중 1개 이상 운행 지원 시 boost
 *   - barometer: environment = 'underground' 시 후보의 lines에 지하역 노선 포함 여부 boost
 *     (단, environment 자체가 underground 조건이므로 현재 환경과 후보 노선 수 기반 정성 신호로 활용)
 *   - 즐겨찾기: favoriteStationNames에 stationName 포함 시 boost
 *   - 최근 목적지: recentDestinationNames에 stationName 포함 시 boost
 *  정렬: weight desc, tiebreaker distanceKm asc
 *
 * Sub-step 4 (선택 UI), Sub-step 5 (mismatch 재확인)은 별 PR.
 */
import { useMemo } from 'react';
import stationsData from '../../../data/stations.json';
import { haversine } from '../../../shared/utils/haversine';
import { hasTimetable } from '../../../shared/utils/timetableShared';
import type { LineNumber, Station } from '../../../shared/types/station';

/** cold start 판단에 쓰이는 GPS 정확도 임계값(m). 50m 초과 시 cold start 상황으로 간주. */
export const COLD_START_ACCURACY_THRESHOLD_M = 50;

/** cold start 후보 탐색 반경(km). */
export const COLD_START_RADIUS_KM = 0.5;

/**
 * 가중치 source별 부분 점수.
 * 합산 후 총 점수 범위: 0 ~ WEIGHT_SCORES_TOTAL.
 * normalize = raw / WEIGHT_SCORES_TOTAL → [0, 1].
 */
const WEIGHT_TIMETABLE = 0.4;
const WEIGHT_BAROMETER = 0.2;
const WEIGHT_FAVORITE = 0.25;
const WEIGHT_RECENT_DESTINATION = 0.15;
const WEIGHT_SCORES_TOTAL =
  WEIGHT_TIMETABLE + WEIGHT_BAROMETER + WEIGHT_FAVORITE + WEIGHT_RECENT_DESTINATION;

const stations = stationsData as Station[];

/**
 * 역 이름 정규화 — 후행 괄호 부제 제거.
 * "왕십리(성동구청)" → "왕십리"
 * groupStationsByName의 normalize와 동일 로직.
 */
function normalizeStationName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed.endsWith(')')) return trimmed;
  const open = trimmed.lastIndexOf('(');
  /* istanbul ignore next — 실제 역명에서 '(' 없이 ')'로 끝나는 케이스 없음 (방어적 guard) */
  if (open === -1) return trimmed;
  return trimmed.slice(0, open).trimEnd();
}

/** 환승 호선 dedup 후 하나의 cold start 후보를 나타내는 그룹. */
export interface ColdStartCandidate {
  /** 정규화된 역 이름 (괄호 부제 제거). 예: "왕십리" */
  readonly stationName: string;
  /** 이 역을 경유하는 노선 목록. 환승역은 복수. */
  readonly lines: readonly LineNumber[];
  /** GPS 좌표 기준 가장 가까운 entry까지의 거리(km). */
  readonly distanceKm: number;
  /** 가장 가까운 entry의 위도. */
  readonly lat: number;
  /** 가장 가까운 entry의 경도. */
  readonly lng: number;
  /** 이 이름에 속하는 모든 Station entry (노선별 환승 정보 포함). Sub-step 4 UI 사용. */
  readonly stations: readonly Station[];
  /**
   * Sub-step 3 (#1841) — 0~1 normalized 가중치.
   * 높을수록 현재 상황에 더 적합한 후보. 0 = 모든 source 미매칭.
   * 계산 source: 시간표 / barometer 일치 / 즐겨찾기 / 최근 목적지.
   */
  readonly weight: number;
}

export interface UseColdStartCandidatesInput {
  /** 현재 GPS 좌표 및 정확도. */
  readonly gps: { readonly lat: number; readonly lng: number; readonly accuracy: number } | null;
  /** 환경 분류. */
  readonly environment: 'surface' | 'underground' | 'hybrid' | 'unknown';
  /** 진행 중 trip 존재 여부. */
  readonly hasTrip: boolean;
  /**
   * Sub-step 3 (#1841) — 사용자 즐겨찾기 역 이름 집합 (정규화 전).
   * useFavoritesStore.favorites[].station.name을 caller가 추출해 전달한다.
   * 미제공 시 빈 집합으로 처리 (가중치 0).
   */
  readonly favoriteStationNames?: readonly string[];
  /**
   * Sub-step 3 (#1841) — 최근 목적지 역 이름 집합 (정규화 전).
   * useDestinationStore.recentDestinations[].name을 caller가 추출해 전달한다.
   * 미제공 시 빈 집합으로 처리 (가중치 0).
   */
  readonly recentDestinationNames?: readonly string[];
}

/**
 * Sub-step 3 (#1841) — 보조 신호 가중치 계산 순수 함수.
 *
 * @param lines 후보 역의 노선 목록
 * @param stationName 후보 역 이름 (정규화 완료)
 * @param environment 현재 환경 분류
 * @param favoriteNames 즐겨찾기 역 이름 집합 (정규화 전)
 * @param recentDestNames 최근 목적지 역 이름 집합 (정규화 전)
 * @returns 0~1 normalized weight
 */
export function computeCandidateWeight(
  lines: readonly LineNumber[],
  stationName: string,
  environment: 'surface' | 'underground' | 'hybrid' | 'unknown',
  favoriteNames: readonly string[],
  recentDestNames: readonly string[],
): number {
  let raw = 0;

  // 1. 시간표 source — lines 중 hasTimetable() 지원 노선 1개 이상이면 boost.
  //    1~9호선이 지원 대상. 분당/신분당/경의중앙 등 외선 0.
  const hasSupportedLine = lines.some((line) => hasTimetable(line));
  if (hasSupportedLine) {
    raw += WEIGHT_TIMETABLE;
  }

  // 2. Barometer source — environment = 'underground' 시 후보의 노선 수 비례 boost.
  //    지하역 신호: 노선이 많을수록 환승 지하역 가능성 높음.
  //    'unknown'은 부분 신호(0.5배). 'surface'/'hybrid'는 cold start 조건 불충족이나
  //    extractColdStartCandidates는 조건 외부에서도 호출 가능하므로 방어적 처리.
  if (environment === 'underground') {
    raw += WEIGHT_BAROMETER;
  } else if (environment === 'unknown') {
    raw += WEIGHT_BAROMETER * 0.5;
  }

  // 3. 즐겨찾기 source — favoriteNames에 stationName 포함 시 boost.
  //    정규화 비교: 즐겨찾기도 괄호 부제 있을 수 있음.
  const normalizedFavorites = favoriteNames.map(normalizeStationName);
  if (normalizedFavorites.includes(stationName)) {
    raw += WEIGHT_FAVORITE;
  }

  // 4. 최근 목적지 source — recentDestNames에 stationName 포함 시 boost.
  const normalizedRecent = recentDestNames.map(normalizeStationName);
  if (normalizedRecent.includes(stationName)) {
    raw += WEIGHT_RECENT_DESTINATION;
  }

  // normalize: 0~1
  return raw / WEIGHT_SCORES_TOTAL;
}

/**
 * 지하 cold start 상태를 감지하고 반경 내 역 후보를 추출한다.
 *
 * 반환값:
 *  - `ColdStartCandidate[]` — cold start 조건 충족 + 1개 이상 후보 존재
 *  - `null` — cold start 조건 미충족 (정확도 양호 / trip 진행 중 / 지상 환경)
 */
export function useColdStartCandidates(
  input: UseColdStartCandidatesInput,
): ColdStartCandidate[] | null {
  const { gps, environment, hasTrip, favoriteStationNames = [], recentDestinationNames = [] } = input;

  return useMemo<ColdStartCandidate[] | null>(() => {
    // cold start 조건 3개 AND 검사
    if (gps === null) return null;
    if (gps.accuracy <= COLD_START_ACCURACY_THRESHOLD_M) return null;
    if (environment === 'surface' || environment === 'hybrid') return null;
    if (hasTrip) return null;

    return extractColdStartCandidates(
      gps.lat,
      gps.lng,
      environment,
      favoriteStationNames,
      recentDestinationNames,
    );
  }, [gps, environment, hasTrip, favoriteStationNames, recentDestinationNames]);
}

/**
 * 순수 함수: GPS 좌표 기준 0.5km 반경 내 역을 추출하고 환승 호선 dedup.
 * Sub-step 3: weight 계산 후 weight desc / distanceKm asc 정렬.
 *
 * 단독 export — Sub-step 4 picker UI + 테스트가 직접 사용.
 */
export function extractColdStartCandidates(
  lat: number,
  lng: number,
  environment: 'surface' | 'underground' | 'hybrid' | 'unknown' = 'unknown',
  favoriteStationNames: readonly string[] = [],
  recentDestinationNames: readonly string[] = [],
): ColdStartCandidate[] {
  // 반경 내 모든 entry를 거리순 정렬
  const inRadius = stations
    .map((s) => ({ station: s, distanceKm: haversine(lat, lng, s.lat, s.lng) }))
    .filter((r) => r.distanceKm <= COLD_START_RADIUS_KM)
    .sort((a, b) => a.distanceKm - b.distanceKm);

  if (inRadius.length === 0) return [];

  // 정규화된 역 이름 기준으로 그룹화 (환승 호선 dedup)
  const buckets = new Map<string, { entries: Array<{ station: Station; distanceKm: number }> }>();
  for (const r of inRadius) {
    const key = normalizeStationName(r.station.name);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { entries: [] };
      buckets.set(key, bucket);
    }
    bucket.entries.push(r);
  }

  const candidates: ColdStartCandidate[] = [];
  for (const [stationName, { entries }] of buckets) {
    // entries는 이미 거리순 — 가장 가까운 entry 기준 위치 사용
    const closest = entries[0];
    const lines = entries.map((e) => e.station.line);
    const weight = computeCandidateWeight(
      lines,
      stationName,
      environment,
      favoriteStationNames,
      recentDestinationNames,
    );
    candidates.push({
      stationName,
      lines,
      distanceKm: closest.distanceKm,
      lat: closest.station.lat,
      lng: closest.station.lng,
      stations: entries.map((e) => e.station),
      weight,
    });
  }

  // weight desc, tiebreaker distanceKm asc
  candidates.sort((a, b) => {
    const weightDiff = b.weight - a.weight;
    if (weightDiff !== 0) return weightDiff;
    return a.distanceKm - b.distanceKm;
  });

  return candidates;
}
