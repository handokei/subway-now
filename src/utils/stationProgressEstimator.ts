import { isBoardingLockExpired, type BoardingLock } from '../types/boardingLock';
import type { Station } from '../types/station';
import type { TrainProgressResult } from './trackTrainProgress';

/**
 * ADR-008 — 탑승 진행 추정(BoardingLock 활성 trip 중 현재역) 합성기.
 *
 * 4단 전략 우선순위로 합성:
 *  ① LivePosition   — realtimePosition으로 lock.trainCode 직접 발견 → 그 statnId (drift=0)
 *  ② ArrivalEta     — 다음 역 arrival에서 trainCode 발견 → arrivalSeconds로 ETA 투영 (Stage 2/#740)
 *  ③ ReanchoredHop  — ①②가 마지막으로 본 (역, 시각)에 재앵커 — 최대 1 hop만 적분
 *  ④ DefaultHop     — 노선/세그먼트 hop time 테이블 (Stage 3/#624)
 *
 * Stage 1(#739)은 ①③만 실구현. ②④는 명시적 TODO 스텁(null 반환)으로 자리만 잡는다 — 인터페이스가
 * 안정화되면 후속 stage에서 채우면 그대로 합성 우선순위에 끼어든다(OCP).
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

/** Strategy ② — TODO Stage 2/#740. 다음 역 arrival의 trainCode 매칭으로 ETA 투영. */
function tryArrivalEta(
  _input: StationProgressEstimatorInput,
): StationProgressEstimate | null {
  // TODO Stage 2/#740 — 다음 역 arrival의 arrivalSeconds로 ETA 투영.
  return null;
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
 * Stage 1은 ①(LivePosition) → ②(스텁) → ③(ReanchoredHop) → ④(스텁) 순. ②④가 자리만 잡혀 있어
 * 후속 stage가 그대로 끼어들 수 있다.
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
