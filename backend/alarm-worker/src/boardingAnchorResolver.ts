/**
 * Backend-authority boarding trainCode resolver (committed architecture, 2026-09-03 결정).
 *
 * 배경
 * ====
 * 사용자가 "탑승했어요"를 탭해도(#819 boarding-prompt 응답 또는 배너 탭, 또는 BoardingTrainList
 * 직접 탭 / C 토글) device는 `promptDisplay`(originStation + line) + `infoModeEnabled=true`
 * (ADR-014 사용자 명시 의향 stamp)만 backend로 forward한다 — trainCode는 device가 로컬에서
 * arrivals API로 자체 resolve를 시도하지만(`useBoardingPromptResponder.tryAutoLock`), 실패하면
 * `PENDING-TRAIN-CODE` sentinel lock을 로컬에만 만들고 `buildBoardingLockMeta.ts`가
 * `isPendingTrainCode` sentinel을 만나면 `boardingLock` 필드 자체를 생략한다(#2407) — backend는
 * 이 trainCode를 절대 받지 않는다. 즉 이 시점의 trip은 backend 관점에서 완전히 lockless다.
 *
 * lockless trip은 `isBoardingLockActive`가 false라 `runTrainCodeTracking`(매역 arvlCd push의
 * 유일한 경로)에 절대 도달하지 못한다 — trainCode 단위 추적이 시작되지 않으면 매역 push가
 * 0건인 채로 trip이 표류한다.
 *
 * 본 모듈은 이 gap을 메운다: `promptDisplay` + `infoModeEnabled=true`(명시 탑승 anchor)가
 * 있는 lockless trip에서 realtimePosition(Seoul API)을 조회해 "지금 이 역에 서 있는 열차"를
 * 확정하고, 정확히 1개만 매칭되면(ambiguity 없음) `BoardingLockMeta`를 합성해 caller
 * (`scheduled.ts`)가 `trip.boardingLock`으로 승격시킬 수 있게 한다. 승격되면 다음 cron
 * cycle부터 `isBoardingLockActive` → `runTrainCodeTracking` 정상 경로로 진입한다.
 *
 * #1729 auto-lock 폐기와의 차이 — 안전 근거
 * ==========================================
 * #1729는 "사용자가 확인하지 않은 trainCode에 backend가 자동으로 lock 부착"을 금지했다.
 * 본 모듈은 다르다:
 *   1. 트리거 자체가 `infoModeEnabled===true`(ADR-014 "사용자 명시 의향" stamp)가 있어야만
 *      평가된다 — lockless라고 아무 trip이나 대상이 아니다. `infoModeEnabled`는 이 코드베이스
 *      전역에서 이미 boarding-prompt 응답 / BoardingTrainList 직접 탭 / C 토글(네비게이션 시작)
 *      3개 경로를 **동급**으로 취급한다(ADR-014 "사용자 명시 의향 trip = lock 활성과 동급
 *      정확도 보장 의무", `runLocklessIntermediate`/`tryFireConsensusTrainLeg`와 동일 게이트) —
 *      본 모듈만 더 좁게 "진짜 탑승 탭"만 골라내는 별도 신호는 두지 않았다(그런 필드가 아직 없다).
 *   2. 정확히 1개의 unambiguous 후보가 나올 때만 승격한다 — 0개(none) 또는 2개+(ambiguous)는
 *      승격하지 않고 다음 cycle 재시도 또는 device BoardingTrainList fallback에 맡긴다
 *      (틀린 열차를 추측해 lock 잠그는 것은 절대 금지 — 이 기능이 막아야 하는 바로 그 위험).
 *
 * 잔존 위험 (PR 리뷰 요청) — "역에 서 있는 열차"가 "사용자가 탄 열차"라는 보장은 없음
 * ============================================================================
 * C 토글만 켠 채 아직 플랫폼에 도착하지 않은 사용자가 있다면, 마침 그 역에 정차/진입 중인
 * 열차 1대와 우연히 매칭되어 lock이 승격될 수 있다 — realtimePosition만으로는 "이 열차가 그
 * 역에 있다"는 사실만 확인되지, "사용자가 물리적으로 그 열차 안에 있다"는 것까지 확인하지
 * 못한다(GPS boarding 근접 게이트 없음). 이 위험은 새로 생긴 것이 아니라 이미
 * `runLocklessIntermediate`/`tryFireConsensusTrainLeg`가 같은 `infoModeEnabled` 게이트만으로
 * 매역 push를 발사하는 것과 동일한 신뢰 수준이다 — 본 PR이 그 수준을 낮추지는 않지만 새로
 * 높이지도 않는다는 점을 리뷰어가 판단할 수 있도록 명시한다.
 *
 * 판정 규칙 (resolveTrainCodeFromPositions)
 * =========================================
 * realtimePosition(anchor.line) snapshot에서:
 *   1. `isUp` 이 anchor.direction과 일치 (direction=null이면 양방향 허용)
 *   2. `stationName` 이 anchor.boardingStation과 정확히 일치
 *   3. `recptnMs` 신선(POSITION_FRESHNESS_MS 이내) — 0(누락)은 신뢰 불가로 제외
 *   4. `trainSttus` ∈ {ARRIVED(1), APPROACHING(0)} — DEPARTED(2)는 제외(이미 그 역을 떠난
 *      열차는 사용자가 방금 탑승한 대상일 수 없다는 실측 신뢰도 기준, 사전 검증 완료)
 * 우선순위 ARRIVED > APPROACHING 타이 안에서 정확히 1개만 남으면 resolved, 2개+ 는 ambiguous,
 * 0개는 none.
 *
 * 이 우선순위(ARRIVED가 최우선)는 `pickAutoTrainCode`(arrivals API, DEPARTED=2가 최우선)와
 * 의도적으로 다르다 — arrivals API는 "곧 도착 예측"이 목적이라 "방금 출발"이 가장 강한 신호지만,
 * realtimePosition 기반 탑승 확정은 "지금 이 역에 있는 열차"가 목적이라 이미 DEPARTED한 열차는
 * 애초에 후보에서 배제한다. 같은 `pickAutoTrainCode`를 재사용하면 정반대 우선순위가 뒤섞여
 * 잘못된 열차를 고를 위험이 있어 별도 함수로 분리했다 (재사용 대신 의도적 비-중복).
 *
 * express 타이브레이크 (design decision — PR 리뷰 요청)
 * ======================================================
 * 원 설계 노트는 "express contention 시 directAt으로 tie-break" 를 언급했으나, 급행/일반 열차
 * 중 어느 쪽을 우선해야 하는지 뒷받침할 신뢰 가능한 근거(실측 evidence)가 없다. 틀린 열차를
 * lock하는 것이 이 기능이 막아야 할 핵심 위험이므로, 이 PR은 trainType 기반 임의 tie-break를
 * 구현하지 않는다 — ARRIVED/APPROACHING 타이 안에서 2개+ 남으면 그대로 ambiguous 로 판정한다.
 * 향후 evidence가 쌓이면 별도 PR로 추가.
 *
 * leg 2(환승 후) 확장 — 도보시간 게이트 (#2515, #2511 supersede)
 * ================================================================
 * #2511(`feat/#2508-transfer-leg-resolver`)이 `Trip.currentLegAnchor`로 이 리졸버를 leg 2까지
 * 확장했으나, 트리거가 환승 waypoint 통과 직후부터 매 cron tick 즉시 평가되어 "사용자가 아직
 * 도보 이동 중인데 환승역 플랫폼에 서 있는 열차 1대와 우연히 매칭 → 오탑승 lock" 위험이 있었다
 * (PR 본문이 loud flag로 명시한 leg 2 고유 위험 — origin보다 도보 이동 창이 길다).
 *
 * 본 PR은 `currentLegAnchor` 자체(leg 2 anchor 개념)는 그대로 재사용하되, `resolveActiveLegOrigin`이
 * `trip.legBoardingEligibleAt`(=환승 통과 시각 + `getTransferSeconds(...)` 도보 시간,
 * `scheduled.ts` transfer advance 블록이 stamp) 게이트를 통과했을 때만 leg 2 anchor를 반환한다.
 * 게이트 미통과(`now < legBoardingEligibleAt`)면 null — caller(`attemptBoardingAnchorResolution`)가
 * anchor 자체를 못 얻으므로 realtimePosition 조회조차 하지 않는다. 즉 도보 창 동안 있었던 열차는
 * "탈락시키는" 필터가 아니라 애초에 "쳐다보지 않는" 시간 게이트로 배제된다.
 *
 * leg 2 cron 자동 resolve — 연속확증 (#2539, 위 leg 2 skip 정책의 supersede)
 * ============================================================================
 * 위 문단(#2515)까지는 "cron은 leg 2를 절대 평가하지 않는다"가 정책이었다 — leg 2 lock이
 * 사용자의 실제 탭(boarding-prompt 응답/BoardingTrainList 탭 → register-time 또는
 * `POST /trips/:token/boarding-confirm`)에만 의존했다. 그러나 그 탭(leg 2 프롬프트) 자체가
 * 뜨지 않으면 lock 형성 경로가 통째로 없다는 것이 실측으로 확정됐다(#2539 root). 이제 cron도
 * `{ allowLegTransfer: true }`로 leg 2를 평가하되(walk-gate는 위 문단 그대로 강제), register-time과
 * 달리 **연속확증**을 추가로 요구한다(#2754 재설계 — 아래 문단). register-time/boarding-confirm
 * 탭 경로는 사용자 확인이 이미 있으므로 연속확증을 전혀 보지 않고 기존처럼 1회 resolved로
 * 즉시 승격한다.
 *
 * leg 2 연속확증 재설계 — ARRIVED/APPROACHING → DEPARTED 전이 (#2754, #2539의 연속확증을 대체)
 * ============================================================================================
 * #2539가 도입한 원 설계("같은 trainCode가 `LEG_RESOLVE_STREAK_THRESHOLD`회 연속 cron tick에서
 * resolved")는 #2751(recptnMs 파싱 fix)로 이 경로가 처음 살아나면서 9/18 실캡처 재생에서
 * **정반대로 동작한다는 것이 드러났다**: 사용자가 실제로 탄 열차는 탑승 직후 곧바로 출발하므로
 * ARRIVED/APPROACHING 상태를 2 cycle 연속 유지할 수 없다 — 반대로 플랫폼에 오래 머무는(=탑승
 * 대상이 아닌) 열차만 연속확증을 통과했다(9/18 사례: 7256은 17:40:31 ARRIVED → 17:41:32
 * DEPARTED로 1 cycle 만에 후보 탈락, 9분 뒤 들어온 무관한 7260이 2 cycle 연속 ARRIVED로
 * 관측돼 lock을 형성).
 *
 * `evaluateLegBoardingTransition`은 "연속 cycle 수"가 아니라 **전이(transition) 발생**을
 * 확증으로 쓴다: 직전 cycle에 resolved(ARRIVED/APPROACHING)로 관측된 candidate가 이번 cycle에
 * 같은 anchor station에서 DEPARTED(2)로 관측되면 "탑승 후 즉시 출발"이라는 실측 신호로 간주해
 * 즉시 confirmed한다. 같은 candidate가 다음 cycle에도 여전히 ARRIVED/APPROACHING로 남아 있으면
 * (아직 출발하지 않음) pending을 유지할 뿐 confirmed하지 않는다 — APPROACHING→ARRIVED처럼
 * "아직 그 열차"인 정상적인 상태 전이는 firstObservedAt을 보존한 채 계속 관찰하고, 다른
 * trainCode로 바뀌거나(교체) ambiguous/none으로 떨어지면(관측 상실) pending을 리셋한다
 * (rejected). `trip.legResolveStreak`가 이 pending 상태의 영속 저장소를 그대로 재사용한다
 * (`{trainCode, count, firstObservedAt}` — `count`는 진단용 연속 관측 횟수, 승격 판정에는
 * 더 이상 관여하지 않는다).
 *
 * 안전성: 이 설계는 leg-1(register-time, 1회 resolved 즉시 승격)보다 오히려 더 보수적이다 —
 * "한 번 봤다"가 아니라 "탑승 후 출발까지 봤다"를 요구한다. 잔존 위험은 실측 evidence 없이는
 * 완전히 제거되지 않는다: 우연히 사용자의 anchor station에서 ARRIVED→DEPARTED 전이를 보이는
 * 무관한 열차가 있다면(예: 반대편 승강장 열차가 방향 필터를 뚫는 경우) 오탑승 lock 위험이
 * 이론적으로 남는다 — 다만 이는 leg-1이 이미 감수하는 "그 역에 있다=탄 것"이라는 동일 신뢰
 * 수준을 넘지 않는다(위 "잔존 위험" 문단 참고, 새로 높이지 않는다).
 *
 * staleness 상한(요구사항 2) — 도입 보류
 * ======================================
 * 이슈(#2754)는 "anchor stamp 이후 일정 시간이 지나면 그 anchor로 resolve하지 않는다"는
 * 상한을 요구하되, 값은 실캡처의 "환승 후 실제 탑승까지 걸린 시간 분포"로 근거를 대라고
 * 명시했다. 이 저장소가 보유한 leg-2 실캡처는 9/18 1건(N=1)뿐이고, 그마저도 위 전이 재설계로
 * 탑승이 anchor 도달 직후(1 cycle, ≈61초) 확정돼 "얼마나 오래 기다려야 했는가"를 관측할
 * 표본이 되지 못한다 — 분포는커녕 단일 값도 만들 수 없다(N=1 편향 금지, `lesson_n1_root_cause_bias`).
 * 따라서 이 PR은 staleness 상한을 도입하지 않는다. 위 전이 기반 확증 자체가 "머무는 열차는
 * 절대 confirmed되지 않는다"는 무기한 안전판을 이미 제공하므로(rejected 판정이 ambiguous/none
 * 조건에서 발생), 상한 부재가 즉각적인 오탑승 위험을 재도입하지는 않는다. 실측이 쌓이면 별도
 * PR로 추가.
 */

