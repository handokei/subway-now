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
 * Sub-step 3 (시간표/즐겨찾기 narrow), Sub-step 4 (선택 UI), Sub-step 5 (mismatch 재확인)은 별 PR.
 */
import { useMemo } from 'react';
import stationsData from '../../../data/stations.json';
import { haversine } from '../../../shared/utils/haversine';
import type { LineNumber, Station } from '../../../shared/types/station';

/** cold start 판단에 쓰이는 GPS 정확도 임계값(m). 50m 초과 시 cold start 상황으로 간주. */
export const COLD_START_ACCURACY_THRESHOLD_M = 50;

/** cold start 후보 탐색 반경(km). */
export const COLD_START_RADIUS_KM = 0.5;

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
}

export interface UseColdStartCandidatesInput {
  /** 현재 GPS 좌표 및 정확도. */
  readonly gps: { readonly lat: number; readonly lng: number; readonly accuracy: number } | null;
  /** 환경 분류. */
  readonly environment: 'surface' | 'underground' | 'hybrid' | 'unknown';
  /** 진행 중 trip 존재 여부. */
  readonly hasTrip: boolean;
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
  const { gps, environment, hasTrip } = input;

  return useMemo<ColdStartCandidate[] | null>(() => {
    // cold start 조건 3개 AND 검사
    if (gps === null) return null;
    if (gps.accuracy <= COLD_START_ACCURACY_THRESHOLD_M) return null;
    if (environment === 'surface' || environment === 'hybrid') return null;
    if (hasTrip) return null;

    return extractColdStartCandidates(gps.lat, gps.lng);
  }, [gps, environment, hasTrip]);
}

/**
 * 순수 함수: GPS 좌표 기준 0.5km 반경 내 역을 추출하고 환승 호선 dedup.
 *
 * 단독 export — Sub-step 3 weighted narrow 함수가 이 결과를 입력으로 사용할 수 있게 분리.
 */
export function extractColdStartCandidates(lat: number, lng: number): ColdStartCandidate[] {
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
    candidates.push({
      stationName,
      lines,
      distanceKm: closest.distanceKm,
      lat: closest.station.lat,
      lng: closest.station.lng,
      stations: entries.map((e) => e.station),
    });
  }

  // 거리순 정렬 (bucket 삽입 순서는 entries 최소 거리 기준이므로 재정렬)
  candidates.sort((a, b) => a.distanceKm - b.distanceKm);
  return candidates;
}
