/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import { isBoardingLockExpired, type BoardingLock } from '../../../shared/types/boardingLock';
import type { ArrivalInfo } from '../../../shared/types/arrival';
import type { Station } from '../../../shared/types/station';
import type { TrainProgressResult } from './trackTrainProgress';
import { projectArrivalEtaStation } from '../../arrival/utils/arrivalEtaProjection';
import { hopsElapsedFrom } from './hopTime';
import { ESTIMATOR_STUCK_TIMEOUT_MS } from '../../../shared/constants/realtime';

/**
 * ADR-008 — 탑승 진행 추정(BoardingLock 활성 trip 중 현재역) 합성기.
 *
 * 4단 전략 우선순위로 합성:
 *  ① LivePosition   — realtimePosition으로 lock.trainCode 직접 발견 → 그 statnId (drift=0)
 *  ② ArrivalEta     — 다음 역 arrival에서 trainCode 발견 → arrivalSeconds로 ETA 투영 (Stage 2/#740)
 *  ③ ReanchoredHop  — ①②가 마지막으로 본 (역, 시각)에 재앵커 — 최대 1 hop만 적분
 *  ④ DefaultHop     — `lock.boardedAt + boardingStationId` 앵커 + segment별 hop time 테이블 (Stage 3/#779)
 *
 * Stage 1(#739)은 ①③. Stage 2(#745)에서 ②(projectArrivalEtaStation 합성) 도입.
 * Stage 3(#779)에서 ④ 구현 — `lock.boardedAt` 앵커가 살아있을 때만 도달(lastObserved 부재 케이스).
 * ③/④ 모두 segment별 hop time을 `hopsElapsedFrom`으로 누적해 uniform 90s 가정을 제거(ADR-008 §④).
 *
 * 핵심 변경(Stage 1): 기존 `interpolateBoardingLockStation`은 `lock.boardedAt`을 시작 앵커로 N hop을
 * 통째로 적분 → 보간이 메꾸는 구간이 trip 전체였다. ReanchoredHop은 마지막 실관측 `(arcIndex, observedAtMs)`에
 * 재앵커 → 폴링 간격(5초)마다 앵커가 갱신되므로 보간 구간이 최대 1 hop으로 줄어든다. (ADR-008 §③)
 *
 * Stage 3 변경(#779): `hopTimeMs` 단일 매직넘버 → `hopTimeMsForHop(fromIdx)` 룩업으로 시그니처 전환.
 * `lock.boardingLine` 기준 `stationTravelTimes.json`(#655) 룩업, 미커버 노선/구간은 `hopTime.ts` 안에서
 * 90s graceful fallback. ReanchoredHop과 DefaultHop의 책임을 명시적으로 분리:
 *   - ReanchoredHop: lastObserved가 유효할 때만 동작(없으면 null)
 *   - DefaultHop:    lastObserved 부재 시 `(boardedAt, boardingStationId)` 앵커로 fallback
 */

/**
 * Lockless trip 컨텍스트 (#1207, Epic #1204 D1).
 *
 * `lock`이 null인 trip(사용자가 lock 없이 GPS만으로 진행)에서도 estimator가 비활성되지 않도록
 * `tripStartedAt`을 앵커로 시간 적분을 수행한다. lock 활성 trip은 본 필드를 무시 — `lock`이
 * non-null이면 기존 4단 전략이 우선.
 *
 * `tripStartedAt`은 destination이 설정된 순간(또는 첫 fusion fix 시각)을 호출자가 전달.
 * arc 위 모든 hop 누적이 elapsed를 넘을 때까지 hop을 진행한다 — `LocklessRouteHop` 전략.
 *
 * 사용자 가치: lockless trip + 토글 ON에서도 사용자 명시 의향 trip 동급 정확도 보장
 * (ADR-013 §B3 면제 폐기). estimator 출력이 D2(hop window 게이트)의 source of truth.
 */
export interface LocklessTripContext {
  /** Trip 시작 epoch ms — destination 설정 시각 또는 첫 fusion fix. */
  tripStartedAt: number;
}