import { TRAIN_STATUS } from './alarm';
import { buildLegSegmentStations, SWAP_LOCK_TTL_MS } from './lockSwap';
import { inferLegDirection } from './legDirection';
import { subwayIdForLine } from './lineAlias';
import { normalizeStationName } from '../../../src/shared/utils/normalizeStationName';
import type { PositionEntry, SeoulArrivalClient } from './seoul';
import type { BoardingLockMeta, Trip, Waypoint } from './types';

/** realtimePosition 항목을 신뢰 가능한 최신 관측으로 볼 임계값(ms). seoul.ts의 arrivals용
 * MAX_RECPTN_DRIFT_SEC(120s)와 동일 정책 — 두 값은 각자 로컬 모듈에 선언해 순환 import를
 * 피한다(`arrivalsFromPositions.ts`의 HOP_SEC 중복 선언과 동일 선례). */
export const POSITION_FRESHNESS_MS = 120_000;

export interface BoardingAnchor {
  /** 탑승 확정 대상 노선 (Waypoint.line / BoardingLockMeta.line과 동일 표기). */
  line: string;
  /** 사용자가 탑승했다고 명시한 역 (promptDisplay.originStation). */
  boardingStation: string;
  /** #1719 leg 진행 방향. 추론 불가 노선은 null(양방향 허용). */
  direction: 'up' | 'down' | null;
}

