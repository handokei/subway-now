/**
 * 현재 위치 + wifi 매칭 결과를 결합해 "현재 역" 후보를 산출하는 hook (#914, Epic #912 — F4).
 *
 * 자동 추정으로 현재역을 단정할 수 없을 때 1탭 모달에 뿌릴 후보 목록을 메모이즈한다.
 * - wifi SSID(F2) 매칭 결과가 있으면 그 역을 topPick으로 두고 후보 1개 + 자동 확정 신호.
 * - F2 실패 시 F3 기압계 절대값(#920)으로 GPS 후보를 narrow.
 * - 그 외엔 GPS 기반 `findTopNearestStations`로 거리순 상위 N개를 반환.
 *
 * 본 hook은 부수 효과 없는 순수 계산 layer. 모달 표시/검색 fallback 트리거는 호출자가 결정한다.
 *
 * 후속 PR:
 *  - HomeScreen wire(cold start + locationUncertain 길어질 때 표시)
 *  - F3 surfacePressure baseline 수집 (현재는 호출자가 주입)
 *  - 환승역 노선/방향 결합 narrow
 */
import { useMemo } from 'react';
import { findTopNearestStations } from '../utils/findNearestStation';
import { MAX_STATION_DISTANCE_KM } from '../../../shared/constants/location';
import {
  narrowStationsByDepthAndEta,
  narrowStationsByPressure,
} from '../../../shared/utils/barometerState';
import type { Station } from '../../../shared/types/station';

export const DEFAULT_MAX_CANDIDATES = 3;

export interface UseStationCandidatesInputs {
  /** 현재 GPS 좌표. null이면 GPS 기반 후보 추출 skip. */
  readonly userLocation: { readonly lat: number; readonly lng: number } | null;
  /** F2 wifi SSID 매칭 결과 (`lookupStationBySsid`). 있으면 최우선. */
  readonly wifiStation: Station | null;
  /** F3 기압계 절대 측정값(hPa). null이면 narrow skip. */
  readonly absolutePressureHpa?: number | null;
  /** 같은 지역 지상 기준 압력(hPa). absolutePressureHpa와 함께 주어져야 narrow 활성. */
  readonly surfacePressureHpa?: number | null;
  /**
   * F3 추가 narrow(#920 후속) — 직전 확정역. previousStation+secondsSincePrevious가
   * 모두 주어졌을 때만 깊이+ETA 결합으로 모호한 후보를 단일 후보로 좁힌다.
   */
  readonly previousStation?: Station | null;
  /** 직전 확정역 통과 후 경과 시간(초). previousStation과 함께 주어져야 결합 narrow 활성. */
  readonly secondsSincePrevious?: number | null;
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
    absolutePressureHpa = null,
    surfacePressureHpa = null,
    previousStation = null,
    secondsSincePrevious = null,
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

    const gpsCandidates = ranked.map((r) => r.station);

    // F3 — 기압계 절대값으로 GPS 후보를 narrow. 압력값 모두 주어지고 narrow 결과가
    // 비지 않을 때만 적용. 0개로 좁아지면 F3 신호를 무시(GPS 후보 그대로 사용).
    let candidates = gpsCandidates;
    if (absolutePressureHpa !== null && surfacePressureHpa !== null) {
      const narrowed = narrowStationsByPressure(
        absolutePressureHpa,
        surfacePressureHpa,
        gpsCandidates,
      );
      if (narrowed.length > 0) candidates = narrowed;
    }

    // F3 추가 narrow(#920 후속) — baseline이 여전히 모호하고 직전 확정역 정보가 있으면
    // 깊이+ETA 결합으로 단일 후보로 좁힘. 결정적 단서가 부족하면 narrow 함수가 candidates
    // 그대로 반환 → 안전.
    if (
      candidates.length > 1 &&
      previousStation !== null &&
      secondsSincePrevious !== null &&
      absolutePressureHpa !== null &&
      surfacePressureHpa !== null
    ) {
      candidates = narrowStationsByDepthAndEta({
        measuredPressureHpa: absolutePressureHpa,
        surfacePressureHpa,
        candidates,
        previousStation,
        secondsSincePrevious,
      });
    }

    return {
      candidates,
      topPick: candidates[0],
      isAutoConfirmed: candidates.length === 1,
    };
  }, [
    userLocation,
    wifiStation,
    absolutePressureHpa,
    surfacePressureHpa,
    previousStation,
    secondsSincePrevious,
    maxCandidates,
    maxDistanceKm,
  ]);
}
