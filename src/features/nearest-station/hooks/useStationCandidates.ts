/**
 * 현재 위치 + wifi 매칭 결과를 결합해 "현재 역" 후보를 산출하는 hook (#914, Epic #912 — F4).
 *
 * 자동 추정으로 현재역을 단정할 수 없을 때 1탭 모달에 뿌릴 후보 목록을 메모이즈한다.
 * - wifi SSID(F2) 매칭 결과가 있으면 그 역을 topPick으로 두고 후보 1개 + 자동 확정 신호.
 * - 그 외엔 GPS 기반 `findTopNearestStations`로 거리순 상위 N개를 반환.
 *
 * 본 hook은 부수 효과 없는 순수 계산 layer. 모달 표시/검색 fallback 트리거는 호출자가 결정한다.
 *
 * 후속 PR:
 *  - HomeScreen wire(cold start + locationUncertain 길어질 때 표시)
 *  - F3 기압계(#920) 신호를 입력에 추가해 지하 진입 시 후보 가중치 보정
 */
import { useMemo } from 'react';
import { findTopNearestStations } from '../utils/findNearestStation';
import { MAX_STATION_DISTANCE_KM } from '../../../shared/constants/location';
import type { Station } from '../../../shared/types/station';

export const DEFAULT_MAX_CANDIDATES = 3;

export interface UseStationCandidatesInputs {
  /** 현재 GPS 좌표. null이면 GPS 기반 후보 추출 skip. */
  readonly userLocation: { readonly lat: number; readonly lng: number } | null;
  /** F2 wifi SSID 매칭 결과 (`lookupStationBySsid`). 있으면 최우선. */
  readonly wifiStation: Station | null;
  /** 후보 최대 개수. 기본 3. */
  readonly maxCandidates?: number;
  /** GPS 후보 추출 시 반경(km). 기본 `MAX_STATION_DISTANCE_KM`(1.0). */
  readonly maxDistanceKm?: number;
}

export interface UseStationCandidatesResult {
  /** UI에 표시할 후보 역 목록 (거리순 또는 wifi 단일). 최대 `maxCandidates`개. */
  readonly candidates: readonly Station[];
  /** 가장 유력한 후보 (강조 표시용). 후보 없으면 null. */
  readonly topPick: Station | null;
  /** 후보가 단 하나 → 모달 없이 자동 확정 가능. */
  readonly isAutoConfirmed: boolean;
}

const EMPTY: UseStationCandidatesResult = {
  candidates: [],
  topPick: null,
  isAutoConfirmed: false,
};

export function useStationCandidates(
  inputs: UseStationCandidatesInputs,
): UseStationCandidatesResult {
  const {
    userLocation,
    wifiStation,
    maxCandidates = DEFAULT_MAX_CANDIDATES,
    maxDistanceKm = MAX_STATION_DISTANCE_KM,
  } = inputs;

  return useMemo<UseStationCandidatesResult>(() => {
    // wifi 매칭(F2)이 있으면 그 역을 단일 후보로 — 지하 SSID는 GPS보다 신뢰도가 높다.
    if (wifiStation) {
      return {
        candidates: [wifiStation],
        topPick: wifiStation,
        isAutoConfirmed: true,
      };
    }

    if (!userLocation || maxCandidates <= 0) return EMPTY;

    const ranked = findTopNearestStations(
      userLocation.lat,
      userLocation.lng,
      maxCandidates,
      maxDistanceKm,
    );
    if (ranked.length === 0) return EMPTY;

    const candidates = ranked.map((r) => r.station);
    return {
      candidates,
      topPick: candidates[0],
      isAutoConfirmed: candidates.length === 1,
    };
  }, [userLocation, wifiStation, maxCandidates, maxDistanceKm]);
}
