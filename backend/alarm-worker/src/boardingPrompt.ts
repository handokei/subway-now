/**
 * "탑승했냐?" 푸시 (#819 B 슬라이스).
 *
 * #2844 (subsumption 증명 기반 은퇴, 2026-09-30) — 이 파일이 원래 구현하던 GPS 9단 AND 게이트
 * (accuracy/origin-distance/direction-cosine/window/fused-speed/motion + trip당 1회/5분 silence,
 * ADR Section 2)와 그 게이트를 평가하던 `evaluateBoardingPromptGates`는 유일한 caller였던
 * `scheduled.ts`의 `evaluateAndMaybeFireBoardingPrompt`와 함께 삭제됐다 — prod 고정 운용인
 * `archFlag='on'`에서 GPS 9단이 정당하게 발사하는 모든 상황을 GPS-free 공유 경로
 * (`maybeFireOriginBoardingPromptGpsFree`/`maybeFireLegBoardingPrompt`, scheduled.ts)가 이미
 * 포함(subsume)한다는 코드 대조 증명 기반. 유일한 차이(9단이 유해하게 더 넓었던 발사 창 —
 * `originProximityAt` 15분 freshness만 재검사, 5분 anchor renewal 없음)는 GPS-free 쪽이 이미
 * 더 엄격하게 막고 있었다. 아래 남은 함수들(근접/신선도 판정, 반복 발사 dedup, arvlCd 임박
 * 판정, hop-end 게이트, trainCode 선택)은 GPS-free/leg-2 공유 경로가 여전히 사용한다.
 *
 * arvlCd 우선순위(trainCode 선택, ADR Section 1.2):
 *   2 (출발) > 1 (도착) > 0 (진입) > 그 외 receivedAt 가까운 + 방향 매칭
 *   ambiguity → 자동 안 함 → 클라가 manual fallback.
 */

import { ARRIVAL_CODE } from './alarm';
import { matchLine } from './lineAlias';
import { evaluateWindow, type WindowedMetrics } from './positionSeries';
import type { ArrivalEntry } from './seoul';
import type { BoardingPromptState } from './types';

// #2844 — 구 게이트 #4(ORIGIN_RADIUS_KM)/#5(DIRECTION_COSINE_THRESHOLD)/#6(MIN_WINDOW_SAMPLES)/
// #7(MIN_FUSED_SPEED_KMH)는 은퇴한 `evaluateBoardingPromptGates`(GPS 9단) 전용 상수였다 —
// 함께 삭제. `DISMISS_SILENCE_MS`(구 게이트 #9)는 `markPromptSilenced`/`evaluateSilenceGate`가
// 계속 쓴다(hop-end 게이트 + 발사 후 dismiss silence 전반).
/** dismiss 후 silence 길이. */
export const DISMISS_SILENCE_MS = 5 * 60 * 1000;
/**
 * #2130 (Part B-be-1) — 근접 게이트 임계(m). `originDistanceM - originAccuracyM`가 이 값을
 * 넘으면 차단(오차 고려 보수적 차단). 역사 반경 실측 100~180m 근거로 150m 채택(플랜 §2 D2).
 */
export const PROMPT_PROXIMITY_MARGIN_M = 150;
/**
 * #2153 — 근접 게이트 판정을 순수 함수로 분리(cron `evaluateAndMaybeFireBoardingPrompt`와
 * `/position` 핸들러 양쪽이 재사용). distance/accuracy 둘 다 있고 오차 고려 후 margin 이내면
 * "근접"으로 본다 — 부재(지하/구 클라)는 "근접 관측"이 아니므로 false(anchor stamp 대상 아님).
 */
