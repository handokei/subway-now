/**
 * 지하(underground) Tier 1 SSOT 합의 판정.
 *
 * #1418 — 지하 GPS dead zone에서 WiFi SSID 또는 realtimePosition train 신호 + Arrival arvlCd 합의.
 *
 * 합의 경로 (둘 중 하나라도 만족):
 *   - WiFi+Arrival: `wifiStation` 비-null + 매칭 arrival row `arvlCd ∈ {1,2,3,5}`
 *   - Position-Train+Arrival: `positionTrainResult` 비-null + 매칭 arrival row 동일 조건
 *
 * 두 신호 모두 활성이면 WiFi 우선 (SSID 매칭은 지하 직접 신호, position-train은 API 추정).
 */

import type { NearestStationResult, Station } from '../../../shared/types/station';
import type { StationArrival } from '../../../shared/types/arrival';

/** arvlCd "정착한 위치 보고" 코드 집합. surfaceSSotConsensus와 동일 — 향후 공용 추출 여지. */
const ARVL_CD_STATIONARY = new Set<number>([1, 2, 3, 5]);

export interface UndergroundSSOTInput {
  /** useWifiStation 매칭 결과. null이면 SSID 미매칭. */
  wifiStation: Station | null;
  /** trackTrainProgress 결과 (fusion 게이트 통과 후). null이면 position-train 신호 부재. */
  positionTrainResult: NearestStationResult | null;
  /** 채택 후보 station 매칭 슬롯의 arrival. null이면 arrival 신호 부재. */
  arrival: StationArrival | null;
}

export interface UndergroundSSOT {
  station: Station;
  /** 합의 근거가 된 arrival row의 trainCode. */
  trainCode: string;
}

function findStationaryTrain(
  arrival: StationArrival | null,
  line: string,
): string | null {
  if (!arrival) return null;
  const allRows = [...arrival.up, ...arrival.down];
  for (const row of allRows) {
    if (row.line !== line) continue;
    if (!ARVL_CD_STATIONARY.has(row.arrivalCode)) continue;
    return row.trainCode;
  }
  return null;
}

export function undergroundSSOTConsensus(input: UndergroundSSOTInput): UndergroundSSOT | null {
  const { wifiStation, positionTrainResult, arrival } = input;
  // WiFi 우선 — SSID 직접 매칭.
  if (wifiStation) {
    const trainCode = findStationaryTrain(arrival, wifiStation.line);
    if (trainCode !== null) {
      return { station: wifiStation, trainCode };
    }
  }
  if (positionTrainResult) {
    const trainCode = findStationaryTrain(arrival, positionTrainResult.station.line);
    if (trainCode !== null) {
      return { station: positionTrainResult.station, trainCode };
    }
  }
  return null;
}