/** estimator 입력 — Stage 2/3에서 ArrivalEta/HopTimeTable 신호 주입 시 입력 필드만 추가하면 된다. */
export interface StationProgressEstimatorInput {
  /** 활성 BoardingLock. null이면 lockless 분기(`locklessTrip` 제공 시) 또는 비활성. */
  lock: BoardingLock | null;
  /**
   * Lockless trip 컨텍스트 (#1207). `lock`이 null이고 본 필드가 제공되면 LocklessRouteHop
   * 전략으로 시간 적분. 미제공이면 기존 동작(lock null → null).
   */
  locklessTrip?: LocklessTripContext | null;
  /** 경로(arc) 위 역 시퀀스 — boarding → destination 순. */
  arcStations: Station[];
  /** 현재 시각(ms). */
  now: number;
  /**
   * Strategy ① 신호 — realtimePosition으로 추적된 현재 열차.
   * **신선도 계약**: 호출 측이 fusion 게이트(TTL + distance gate)를 통과한 trainProgress만 non-null로 넘긴다.
   * stale이거나 게이트 탈락 시 null로 전달 — estimator는 내부 신선도 검사 없이 non-null이면 채택.
   * null이면 Strategy ① skip → Strategy ②/③ fallback.
   */
  trainProgress: TrainProgressResult | null;
  /** lock.trainCode 패스스루(호출 측에서 추출). null이면 ① skip(매칭 불가). */
  lockedTrainCode: string | null;
  /**
   * Strategy ③ 앵커 — 마지막으로 ①(LivePosition)이 성공한 시각·arc 인덱스.
   * 호출 측이 ref로 관리해 trainProgress 매칭이 끊긴 후에도 직전 관측을 보존한다.
   */
  lastObserved: { arcIndex: number; observedAtMs: number } | null;
  /**
   * Strategy ③④에서 사용할 hop 시간 lookup. arc 위 `fromIdx`에서 다음 역으로의 hop ms를 반환.
   *
   * Stage 3(#779) — uniform `HOP_TIME_MS` 매직넘버를 segment별 lookup으로 대체.
   * 호출자는 `lock.boardingLine`을 캡슐화한 closure를 전달한다(`(idx) => hopTimeMsAt(arc, idx, line)`).
   * arc 경계/미커버 노선은 `hopTime.ts` 내부에서 `HOP_TIME_MS` graceful fallback.
   */
  hopTimeMsForHop: (fromIdx: number) => number;
  /**
   * Strategy ② 입력 (#745) — `arcStations[currentIdxHint + 1]` 역의 ArrivalInfo 목록.
   * `projectArrivalEtaStation`이 row별로 trainCode 매칭 + 신선도 필터링을 수행하므로 호출자는
   * raw 배열을 그대로 전달한다 (호선/방향 사전 필터링은 호출자 책임). null/빈배열이면 ② skip.
   */
  nextStationArrivals: readonly ArrivalInfo[];
  /**
   * Strategy ②의 신선도 TTL(ms). row의 `nowMs - receivedAtMs > ttlMs`면 stale로 스킵.
   * Stage 2 기준값은 `POSITION_TRAIN_TTL_MS`(60s)와 동일 — Strategy ①(LivePosition) 신선도
   * 기준과 정렬해 채택 경계가 자연스럽게 ①→②→③로 흐르도록 한다(통합된 신선도 게이트).
   * 후속 stage에서 측정 데이터 기반으로 별도 임계 사용 가능.
   */
  arrivalEtaTtlMs: number;
  /**
   * Strategy ② 진입점 인덱스 — 호출자가 직전 사이클의 채택 idx 또는 lastObserved.arcIndex로 전달.
   * null이면 ② skip(다음 역을 가리킬 기준점 없음). null이 아니어도 `currentIdx + 1`이 arc 밖이면
   * `projectArrivalEtaStation`이 종착 cap 처리로 마지막 인덱스를 반환한다.
   */
  currentIdxHint: number | null;
}