export function isNearOrigin(
  originDistanceM: number | undefined,
  originAccuracyM: number | undefined,
): boolean {
  if (originDistanceM === undefined || originAccuracyM === undefined) return false;
  return originDistanceM - originAccuracyM <= PROMPT_PROXIMITY_MARGIN_M;
}
/**
 * #2653 (코드리뷰 MEDIUM-2) — GPS-free origin 거리 가드 전용 교차검증 순수 함수.
 *
 * register 시점 정적 스냅샷(`trip.promptGeoContext.originDistanceM/originAccuracyM`)은
 * 타임스탬프가 없어 스냅샷 자체만으로는 신선도를 판단할 수 없다. device의 `buildOriginGpsStamp`
 * (`haversine(마지막 GPS fix, 현재 fused 역)`)는 GPS가 지하에서 끊기면 fix는 "마지막 지상 좌표"에
 * 고정되는 반면 fused 역은 lockless 추론으로 계속 전진한다 — 그 순간엔 정확했던(작은 accuracy)
 * fix가 이제는 먼 거리로 오판정되는 스냅샷을 만든다.
 *
 * `/position` 채널이 독립적으로 쌓는 `positionSeries`의 최신 sample을 교차검증 입력으로 쓴다 —
 * 그 sample이 지금(`now`) 기준 `freshnessMs` 이내이고 accuracy가 `accuracyCutoffM` 미만이면
 * "GPS가 지금 살아있다"고 보고 정적 스냅샷을 신뢰한다. 그렇지 않으면(series 비어있음/stale/
 * 저정확도) 신뢰하지 않는다 — caller는 이 경우 스냅샷을 "부재"와 동일하게 취급해 관대 허용해야
 * 한다(#2532 취지 재적용, #2531/#2532가 없애려던 지하 영구 침묵의 재발 방지).
 */
export function hasFreshOriginProximityCorroboration(
  newestSeriesPoint: { ts: number; accuracy: number } | undefined,
  now: number,
  freshnessMs: number,
  accuracyCutoffM: number,
): boolean {
  if (newestSeriesPoint === undefined) return false;
  if (now - newestSeriesPoint.ts > freshnessMs) return false;
  return newestSeriesPoint.accuracy < accuracyCutoffM;
}
// #2844 — `PROMPT_FRESHNESS_MS`(구 #2130 Part B-be-1, 15분 신선도 게이트)는 은퇴한 GPS 9단
// 경로(`evaluateAndMaybeFireBoardingPrompt`) 전용이었다 — 함께 삭제. GPS-free 경로는 15분
// freshness 재검사가 없다(#2653 설계 — anchor 5분 renewal만으로 유해 발사 창을 막는다).
/**
 * #2358 — 근접 관측(anchor, `trip.originProximityAt`) 갱신 주기. anchor를 이 주기(5분)마다
 * 재stamp해 GPS-free 거리 가드(#2653)의 anchor freshness 판정 입력이 된다 — 매 cycle(cron 1분
 * / `/position` 10초) 무조건 쓰지 않고 스로틀링해 KV write를 최소화한다(#2073 lesson: CF free
 * tier quota).
 */
export const ORIGIN_PROXIMITY_RENEWAL_MS = 5 * 60 * 1000;
/**
 * #2358 — `trip.originProximityAt`를 지금 다시 stamp해야 하는지 판정하는 순수 함수.
 * cron(`evaluateAndMaybeFireBoardingPrompt`)과 `/position`(`stampOriginProximityIfNeeded`)
 * 양쪽이 공유 — 최초 관측(undefined) 또는 마지막 stamp로부터 `ORIGIN_PROXIMITY_RENEWAL_MS` 이상
 * 지났으면 true.
 */
export function shouldStampOriginProximity(
  originProximityAt: number | undefined,
  now: number,
): boolean {
  return (
    originProximityAt === undefined || now - originProximityAt >= ORIGIN_PROXIMITY_RENEWAL_MS
  );
}
/**
 * #2130 (Part B-be-2, 2026-08-04 사용자 결정) — 반복 발사(A4) 최소 발사 간격.
 * 직전 발사로부터 이 시간 미만이면 새 열차(arvlCd=1)가 도착해도 재발사하지 않는다
 * (배차 2~3분 역에서 연발 방지). `DISMISS_SILENCE_MS`와 값은 같지만 의미가 달라 별도 상수로 분리.
 */
export const MIN_FIRE_INTERVAL_MS = 5 * 60 * 1000;
/**
 * #2130 (Part B-be-2, 2026-08-04 사용자 결정) — trip당 boarding-prompt 최대 발사 횟수 hard cap.
 * "15분 창 ÷ 5분 간격 = 실효 최대 3회"와 정합 — `promptState.fireCount`가 이 값에 도달하면
 * 신선도 게이트(15분) 만료 전이라도 즉시 skip한다.
 */
export const MAX_FIRE_COUNT = 3;

