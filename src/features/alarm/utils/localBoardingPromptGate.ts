/**
 * #2422 — 로컬 boarding-prompt 게이트.
 *
 * backend `evaluateAndMaybeFireBoardingPrompt`(9단 AND 게이트, `backend/alarm-worker/src/
 * boardingPrompt.ts`)의 본질만 device FG 단발 폴링 컨텍스트로 이식한다. 9개 전부 무차별
 * 복제는 과설계(CLAUDE.md 단순성) — 오탐 방지에 실제로 필요한 것만 남긴다.
 *
 * 포함:
 *   - 근접(backend #3/#4) — `isNearOrigin`(boardingPrompt.ts) 공식을 그대로 포팅:
 *     `originDistanceM - originAccuracyM <= PROMPT_PROXIMITY_MARGIN_M`. features → backend
 *     import는 금지 룰(CLAUDE.md)이라 상수/함수를 직접 재사용할 수 없어 값만 동기화한다.
 *   - 방향 + 도착열차 존재(backend #5 대체) — GPS 이동방향 cosine(backend #5)은 다중 GPS
 *     샘플(position series)이 필요해 FG 단발 폴링 훅에서 별도 유지 비용이 크다. 대신
 *     `useBoardingPromptResponder.tryAutoLock`이 이미 쓰는 "route 방향(direction) + 같은
 *     line arrival 필터" 패턴을 재사용 — 실제 열차가 그 방향/노선에 존재한다는 사실 자체가
 *     "지금 이 역에서 탑승 대기 중"이라는 더 신뢰 가능한 신호다.
 *
 * 제외(의도적):
 *   - motion 게이트(backend #6/#8) — ADR-032(device emitter) 사망 원인이 motion-accelerometer
 *     오분류(walking/automotive 오분류, 감지 0건)였다. 방향 A 지침이 명시적으로 GPS/route/arrival
 *     기반만 허용하고 motion 기반을 금지한다.
 *   - fused speed(backend #7) — GPS position series 다중 샘플이 전제. 이 안전망은 backend의
 *     보조/fallback 채널이므로 series 유지 비용이 가치 대비 과설계.
 *   - 반복 발사/침묵(backend #9) — 게이트 함수 책임이 아니라 별도 dedup 레이어
 *     (`recentLocalStationFires.ts`, #2122 station-passed 선례 재사용)가 담당.
 *   - lock 활성 여부(backend #1)/context 존재(backend #2) — 호출자(`useLocalBoardingPromptGate`)
 *     가 `buildBoardingPromptContext` 호출 전에 사전 보장한다.
 *
 * #2801 (REOPENED 2026-09-30 정정 스펙 §1/§3.3) — 근접 통과했지만 후보 열차가 전부 non-imminent
 * (임박 아님)면 backend `decideBoardingPromptFire`(boardingPrompt.ts)와 동일한 OR-fallback
 * 게이트로 조기 발사를 차단한다. 값 동기화 규약은 위 근접 게이트와 동일하되, 이 파일은
 * `src/shared/constants/arrivalCodes.ts`를 직접 import할 수 있다(features → shared는 허용,
 * features → backend만 금지) — 값 재정의가 아니라 실제 재사용.
 */
import { ARRIVAL_CODE } from '../../../shared/constants/arrivalCodes';
import type { BoardingPromptContext } from './boardingPromptContext';
import type { ArrivalInfo, StationArrival } from '../../../shared/types/arrival';

/**
 * backend `PROMPT_PROXIMITY_MARGIN_M`(boardingPrompt.ts)와 동일 값. SSoT는 backend — features
 * → backend import 금지 룰로 상수 자체는 공유 불가하니 drift 방지는 이 주석 + 값 동기화로 관리.
 */
export const LOCAL_BOARDING_PROMPT_PROXIMITY_MARGIN_M = 150;