export type BoardingResolution =
  | { status: 'resolved'; trainCode: string }
  | { status: 'ambiguous' }
  | { status: 'none' };

/**
 * ADR-037 D2b (#2535) — 진단 계측 전용. `attemptBoardingAnchorResolution`이 어느 경로로
 * null/성공을 반환했는지 caller(index.ts `POST /trips/:token/boarding-confirm`)에게 노출한다.
 * `walk-gated` = leg-2 도보시간 게이트(#2515) 미통과, `ambiguous`/`none` = `BoardingResolution`의
 * 동명 status와 동일 의미(후보 2개+/0개), `resolved` = 승격 성공. 반환 타입 자체는 바꾸지
 * 않는다(기존 caller 전부 무변경) — `onOutcome` 콜백으로만 부가 관측.
 */
/**
 * #2739 — `'invalid-route'` 추가. 탭(`options.tapAnchor`)이 실어 보낸 station/line이 trip
 * route(waypoints/originStationName) 어디와도 정합하지 않을 때(findTapLegStart가 null 반환)
 * 이 값을 낸다 — `'none'`(anchor 자체가 없음)과 구분해 "탭이 왔지만 신뢰할 수 없어 거부했다"는
 * 사유를 D1에서 바로 읽을 수 있게 한다(요구사항 3).
 */
