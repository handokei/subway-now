/**
 * #1439 (E6) — ADR-015 §3/§4/§7/§9 backend fire 재설계.
 *
 * 본 모듈은 backend가 fire(=lock 부착 + 알림 발사)를 결정할 때의 합의 게이트를 한 곳에 모은다.
 *
 * §3 N-of-M 합의 게이트:
 *   기존 9단 AND 게이트(`evaluateBoardingPromptGates`)는 strong 신호(motion + 방향 cosine +
 *   fused speed + accuracy + origin 근접 + 윈도우 N≥3 + arrival arvlCd 우선순위)의 곱(AND)으로
 *   이미 "다중 신호 합의"의 보수 케이스를 만족한다. 본 모듈은 그 위에 환경 분기 정책을 얹는다:
 *
 *     - `environment=surface`: 기존 9단 게이트(GPS+arrival+motion 합의) 통과로 충분.
 *     - `environment=underground`: GPS는 입력 set에서 reject — 9단 게이트 결과를 그대로 신뢰하면
 *       지하 false positive(GPS jitter 기반 origin proximity / 방향 cosine)가 통과할 수 있다.
 *       따라서 underground에서는 strong B(arrival arvlCd 1~3) + strong E(lockAttachable) 의
 *       2-of-2 합의(또는 strong G consensusConfirmed 단독)가 필요 — arrival 단독으로 통과를
 *       허용하지 않고 reject. boarding-prompt fallback은 게이트 미통과로 자연 silent.
 *       #2765 (게이트 전수감사 A) — strong C(position-train)/D(WiFi)/F(cellular) 분기는 생산자
 *       0건(2026-09-03 확정 아키텍처가 폐기한 device-fusion 패러다임 잔재)이 감사로 확정돼
 *       제거됐다.
 *     - `environment=mixed`: 보수적. strong 2개(arrival + arvlCd 우선순위 확정 + 단일 trainCode)
 *       충족 시에만 통과 — `pickAutoTrainCode`가 단일 후보로 수렴(ambiguity 없음)한 시점이 곧
 *       arrival(strong B) + lock-line(strong E surrogate) 합의로 해석된다.
 *
 * §4 합의 안 됨 = fire X:
 *   `evaluateConsensusGate`가 false면 caller는 lock 부착 / push 발사 모두 skip. UI 추적
 *   채널(promptDisplay)은 동작 보존 — 본 모듈은 fire 결정에만 관여한다.
 *
 * §7 토글 input X:
 *   본 게이트는 `trip.infoModeEnabled`(C 토글) / `trip.boardingPromptState.fired`
 *   (사용자 응답) 등 **사용자 명시 의향 필드를 input으로 받지 않는다**. 시그너처가 `environment`
 *   + `signals` 만 받는 사실이 §7의 정적 보증. 토글 UI 라벨은 frontend 책임.
 *
 * §9 trainCode lock 정확성 게이트:
 *   `isLockLineAllowed(lock, allowedLines)`로 별도 검증. caller(`attachTrainCodeForLeg`)가
 *   lock 합성 직후 본 검증을 통과시키지 못하면 null 반환.
 *   `computeAllowedLines(trip)`는 trip route의 모든 leg line을 union으로 산출한다.
 *
 * memory `feedback_user_intent_equal_protection.md` (사용자 의향 trip 동급 보장) 호환:
 *   본 게이트는 모든 trip에 동일 적용 — 토글 ON/OFF, lock 활성/비활성 trip 모두 같은 정확성
 *   기준을 통과해야 fire. 토글 ON trip이라고 정확성 게이트를 우회하지 않으며, lock 비활성
 *   trip도 fire 권한이 자동 박탈되지 않는다.
 */

import type { ArchFlagValue } from './archFlag';
import type { GateOutcome } from './boardingPrompt';
import type { BoardingLockMeta, LineNumber, Route, Trip, Waypoint } from './types';

/**
 * stations.json `environment` 필드 (E1 #1444에서 도입).
 *
 * - surface: 모든 승강장이 지상 (F prefix only)
 * - underground: 모든 승강장이 지하 (B prefix only)
 * - mixed: 지상 + 지하 복합 (FB)
 * - unknown: 데이터 미수집 (분기 보수적 — mixed 동급으로 다룸)
 */
export type StationEnvironment = 'surface' | 'underground' | 'mixed' | 'unknown';