export type StationProgressStrategy =
  | 'live-position'
  | 'arrival-eta'
  | 'reanchored-hop'
  | 'default-hop'
  | 'lockless-route-hop'
  /**
   * #1605 — backend SSoT 권위 override 결과. estimator 자체가 산출하는 strategy가 아니라
   * `useFusedNearestStation`이 backend SSoT mirror가 fresh일 때 estimator 결과를 override한 표시.
   *
   * cascade의 `backend-ssot` source/confidence와는 분리된 라벨 — estimator/DebugModal Estimator State
   * 채널에서만 사용한다. `displayOnlyEstimate`와 buffer push의 strategy 출처 표시로 사용해
   * "estimator가 어떤 strategy로 wrong station을 가리켰는데 backend SSoT가 override했다"의 사후
   * 분석을 가능하게 한다.
   */
  | 'backend-ssot-override';

export interface StationProgressEstimate {
  station: Station;
  /** arcStations 내 위치 (0 = 탑승역). */
  index: number;
  /** 채택된 전략 — 측정/디버그용. */
  strategy: StationProgressStrategy;
}

/**
 * 종착역 고정 회귀 방지. 종점 도달 후 추가로 흐른 hop이 이 값을 넘으면 estimator를 무효화 —
 * release/만료 책임을 호출자에게 돌려준다. `boardingLockInterpolation.ts`와 동일 정책.
 */
const OVER_TERMINAL_GRACE_HOPS = 2;

/** Strategy ① — trainProgress가 lock.trainCode와 매칭되고 arc 위에 있으면 그 위치를 반환. */
function tryLivePosition(
  input: StationProgressEstimatorInput,
): StationProgressEstimate | null {
  const { trainProgress, lockedTrainCode, arcStations } = input;
  if (!trainProgress || lockedTrainCode == null) return null;
  if (trainProgress.trainNo !== lockedTrainCode) return null;
  const idx = arcStations.findIndex((s) => s.id === trainProgress.currentStation.id);
  if (idx === -1) return null;
  return { station: arcStations[idx], index: idx, strategy: 'live-position' };
}

/**
 * Strategy ② — 다음 역 arrival의 `trainCode` 매칭 row를 `projectArrivalEtaStation`으로 투영.
 *
 * lockedTrainCode 없거나 currentIdxHint 없으면 매칭 기준점 부재로 skip.
 * `projectArrivalEtaStation`이 내부에서 (1) trainCode 매칭, (2) receivedAtMs 신선도, (3) arrivalCode
 * 디코딩(5/0/1)을 처리해 적격 row가 없으면 null — 그대로 다음 전략으로 흐른다.
 */
function tryArrivalEta(
  input: StationProgressEstimatorInput,
): StationProgressEstimate | null {
  const {
    nextStationArrivals,
    lockedTrainCode,
    currentIdxHint,
    arcStations,
    now,
    arrivalEtaTtlMs,
  } = input;
  if (lockedTrainCode == null) return null;
  if (currentIdxHint == null) return null;
  if (nextStationArrivals.length === 0) return null;
  const projected = projectArrivalEtaStation({
    arrivals: nextStationArrivals,
    trainCode: lockedTrainCode,
    currentIdx: currentIdxHint,
    arcStations,
    nowMs: now,
    ttlMs: arrivalEtaTtlMs,
  });
  if (!projected) return null;
  return {
    station: projected.station,
    index: projected.index,
    strategy: 'arrival-eta',
  };
}

/**
 * `anchorIdx`에서 `elapsedMs` 동안 segment별 hop time을 누적해 산출한 현재 arc 인덱스.
 *
 * 시계 후진(elapsedMs < 0)이나 종착역 cap+grace 초과 시 null. cap 이내면 종착역으로 saturate.
 * ReanchoredHop/DefaultHop이 공유 — anchor 종류(lastObserved vs boardedAt)만 다르고 시간 적분 로직은 동일.
 */