/** backend `isNearOrigin`(boardingPrompt.ts) 공식 포팅. */
function isNearOriginLocal(
  originDistanceM: number | undefined,
  originAccuracyM: number | undefined,
): boolean {
  if (originDistanceM === undefined || originAccuracyM === undefined) return false;
  return originDistanceM - originAccuracyM <= LOCAL_BOARDING_PROMPT_PROXIMITY_MARGIN_M;
}

/**
 * #2801 — backend `IMMINENT_BOARDING_ARVLCD`(boardingPrompt.ts)와 동일 값(0 진입/1 도착/2 출발).
 * 근거는 backend 주석과 동일 — cron/폴링 갭에 진입→도착→출발이 한 tick에 지나갈 수 있어 출발도
 * "방금 탑승" 신호로 포함한다.
 */
const LOCAL_IMMINENT_BOARDING_ARVLCD: ReadonlySet<number> = new Set([
  ARRIVAL_CODE.ENTERING,
  ARRIVAL_CODE.ARRIVED,
  ARRIVAL_CODE.DEPARTED,
]);

export type LocalBoardingFireDecision =
  | { fire: true; decision: 'imminent' }
  | { fire: true; decision: 'fallback-unobservable' }
  | { fire: false; decision: 'suppressed-not-imminent' };

/**
 * backend `decideBoardingPromptFire`(boardingPrompt.ts)와 동일 OR-fallback 판정.
 * `ArrivalInfo.arrivalCode`는 누락/비숫자 시 -1(미관측) — backend의 arvlCd===null과 동치.
 */
export function decideLocalBoardingPromptFire(
  pool: readonly ArrivalInfo[],
): LocalBoardingFireDecision {
  const imminent = pool.filter(
    (a) => a.arrivalCode >= 0 && LOCAL_IMMINENT_BOARDING_ARVLCD.has(a.arrivalCode),
  );
  if (imminent.length > 0) return { fire: true, decision: 'imminent' };
  if (pool.some((a) => a.arrivalCode < 0)) {
    return { fire: true, decision: 'fallback-unobservable' };
  }
  return { fire: false, decision: 'suppressed-not-imminent' };
}

export interface EvaluateLocalBoardingPromptGateInput {
  context: BoardingPromptContext;
  arrival: StationArrival;
}

export type LocalBoardingPromptGateSkipReason =
  | 'not-near-origin'
  | 'no-arriving-train'
  | 'suppressed-not-imminent';

export type LocalBoardingPromptGateOutcome =
  | { pass: true }
  | { pass: false; reason: LocalBoardingPromptGateSkipReason };

/**
 * 로컬 boarding-prompt 발사 여부 평가. pure 함수 — 부수효과 없음.
 */
export function evaluateLocalBoardingPromptGate(
  input: EvaluateLocalBoardingPromptGateInput,
): LocalBoardingPromptGateOutcome {
  const { originDistanceM, originAccuracyM, direction } = input.context.promptGeoContext;
  if (!isNearOriginLocal(originDistanceM, originAccuracyM)) {
    return { pass: false, reason: 'not-near-origin' };
  }

  const { line } = input.context.promptDisplay;
  const { arrival } = input;
  const directionSlice: readonly ArrivalInfo[] =
    direction === 'up' || direction === 'down'
      ? arrival[direction]
      : ([] as ArrivalInfo[]).concat(arrival.up, arrival.down);
  const arrivingPool = directionSlice.filter((a) => a.line === line && a.arrivalSeconds > 0);
  if (arrivingPool.length === 0) {
    return { pass: false, reason: 'no-arriving-train' };
  }

  // #2801 — 근접 통과 + 같은 line/방향 후보는 있으나 전부 non-imminent → 조기 발사 억제.
  const gate = decideLocalBoardingPromptFire(arrivingPool);
  if (!gate.fire) {
    return { pass: false, reason: 'suppressed-not-imminent' };
  }

  return { pass: true };
}
