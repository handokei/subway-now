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
 *       따라서 underground에서는 strong B(arrival arvlCd 1~3) + strong C(position-train 일치)
 *       또는 strong D(WiFi) 의 2-of-2 합의가 필요. 본 백엔드는 현재 cycle에서 position-train과
 *       WiFi SSID를 갖지 않으므로(추후 E7 이후 wire), underground 분기는 arrival 단독으로 통과를
 *       허용하지 않고 reject — boarding-prompt fallback은 게이트 미통과로 자연 silent.
 *     - `environment=mixed`: 보수적. strong 2개(arrival + arvlCd 우선순위 확정 + 단일 trainCode)
 *       충족 시에만 통과 — `pickAutoTrainCode`가 단일 후보로 수렴(ambiguity 없음)한 시점이 곧
 *       arrival(strong B) + lock-line(strong E surrogate) 합의로 해석된다.
 *
 * §4 합의 안 됨 = fire X:
 *   `evaluateConsensusGate`가 false면 caller는 lock 부착 / push 발사 모두 skip. UI 추적
 *   채널(promptDisplay)은 동작 보존 — 본 모듈은 fire 결정에만 관여한다.
 *
 * §7 토글 input X:
 *   본 게이트는 `trip.locklessStationPassed`(C 토글) / `trip.boardingPromptState.fired`
 *   (사용자 응답) 등 **사용자 명시 의향 필드를 input으로 받지 않는다**. 시그너처가 `environment`
 *   + `signals` 만 받는 사실이 §7의 정적 보증. 토글 UI 라벨은 frontend 책임.
 *
 * §9 trainCode lock 정확성 게이트:
 *   `assertLockLineAllowed(lock, allowedLines)`로 별도 검증. caller(`attemptAutoLock` /
 *   `attachTrainCodeForLeg`)가 lock 합성 직후 본 검증을 통과시키지 못하면 null 반환.
 *   `computeAllowedLines(trip)`는 trip route의 모든 leg line을 union으로 산출한다.
 *
 * memory `feedback_user_intent_equal_protection.md` (사용자 의향 trip 동급 보장) 호환:
 *   본 게이트는 모든 trip에 동일 적용 — 토글 ON/OFF, lock 활성/비활성 trip 모두 같은 정확성
 *   기준을 통과해야 fire. 토글 ON trip이라고 정확성 게이트를 우회하지 않으며, lock 비활성
 *   trip도 fire 권한이 자동 박탈되지 않는다.
 */

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
 *
 * 추후 wire 대상(현 cycle 미지원, undefined로 무시):
 * - `positionTrainAgreement`: device fusion이 산출한 position-train 일치 (strong C)
 * - `wifiSsidMatch`: 역 WiFi SSID 일치 (strong D)
 * - `cellularEnvironmentVote`: device CTRadioAccessTechnology 기반 환경 vote (S10 #1543)
 *     - 'surface'      : 4G/5G 잡힘 → 지상 환경 vote (strong F)
 *     - 'underground'  : 2G/3G fallback → 지하 환경 vote (strong F)
 *     - 'unknown'/미전송 : vote 미투표 (정책 영향 0)
 */
export interface ConsensusSignals {
  gateOutcome: GateOutcome;
  arrivalSignalPresent: boolean;
  lockAttachable: boolean;
  positionTrainAgreement?: boolean;
  wifiSsidMatch?: boolean;
  cellularEnvironmentVote?: 'surface' | 'underground' | 'unknown';
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
        | 'mixed-strong-signals-insufficient'
        | 'cellular-environment-contradicts';
    };

/**
 * §3 분기별 fire 게이트 평가.
 *
 * - surface: base 9단 게이트 통과로 충분 (GPS+arrival+motion 합의)
 * - underground: GPS reject. arrival(B) + lockAttachable(E surrogate) 2-of-2 또는
 *   positionTrainAgreement(C) / wifiSsidMatch(D)가 arrival과 함께. 현 cycle에서 후자는 미wire라
 *   B+E 2-of-2 강제.
 * - mixed/unknown: 보수적. arrival + lockAttachable 동시 충족 강제. base 9단 게이트 통과도
 *   동시에 요구해 false positive 누적 차단.
 */
/**
 * S10 #1543 — cellular vote가 trip 환경과 정면 충돌하는지 판정.
 *
 * 충돌 케이스(둘 다 명시적 surface ↔ underground일 때만 contradict):
 *   - environment=surface + cellularEnvironmentVote=underground
 *   - environment=underground + cellularEnvironmentVote=surface
 *
 * 비충돌 케이스 (모두 false):
 *   - vote가 'unknown' / undefined (미투표) — 모르는 상태는 차단 안 함
 *   - environment=mixed/unknown — 환경 자체가 보수적이라 vote로 추가 거절 X
 *   - vote가 environment와 일치 — 정상
 *
 * 정책: 본 함수는 contradict만 식별. 일치 vote가 OR 통과를 추가로 열어주진 않는다
 * (false positive 차단 우선 — surface GPS jitter가 cellular 4G와 동시에 거짓 합의를 만들면
 *  지상 false positive로 새는 회귀를 막기 위함).
 */
function cellularContradictsEnvironment(
  environment: StationEnvironment,
  vote: ConsensusSignals['cellularEnvironmentVote'],
): boolean {
  if (vote === undefined || vote === 'unknown') return false;
  if (environment === 'surface' && vote === 'underground') return true;
  if (environment === 'underground' && vote === 'surface') return true;
  return false;
}

export function evaluateConsensusGate(
  environment: StationEnvironment,
  signals: ConsensusSignals,
): ConsensusOutcome {
  // S10 #1543 — cellular vote가 환경과 정면 충돌하면 즉시 reject.
  // 본 게이트는 base 통과/미통과와 무관하게 적용 — 환경 자체가 신뢰 불가하다는 강한 신호.
  if (cellularContradictsEnvironment(environment, signals.cellularEnvironmentVote)) {
    return { pass: false, environment, reason: 'cellular-environment-contradicts' };
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
    // 타고 있다는 강한 cross-check가 된다. 추후 C/D wire 시 OR 분기 확장.
    const strongBE = signals.arrivalSignalPresent && signals.lockAttachable;
    const strongCB = (signals.positionTrainAgreement ?? false) && signals.arrivalSignalPresent;
    const strongDB = (signals.wifiSsidMatch ?? false) && signals.arrivalSignalPresent;
    if (strongBE || strongCB || strongDB) return { pass: true, environment };
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
 * caller는 `attemptAutoLock` 결과(또는 `attachTrainCodeForLeg` swap 결과)에 본 검증을 적용해
 * 외부 line(분당선 variant 등) 잘못된 매핑을 차단한다. 미통과 시 lock 없는 것과 동일하게 처리:
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