function projectIndexByHopTime(
  arcStations: Station[],
  anchorIdx: number,
  elapsedMs: number,
  hopTimeMsForHop: (fromIdx: number) => number,
): number | null {
  if (elapsedMs < 0) return null;
  const hops = hopsElapsedFrom(arcStations.length, anchorIdx, elapsedMs, hopTimeMsForHop);
  const lastIdx = arcStations.length - 1;
  if (anchorIdx + hops > lastIdx + OVER_TERMINAL_GRACE_HOPS) return null;
  return Math.min(anchorIdx + hops, lastIdx);
}

/**
 * Strategy ③ — `lastObserved`(LivePosition 직전 관측)에 재앵커 + segment별 hop time 누적.
 *
 * lastObserved가 없거나 arc 범위 밖이면 본 전략 skip → 다음 전략(④ DefaultHop)에서 boardedAt fallback.
 * lastObserved는 LivePosition이 살아있던 동안 갱신되므로 보간 구간이 폴링 1회분(최대 1 hop)으로 제한된다.
 *
 * Stage 3(#779): 시간 적분이 segment별 실측 hop time(`hopTimeMsForHop`)을 사용 — 9호선 급행처럼
 * 데이터가 없는 노선/구간은 lookup 내부에서 graceful 90s fallback.
 */
function tryReanchoredHop(
  input: StationProgressEstimatorInput,
): StationProgressEstimate | null {
  const { arcStations, now, lastObserved, hopTimeMsForHop } = input;
  if (!lastObserved) return null;
  if (lastObserved.arcIndex < 0 || lastObserved.arcIndex >= arcStations.length) return null;

  const idx = projectIndexByHopTime(
    arcStations,
    lastObserved.arcIndex,
    now - lastObserved.observedAtMs,
    hopTimeMsForHop,
  );
  if (idx === null) return null;
  // Seam B(#898) 외부 cap은 useFusedNearestStation에서 적용 — 내부에서 한 번 더 자르면
  // 종착역 grace cap(line 168)과 충돌(`종착역 유지` 시나리오에서 +1로 잘림). ReanchoredHop은
  // 외부 ceiling으로만 제한, 내부는 종착 grace 보존.
  return { station: arcStations[idx], index: idx, strategy: 'reanchored-hop' };
}

/**
 * Strategy ④ — `lock.boardedAt + lock.boardingStationId` 앵커 + segment별 hop time 누적.
 *
 * ①②③ 모두 fallback된 dead zone에서만 도달 (lastObserved도 없는 상태). Stage 3(#779)에서 ADR-008 §④
 * "per-line/segment 데이터 테이블"을 구현 — uniform 90s 가정 제거.
 *
 * #1896 (RC-8) — stuck timeout: lock.boardedAt 기준 ESTIMATOR_STUCK_TIMEOUT_MS(5분) 초과 시
 * 탑승역에서 벗어나지 못하면 null 반환해 호출자(useFusedNearestStation)가 cascade fallback하도록 유도.
 * tryLivePosition/ArrivalEta/ReanchoredHop이 살아있으면 본 분기 미도달 — dead zone 전용.
 *
 * 상위 가드(lock null, arc 비어있음, lock 만료)는 estimateStationProgress에서 차단되므로
 * 시그니처에 lock 비-null만 명시(NonNullable).
 */