/**
 * #2801 (REOPENED 2026-09-30 정정 스펙 §1/§2) — boarding-prompt 임박 게이트.
 *
 * 9/30 실측 트립(e25e1158) D1 RCA: `fireBoardingPromptForAnchor`의 유일 발사 게이트가
 * `candidateTrains.length === 0`뿐이라 "노선/방향만 필터한 아무 열차"(전역출발/운행중 포함)만
 * 있어도 발사됐다 — 열차가 아직 도착하지 않은 조기 발사(leg-2 06:42/06:44, 열차는 06:46 도착).
 *
 * 임박 정의(0 진입/1 도착/2 출발): 0/1은 승강장 진입/도착. 2(출발)를 포함하는 이유는 cron
 * 60s 폴링 주기가 도착 창(~30s)보다 길어 진입→도착→출발이 한 폴링 갭에 지나갈 수 있고,
 * `pickAutoTrainCode`의 lock-pick 우선순위(2>1>0, 회고형 — 푸시 도착·탭 시점엔 열차가 이미
 * 출발해 있는 게 정상)와 발사 게이트의 의미를 정합시키기 위함이다.
 */
export const IMMINENT_BOARDING_ARVLCD: ReadonlySet<number> = new Set([
  ARRIVAL_CODE.ENTERING, // 0
  ARRIVAL_CODE.ARRIVED, // 1
  ARRIVAL_CODE.DEPARTED, // 2
]);

/**
 * #2801 (3차 reopen, 2026-10-03 실측) — approaching 게이트. 임박{0,1,2}이 cron 60s 폴링에
 * 걸리지 않은 채(도착창 ~30s가 폴링 갭보다 짧아) leg-2 "탑승하셨나요?" 시도 9회가 전부
 * suppressed-not-imminent로 억제된 10/2 실측 miss를 봉합한다. 사용자 열차의 최근접 관측은
 * 5(전역도착)/3(전역출발) — 직전역 신호(도착 60~150s 전), 플랫폼 대기 사용자에게 "곧 도착"
 * 프롬프트로 적절한 창이다.
 *
 * 4(전역진입, ≈2~3분 전)는 **의도적으로 제외** — 9/30 조기 발사 불만(4분 전 발사) 창에
 * 근접하고 10/2 실측에도 미관측. 필요 시 측정 후 별도 이슈로 확장.
 */
export const APPROACHING_BOARDING_ARVLCD: ReadonlySet<number> = new Set([
  ARRIVAL_CODE.PREV_DEPARTED, // 3
  ARRIVAL_CODE.PREV_ARRIVED, // 5
]);

export type BoardingFireDecision =
  | { fire: true; decision: 'imminent' }
  | { fire: true; decision: 'approaching' }
  | { fire: true; decision: 'fallback-unobservable' }
  | { fire: false; decision: 'suppressed-not-imminent' };

/**
 * OR-fallback 판정 — **arvlCd 하드 필터가 아니다** (caller가 candidateTrains payload에 이
 * 함수의 pool을 그대로 쓴다는 전제로 설계됨, 이슈 §4 금지사항).
 *
 * 1. 임박(§ IMMINENT_BOARDING_ARVLCD) 열차가 하나라도 있으면 발사.
 * 2. 임박이 없어도 approaching(§ APPROACHING_BOARDING_ARVLCD) 열차가 하나라도 있으면 발사
 *    (#2801 3차 reopen) — 관측된 결정적 신호이므로 null-fallback(3)보다 우선 판정한다.
 * 3. 임박/approaching이 둘 다 없어도, 관측 불가(arvlCd===null) 후보가 하나라도 있으면
 *    "임박이 아니다"를 확정할 수 없으므로 발사(fallback) — 지하/API 부재에서 기존 동작(발사)을
 *    보존해 miss 재발을 막는다(equal-protection).
 * 4. 모든 후보가 관측됐는데(non-null) 임박/approaching이 하나도 없을 때만 억제.
 */
export function decideBoardingPromptFire(
  pool: readonly { arvlCd: number | null }[],
): BoardingFireDecision {
  const imminent = pool.filter(
    (a) => a.arvlCd !== null && IMMINENT_BOARDING_ARVLCD.has(a.arvlCd),
  );
  if (imminent.length > 0) return { fire: true, decision: 'imminent' };
  const approaching = pool.filter(
    (a) => a.arvlCd !== null && APPROACHING_BOARDING_ARVLCD.has(a.arvlCd),
  );
  if (approaching.length > 0) return { fire: true, decision: 'approaching' };
  if (pool.some((a) => a.arvlCd === null)) {
    return { fire: true, decision: 'fallback-unobservable' };
  }
  return { fire: false, decision: 'suppressed-not-imminent' };
}

export type GateOutcome =
  | { pass: true; metrics: WindowedMetrics; fusedSpeedKmh: number }
  | { pass: false; reason: GateSkipReason; metrics?: WindowedMetrics };

