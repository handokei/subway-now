import type { TravelDirection } from './exitSide';

/**
 * 알람 도메인 type — useAppStore, BG task 등 cross-feature에서 참조되므로 shared로 추출.
 * 원본 위치: `src/features/alarm/utils/stationAlarm.ts` (re-export 유지).
 *
 * ADR Roadmap Phase 5 (#890).
 */

/**
 * 알람 단계 식별자. 'early' = N역 전 사전 경보, 'imminent' = 도착 임박(N초 이내).
 * 원본은 `features/alarm/utils/alarmPhases.ts` — cross-feature 참조용 ID만 shared에 둠.
 */
export type AlarmPhaseId = 'early' | 'imminent';

export type AlarmType = 'destination' | 'transfer';

export interface AlarmEvent {
  phaseId: AlarmPhaseId;
  type: AlarmType;
  stationName: string;
  // 알람 대상역에 진입하는 진행방향(상행/하행). 좌/우 하차 방향을 결정하는 데 쓰인다.
  // 노선/탑승역/목적역 중 하나라도 불명이면 undefined — 알람 본문에서 좌/우 라인을 생략한다.
  direction?: TravelDirection;
}

/**
 * backend trip register payload에 포함되는 단일 waypoint.
 * 원본: `features/alarm/api/alarmBackend.ts`. route 슬라이스가 routeWaypoints 빌더에서 type 참조.
 */
export interface AlarmWaypoint {
  stationName: string;
  line: string;
  kind: 'transfer' | 'destination' | 'intermediate';
}
