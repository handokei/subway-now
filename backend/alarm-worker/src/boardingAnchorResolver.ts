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
 */

import { TRAIN_STATUS } from './alarm';
import { buildLegSegmentStations, SWAP_LOCK_TTL_MS } from './lockSwap';
import { inferLegDirection } from './legDirection';
import { subwayIdForLine } from './lineAlias';
import type { PositionEntry, SeoulArrivalClient } from './seoul';
import type { BoardingLockMeta, Trip } from './types';

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
 * realtimePosition snapshot에서 anchor 조건에 맞는 정확히 1개의 trainCode를 찾는다. Pure —
 * KV/네트워크 의존 없음. caller(`attemptBoardingAnchorResolution`)가 `seoul.fetchPositions`
 * 결과를 전달한다.
 */
export function resolveTrainCodeFromPositions(
  anchor: BoardingAnchor,
  positions: readonly PositionEntry[],
  now: number,
): BoardingResolution {
  const directional =
    anchor.direction !== null
      ? positions.filter((p) => p.isUp === (anchor.direction === 'up'))
      : positions;
  const atStation = directional.filter((p) => p.stationName === anchor.boardingStation);
  const fresh = atStation.filter(
    (p) => p.recptnMs > 0 && now - p.recptnMs <= POSITION_FRESHNESS_MS,
  );

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

/** `resolveActiveLegOrigin`이 반환하는 "지금 leg"의 origin 컨텍스트. */
export interface ActiveLegOrigin {
  originStation: string;
  line: string;
}

/** `resolveActiveLegOrigin`/`attemptBoardingAnchorResolution` 호출 컨텍스트 (break #2, #2323 rework). */
export interface LegOriginResolutionOptions {
  /**
   * true = 사용자의 실제 탭이 트리거인 register-time 경로(`index.ts` `POST /trips` →
   * `resolveBoardingAnchorAtRegister`)에서 호출됐다는 뜻 — leg 2(`currentLegAnchor`)까지
   * 평가 대상에 포함한다.
   *
   * false/미지정(기본값) = cron 경로(`scheduled.ts` 매 사이클 폴링)에서 호출됐다는 뜻 — leg 2는
   * 절대 평가하지 않는다(null 반환, leg 1 `promptDisplay`로도 fallback하지 않음 — 기존 정책과
   * 동일). leg 1(`promptDisplay`)은 도보 이동 창이 없는 즉시 탑승이라 cron 매 cycle 재시도가
   * 안전하므로 이 옵션과 무관하게 계속 평가된다.
   *
   * 근거: leg 2는 환승 후 도보 이동 창(#2511이 놓친 위험)이 있어, cron이 매 사이클 조용히
   * 승격을 시도하면 "아직 플랫폼에 도착하지 않았는데 서 있는 열차와 우연히 매칭"될 위험이
   * 크다. leg 2 승격은 사용자의 실제 탭(boarding-prompt 응답 → device re-register)이 트리거인
   * 순간에만 일어나야 한다 — cron의 배경 폴링이 아니라.
   */
  allowLegTransfer?: boolean;
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
 * forward한다. cron 호출자(`scheduled.ts`)는 미전달(기본 false)해 leg 2 자동 승격을 완전히
 * skip하고, register-time 호출자(`index.ts` tap 트리거)만 true를 전달한다.
 */
export async function attemptBoardingAnchorResolution(
  trip: Trip,
  seoul: SeoulArrivalClient,
  now: number,
  options?: LegOriginResolutionOptions,
): Promise<BoardingLockMeta | null> {
  if (trip.infoModeEnabled !== true) return null;
  const anchor = resolveActiveLegOrigin(trip, now, options);
  if (!anchor) return null;
  const { waypoints } = trip;

  const subwayId = subwayIdForLine(anchor.line);
  if (!subwayId) return null;

  // #1719 — direction 추론. waypoints[0]은 "지금" leg의 다음 정차역(anchor.originStation 자체는
  // waypoints에 포함되지 않는다 — leg 1은 `dijkstraRoute.ts:routeToInferredWaypoints`의 "출발역 —
  // push 안 함" 계약, leg 2는 `scheduled.ts` transfer advance가 이미 `waypoints.slice(1)`로 shift).
  // 추론 불가 노선/매칭 실패는 null(양방향 허용) — 기존 `attachTrainCodeForLeg`와 동일 fallback 정책.
  const nextWaypoint = waypoints[0];
  const direction =
    nextWaypoint && nextWaypoint.line === anchor.line
      ? inferLegDirection(anchor.line, anchor.originStation, nextWaypoint.stationName)
      : null;

  const positions = await seoul.fetchPositions(anchor.line);
  const resolution = resolveTrainCodeFromPositions(
    { line: anchor.line, boardingStation: anchor.originStation, direction },
    positions,
    now,
  );
  if (resolution.status !== 'resolved') return null;

  // segmentStations — 탑승역(anchor.originStation) + 현재 leg의 나머지 정차역(환승/도착까지 포함).
  // `buildLegSegmentStations`는 waypoints[0]부터 수집하므로 origin이 빠져 있다 — prepend.
  const legSegment = buildLegSegmentStations(waypoints, anchor.line);
  if (legSegment.length === 0) return null;
  const segmentStations =
    legSegment[0] === anchor.originStation ? legSegment : [anchor.originStation, ...legSegment];

  return {
    trainCode: resolution.trainCode,
    line: anchor.line,
    subwayId,
    selectedDepartureTime: now,
    segmentStations,
    expiresAt: now + SWAP_LOCK_TTL_MS,
  };
}