// #2844 — 'no-series'/'window-too-small'/'no-candidates'/'accuracy-too-poor'/'origin-too-far'/
// 'direction-mismatch'/'speed-too-low'/'motion-not-moving'/'motion-stationary'는 은퇴한
// `evaluateBoardingPromptGates`(GPS 9단) 전용 reason이었다 — 함께 제거. 남은 4개는
// `evaluateSilenceGate`(hop-end)/`evaluateBoardingPromptRepeatGate`(boarding-prompt)가 계속 쓴다.
export type GateSkipReason =
  | 'silenced'
  | 'already-fired'
  | 'fired-too-recently'
  | 'max-fires-reached';

/**
 * 게이트 #9 — silence / 1회 발사 dedup. promptState 부재 = 첫 시도, 통과 (null 반환).
 *
 * hop-end 전용(`evaluateHopEndPromptGates`)이 사용한다 — leg당 1회 정책은 불변.
 * boarding-prompt는 #2130 Part B-be-2부터 `evaluateBoardingPromptRepeatGate`를 대신 사용한다
 * (아래) — "trip당 1회(fired 영구 차단)" 정책 폐기.
 */
function evaluateSilenceGate(
  promptState: BoardingPromptState | undefined,
  now: number,
): GateOutcome | null {
  if (!promptState) return null;
  if (promptState.fired) {
    return { pass: false, reason: 'already-fired' };
  }
  if (
    promptState.silencedUntil !== undefined &&
    promptState.silencedUntil > now
  ) {
    return { pass: false, reason: 'silenced' };
  }
  return null;
}

/**
 * 게이트 #9 (boarding-prompt 전용, #2130 Part B-be-2, 2026-08-04 사용자 결정) — 반복 발사 정책.
 *
 * "trip당 1회(`fired` 영구 차단)" 정책 폐기 — 15분 창 내 arvlCd=1 열차 도착마다 재발사를
 * 허용하되 다음 정지 조건으로 스팸을 막는다:
 *   ① 응답 — caller(scheduled.ts)의 F2 defense(`trip.boardingLock !== undefined`)가 별도 차단.
 *   ② dismiss 후 silence — `silencedUntil` (기존 `DISMISS_SILENCE_MS` 유지).
 *   [신규] 최대 발사 횟수 hard cap(3회) — `promptState.fireCount`.
 *   ③ 최소 발사 간격(5분) — `promptState.lastFiredAt`.
 * `fired` 필드 자체는 더 이상 검사하지 않는다 — 관측 전용 플래그로만 유지된다(d1TripMetrics 등).
 *
 * hop-end는 여전히 `evaluateSilenceGate`(1회 정책)를 사용 — 이 함수는 boarding-prompt 전용.
 *
 * #2531 — export. GPS-free 경로(`maybeFireOriginBoardingPromptGpsFree`/`maybeFireLegBoardingPrompt`,
 * scheduled.ts)가 동일 `trip.boardingPromptState`/`trip.legBoardingPromptState` ledger로 이
 * 게이트를 직접 호출한다.
 */
export function evaluateBoardingPromptRepeatGate(
  promptState: BoardingPromptState | undefined,
  now: number,
): GateOutcome | null {
  if (!promptState) return null;
  if (
    promptState.silencedUntil !== undefined &&
    promptState.silencedUntil > now
  ) {
    return { pass: false, reason: 'silenced' };
  }
  if ((promptState.fireCount ?? 0) >= MAX_FIRE_COUNT) {
    return { pass: false, reason: 'max-fires-reached' };
  }
  if (
    promptState.lastFiredAt !== undefined &&
    now - promptState.lastFiredAt < MIN_FIRE_INTERVAL_MS
  ) {
    return { pass: false, reason: 'fired-too-recently' };
  }
  return null;
}

/**
 * trip의 boarding-prompt state를 발사 시점 또는 dismiss 시점에 갱신해 반환.
 * caller는 결과를 trip에 set 후 KV 저장.
 *
 * #2130 (Part B-be-2) — `prev` + `trainCode`를 전달하면 반복 발사(A4) 상태를 누적한다:
 *   - `firedTrainCodes`: trainCode가 주어지면 prev 배열에 append (같은 trainCode 재추가는
 *     caller가 사전에 dedup 체크로 걸러내므로 여기서는 단순 append).
 *   - `fireCount`: 매 호출마다 +1 (최대 발사 횟수 hard cap 게이트의 입력).
 * hop-end 호출부(`maybeFireHopEndPrompt`)는 `prev`/`trainCode` 없이 `markPromptFired(now)`만
 * 호출한다 — 이 경우 `firedTrainCodes`는 생략되고 `fireCount`는 1로 시작(hop-end는 leg당 1회라
 * 게이트에서 참조되지 않음, 값 존재 자체는 무해).
 */
