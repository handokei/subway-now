import type { TravelDirection } from './exitSide';

/**
 * 알람 도메인 type — useAlarmEventStore, BG task 등 cross-feature에서 참조되므로 shared로 추출.
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
  // 실제로 내리는 승강장의 역 id (경로 계산 함수가 채운 값). 환승역=목적지여도 fromLine 쪽 id다.
  // 경로에 id가 없으면 undefined — 이름으로 대체 조회하지 않는다(#3177 PR-4, 필수화는 PR-6z).
  stationId?: string;
  // 알람 대상역에 진입하는 진행방향(상행/하행). 좌/우 하차 방향을 결정하는 데 쓰인다.
  // 노선/탑승역/목적역 중 하나라도 불명이면 undefined — 알람 본문에서 좌/우 라인을 생략한다.
  direction?: TravelDirection;
  // 사용자가 잠근 열차의 종착역명(Seoul `bstatnNm`). 대상역에서 종착하는 열차만 문 방향이 달라지는
  // 역(예: 성수 외선 당역 종착)에서 쓴다. lock 열차 row를 못 찾으면 undefined — 종착 불명으로 처리.
  trainTerminal?: string;
  // #3100 — 취침 알람 N역 전 칸(타깃까지 실제 남은 정거장 수). 기본 칸(1역 전)은 undefined → 현행 문구.
  // 문구(안전망 알림·오버레이·Live Activity)만 읽는다 — dedup 키·phase 판정은 이 필드를 보지 않는다.
  band?: number;
}

/**
 * backend trip register payload에 포함되는 단일 waypoint.
 * 원본: `features/alarm/api/alarmBackend.ts`. route 슬라이스가 routeWaypoints 빌더에서 type 참조.
 */
export interface AlarmWaypoint {
  stationName: string;
  line: string;
  kind: 'transfer' | 'destination' | 'intermediate';
  /**
   * #2747 PR-6 — 이 역에 정차해 있다고 볼 때 목적지(하차역)까지 남은 초. backend가 LA push
   * etaMinutes를 (다음 waypoint ETA + 이 값)으로 합산한다. 구 client·계산 불가 시 부재(optional).
   */
  remainingSecToDest?: number;
  /**
   * #1480 PR-E (B2) — 환승 waypoint 전용. 환승 도보 이후 toLine·진행방향·요일 시간표의 다음 출발 K개(epoch 초, 오름차순).
   * backend가 push마다 "lock 열차 실시간 환승역 도착 + transferWalkSec" 이후 첫 출발을 다시 골라 etaMinutes를 갱신한다.
   * 셋(next/transferWalk/ride)은 함께 있거나 함께 없다. 시간표를 쓸 수 없으면 부재 -> backend는 remainingSecToDest로 폴백.
   */
  nextLegDeparturesEpochSec?: number[];
  /** 환승역 도착 → 승강장 준비까지 도보 + buffer (초). */
  transferWalkSec?: number;
  /** 이 환승의 도보·대기를 제외한 나머지 주행 (초). etaMinutes = 선택 출발까지 + 이 값. */
  rideSecToDest?: number;
}
