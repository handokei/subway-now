import type { BoardingLock } from '../types/boardingLock';
import type { AlarmType } from './stationAlarm';

/**
 * 공통 sleep 룰 게이트가 다루는 알람 카테고리.
 * scheduler/FG/BG 경로 모두에서 적용되는 좁은 식별자 — 'transfer'일 때만 suppress 가능,
 * 'destination' / 'station-passed'는 항상 fire 한다.
 */
export type SleepRuleEventType = AlarmType | 'station-passed';

export interface SleepRuleEvent {
  type: SleepRuleEventType;
  stationName: string;
}

export interface SleepRuleInput {
  lock: BoardingLock | null;
  event: SleepRuleEvent;
  sleepMode: boolean;
  /**
   * 호출자가 도출한 "이 알람이 현재 leg의 *첫* hop을 향하는가" 신호.
   *
   * - `scheduleHopsForLock` : 배치 안의 hopIndex === 0
   * - `advanceHopWindow`     : hopIndex === passedIndex + 1
   * - FG/BG 즉시 발사 path   : `lock.boardingStationId`가 사용자가 직전에 lock한 탑승역이므로
   *                            "현재 노선의 다음 transfer"가 곧 첫 hop. 호출자는 자신이 보는
   *                            event.stationName이 lock이 시작된 leg의 첫 transfer waypoint와
   *                            일치하는지로 판단해 전달한다.
   */
  isFirstHop: boolean;
}

/**
 * #750 — 취침모드 첫 환승 알람 누수 차단용 공통 게이트.
 *
 * 단일 정책: lock 활성 + sleep ON + event가 현재 leg의 첫 hop transfer면 suppress.
 *
 * 이전 구현(`boardingLockScheduler.shouldSkipFirstTransferForSleep`)은 scheduler에만
 * 적용돼 폴링 기반 즉시 발사 path(useStationAlarm FG, stationPipeline BG)가 동일 조건에서
 * 발사를 우회했다. 이 함수를 세 경로 공통으로 호출해 정책을 한 곳에서 결정한다.
 *
 * lock=null이면 규칙은 비활성(scheduler가 동작하지 않고 "첫 hop" 개념이 없는 자유 트립).
 */
export function shouldSuppressBySleepRule(input: SleepRuleInput): boolean {
  if (!input.lock) return false;
  if (!input.sleepMode) return false;
  if (!input.isFirstHop) return false;
  return input.event.type === 'transfer';
}
