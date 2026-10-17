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
 *
 * code-review(medium, #2801) — taxonomy drift 주의: 이 레포에는 {4,5} 집합을 쓰는 곳이 이미
 * 둘 더 있다 — `alarm.ts`의 `EARLY_CODES={PREV_ENTERING,PREV_ARRIVED}`(표시 phase='early' 판정)
 * 와 `scheduled.ts`의 `pickBestArrivalSignal`의 2순위 tier(위치/ETA 추정 신호). 둘 다 "4/5=이르지만
 * 유효한 신호"라는 같은 철학이라 {4,5}를 쓴다. 이 상수는 **발사 게이트**라는 다른 성격이고
 * {3,5}라는 다른 집합을 쓴다 — 4를 포함하면 위에서 설명한 9/30 조기 발사 리스크에 다시 노출되기
 * 때문이다. 세 taxonomy를 같은 집합으로 통일하려 하지 말 것(의미가 다르다) — 수정 시 이 상수와
 * 저 둘을 혼동하지 않도록 반드시 교차 확인한다.
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
 * #2880 — `selectedTrainCode=null`(후보 전원 방향 필터 탈락 / lock 열차 피드 소실 /
 * ambiguity로 `pickAutoTrainCode`가 null을 반환하는 모든 경로) 동안 `firedTrainCodes`
 * trainCode dedup(#2130 A4)이 `selectedTrainCode !== null` 전제라 전혀 작동하지 않아
 * fail-open되는 문제의 fallback 키.
 *
 * trainCode를 특정할 수 없을 때는 "같은 상황"을 `decideBoardingPromptFire`의 phase
 * 라벨(`decision`)로 근사한다 — leg/station은 이미 `firedTrainCodes`가 속한
 * `BoardingPromptState` 객체 자체가 leg/station 단위로 스코프돼 있으므로(leg 전환 시
 * `legBoardingPromptState`가 매번 새로 초기화됨) 추가 키가 불필요하다. 반환값은 실제
 * trainCode와 절대 충돌하지 않는 접두사(`'null-trainCode:'`, Seoul API trainCode는 항상
 * 숫자 문자열)를 쓴다 — `firedTrainCodes` 배열에 실제 trainCode와 이 fallback 키가
 * 섞여도 안전하게 구분된다.
 *
 * 동작: phase가 바뀌면(예: approaching → imminent) 새 fallback 키가 추가돼 재발사를
 * 허용한다 — "trainCode 불명이지만 상황이 달라졌다"를 그대로 인정(과차단 방지). phase가
 * 그대로면 같은 키가 이미 있어 차단(5분 repeat gate가 지나도 동일 phase 반복 재발사를
 * 막는 이 이슈의 본래 목적).
 */
export function boardingPromptDedupKey(
  selectedTrainCode: string | null,
  decision: BoardingFireDecision['decision'],
): string {
  return `${selectedTrainCode ?? 'null-trainCode'}:${decision}`;
}

/**
 * #2898 배포 경계 하위호환 — `firedTrainCodes`에 이 fix 이전 포맷(":" 없는 bare trainCode,
 * phase 정보 없음)인 항목이 섞여 있을 수 있다(배포 순간 in-flight였던 trip). 그런 trip이
 * 이 fix 이후 처음 평가될 때, 새 dedupKey(`${trainCode}:${decision}`)와 구형식 bare 키는
 * 문자열이 달라 `includes` 정확매치로는 "이미 쐈다"를 못 잡는다 — 구코드가 trainCode만
 * 보고(phase 무관) 차단했던 것과 달리 새 코드가 그 보호를 놓치면, 똑같은 phase를 다시
 * 관측했을 때(= 진행 없음, 진짜 중복) 최악의 경우 1회 더 발사할 수 있다.
 *
 * 그 위험을 없애기 위해, exact-duplicate 판정은 구형식 항목을 만나면 phase를 모르니
 * trainCode 일치만으로 보수적으로 "중복"으로 간주한다(과소차단보다 과차단이 안전 — 구코드와
 * 동일 엄격도). 이 fix 이후 기록되는 항목은 전부 신형식(":" 포함)이라, 정상 배포 완료 후에는
 * 이 분기가 더 이상 실질적으로 쓰이지 않는다(해당 trip이 만료/삭제되면 자연 소멸하는
 * 일시적 하위호환 경로).
 */
export function isExactDuplicateFire(
  firedTrainCodes: readonly string[] | undefined,
  selectedTrainCode: string | null,
  decision: BoardingFireDecision['decision'],
): boolean {
  const dedupKey = boardingPromptDedupKey(selectedTrainCode, decision);
  const token = resolveTrainCodeToken(selectedTrainCode);
  return (firedTrainCodes ?? []).some((key) =>
    key.includes(':') ? key === dedupKey : key === token,
  );
}

/**
 * #2898 (사용자 2회 지적 — 탑승 전엔 프롬프트가 뜨고 정작 실제 도착 시엔 아무것도 안 옴) — 같은
 * trainCode에 대해 phase(approaching/imminent 등)를 불문하고 허용하는 최대 발사 횟수.
 * approaching 1회 + 실제 도착(arrival) 재확인 1회까지만 — 그 열차에 대해 3번째 발사는 하지
 * 않는다(스펙 ③, 거부 케이스 ⓑ).
 */
export const MAX_FIRES_PER_TRAIN_CODE = 2;

/** `boardingPromptDedupKey`가 만든 `${trainCode}:${decision}` 키에서 trainCode 토큰만 추출. */
function trainCodeTokenOf(dedupKey: string): string {
  const idx = dedupKey.indexOf(':');
  return idx === -1 ? dedupKey : dedupKey.slice(0, idx);
}

/** selectedTrainCode의 dedup 토큰(실 trainCode 또는 'null-trainCode' fallback, #2880과 동일). */
function resolveTrainCodeToken(selectedTrainCode: string | null): string {
  return selectedTrainCode ?? 'null-trainCode';
}

/**
 * #2898 — `firedTrainCodes`(dedup 키 배열, 각 `${trainCode}:${decision}` 형식)에서 주어진
 * trainCode가 지금까지 몇 번 발사됐는지(phase 무관) 센다.
 */
export function trainCodeFireCount(
  firedTrainCodes: readonly string[] | undefined,
  selectedTrainCode: string | null,
): number {
  const token = resolveTrainCodeToken(selectedTrainCode);
  return (firedTrainCodes ?? []).filter((key) => trainCodeTokenOf(key) === token).length;
}

/** #2898 — 같은 trainCode에 대해 `MAX_FIRES_PER_TRAIN_CODE`(2) 미만이면 발사 가능. */
export function canFireForTrainCode(
  firedTrainCodes: readonly string[] | undefined,
  selectedTrainCode: string | null,
): boolean {
  return trainCodeFireCount(firedTrainCodes, selectedTrainCode) < MAX_FIRES_PER_TRAIN_CODE;
}

/**
 * #2898 — `evaluateBoardingPromptRepeatGate`의 'fired-too-recently'(5분 간격) 판정은 trainCode를
 * 모른다(leg/origin당 단일 `lastFiredAt` 타임스탬프). caller는 pool을 아직 모르는 시점에 이
 * 판정을 먼저 받으므로, 그 블록을 "소프트"로만 다루고 pool에서 실제 선택된 trainCode를 알게 된
 * 뒤(`shouldProceedToSend` 시점) 이 함수로 최종 판정한다. 다음 두 경우에만 bypass(발사 허용):
 *
 *   1. 지금 선택된 trainCode가 **마지막으로 발사된 열차와 같고**, 그 열차의 누적 발사가
 *      `MAX_FIRES_PER_TRAIN_CODE` 미만이면 → 같은 열차의 재확인(approaching→arrival, 스펙 ①).
 *   2. 지금 선택된 trainCode가 **마지막으로 발사된 열차와 다르고**, 그 마지막 열차가 이미
 *      `MAX_FIRES_PER_TRAIN_CODE`에 도달(소진)했으면 → 열차 교체로 새 cycle 시작(스펙 ④).
 *
 * 그 외(아직 소진되지 않은 다른 열차)는 여전히 5분 게이트로 차단한다 — 단배차(배차 간격 좁은
 * 역)에서 서로 다른 열차가 연달아 관측되며 반복 발사되는 것을 막는 기존 취지(#2130 Part B-be-2)
 * 는 그대로 유지한다(거부 케이스 ⓒ). 5분 게이트 자체를 제거하는 것이 아니라 (trainCode, phase)
 * 축으로 세분화할 뿐이다.
 */
export function canBypassRepeatIntervalForTrainTransition(
  firedTrainCodes: readonly string[] | undefined,
  selectedTrainCode: string | null,
): boolean {
  const list = firedTrainCodes ?? [];
  const lastKey = list.at(-1);
  if (lastKey === undefined) return false;
  const lastToken = trainCodeTokenOf(lastKey);
  const currentToken = resolveTrainCodeToken(selectedTrainCode);
  const lastTokenFireCount = list.filter((key) => trainCodeTokenOf(key) === lastToken).length;
  if (currentToken === lastToken) return lastTokenFireCount < MAX_FIRES_PER_TRAIN_CODE;
  return lastTokenFireCount >= MAX_FIRES_PER_TRAIN_CODE;
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
  // #2944 (H-6, plan 2026-10-10 J5) — 방향 일치. direction이 null이면 fail-closed(후보 0건).
  // 구 동작("양방향 허용")은 10/9 반대 방향 lock 사고(군자→광화문, 5호선)의 근본 fail-open
  // 지점이었다 — device #2696 정책("direction===null → 후보 없음, 양방향 병합 금지")을
  // backend 판정 지점에도 동일 적용한다. 방향을 모르면 어느 방향 열차도 lock 후보로 내지 않는다.
  const directional = direction
    ? matching.filter((a) => (direction === 'up' ? a.isUp : !a.isUp))
    : [];
  if (directional.length === 0) return null;

  // #2801 (3차 reopen, audit-sides 편측 확정 2026-10-03) — 3(전역출발)/5(전역도착)를 각자
  // 별도 tier로 추가. approaching 발사로 뜬 "탑승하셨나요?" 프롬프트에 사용자가 응답하면
  // candidateTrains(payload)에 3/5만 있는 pool이 이 함수를 거친다 — 추가 전에는 어느 tier에도
  // 안 걸려 "그 외" 분기(`directional[0]`, Seoul API 수신 순서 첫 후보)로 ambiguity 보호 없이
  // silent 선택돼 엉뚱한 열차가 lock될 수 있었다. 순서 근거: 2>1>0(기존, 회고형 — 진행도 높은
  // 열차가 탑승 열차일 확률 높음) > 3(전역출발, 도착 60~150s 전으로 5보다 근접) > 5(전역도착).
  // 99-only(운행중만) pool의 `directional[0]` fallback은 무변경(기존 동작, 이 fix의 scope 밖).
  const priority: readonly number[] = [
    /* 2: 출발 */ 2,
    /* 1: 도착 */ ARRIVAL_CODE.ARRIVED,
    /* 0: 진입 */ ARRIVAL_CODE.ENTERING,
    /* 3: 전역출발 */ ARRIVAL_CODE.PREV_DEPARTED,
    /* 5: 전역도착 */ ARRIVAL_CODE.PREV_ARRIVED,
  ];
  for (const code of priority) {
    const tier = directional.filter((a) => a.arvlCd === code);
    // ambiguity 임계: 같은 우선순위 후보가 2개 이상이면 자동 판단 불가 → null.
    // 단일 후보(tier.length === 1)만 자동 lock을 허용한다.
    if (tier.length === 1) return tier[0].trainCode || null;
    if (tier.length > 1) return null; // ambiguity → 자동 안 함
  }
  // 그 외(99 운행중 등) — 받은 순서 첫 후보.
  return directional[0].trainCode || null;
}
