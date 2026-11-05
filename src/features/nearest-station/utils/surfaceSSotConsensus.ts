/**
 * 지상(surface) Tier 1 SSOT 합의 판정.
 *
 * #1418 — 환경 인지 fusion arbitration. GPS+Arrival 두 실측 신호가 같은 역에 합의하면
 * "지상 SSOT" 라벨을 부여, 그 외 Tier 1~4가 모두 null인 dead zone에서만 Tier 5(시간 적분)
 * forward ratchet을 허용하기 위한 게이트 입력.
 *
 * 합의 조건 (모두 충족):
 *   1. GPS 신호 신선 — `gpsResult` 비-null, `gpsAccuracy` 가용 (`<= MAX_ACC_M`).
 *      너무 부정확한 GPS는 지하/wifi-cell 삼각측량 fallback일 가능성이 높아 "지상 신호"로 신뢰 X.
 *   2. Arrival 응답에서 `gpsResult.station` 매칭 trainCode의 `arrivalCode` ∈ {1, 2, 3, 5}
 *      (도착/출발/전역출발/전역도착) — 해당 열차가 같은 역 근방에 있다고 보고. arvlCd 0(진입)/
 *      4(전역진입)/99(운행중)/-1(누락)는 위치 불확정이라 합의 미성립.
 *
 * 호출자(useFusedNearestStation)가 result를 null로 받으면 "지상 SSOT 미합의"로 흘려보내고,
 * non-null이면 Tier 1로 채택할 수 있다(본 함수는 입력만 검증, 채택은 cascade가 책임).
 *
 * 임계값 선정 근거:
 *   - GPS_ACC_MAX_M=30 — 기존 fusion `lockActive=false` 거리 게이트 `accuracy>200m bypass`와는
 *     별개. Tier 1 SSOT는 더 엄격한 기준 필요 — `passesFusionDistanceGate`의 기본 통과 임계는
 *     50m라 30m로 더 좁히는 게 false-positive 차단에 적합. lockless trip에서 정적 사용자가
 *     14m accuracy로 보고된 회귀 evidence와 일치.
 */

import type { NearestStationResult } from '../../../shared/types/station';
import type { StationArrival } from '../../../shared/types/arrival';

/** Tier 1 SSOT 합의 임계값. accuracy_m. */
const GPS_ACC_MAX_M = 30;

/** arvlCd "정착한 위치 보고" 코드 집합. */
const ARVL_CD_STATIONARY = new Set<number>([1, 2, 3, 5]);

export interface SurfaceSSOTInput {
  /** GPS 최근접 result (null이면 GPS 신호 부재). */
  gpsResult: NearestStationResult | null;
  /** GPS accuracy_m. null이면 신뢰도 불명 — Tier 1 미충족. */
  gpsAccuracy: number | null;
  /** gpsResult.station 매칭 슬롯의 arrival. null이면 arrival 신호 부재. */
  arrival: StationArrival | null;
}

export interface SurfaceSSOT {
  station: NearestStationResult['station'];
  /** 합의 근거가 된 arrival row의 trainCode. */
  trainCode: string;
}

/**
 * 합의 시 SSOT 반환, 불합의 시 null.
 *
 * 합의 trainCode는 가장 먼저 매칭된 `arvlCd ∈ {1,2,3,5}` row 기준 — 다중 매칭은 모두 같은 역을
 * 지나는 열차 그룹이므로 어느 trainCode를 골라도 fusion 입력으로 동등.
 */
export function surfaceSSOTConsensus(input: SurfaceSSOTInput): SurfaceSSOT | null {
  const { gpsResult, gpsAccuracy, arrival } = input;
  if (!gpsResult) return null;
  if (gpsAccuracy === null || gpsAccuracy > GPS_ACC_MAX_M) return null;
  if (!arrival) return null;

  const allRows = [...arrival.up, ...arrival.down];
  for (const row of allRows) {
    if (row.line !== gpsResult.station.line) continue;
    if (!ARVL_CD_STATIONARY.has(row.arrivalCode)) continue;
    return { station: gpsResult.station, trainCode: row.trainCode };
  }
  return null;
}
