import { isBoardingLockExpired, type BoardingLock } from '../types/boardingLock';
import type { ArrivalInfo } from '../api/arrivalApi';
import type { Station } from '../types/station';
import type { TrainProgressResult } from './trackTrainProgress';
import { projectArrivalEtaStation } from './arrivalEtaProjection';

/**
 * ADR-008 — 탑승 진행 추정(BoardingLock 활성 trip 중 현재역) 합성기.
 *
 * 4단 전략 우선순위로 합성:
 *  ① LivePosition   — realtimePosition으로 lock.trainCode 직접 발견 → 그 statnId (drift=0)
 *  ② ArrivalEta     — 다음 역 arrival에서 trainCode 발견 → arrivalSeconds로 ETA 투영 (Stage 2/#740)
 *  ③ ReanchoredHop  — ①②가 마지막으로 본 (역, 시각)에 재앵커 — 최대 1 hop만 적분
 *  ④ DefaultHop     — 노선/세그먼트 hop time 테이블 (Stage 3/#624)
 *
 * Stage 1(#739)은 ①③. Stage 2(#745)에서 ②(projectArrivalEtaStation 합성) 도입. ④는 Stage 3까지
 * 명시적 TODO 스텁으로 자리만 잡는다 — 후속 stage에서 채우면 그대로 합성 우선순위에 끼어든다(OCP).
 *
 * 핵심 변경: 기존 `interpolateBoardingLockStation`은 `lock.boardedAt`을 시작 앵커로 N hop을 통째로
 * 적분 → 보간이 메꾸는 구간이 trip 전체였다. ReanchoredHop은 마지막 실관측 `(arcIndex, observedAtMs)`에
 * 재앵커 → 폴링 간격(5초)마다 앵커가 갱신되므로 보간 구간이 최대 1 hop으로 줄어든다. (ADR-008 §③)
 */

/** estimator 입력 — Stage 2/3에서 ArrivalEta/HopTimeTable 신호 주입 시 입력 필드만 추가하면 된다. */
export interface StationProgressEstimatorInput {
  /** 활성 BoardingLock. null이면 estimator 자체가 비활성. */
  lock: BoardingLock | null;
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
  /** Strategy ③④에서 사용할 hop 시간(ms). Stage 1은 HOP_TIME_MS 패스스루, Stage 3에서 lookup. */
  hopTimeMs: number;
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
  | 'default-hop';

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
 * Strategy ③ — lastObserved(또는 fallback으로 boardedAt+boardingIdx)에 재앵커 + 시간 적분.
 *
 * 핵심: lastObserved가 있으면 `(observedAtMs, arcIndex)` 앵커, 없으면 `(boardedAt, boardingIdx)`.
 * lastObserved는 LivePosition이 살아있던 동안 갱신되므로 보간 구간이 폴링 1회분(최대 1 hop)으로 제한된다.
 *
 * 시계 후진(now < anchorTs)이나 종착역 cap+grace 초과 시 null.
 *
 * 상위 가드(lock null, arc 비어있음, lock 만료)는 estimateStationProgress에서 차단되므로 여기서는
 * 시그니처에 lock 비-null만 명시(NonNullable) — 호출부와 함께 점검할 수 있도록 비공개 헬퍼로 유지.
 */
function tryReanchoredHop(
  input: StationProgressEstimatorInput & { lock: BoardingLock },
): StationProgressEstimate | null {
  const { lock, arcStations, now, lastObserved, hopTimeMs } = input;

  let anchorIdx: number;
  let anchorTs: number;
  // lastObserved가 arc 범위를 벗어나면(잘못된 값) boardedAt fallback으로 안전 복구.
  if (
    lastObserved &&
    lastObserved.arcIndex >= 0 &&
    lastObserved.arcIndex < arcStations.length
  ) {
    anchorIdx = lastObserved.arcIndex;
    anchorTs = lastObserved.observedAtMs;
  } else {
    const boardingIdx = arcStations.findIndex((s) => s.id === lock.boardingStationId);
    if (boardingIdx === -1) return null;
    anchorIdx = boardingIdx;
    anchorTs = lock.boardedAt;
  }

  const elapsed = now - anchorTs;
  if (elapsed < 0) return null;

  const hopsElapsed = Math.floor(elapsed / hopTimeMs);
  const lastIdx = arcStations.length - 1;
  if (anchorIdx + hopsElapsed > lastIdx + OVER_TERMINAL_GRACE_HOPS) return null;
  const idx = Math.min(anchorIdx + hopsElapsed, lastIdx);
  return { station: arcStations[idx], index: idx, strategy: 'reanchored-hop' };
}

/** Strategy ④ — TODO Stage 3/#624. line/segment별 hop time 데이터 테이블 fallback. */
function tryDefaultHop(
  _input: StationProgressEstimatorInput,
): StationProgressEstimate | null {
  // TODO Stage 3/#624 — HOP_TIME_TABLE lookup으로 line/segment별 정밀 hop time 대체.
  return null;
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
 * Stage 2(#745) 기준 ①(LivePosition) → ②(ArrivalEta) → ③(ReanchoredHop) → ④(스텁) 순.
 * ④는 후속 stage에서 채워지면 자연스레 끼어든다(OCP).
 */
export function estimateStationProgress(
  input: StationProgressEstimatorInput,
): StationProgressEstimate | null {
  const { lock, arcStations, now } = input;
  if (!lock) return null;
  if (arcStations.length === 0) return null;
  if (isBoardingLockExpired(lock, now)) return null;

  // tryLivePosition은 lock과 무관 — trainProgress.trainNo === lockedTrainCode만 검사.
  // tryReanchoredHop은 lock에 의존하므로 비-null 시그니처로 좁힌다.
  const lockedInput = { ...input, lock };
  return (
    tryLivePosition(input) ??
    tryArrivalEta(input) ??
    tryReanchoredHop(lockedInput) ??
    tryDefaultHop(input)
  );
}