export type BoardingResolveOutcome = 'resolved' | 'none' | 'ambiguous' | 'walk-gated' | 'invalid-route';

/**
 * anchor(방향/역명) 조건을 만족하고 신선한(POSITION_FRESHNESS_MS 이내) position 항목 전부 —
 * trainSttus 무관(DEPARTED 포함). `resolveTrainCodeFromPositions`(ARRIVED/APPROACHING만
 * 우선순위 채택)와 `evaluateLegBoardingTransition`(#2754, DEPARTED 전이 탐지) 둘 다 이
 * 공통 필터를 재사용한다 — 중복 구현 대신 단일 SSoT.
 */
function freshCandidatesAtAnchor(
  anchor: BoardingAnchor,
  positions: readonly PositionEntry[],
  now: number,
): PositionEntry[] {
  const directional =
    anchor.direction !== null
      ? positions.filter((p) => p.isUp === (anchor.direction === 'up'))
      : positions;
  const atStation = directional.filter((p) => p.stationName === anchor.boardingStation);
  return atStation.filter((p) => p.recptnMs > 0 && now - p.recptnMs <= POSITION_FRESHNESS_MS);
}

/**
 * realtimePosition snapshot에서 anchor 조건에 맞는 정확히 1개의 trainCode를 찾는다. Pure —
 * KV/네트워크 의존 없음. caller(`attemptBoardingAnchorResolution`)가 `seoul.fetchPositions`
 * 결과를 전달한다.
 */
export function resolveTrainCodeFromPositions(
  anchor: BoardingAnchor,
  positions: readonly PositionEntry[],
  now: number,
): BoardingResolution {
  const fresh = freshCandidatesAtAnchor(anchor, positions, now);

  // ARRIVED(1) 우선 — "지금 이 역에 서 있음" 확정 신호. APPROACHING(0)은 차선.
  // DEPARTED(2)/그 외는 priority list 밖이라 자연히 후보에서 배제된다.
  const priority: readonly number[] = [TRAIN_STATUS.ARRIVED, TRAIN_STATUS.APPROACHING];
  for (const trainSttus of priority) {
    const tier = fresh.filter((p) => p.trainSttus === trainSttus);
    if (tier.length === 1) return { status: 'resolved', trainCode: tier[0].trainCode };
    if (tier.length > 1) return { status: 'ambiguous' };
  }
  return { status: 'none' };
}

/** `evaluateLegBoardingTransition`이 pending으로 기억하는 직전 cycle의 미확정 후보(#2754). */
export interface LegPendingCandidate {
  trainCode: string;
  /** 이 trainCode가 최초로 resolved 관측된 시각(ms) — 진단용, 승격 판정에는 미사용. */
  firstObservedAt: number;
}

/** `evaluateLegBoardingTransition`의 D1 진단 로그(요구사항 1)용 후보 스냅샷. */
export interface LegResolveCandidate {
  trainCode: string;
  trainSttus: number | null;
}

/**
 * `evaluateLegBoardingTransition`의 판정 결과(#2754). `confirmed` = 탑승 확정(lock 승격
 * 대상), `pending` = 아직 미확정(다음 cycle에 재평가), `rejected` = 이전 pending을 리셋(관측
 * 상실/ambiguous), `none` = pending도 없고 이번 cycle도 후보 없음(정상 유휴). 모든 variant가
 * `candidates`(이번 cycle 이 anchor station에서 관측된 신선한 후보 전부, 상태 무관)를 실어
 * D1 진단 로그(요구사항 1)가 "왜 배제/선택됐는지"를 그대로 기록할 수 있게 한다.
 */
export type LegBoardingConfirmation =
  | { status: 'confirmed'; trainCode: string; candidates: readonly LegResolveCandidate[] }
  | {
      status: 'pending';
      trainCode: string;
      firstObservedAt: number;
      candidates: readonly LegResolveCandidate[];
    }
  | { status: 'rejected'; candidates: readonly LegResolveCandidate[] }
  | { status: 'none'; candidates: readonly LegResolveCandidate[] };