/**
 * §3 합의 게이트에 들어가는 신호 입력. 본 모듈은 backend가 cron 사이클에 산출 가능한 신호만 받는다.
 *
 * - `gateOutcome`: 기존 9단 AND 게이트 결과 (motion/방향/GPS accuracy/fused speed 합의)
 * - `arrivalSignalPresent`: 다음 waypoint의 arvlCd ∈ {0,1,2,3} 신호 존재 여부 (strong B)
 * - `lockAttachable`: `pickAutoTrainCode`가 단일 trainCode로 수렴 (strong E surrogate — 사용자가
 *   실제 그 열차에 타고 있다는 강한 cross-check)
 * - `consensusConfirmed`: #2329 (consensus-C, 설계 SSoT #2323) — `transferLegConsensus.ts`
 *   상태기계가 'confirmed'로 수렴했다는 surrogate 신호(strong G). underground 분기에서
 *   `lockAttachable`(=lock 부착, strong E)의 대체 surrogate로 취급한다 — 2+ waypoint 연속
 *   match(±90s) + mismatch=0 확정은 실제 lock 부착과 동급의 강 신호이기 때문이다(설계 SSoT
 *   (1) "confirmed = lockAttachable surrogate"). true일 때만 의미 있고, false/undefined는
 *   기존 정책 무영향(다른 OR 분기가 그대로 평가된다).
 *
 * #2765 (게이트 전수감사 A) — `positionTrainAgreement`(strong C) / `wifiSsidMatch`(strong D) /
 * `cellularEnvironmentVote`(strong F, cellular hard-reject 포함)는 생산자 0건이 감사로 확정돼
 * signal 자체가 제거됐다.
 */
export interface ConsensusSignals {
  gateOutcome: GateOutcome;
  arrivalSignalPresent: boolean;
  lockAttachable: boolean;
  consensusConfirmed?: boolean;
}

/**
 * §3/§4 평가 결과. caller는 `pass=false`면 fire(=lock 부착 / push 발사)를 skip한다.
 *
 * `reason`은 미통과 사유 — 분포 측정 + 로깅 용. `'environment-no-gps-consensus'`는 underground
 * 환경에서 비-GPS 강신호 합의가 부족해 reject된 케이스(§3 underground 정책).
 */
export type ConsensusOutcome =
  | { pass: true; environment: StationEnvironment }
  | {
      pass: false;
      environment: StationEnvironment;
      reason:
        | 'base-gate-failed'
        | 'environment-no-gps-consensus'
        | 'mixed-strong-signals-insufficient';
    };

/**
 * §3 분기별 fire 게이트 평가.
 *
 * - surface: base 9단 게이트 통과로 충분 (GPS+arrival+motion 합의)
 * - underground: GPS reject. arrival(B) + lockAttachable(E surrogate) 2-of-2 또는
 *   consensusConfirmed(G) 단독.
 * - mixed/unknown: 보수적. arrival + lockAttachable 동시 충족 강제. base 9단 게이트 통과도
 *   동시에 요구해 false positive 누적 차단.
 *
 * #2765 (게이트 전수감사 A) — cellular hard-reject(S10 #1543, `cellularContradictsEnvironment`)와
 * underground strong C(position-train)/D(WiFi) 분기는 생산자 0건이 감사로 확정돼 제거됐다.
 */
export function evaluateConsensusGate(
  environment: StationEnvironment,
  signals: ConsensusSignals,
  archFlag?: ArchFlagValue,
): ConsensusOutcome {
  // #2014 (ADR-022 B8) — archFlag=on 시 arvlCd 자체가 SSoT. 환경 분기 / GPS 합의 모두 우회한다.
  // arrival API 신호(=arvlCd) 를 유일한 진실로 삼는다는 B8 정책 정합.
  // caller(scheduled.ts) 가 실제 arvlCd 관측 + `pickAutoTrainCode` 로 별도 검증.
  if (archFlag === 'on') {
    return { pass: true, environment };
  }
  const baseGatePassed = signals.gateOutcome.pass;
  if (environment === 'surface') {
    return baseGatePassed
      ? { pass: true, environment }
      : { pass: false, environment, reason: 'base-gate-failed' };
  }
  if (environment === 'underground') {
    // GPS reject — base 9단 게이트는 motion/arrival/speed 등 비-GPS 신호도 포함하지만
    // origin proximity와 방향 cosine은 GPS 의존이라 underground 환경에서는 신뢰 못한다.
    // 대신 arrival(B) + lockAttachable(E surrogate)가 함께 만족하면 사용자가 실제 그 열차에
    // 타고 있다는 강한 cross-check가 된다.
    const strongBE = signals.arrivalSignalPresent && signals.lockAttachable;
    // #2329 (consensus-C) — consensusConfirmed는 lockAttachable(strong E) surrogate.
    // arrival(B) 없이도 confirmed 단독으로 통과시킨다 — 상태기계 자체가 이미 다중 waypoint
    // match(±90s)/mismatch=0 확정이라 arrival 신호 재요구는 이중 게이트(설계 SSoT (1)).
    const strongG = signals.consensusConfirmed === true;
    if (strongBE || strongG) return { pass: true, environment };
    return { pass: false, environment, reason: 'environment-no-gps-consensus' };
  }
  // mixed/unknown: 보수적 — base 9단 + arrival + lockAttachable 모두 통과 시에만.
  if (baseGatePassed && signals.arrivalSignalPresent && signals.lockAttachable) {
    return { pass: true, environment };
  }
  if (!baseGatePassed) {
    return { pass: false, environment, reason: 'base-gate-failed' };
  }
  return { pass: false, environment, reason: 'mixed-strong-signals-insufficient' };
}