function tryDefaultHop(
  input: StationProgressEstimatorInput & { lock: BoardingLock },
): StationProgressEstimate | null {
  const { lock, arcStations, now, hopTimeMsForHop } = input;
  const boardingIdx = arcStations.findIndex((s) => s.id === lock.boardingStationId);
  if (boardingIdx === -1) return null;

  const elapsedMs = now - lock.boardedAt;

  // #1896 (RC-8) — stuck timeout: dead zone(①②③ 모두 실패)에서 5분+ 경과했는데
  // Seam B cap 후 결과가 탑승역에서 1역만 벗어난(boardingIdx+1) 상태로 고착이면 null 반환.
  // 호출자(useFusedNearestStation)가 backendSsot / wifi / fused 등 다른 cascade tier로 재진입하도록 유도.
  //
  // 진짜 고착 판정: rawIdx === boardingIdx (0 hop = 탑승역에서 전혀 안 움직임).
  //   - elapsedMs > ESTIMATOR_STUCK_TIMEOUT_MS(5분) — 3+ stop 통과 시간이 지났는데
  //   - `projectIndexByHopTime` raw idx = boardingIdx (0 hop) — 진짜 고착.
  //   → "Strategy①②③ 모두 죽고 DefaultHop이 탑승역 고착"이라는 dead zone 신호.
  //   → null 반환해 cascade reentry. ①②③이 살아있으면 본 분기 미도달.
  //
  // rawIdx = boardingIdx+1 (1 hop 완료)은 고착이 아님 — Seam B cap과 무관하게 정상 진행.
  // 롱 세그먼트 노선(hop time > 5min)에서 false positive를 막기 위해 strictly boardingIdx만 대상.
  //
  // false positive 방어:
  //   - boardingIdx가 arc 마지막(단일 역 목적지)이면 cappedIdx == boardingIdx → 고착 아님(arc 자체가 1역).
  //     단일 arc는 estimateStationProgress 상위가 arc 비어있으면 null로 막으므로 도달 보기 드물다.
  //   - 5분 임계: PICKER_STUCK_MAX_AGE_MS와 동일 기준. 지하철 3+ 정차 시간.
  if (elapsedMs > ESTIMATOR_STUCK_TIMEOUT_MS && boardingIdx + 1 < arcStations.length) {
    const rawIdx = projectIndexByHopTime(arcStations, boardingIdx, elapsedMs, hopTimeMsForHop);
    if (rawIdx !== null && rawIdx <= boardingIdx) {
      // 5분+ 경과했는데 hop 적분이 여전히 탑승역(0 hop) → 진짜 고착 → null.
      // rawIdx = boardingIdx+1(1 hop 진행)은 고착이 아님 — 정상 진행이므로 제외.
      return null;
    }
  }

  const idx = projectIndexByHopTime(
    arcStations,
    boardingIdx,
    elapsedMs,
    hopTimeMsForHop,
  );
  if (idx === null) return null;
  // Seam B (#898): dead-zone(①②③ 모두 실패)에서는 boarding 외 anchor가 없다. boarding+1로
  // cap해 적분이 종착역까지 단번에 흘러가는 것을 차단. 외부 cap(useFusedNearestStation)과 이중
  // 안전. tryReanchoredHop은 lastObserved 앵커가 갱신되며 종착 grace 의미가 있으므로 외부 cap만 적용.
  const cappedIdx = Math.min(idx, boardingIdx + 1);
  return { station: arcStations[cappedIdx], index: cappedIdx, strategy: 'default-hop' };
}

/**
 * Lockless Strategy — `tripStartedAt`을 arc 0번 앵커로 두고 segment별 hop time을 누적해 현재 위치 추정.
 *
 * lock이 없는 trip(사용자가 lock 없이 GPS만으로 진행)에서 estimator가 비활성되는 회귀(#1207)를 막기 위한 #1204 D1.
 * 사용자 명시 의향(lockless 토글 ON / boardingPrompt 응답) trip은 lock 활성과 동급 정확도 보장 의무 (ADR-013 §B3).
 *
 * #1418 — fusion arbitration에서 본 strategy는 **Tier 5(시간 적분, dead zone fallback)** 로 다뤄진다.
 * `useFusedNearestStation`의 forward ratchet 게이트가 Tier 1~4 실측 신호(surfaceSSOT/undergroundSSOT/
 * lastObservedRef/boardingLock/positionTrainResult)가 하나라도 활성이면 본 strategy의 result override
 * 자체를 차단해 lockless trip 정적 사용자에 대한 false fire(청담/중곡/사가정 류)를 막는다. strategy
 * 자체 동작은 변경 없음 — dead zone에서만 채택되는 fallback 위치 유지.
 *
 * Guard:
 *   - `arcStations` 빈 배열 → null (상위 가드에서도 차단되지만 방어적 cap)
 *   - `now < tripStartedAt`(시계 후진) → null
 *
 * Cap:
 *   - 시간 적분 결과가 arc 끝을 넘으면 마지막 인덱스로 saturate (over-terminal grace는 lock 전략의
 *     responsibility — lockless는 release 트리거 자체가 다른 경로이므로 clamp만 수행).
 */