/**
 * leg-2 cron 자동 resolve 연속확증 재설계(#2754) — 파일 헤더 "leg 2 연속확증 재설계" 참고.
 * "같은 trainCode가 N cycle 연속 ARRIVED/APPROACHING"(구 설계, #2539) 대신 ARRIVED/
 * APPROACHING → DEPARTED **전이**를 확증으로 쓴다:
 *
 *   1. `pending`(직전 cycle의 미확정 후보)이 있고, 이번 cycle에 같은 trainCode가 같은 anchor
 *      station에서 DEPARTED(2)로 관측되면 → `confirmed`("탑승 후 즉시 출발" 실측 신호).
 *   2. 그 외 이번 cycle이 resolved(ARRIVED/APPROACHING 유일 후보)면 → `pending`. 직전
 *      pending과 같은 trainCode면 `firstObservedAt`을 보존(연속 관찰), 다르면 교체(신규
 *      후보, `firstObservedAt`=now) — 같은 trainCode가 계속 ARRIVED/APPROACHING로 남아
 *      있는 것(9/18의 7260처럼 플랫폼에 머무는 열차)은 이 분기에 계속 머물 뿐 confirmed로
 *      승격되지 않는다.
 *   3. 그 외(ambiguous/none, DEPARTED 전이도 없음) — pending이 있었다면 `rejected`(리셋),
 *      없었다면 `none`.
 *
 * Pure — KV/네트워크 의존 없음. `attemptBoardingAnchorResolution`이 leg-2 cron 경로에서만
 * 호출한다(register-time/boarding-confirm 탭 경로는 무변경, 1회 resolved 즉시 승격).
 */
export function evaluateLegBoardingTransition(
  anchor: BoardingAnchor,
  positions: readonly PositionEntry[],
  now: number,
  pending: LegPendingCandidate | undefined,
): LegBoardingConfirmation {
  const fresh = freshCandidatesAtAnchor(anchor, positions, now);
  const candidates: LegResolveCandidate[] = fresh.map((p) => ({
    trainCode: p.trainCode,
    trainSttus: p.trainSttus,
  }));

  if (pending) {
    const departed = fresh.some(
      (p) => p.trainCode === pending.trainCode && p.trainSttus === TRAIN_STATUS.DEPARTED,
    );
    if (departed) return { status: 'confirmed', trainCode: pending.trainCode, candidates };
  }

  const resolution = resolveTrainCodeFromPositions(anchor, positions, now);
  if (resolution.status === 'resolved') {
    return {
      status: 'pending',
      trainCode: resolution.trainCode,
      firstObservedAt:
        pending && pending.trainCode === resolution.trainCode ? pending.firstObservedAt : now,
      candidates,
    };
  }
  return pending ? { status: 'rejected', candidates } : { status: 'none', candidates };
}

/** `resolveActiveLegOrigin`이 반환하는 "지금 leg"의 origin 컨텍스트. */
export interface ActiveLegOrigin {
  originStation: string;
  line: string;
}

/**
 * #2739 — 탭(`POST /trips/:token/boarding-confirm`)이 실어 보낸 station/line을 route와
 * 정합 검증한 뒤 그 leg의 waypoints slice 시작점을 반환한다. 하드코딩 인덱스 없이 waypoints
 * 배열을 순회하므로 다중 환승(leg 3+)도 동일 로직으로 커버한다.
 *
 * 두 경우만 유효한 "탑승 지점"으로 인정한다(그 외는 route 밖 — null, 요구사항 3):
 *   1. leg 1 origin — `trip.originStationName`(등록 시 SSoT 출발역)과 `tapStation`이 일치하고
 *      `waypoints[0].line`이 `tapLine`과 일치. sliceFrom=0(waypoints 그대로 사용).
 *   2. leg 2+ 환승 지점 — `kind==='transfer'`인 waypoint(그 leg가 끝나는 지점)의
 *      stationName이 `tapStation`과 일치하고, 바로 다음 waypoint의 line이 `tapLine`과
 *      일치. sliceFrom=그 다음 waypoint의 index(`scheduled.ts` `stampCurrentLegAnchor`가
 *      환승 통과 시 `waypoints.slice(1)`로 shift하는 것과 동일 관례 — 이 함수는 그 shift를
 *      cron의 arvlCd 확증 없이 탭 시점에 미리 계산만 한다, mutate는 caller 책임).
 *
 * 역명 비교는 #1410/#2566 정규화 drift(괄호 부제 등) 흡수를 위해 `normalizeStationName`을
 * 거친다(`scheduled.ts` `isSameLegAnchor`와 동일 관례).
 */
export function findTapLegStart(
  trip: Pick<Trip, 'waypoints' | 'originStationName'>,
  tapStation: string,
  tapLine: string,
): { originStation: string; sliceFrom: number } | null {
  const { waypoints, originStationName } = trip;
  if (
    originStationName !== undefined &&
    normalizeStationName(originStationName) === normalizeStationName(tapStation) &&
    waypoints[0]?.line === tapLine
  ) {
    return { originStation: originStationName, sliceFrom: 0 };
  }
  for (let i = 0; i < waypoints.length - 1; i += 1) {
    const current = waypoints[i];
    const next = waypoints[i + 1];
    if (
      current.kind === 'transfer' &&
      normalizeStationName(current.stationName) === normalizeStationName(tapStation) &&
      next.line === tapLine
    ) {
      return { originStation: current.stationName, sliceFrom: i + 1 };
    }
  }
  return null;
}

