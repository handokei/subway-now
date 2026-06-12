import type { BoardingLock } from '../../../shared/types/boardingLock';
import type { AlarmType } from './stationAlarm';

/**
 * 공통 sleep 룰 게이트가 다루는 알람 카테고리.
 * scheduler/FG/BG 경로 모두에서 적용되는 좁은 식별자 — 'transfer' / 'station-passed' 일 때
 * suppress 가능. 'destination'은 항상 fire(도착 놓치면 안 됨).
 */
export type SleepRuleEventType = AlarmType | 'station-passed';

export interface SleepRuleEvent {
  type: SleepRuleEventType;
  stationName: string;
}

export interface SleepRuleInput {
  /**
   * 활성 BoardingLock. null이면 lockless trip — `isFirstHop`을 호출자가 lockless estimator
   * (`stationProgressEstimator` hopIndex===0)로 판단해 전달한다(#1214, Epic #1204 D8).
   */
  lock: BoardingLock | null;
  event: SleepRuleEvent;
  sleepMode: boolean;
  /**
   * 호출자가 도출한 "이 알람이 현재 leg의 *첫* hop을 향하는가" 신호.
   *
   * - `scheduleHopsForLock` : 배치 안의 hopIndex === 0
   * - `advanceHopWindow`     : hopIndex === passedIndex + 1
   * - FG/BG 즉시 발사 path (lock 활성): `lock.boardingStationId`가 사용자가 직전에 lock한
   *                            탑승역이므로 "현재 노선의 다음 transfer" / "탑승역에서의
   *                            station-passed"가 곧 첫 hop. 호출자는 event.stationName이
   *                            lock이 시작된 leg의 첫 waypoint와 일치하는지로 판단해 전달.
   * - Lockless trip (#1214) : D1 lockless estimator(`stationProgressEstimator`)의 hopIndex===0
   *                            을 호출자가 fallback으로 계산해 전달. signature는 유지.
   */
  isFirstHop: boolean;
}

/**
 * #750 — 취침모드 첫 환승 알람 누수 차단용 공통 게이트.
 * #1214 (Epic #1204 D8) — 'station-passed' 도 차단 대상 추가 + lockless trip 적용.
 *
 * 단일 정책: sleep ON + event가 현재 leg의 첫 hop을 향함 + event.type이 transfer/station-passed면 suppress.
 *
 * - 이전 구현(`boardingLockScheduler.shouldSkipFirstTransferForSleep`)은 scheduler에만 적용돼
 *   폴링 기반 즉시 발사 path(useStationAlarm FG, stationPipeline BG)가 우회했다 — #750에서 통합.
 * - 'station-passed' 통과 회귀(2026-06-12 사가정 fire, Epic #1204 §1 회귀 6)는 본 함수가
 *   transfer에만 적용돼 사용자가 자던 중 출발역 매역 알림이 발사된 결과 — D8에서 차단.
 * - lock=null 조기 종료를 제거 — 사용자 명시 의향 trip(C 토글 ON / boardingPrompt 응답 /
 *   BoardingTrainList 직접 탭)은 lock 활성과 동급 정확도 보장 의무(ADR-013 §B3, ADR-014).
 *   호출자가 lockless estimator로 `isFirstHop`을 계산해 전달하면 본 함수는 동일 정책 적용.
 *
 * 'destination'은 항상 통과 — 도착 알람을 놓치면 사용자가 종착역을 지나칠 수 있음.
 */
export function shouldSuppressBySleepRule(input: SleepRuleInput): boolean {
  if (!input.sleepMode) return false;
  if (!input.isFirstHop) return false;
  return input.event.type === 'transfer' || input.event.type === 'station-passed';
}

/**
 * #1236 (Epic #1204 D8 wire) — station-passed dispatch path에서 `isFirstHop`을 결정하는 공통 헬퍼.
 *
 * FG (useStationAlarm GPS/arvlCd) / BG (stationPipeline) 세 경로가 동일 정책으로
 * sleep 룰을 호출하기 위해 isFirstHop 산출을 한 곳에 둔다.
 *
 * - lock 활성 : candidate 역이 사용자가 명시 lock한 boardingStationId와 일치하면 첫 hop.
 *   사가정 22:11:56 회귀(boardingStationId='사가정', candidate='사가정', station-passed fire)와 직접 매핑.
 * - lockless  : D1 estimator의 hopIndex===0이 SSOT. 미전달이면 false(graceful skip — 게이트 미적용).
 *
 * 두 신호가 모두 없으면 false — 정확성 보강이 불가능하면 알람을 차단하지 않는다(보수적).
 */
export function isStationPassedFirstHop(input: {
  lock: BoardingLock | null;
  candidateStationId: string;
  currentHopIndex: number | null | undefined;
}): boolean {
  if (input.lock) return input.candidateStationId === input.lock.boardingStationId;
  if (input.currentHopIndex === 0) return true;
  return false;
}
