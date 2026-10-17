/* eslint-disable import/no-restricted-paths --
 * `arcIndexOfStation`는 route feature 소유(`stationProgressEstimator.ts`) — 이 helper는
 * `useFusedNearestStation.ts:924~943`(positionTrainResult lock 게이트)와 동일 로직을 순수
 * 함수로 추출한 것으로 본질적으로 cross-feature다. Phase 5 orchestrator 옵트인 패턴
 * (undergroundConsensusFire.ts 등)과 동일.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import type { Station } from '../../../shared/types/station';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import { arcIndexOfStation } from '../../route/utils/stationProgressEstimator';

/** LOCK_NEXT_HOP_WINDOW — arc window 밖(탑승역 + N hop 초과) candidate 차단. */
const LOCK_NEXT_HOP_WINDOW = 3;

/**
 * arcStations 내에서 candidateId가 boardingStationId 기준 arc window(±N hop) 이내인지.
 * `fusionDistanceGate.ts`의 동일 이름 함수와 같은 계약 — BG에는 그 파일의 다른 GPS 전용
 * export(`passesFusionDistanceGate` 등)가 불필요해 순수 부분만 이 파일에 재정의한다.
 */
function isWithinArcWindow(
  arcStations: readonly Station[],
  candidateId: string,
  boardingStationId: string,
): boolean {
  if (arcStations.length === 0) return true;
  const boardingIdx = arcStations.findIndex((s) => s.id === boardingStationId);
  if (boardingIdx === -1) return true;
  const candidateIdx = arcStations.findIndex((s) => s.id === candidateId);
  return candidateIdx !== -1 && candidateIdx <= boardingIdx + LOCK_NEXT_HOP_WINDOW;
}

/**
 * #2383 — `useFusedNearestStation.ts:924~943`(positionTrainResult lock 게이트)와 동일한 3단
 * 검증을 GPS 없이 수행하는 순수 헬퍼. lock trainCode 경로(`bgPositionTrainFire.ts`)가 채택한
 * station이 사용자가 명시적으로 잠근 노선/경로를 벗어나지 않았는지 검증한다.
 *
 * 1. 노선 일치 — station.line === lock.boardingLine (환승역 옆 노선 오채택 방지, #662 동일 취지)
 * 2. arc-window — 탑승역 기준 앞으로 LOCK_NEXT_HOP_WINDOW hop 이내만 허용 (#1016 hole c 동일 취지)
 * 3. forward-only — 탑승역보다 과거(backward) station이면 차단 (#1015 동일 취지)
 */
export function passesLockedStationGate(
  station: Station,
  lock: BoardingLock,
  arcStations: readonly Station[],
): boolean {
  if (station.line !== lock.boardingLine) return false;
  if (!isWithinArcWindow(arcStations, station.id, lock.boardingStationId)) return false;
  if (arcStations.length > 0) {
    const boardingIdx = arcStations.findIndex((s) => s.id === lock.boardingStationId);
    if (boardingIdx !== -1) {
      const stationIdx = arcIndexOfStation(arcStations as Station[], station);
      if (stationIdx !== -1 && stationIdx < boardingIdx) return false;
    }
  }
  return true;
}
