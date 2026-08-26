import type { StationArrival } from '../../../shared/types/arrival';
import type { CandidateTrain } from '../../../shared/types/position';
import { getArrivalPriority } from '../../../shared/constants/arrivalCodes';

/**
 * #2383 — arrival(폴링 대상 waypoint station) 응답에서 lock.trainCode와 일치하는 row를
 * `CandidateTrain[]`으로 변환한다. `pickCandidateTrains.ts`(realtimePosition API 전용)와 동일
 * 계약(`CandidateTrain`)을 따르지만 입력 소스가 다르다 — arrival API는 특정 station으로
 * 접근 중인 열차만 반환하고 train의 정확한 좌표/statnNm을 주지 않으므로, "폴링한 waypoint
 * station 자체가 현재 위치에 가깝다"는 근사로 `currentStationName`을 채운다
 * (issue #2383 스펙 편차 — 이슈 본문은 arrival row에 currentStationName이 포함된다고 서술했으나
 * `ArrivalInfo`엔 그 필드가 없다. `trackTrainProgress`가 요구하는 계약을 만족시키기 위한 근사).
 *
 * `getArrivalPriority`(0 = 출발/전역출발/운행중, "현재 위치 신호로 부적합")가 0인 row는 제외 —
 * 열차가 이미 그 역을 떠났거나(운행중) 위치 근사 신뢰도가 낮은 경우 후보에서 배제한다.
 */
export function buildCandidateTrainsFromArrival(
  arrival: StationArrival,
  waypointStationName: string,
  trainCode: string,
): CandidateTrain[] {
  const groups: Array<{ rows: StationArrival['up']; direction: 0 | 1 }> = [
    { rows: arrival.up, direction: 0 },
    { rows: arrival.down, direction: 1 },
  ];

  const candidates: CandidateTrain[] = [];
  for (const { rows, direction } of groups) {
    for (const row of rows) {
      if (row.trainCode !== trainCode) continue;
      if (getArrivalPriority(row.arrivalCode) <= 0) continue;
      candidates.push({
        trainNo: row.trainCode,
        line: row.line,
        direction,
        currentStationName: waypointStationName,
        trainStatus: row.arrivalCode,
        receivedAtMs: row.receivedAtMs,
      });
    }
  }
  return candidates;
}