function tryLocklessRouteHop(
  arcStations: Station[],
  tripStartedAt: number,
  now: number,
  hopTimeMsForHop: (fromIdx: number) => number,
): StationProgressEstimate | null {
  // 상위 estimateStationProgress가 arcStations.length === 0을 미리 차단하므로 본 가드는
  // 도달 불가하지만 방어적 유지 — 직접 호출자가 추가될 때 안전.
  /* istanbul ignore next */
  if (arcStations.length === 0) return null;
  // #1605 — route hop count=0 (arcStations 단일 역 = origin 자체) 가드.
  // arc가 1개 역만 가지는 경우(예: destination 미설정 직후 / origin==destination edge case)
  // 시간 적분 자체가 의미 없다 — clamp 결과가 항상 idx=0이라 origin과 동일하지만, "lockless-route-hop"
  // entry를 강제로 push하면 DebugModal에서 estimator 활성으로 오인되어 보인다. null 반환으로
  // estimator skip → strategy=null entry가 buffer에 push되어 trip context 미준비 상태가 명시된다.
  if (arcStations.length === 1) return null;
  const elapsedMs = now - tripStartedAt;
  if (elapsedMs < 0) return null;
  const hops = hopsElapsedFrom(arcStations.length, 0, elapsedMs, hopTimeMsForHop);
  const lastIdx = arcStations.length - 1;
  const idx = Math.min(hops, lastIdx);
  return {
    station: arcStations[idx],
    index: idx,
    strategy: 'lockless-route-hop',
  };
}

/**
 * arcStations에서 station.id 기준 인덱스. 미발견은 -1.
 * estimator 결과와 fusion 결과를 arc 위치로 비교(역행 방지)할 때 사용.
 */
export function arcIndexOfStation(
  arcStations: Station[],
  station: Station | null | undefined,
): number {
  if (!station) return -1;
  return arcStations.findIndex((s) => s.id === station.id);
}

/**
 * 4단 전략을 우선순위대로 시도. 처음 채택된 전략의 결과를 반환.
 *
 * Stage 3(#779) 기준 ①(LivePosition) → ②(ArrivalEta) → ③(ReanchoredHop) → ④(DefaultHop) 순.
 * ③은 `lastObserved` 유효 시만 동작, ④는 `lock.boardedAt + boardingStationId` 앵커로 fallback.
 */
export function estimateStationProgress(
  input: StationProgressEstimatorInput,
): StationProgressEstimate | null {
  const { lock, locklessTrip, arcStations, now, hopTimeMsForHop } = input;
  if (arcStations.length === 0) return null;
  // Lockless 분기 (#1207): lock이 null이고 locklessTrip 컨텍스트가 제공되면 LocklessRouteHop으로 적분.
  // locklessTrip 미제공이면 기존 동작 유지(null) — 호출자가 명시적으로 lockless 활성을 옵트인.
  if (!lock) {
    if (locklessTrip) {
      return tryLocklessRouteHop(arcStations, locklessTrip.tripStartedAt, now, hopTimeMsForHop);
    }
    return null;
  }
  if (isBoardingLockExpired(lock, now)) return null;

  // tryLivePosition/ArrivalEta/ReanchoredHop은 lock에 직접 의존하지 않으나 estimateStationProgress가
  // 이미 lock 비-null을 보장해 호출 트리 전체가 active trip context. tryDefaultHop만 lock.boardedAt/
  // boardingStationId를 사용하므로 시그니처에 명시(NonNullable)한다.
  const lockedInput = { ...input, lock };
  return (
    tryLivePosition(input) ??
    tryArrivalEta(input) ??
    tryReanchoredHop(input) ??
    tryDefaultHop(lockedInput)
  );
}