export function markPromptFired(
  now: number,
  prev?: BoardingPromptState,
  trainCode?: string | null,
): BoardingPromptState {
  const firedTrainCodes =
    trainCode != null ? [...(prev?.firedTrainCodes ?? []), trainCode] : prev?.firedTrainCodes;
  return {
    fired: true,
    lastFiredAt: now,
    fireCount: (prev?.fireCount ?? 0) + 1,
    ...(firedTrainCodes !== undefined ? { firedTrainCodes } : {}),
  };
}

export function markPromptSilenced(
  prev: BoardingPromptState | undefined,
  now: number,
): BoardingPromptState {
  return {
    ...prev,
    silencedUntil: now + DISMISS_SILENCE_MS,
  };
}

/**
 * #2034 — hop-end (환승역 "하차했나요?") 프롬프트 게이트.
 *
 * 발사 조건은 boarding-prompt 대비 훨씬 단순하다 — transfer waypoint advance = "환승역 도착 판정"
 * 은 이미 caller (scheduled.ts) 의 boarding-lock waypoint advance 게이트가 통과된 상태이므로
 * ground truth 로 다뤄지고, GPS/motion/speed 는 재검증하지 않는다. false-positive 방어는:
 *   - fired dedup (같은 leg 는 1회만 발사)
 *   - silencedUntil (사용자 [아직] 응답 시 5 분 재발사 차단)
 *
 * caller 는 leg-key (예: `${originStation}|${nextLine}`) 로 `trip.hopEndPromptState[key]` 를 조회해
 * 이 함수에 전달한다.
 */
export function evaluateHopEndPromptGates(inputs: {
  promptState?: BoardingPromptState;
  now: number;
}): GateOutcome {
  const silenceOutcome = evaluateSilenceGate(inputs.promptState, inputs.now);
  if (silenceOutcome) return silenceOutcome;
  // GPS/motion 게이트 없이 통과. fusedSpeed 는 caller 가 사용하지 않는 필드지만 GateOutcome
  // 계약 준수를 위해 0 을 반환 (evaluateBoardingPromptGates bypass 분기와 동일 정책).
  return { pass: true, metrics: evaluateWindow([], inputs.now), fusedSpeedKmh: 0 };
}

/**
 * arvlCd 우선순위로 trainCode 자동 선택 (ADR Section 1.2).
 *
 * 같은 line + 진행 방향 매칭하는 후보 중:
 *   1순위: arvlCd=2 (출발) — 사용자가 방금 그 차 타고 출발
 *   2순위: arvlCd=1 (도착) — 막 탑승
 *   3순위: arvlCd=0 (진입) — 다음 차 대기
 *   4순위: 그 외 → 받은 순서 그대로 (Seoul API receivedAt 정렬)
 *
 * 같은 우선순위 후보가 여러 개면 (ambiguity) → null 반환. caller가 manual fallback.
 *
 * `line`은 boarding line (사용자 trip 출발 라인). lineAlias.matchLine으로 별칭(예: "1호선"
 * vs "지하철1호선") 매칭.
 */
export function pickAutoTrainCode(
  arrivals: readonly ArrivalEntry[],
  line: string,
  direction: 'up' | 'down' | null,
): string | null {
  const matching = arrivals.filter((a) => matchLine(a.subwayNm, line));
  if (matching.length === 0) return null;
  // 방향 일치 — direction이 null이면 양방향 허용.
  const directional = direction
    ? matching.filter((a) => (direction === 'up' ? a.isUp : !a.isUp))
    : matching;
  if (directional.length === 0) return null;

  const priority: readonly number[] = [
    /* 2: 출발 */ 2,
    /* 1: 도착 */ ARRIVAL_CODE.ARRIVED,
    /* 0: 진입 */ ARRIVAL_CODE.ENTERING,
  ];
  for (const code of priority) {
    const tier = directional.filter((a) => a.arvlCd === code);
    // ambiguity 임계: 같은 우선순위 후보가 2개 이상이면 자동 판단 불가 → null.
    // 단일 후보(tier.length === 1)만 자동 lock을 허용한다.
    if (tier.length === 1) return tier[0].trainCode || null;
    if (tier.length > 1) return null; // ambiguity → 자동 안 함
  }
  // 그 외 — 받은 순서 첫 후보.
  return directional[0].trainCode || null;
}