/**
 * §5/§9 trip route + waypoints의 allowedLines union 계산.
 *
 * - DirectRoute: `{ route.line }`
 * - TransferRoute: `{ fromLine, toLine }`
 * - MultiTransferRoute: `transfers[].fromLine ∪ transfers[].toLine`
 * - waypoints[]: 각 waypoint.line도 union에 포함 (실제 lock 대상 leg 보장)
 *
 * route만 보면 구 client가 `route.type='direct, line=A'`를 보내면서 waypoints에는 B/C 라인이
 * 포함된 케이스(역사적 호환 데이터)를 잘못 차단한다. waypoints가 POST /trips validateTrip을
 * 통과한 시점에 이미 정합성 검증을 받았으므로 그 line set도 신뢰 대상.
 *
 * lock.line이 본 set 밖이면 §9에 따라 reject. 예: 분당선 variant(`bundang-053`)가
 * fusion 후보로 통과해도 lock 합성 시점에 line=bundang이면 trip route + waypoints 외라 차단된다.
 */
export function computeAllowedLines(
  route: Route,
  waypoints: readonly Waypoint[] = [],
): Set<LineNumber> {
  const set = new Set<LineNumber>();
  if (route.type === 'direct') {
    set.add(route.line);
  } else if (route.type === 'transfer') {
    set.add(route.fromLine);
    set.add(route.toLine);
  } else {
    // multi-transfer
    for (const seg of route.transfers) {
      set.add(seg.fromLine);
      set.add(seg.toLine);
    }
  }
  for (const wp of waypoints) {
    set.add(wp.line);
  }
  return set;
}

/**
 * §9 lock 채택 시 trainCode lock의 line이 trip route allowedLines에 포함되는지 검증.
 *
 * caller는 `attachTrainCodeForLeg` swap 결과에 본 검증을 적용해 외부 line(분당선 variant 등)
 * 잘못된 매핑을 차단한다. 미통과 시 lock 없는 것과 동일하게 처리:
 * boarding-prompt fallback 또는 silent skip.
 *
 * trip route가 정의되지 않은 케이스(이론상 발생 X)는 보수적으로 allow — 본 게이트는 trip route
 * 데이터가 있는 경우의 cross-line 매핑 회귀 차단이 목적이지, 데이터 부재 자체로 lock 발사를
 * 막진 않는다.
 */
export function isLockLineAllowed(
  lock: Pick<BoardingLockMeta, 'line'>,
  allowedLines: Set<LineNumber>,
): boolean {
  if (allowedLines.size === 0) return true;
  return allowedLines.has(lock.line);
}

/**
 * trip 기반 편의 wrapper. caller는 trip만 넘기면 allowedLines 산출 + 검증을 한 번에 수행한다.
 *
 * `computeAllowedLines(trip.route)` 결과를 매 호출 caching하지 않는다 — set 크기가 작고(1~5)
 * cron 사이클 hot path에서도 부담 없다.
 */
export function isLockLineAllowedForTrip(
  lock: Pick<BoardingLockMeta, 'line'>,
  trip: Pick<Trip, 'route' | 'waypoints'>,
): boolean {
  const allowed = computeAllowedLines(trip.route, trip.waypoints);
  return isLockLineAllowed(lock, allowed);
}