/** `resolveActiveLegOrigin`/`attemptBoardingAnchorResolution` 호출 컨텍스트 (break #2, #2323 rework). */
export interface LegOriginResolutionOptions {
  /**
   * true = 사용자의 실제 탭이 트리거인 register-time 경로(`index.ts` `POST /trips` →
   * `resolveBoardingAnchorAtRegister`)에서 호출됐다는 뜻 — leg 2(`currentLegAnchor`)까지
   * 평가 대상에 포함한다.
   *
   * false/미지정(기본값) = leg 2를 평가하지 않는다(null 반환, leg 1 `promptDisplay`로도
   * fallback하지 않음). leg 1(`promptDisplay`)은 도보 이동 창이 없는 즉시 탑승이라 이 옵션과
   * 무관하게 계속 평가된다.
   *
   * 근거: leg 2는 환승 후 도보 이동 창(#2511이 놓친 위험)이 있어, walk-gate(`legBoardingEligibleAt`)
   * 없이 평가하면 "아직 플랫폼에 도착하지 않았는데 서 있는 열차와 우연히 매칭"될 위험이 크다.
   * walk-gate는 `allowLegTransfer` 값과 무관하게 항상 강제된다(우회 불가).
   *
   * #2539 갱신 — cron(`scheduled.ts`)도 이제 `{ allowLegTransfer: true }`를 전달해 leg 2를
   * 평가한다(구 정책: cron은 leg 2를 절대 평가하지 않음 — #2539가 supersede). register-time(탭,
   * `index.ts`)과의 차이는 이 함수 자체가 아니라 caller의 승격 규율에 있다: register-time/
   * boarding-confirm 탭은 이 함수가 resolved를 반환하는 즉시 1회로 lock 승격하지만, cron은
   * `trip.legResolveStreak`로 같은 trainCode의 연속 resolved를 `LEG_RESOLVE_STREAK_THRESHOLD`회
   * 확인한 뒤에만 승격한다(`scheduled.ts` 참고) — 탭이 없는 배경 폴링이라 더 강한 확증이
   * 필요하다는 판단.
   */
  allowLegTransfer?: boolean;
  /**
   * #2739 — `POST /trips/:token/boarding-confirm`이 LA 탭에서 받은 station/line.
   * `resolveActiveLegOrigin(trip, now, options)`가 null을 반환하고(=`currentLegAnchor`도
   * `promptDisplay`도 없음) **도보 게이트(walk-gated)가 원인이 아닐 때만** 1순위 fallback
   * anchor로 시도한다 — 이미 있는 backend anchor(currentLegAnchor/promptDisplay)를 절대
   * 덮어쓰지 않고(요구사항 2, 회귀 없음), 도보 게이트도 우회하지 않는다(요구사항 2 — 게이트가
   * 막고 있는 currentLegAnchor가 있으면 tapAnchor가 있어도 그대로 walk-gated로 끝난다).
   * `findTapLegStart`로 route 정합을 검증해 실패하면 `'invalid-route'`로 거부한다(요구사항 3).
   */
  tapAnchor?: { boardingStation: string; line: string };
  /**
   * #2754 — true면 leg-2 cron 자동 resolve가 `resolveTrainCodeFromPositions`(단순 1회 매칭)
   * 대신 `evaluateLegBoardingTransition`(ARRIVED/APPROACHING→DEPARTED 전이 확증)을 사용한다.
   * `pending`은 직전 cycle에 저장된 미확정 후보(`trip.legResolveStreak`) — caller(`scheduled.ts`
   * cron)만 전달한다. register-time/boarding-confirm 탭 경로는 이 옵션을 전달하지 않아
   * 기존과 동일하게 1회 resolved 즉시 승격을 유지한다(무변경).
   */
  legTransition?: { pending?: LegPendingCandidate };
}

/**
 * #2739 — 탭 anchor가 leg 2+(환승 지점) 경유로 채택됐을 때, caller(`index.ts` boarding-confirm
 * 핸들러)에게 "이 leg부터 다시 시작하는 waypoints"를 통지한다. caller는 이 값으로 `trip.waypoints`
 * (그리고 `currentLegAnchor`/`legBoardingEligibleAt`)를 갱신해야 다음 cron이 올바른 정거장을
 * 추적한다 — 갱신하지 않으면 `trip.waypoints[0]`이 여전히 이미 통과한 환승 waypoint를 가리켜
 * `estimateBoardingLockArrival`이 엉뚱한 역의 arrivals를 조회하게 된다.
 *
 * leg 1(탭이 origin과 일치, sliceFrom=0)에서는 advance가 필요 없으므로 호출되지 않는다.
 */
export interface TapLegAdvance {
  waypoints: Waypoint[];
  boardingStation: string;
  line: string;
}

/**
 * "지금" leg의 anchor origin을 결정한다 (#2515, #2511 supersede; break #2 옵션 추가는 #2323 rework).
 *
 * 우선순위:
 *   1. `trip.currentLegAnchor` — leg 2+(환승 후). `options.allowLegTransfer===true`이고
 *      `trip.legBoardingEligibleAt`(도보시간 게이트)를 통과했을 때만(`now >= legBoardingEligibleAt`)
 *      반환한다. 둘 중 하나라도 미충족이면 null — leg 1 `promptDisplay`로 fallback하지 않는다
 *      (환승 후에는 leg 1 anchor가 더 이상 유효하지 않다).
 *   2. `trip.promptDisplay` — leg 1(origin, 환승 전). `currentLegAnchor`가 아직 없을 때만.
 *
 * 둘 다 없거나(신규 trip 최초 register 전) leg 2 게이트 미통과면 null.
 */
