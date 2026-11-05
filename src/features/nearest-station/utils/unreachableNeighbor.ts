import {
  STATIONARY_HOLD_MAX_ACCURACY_M,
  STATIONARY_HOLD_MAX_SPEED_MPS,
} from '../../../shared/constants/stationaryFixHold';
import { GPS_QUALITY_GATE_MAX_AGE_MS } from '../../../shared/constants/gpsQualityGate';
import { MAX_FUSION_DELTA_KM, MAX_FUSION_DISTANCE_KM } from '../../../shared/constants/realtime';
import { lookupAdjacentHopSeconds } from '../../../shared/utils/adjacentHopSeconds';
import { findStationByNameAndLine } from '../../../shared/utils/stationLookup';
import type { NearestStationResult } from '../../../shared/types/station';
import { passesFusionDistanceGate } from './fusionDistanceGate';

export interface UnreachableNeighborInput {
  /** 거리 오름차순 후보 - `[0]`이 앵커(GPS 최근접, pickFusedStation과 같은 기준). */
  candidates: readonly NearestStationResult[];
  /** 마지막 fix 나이(ms). 판단 불가(null)면 비활성. */
  fixAgeMs: number | null;
  /** 마지막 fix 품질 - 정지 fix 판정(STATIONARY_HOLD_MAX_*)에 쓴다. */
  accuracyMeters: number | null;
  speedMps: number | null;
  /** 마지막 fix 좌표 - "신선했다면 거리 게이트가 거부했을 위치"인지 판정. */
  userLocation: { lat: number; lng: number } | null;
  /** 기존 정지 fix 유지(hold)가 활성이면 그쪽이 L을 게이트에 계속 쓰므로 여기서는 비활성. */
  stationaryHold: boolean;
  lockActive: boolean;
}

/**
 * #3191 PR-D(D-hop) - 정지 fix 직후 "물리적으로 도달 불가"한 이웃 후보 id 목록.
 *
 * 지상 정지(15초 넘게 새 fix 없음)에서 15초 넘은 fix는 결정 입력에서 빠져 거리 게이트가 꺼진다(ADR-039 1단계).
 * 그 틈에 앵커(최근접역) 바로 옆 역의 열차 신호가 앵커를 이겨 사용자가 한 역 앞/뒤로 표시된다(R11 뚝섬->성수 등).
 * 아래를 모두 만족하는 후보만 제외한다 - 제외 조건이 신선 게이트보다 엄격해지는 일이 없고(`freshWouldReject`),
 * 길어야 그 hop 운행시간(데이터상 60~270s)이 지나면 현행 동작으로 돌아간다.
 *   1. lock 없음, hold 아님, fix 나이 >= 15s
 *   2. 마지막 fix가 정지 품질 (acc <= 30, speed null 또는 < 0.5) - hold 술어와 같은 임계
 *   3. 후보가 앵커의 같은 노선 인접역이고 fix 나이 < 그 hop 운행시간
 *   4. 신선 fix였다면 거리 게이트가 이 후보를 거부했을 위치
 */
export function findUnreachableNeighborIds({
  candidates,
  fixAgeMs,
  accuracyMeters,
  speedMps,
  userLocation,
  stationaryHold,
  lockActive,
}: UnreachableNeighborInput): string[] {
  if (lockActive || stationaryHold || userLocation === null || fixAgeMs === null) return [];
  if (fixAgeMs < GPS_QUALITY_GATE_MAX_AGE_MS) return [];
  if (accuracyMeters === null || accuracyMeters > STATIONARY_HOLD_MAX_ACCURACY_M) return [];
  if (speedMps !== null && speedMps >= STATIONARY_HOLD_MAX_SPEED_MPS) return [];
  const [anchor, ...neighbors] = candidates;
  if (!anchor) return [];
  return neighbors
    .filter((candidate) => {
      const { id, line } = candidate.station;
      const anchorOnLine = findStationByNameAndLine(anchor.station.name, line);
      if (!anchorOnLine) return false;
      const hopSeconds = lookupAdjacentHopSeconds(line, anchorOnLine.id, id);
      if (hopSeconds === null || fixAgeMs >= hopSeconds * 1000) return false;
      return !passesFusionDistanceGate({
        candidate,
        userLocation,
        accuracyMeters,
        gpsNearest: anchor,
        maxAbsoluteKm: MAX_FUSION_DISTANCE_KM,
        maxDeltaKm: MAX_FUSION_DELTA_KM,
        lockActive: false,
      });
    })
    .map((candidate) => candidate.station.id);
}