export function resolveActiveLegOrigin(
  trip: Trip,
  now: number,
  options?: LegOriginResolutionOptions,
): ActiveLegOrigin | null {
  if (trip.currentLegAnchor) {
    if (options?.allowLegTransfer !== true) return null;
    const eligibleAt = trip.legBoardingEligibleAt;
    if (eligibleAt === undefined || now < eligibleAt) return null;
    return { originStation: trip.currentLegAnchor.boardingStation, line: trip.currentLegAnchor.line };
  }
  if (trip.promptDisplay) {
    return { originStation: trip.promptDisplay.originStation, line: trip.promptDisplay.line };
  }
  return null;
}

/**
 * lockless trip이 명시 탑승 anchor(`resolveActiveLegOrigin` + `infoModeEnabled===true`)를 가지고
 * 있을 때 realtimePosition으로 trainCode를 확정해 승격 가능한 `BoardingLockMeta`를 합성한다.
 *
 * 전제(caller 책임, #902 Seam F `attachTrainCodeForLeg`와 동일 계약): `isBoardingLockActive(trip,
 * now) === false`. 본 함수는 그 판정을 재검증하지 않는다 — `scheduled.ts` 순환 import를 피하기
 * 위해 의도적으로 분리(이미 `lockSwap.ts`가 같은 패턴).
 *
 * null 반환 사유: anchor 정보 부재/미확정(promptDisplay 없음 + currentLegAnchor 없음, 또는
 * currentLegAnchor는 있으나 `options.allowLegTransfer!==true`이거나 도보시간 게이트 미통과,
 * infoModeEnabled!==true) / line 매핑 실패 / 후보 0개 또는 ambiguous(2개+) / segmentStations
 * 산출 실패(route 불일치).
 *
 * break #2 (#2323 rework) — `options.allowLegTransfer`를 그대로 `resolveActiveLegOrigin`에
 * forward한다. #2539부터는 cron 호출자(`scheduled.ts`)와 register-time 호출자(`index.ts` 탭
 * 트리거) 모두 true를 전달해 leg 2를 평가한다 — 승격 규율(1회 즉시 vs 연속확증 K회)의 차이는
 * caller 쪽 로직이며 이 함수 자체는 두 caller에 대해 동일하게 동작한다.
 *
 * ADR-037 D2b (#2535) — `onOutcome` 콜백(진단 계측 전용, optional)은 각 조기 반환/성공 지점에서
 * `BoardingResolveOutcome`을 관측한다. 반환값(`BoardingLockMeta | null`)과 기존 호출자 동작은
 * 완전히 무변경 — 콜백을 전달하지 않는 기존 3개 호출자(index.ts register-time, scheduled.ts
 * cron)는 영향 없다.
 *
 * #2739 — `options.tapAnchor`(optional, `POST /trips/:token/boarding-confirm` 전용)와
 * `onTapLegAdvance` 콜백(optional)을 추가했다. `resolveActiveLegOrigin`이 null을 반환하고
 * walk-gate가 원인이 아닐 때만 `findTapLegStart`로 route 정합을 검증해 anchor를 합성한다 —
 * `currentLegAnchor`/`promptDisplay`가 이미 있으면 이 분기에 진입하지 않으므로 기존 3개
 * 호출자(tapAnchor 미전달)는 100% 무변경이다. leg 2+ 경유(sliceFrom>0)로 채택된 경우에만
 * `onTapLegAdvance`로 advance된 waypoints를 caller에 통지한다(leg 1은 advance 불필요).
 *
 * #2754 — `options.legTransition`이 전달되면(cron leg-2 전용) realtimePosition 매칭을
 * `evaluateLegBoardingTransition`으로 대체한다 — `confirmed`일 때만 아래 lock 합성으로
 * 이어지고, 그 외(`pending`/`rejected`/`none`)는 `onLegTransition` 콜백으로 caller
 * (`scheduled.ts`)에 전체 판정을 통지한 뒤 null을 반환한다. 이 옵션을 전달하지 않는 기존
 * 3개 호출자(index.ts register-time/boarding-confirm)는 100% 무변경.
 */
export async function attemptBoardingAnchorResolution(
  trip: Trip,
  seoul: SeoulArrivalClient,
  now: number,
  options?: LegOriginResolutionOptions,
  onOutcome?: (outcome: BoardingResolveOutcome) => void,
  onTapLegAdvance?: (advance: TapLegAdvance) => void,
  onLegTransition?: (confirmation: LegBoardingConfirmation) => void,
): Promise<BoardingLockMeta | null> {
  if (trip.infoModeEnabled !== true) {
    onOutcome?.('none');
    return null;
  }
  let anchor = resolveActiveLegOrigin(trip, now, options);
  let legWaypoints = trip.waypoints;
  if (!anchor) {
    const walkGated =
      trip.currentLegAnchor !== undefined &&
      options?.allowLegTransfer === true &&
      (trip.legBoardingEligibleAt === undefined || now < trip.legBoardingEligibleAt);
    if (walkGated) {
      onOutcome?.('walk-gated');
      return null;
    }
    if (!options?.tapAnchor) {
      onOutcome?.('none');
      return null;
    }
    // #2739 — 탭은 currentLegAnchor/promptDisplay 둘 다 없을 때만(요구사항 2 — 위에서 anchor
    // null + walk-gate 아님을 이미 확인) 1순위 fallback으로 쓴다. route 밖 값은 거부(요구사항 3).
    const tapStart = findTapLegStart(trip, options.tapAnchor.boardingStation, options.tapAnchor.line);
    if (!tapStart) {
      onOutcome?.('invalid-route');
      return null;
    }
    anchor = { originStation: tapStart.originStation, line: options.tapAnchor.line };
    legWaypoints = trip.waypoints.slice(tapStart.sliceFrom);
    if (tapStart.sliceFrom > 0) {
      onTapLegAdvance?.({
        waypoints: legWaypoints,
        boardingStation: tapStart.originStation,
        line: options.tapAnchor.line,
      });
    }
  }

  const subwayId = subwayIdForLine(anchor.line);
  if (!subwayId) {
    onOutcome?.('none');
    return null;
  }

  // #1719 — direction 추론. legWaypoints[0]은 "지금" leg의 다음 정차역(anchor.originStation
  // 자체는 legWaypoints에 포함되지 않는다 — leg 1은 `dijkstraRoute.ts:routeToInferredWaypoints`의
  // "출발역 — push 안 함" 계약, leg 2+는 이미 origin 이후로 slice됨). 추론 불가 노선/매칭 실패는
  // null(양방향 허용) — 기존 `attachTrainCodeForLeg`와 동일 fallback 정책.
  const nextWaypoint = legWaypoints[0];
  const direction =
    nextWaypoint && nextWaypoint.line === anchor.line
      ? inferLegDirection(anchor.line, anchor.originStation, nextWaypoint.stationName)
      : null;

  const positions = await seoul.fetchPositions(anchor.line);
  const resolutionAnchor = { line: anchor.line, boardingStation: anchor.originStation, direction };

  let resolvedTrainCode: string;
  if (options?.legTransition) {
    const confirmation = evaluateLegBoardingTransition(
      resolutionAnchor,
      positions,
      now,
      options.legTransition.pending,
    );
    onLegTransition?.(confirmation);
    if (confirmation.status !== 'confirmed') {
      onOutcome?.('none');
      return null;
    }
    resolvedTrainCode = confirmation.trainCode;
  } else {
    const resolution = resolveTrainCodeFromPositions(resolutionAnchor, positions, now);
    if (resolution.status !== 'resolved') {
      onOutcome?.(resolution.status);
      return null;
    }
    resolvedTrainCode = resolution.trainCode;
  }

  // segmentStations — 탑승역(anchor.originStation) + 현재 leg의 나머지 정차역(환승/도착까지 포함).
  // `buildLegSegmentStations`는 legWaypoints[0]부터 수집하므로 origin이 빠져 있다 — prepend.
  const legSegment = buildLegSegmentStations(legWaypoints, anchor.line);
  if (legSegment.length === 0) {
    onOutcome?.('none');
    return null;
  }
  const segmentStations =
    legSegment[0] === anchor.originStation ? legSegment : [anchor.originStation, ...legSegment];

  onOutcome?.('resolved');
  return {
    trainCode: resolvedTrainCode,
    line: anchor.line,
    subwayId,
    selectedDepartureTime: now,
    segmentStations,
    expiresAt: now + SWAP_LOCK_TTL_MS,
  };
}

/**
 * #2560 (ADR-038 Phase 2, ROOT fix) — device가 탭한 확정 trainCode로 BoardingLockMeta를 합성한다.
 *
 * 배경: 사용자가 열차를 탭하면 device는 (1)로컬 boardingLock + (2)infoModeEnabled=true를 set하고,
 * POST /trips에 lock을, /boarding-lock/sync에 trainCode(D4 #1210)를 실어 backend에 알린다. 그러나
 * 2026-09-10/11 실측: backend Trip이 `infoModeEnabled=true + boardingLock=null`(lockless)로 남아
 * `runTrainCodeTracking`(lock 경로) 대신 `runLocklessIntermediate`로 흘러 leg-1 매역 발사가 지하
 * motion 게이트(#2448)에 전멸했다(D1 cron-fire-attempt=0, 2 라이드 재현).
 *
 * `attemptBoardingAnchorResolution`은 trainCode를 realtimePosition에서 **추론**하지만, device가 이미
 * **명시 탭으로 확정한 trainCode**가 sync로 도착하면 추론이 불필요하다(탭=ground truth). 본 함수는
 * 그 확정 trainCode + trip.waypoints + 관측 탑승역으로 lock을 직접 합성해 sync 핸들러가 backend에
 * 부착한다 — POST /trips 경로의 race/드롭과 무관하게 lock이 확실히 active가 된다.
 *
 * leg 무관: `buildLegSegmentStations`가 line이 바뀌는 waypoint에서 break하므로 leg-1/2/3 각 leg의
 * 탭이 그 leg의 새 trainCode를 sync로 보내면 해당 leg lock이 매번 합성된다.
 *
 * null 반환: subwayId 미매핑 / boardingLine에 해당하는 leg segment 없음(waypoints[0]이 다른 line —
 * stale trainCode) → 부착 안 함(안전).
 */
export function buildLockFromKnownTrainCode(
  waypoints: Trip['waypoints'],
  trainCode: string,
  boardingLine: string,
  observedStation: string,
  now: number,
): BoardingLockMeta | null {
  const subwayId = subwayIdForLine(boardingLine);
  if (!subwayId) return null;
  const legSegment = buildLegSegmentStations(waypoints, boardingLine);
  if (legSegment.length === 0) return null;
  const segmentStations =
    legSegment[0] === observedStation ? legSegment : [observedStation, ...legSegment];
  return {
    trainCode,
    line: boardingLine,
    subwayId,
    selectedDepartureTime: now,
    segmentStations,
    expiresAt: now + SWAP_LOCK_TTL_MS,
  };
}
