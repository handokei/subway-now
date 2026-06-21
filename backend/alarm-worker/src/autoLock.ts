/**
 * #916 — trip-bound trainCode auto-lock (A1).
 *
 * lockMissing trip에서 9단 게이트(`boardingPrompt.ts`)가 통과한 시점에 backend가
 * Seoul arrivals의 `pickAutoTrainCode`(arvlCd 우선순위)로 trainCode를 자동 결정해
 * `BoardingLock`을 합성한다. 사용자가 "탑승" 액션을 직접 탭하지 않아도 cron이 매역 추적을
 * 시작할 수 있게 한다.
 *
 * Confidence threshold:
 *  - 9단 AND 게이트 (#819 ADR Section 2) — 9개의 독립 조건 곱으로 발사 임계 자체가 매우 높다.
 *    (정확도, 방향 cosine, fused speed, motion 등 모두 통과 시점에만 호출된다)
 *  - arvlCd 우선순위 (#819 ADR Section 1.2)의 ambiguity 해소 — 같은 우선순위 후보 2개 이상이면
 *    `pickAutoTrainCode`가 null을 반환해 자동 lock을 자연 차단한다 → 다음 cycle에 narrow.
 *  - RC1 차단 (#1018) — arvlCd=2(출발) at next-waypoint는 origin-pass 후보이므로 origin
 *    arrival 보조 검증 + boardingPromptState + lastMotionAt으로 confidence를 합산한다.
 *    confidence < AUTO_LOCK_CONFIDENCE_THRESHOLD면 null 반환 → prompt push fallback.
 *
 * 두 임계가 곱(AND)이라 단일 magic number 대신 "통과한 게이트의 곱"이 threshold다.
 * 본 모듈은 두 신호 양쪽이 모두 만족할 때만 lock 합성을 시도한다.
 *
 * 거짓 양성 차단: 사용자가 자동 lock 직후 다른 trainCode를 탭하면 client가 새 lock POST →
 * 기존 #864/#704 same-session 분기가 새 lock으로 자연 교체 (Seam F swap과 동일 경로).
 *
 * #1536 (S3, Epic #1533) — 환경 분기. caller 가 `environment` + `gateOutcome` 동반 전달 시
 * `evaluateConsensusGate(environment, signals)` 가 추가 합의 검증. underground 환경에서
 * arrival(arvlCd 0~3) + lockAttachable(trainCode 단일 수렴) 2-of-2 합의 미충족 시 null
 * 반환 → boarding-prompt push fallback. lesson `boarding_prompt_9and_gate_gps_only` 회귀
 * (지하 7일 누적 0건) 직접 해소.
 */

import { pickAutoTrainCode, type GateOutcome } from './boardingPrompt';
import {
  evaluateConsensusGate,
  isLockLineAllowed,
  type StationEnvironment,
} from './consensusGate';
import { matchLine, subwayIdForLine } from './lineAlias';
import { buildLegSegmentStations, SWAP_LOCK_TTL_MS } from './lockSwap';
import { METRIC_KIND, writeMetricDataPoints, type HistogramMetric } from './metrics';
import type { SeoulArrivalClient } from './seoul';
import type {
  AnalyticsEngineWriter,
  BoardingLockMeta,
  BoardingPromptState,
  LineNumber,
  Trip,
  Waypoint,
} from './types';

/**
 * 자동 lock의 TTL. lockSwap의 `SWAP_LOCK_TTL_MS`와 동일 30분 — 두 흐름 모두 "사용자 명시
 * 입력 없이 backend가 lock을 합성"한 케이스라 같은 마진이 적절.
 *
 * 본 모듈에서 별도 상수를 두지 않고 `lockSwap.SWAP_LOCK_TTL_MS`를 그대로 재사용한다 — 한쪽 정책
 * 변경 시 두 흐름이 동시에 따라가야 한다.
 */
export const AUTO_LOCK_TTL_MS = SWAP_LOCK_TTL_MS;

/**
 * #916 follow-up B — auto-prompt 발사 dedup 윈도우.
 *
 * `evaluateAndMaybeFireBoardingPrompt`가 9단 게이트 통과 직후 `attemptAutoLock`을 시도/성공한
 * trip은 이 윈도우 내에서 다시 prompt를 평가하지 않는다. lock이 사라져도(transfer release,
 * 사용자 swap, isSameSession=false로 boardingPromptState 리셋) 같은 trip token에 대한 자동
 * prompt 재발사를 차단해 시도 - 클리어 - 재시도 ping-pong 회귀를 방지한다.
 *
 * 길이는 `AUTO_LOCK_TTL_MS`(=30분)와 동일 — 자동 lock TTL이 끝나면 prompt dedup도 자연 만료.
 * 두 정책이 한 번에 바뀌도록 같은 상수를 재사용한다.
 */
export const AUTO_PROMPT_DEDUP_WINDOW_MS = AUTO_LOCK_TTL_MS;

/**
 * #1018 RC1 차단 — arvlCd=2(출발) at next-waypoint 검출 시 confidence gate 임계.
 *
 * 0~4점 척도:
 *   +2: origin arrivals에서 같은 trainCode 확인 (열차가 아직 출발역 권역에 있음 — 강한 증거)
 *   +1: boardingPromptState.fired=true (사용자가 이 세션에 이미 1회 탑승 확인 응답)
 *   +1: lastMotionAt이 3분 이내 (사용자가 최근까지 이동 중 — 탑승 직후 신호)
 *
 * threshold=2: origin 확인이 없더라도 두 소프트 신호가 모두 있으면 통과.
 * origin 확인만 있어도 통과 (2점). 단일 소프트 신호만 있으면 차단 (1점 < 2).
 * arvlCd=2가 아닌 경우 confidence check 자체를 skip → 기존 동작 유지.
 */
export const AUTO_LOCK_CONFIDENCE_THRESHOLD = 2;

/** RC1 confidence 체크 트리거 arvlCd 값 (출발). */
const ARVL_CD_DEPARTED = 2;

/** lastMotionAt이 이 시간(ms) 이내이면 "최근 이동" 신호로 간주. */
const RECENT_MOTION_WINDOW_MS = 3 * 60 * 1000;

export interface AttemptAutoLockInputs {
  trip: Trip;
  /** 다음 추적 대상 waypoint — arrivals 폴링 대상 (현재 leg 첫 waypoint). */
  targetWaypoint: Waypoint;
  /**
   * 사용자 boarding 출발역 표시명. `BoardingLockMeta.segmentStations` 첫 원소로 prepend된다
   * (#902 swap path와 달리 사용자가 origin에 머무는 시점이라 origin도 segment에 포함되어야
   * positions-fallback이 origin 인덱스를 찾을 수 있다).
   */
  originStation: string;
  /**
   * 진행 방향. `promptGeoContext.direction` 그대로 — null이면 양방향 허용
   * (`pickAutoTrainCode` 내부에서 stationName 필터가 implicit 방향 해소).
   */
  direction: 'up' | 'down' | null;
  seoul: SeoulArrivalClient;
  now: number;
  /**
   * #1018 RC1 confidence gate 입력 (a): trip의 boarding-prompt 발사 상태.
   * fired=true면 사용자가 이미 탑승 확인 응답을 한 것 → confidence +1.
   * 미전달 시 0점으로 간주.
   */
  boardingPromptState?: BoardingPromptState;
  /**
   * #1018 RC1 confidence gate 입력 (b): GPS 시리즈 마지막 motion 샘플 시각(epoch ms).
   * 호출자가 `fusion.series[fusion.series.length - 1]?.ts`를 전달한다.
   * RECENT_MOTION_WINDOW_MS 이내이면 confidence +1. 미전달 시 0점으로 간주.
   */
  lastMotionAt?: number;
  /**
   * #1439 (E6, ADR-015 §9) — trip route의 allowedLines union. lock 합성 시 `lock.line`이
   * 본 set 밖이면 reject한다(분당선 variant 같은 cross-line 매핑 차단).
   *
   * caller(`scheduled.ts`)가 `computeAllowedLines(trip.route)` 결과를 전달한다. 미전달 시
   * 검증을 skip — 구 호출자 호환 + trip route 데이터가 없는 케이스 보수적 허용.
   */
  allowedLines?: Set<LineNumber>;
  /**
   * #1536 (S3, Epic #1533) — trip 환경. consensusGate 분기 입력.
   *
   * - 'surface': 9단 게이트 통과면 lockAttachable=true 면 즉시 통과 — 기존 동작.
   * - 'underground' | 'mixed' | 'unknown': arrival + lockAttachable 2-of-2 합의 강제.
   *   `evaluateConsensusGate` 가 미통과면 lock 합성 skip — `pickAutoTrainCode` 단일 수렴이
   *   lockAttachable signal 로 forward 되어 합의를 만든다(arrival signal 은 chosen
   *   ArrivalEntry.arvlCd 가 0~3 범위면 present 로 판정).
   *
   * 미전달(undefined) 시 검증 skip — 구 호출자 호환. 신규 호출자(scheduled.ts)는 항상 전달.
   */
  environment?: StationEnvironment;
  /**
   * #1536 (S3) — 9단 게이트 결과. `evaluateConsensusGate` 의 `gateOutcome` 입력으로 forward.
   *
   * caller(scheduled.ts) 가 `evaluateBoardingPromptGates` 결과를 그대로 전달한다.
   * GPS bypass 분기에서는 `outcome.pass=true` 이고 `fusedSpeedKmh=0` 이지만 consensusGate
   * 의 underground 분기는 baseGatePassed 와 무관하게 arrival+lockAttachable 만 평가하므로
   * 안전(consensusGate.ts:149-158 참조).
   *
   * 미전달(undefined) 시 검증 skip — 구 호출자 호환.
   */
  gateOutcome?: GateOutcome;
  /**
   * #1614 Phase B (S4 #1537) — backend self-poll realtimePosition 결과 (호선 단위 운행 trainCode 위치).
   *
   * caller(scheduled.ts `maybeBindLocklessTrainCode`)가 `readSelfPollPosition(env.TRIPS, line)`
   * 으로 KV stamp 읽어 그대로 전달. attemptAutoLock 가 `pickAutoTrainCode` 결과로 trainCode를
   * 결정한 직후, 본 list 에 해당 trainCode가 존재하면 `consensusGate.ts:155` strongCB
   * (positionTrainAgreement + arrival) 통과 path를 연다 — underground 환경에서 strongBE 외 추가
   * 합의 분기를 활성화.
   *
   * 미전달(undefined) / 빈 배열 시 consensusGate가 자연 `?? false` fallback (strongBE 동작 유지).
   */
  selfPollPositions?: readonly { trainCode: string; stationName: string }[];
}

/**
 * #1171 — RC1 confidence gate 평가 결과를 caller에게 노출하는 trace.
 *
 * `attemptAutoLock`이 confidence를 산출했을 때만 set (arvlCd=2 branch). 다른 경로
 * (subwayId 누락, ambiguity, arvlCd!=2)에서는 undefined. caller는 본 값을 받아
 * `metrics.autoLockConfidenceBreakdown` histogram에 적재해 운영 분포를 측정한다.
 *
 * threshold 튜닝은 본 측정 데이터(1주 운영)로 별도 PR에서 결정한다 — 본 PR은 측정
 * 인프라만 추가하고 임계값(`AUTO_LOCK_CONFIDENCE_THRESHOLD=2`)은 변경하지 않는다.
 */
export interface AutoLockConfidenceTrace {
  /** RC1 confidence 점수 (0~4). */
  score: number;
  /** threshold 통과 여부 (`score >= AUTO_LOCK_CONFIDENCE_THRESHOLD`). */
  passed: boolean;
}

/**
 * #1171 — attemptAutoLock 결과 + confidence trace.
 *
 * 기존 nullable return을 wrapping해 caller가 confidence 분포를 적재할 수 있게 한다.
 * `lock`이 null이고 `confidenceTrace`가 set이면 RC1 gate가 차단한 케이스 (분포 측정 대상).
 * `lock`이 null이고 `confidenceTrace`가 undefined면 다른 원인의 실패 (subwayId 등).
 */
export interface AutoLockAttemptResult {
  lock: BoardingLockMeta | null;
  confidenceTrace?: AutoLockConfidenceTrace;
}

/**
 * lockMissing trip에 대해 trainCode 자동 결정 시도.
 *
 * 성공 (`result.lock` non-null):
 *  - subwayId 매핑 성공
 *  - segmentStations 비어있지 않음 (origin + 같은 line 유지 구간)
 *  - arrivals 비어있지 않음
 *  - `pickAutoTrainCode`가 단일 후보로 수렴 (ambiguity 없음)
 *  - RC1 confidence gate 통과 (선택 trainCode의 arvlCd=2인 경우만 평가)
 *
 * 실패 (`result.lock` null):
 *  - 위 중 하나라도 실패 → caller가 기존 boarding-prompt push fallback 진행
 *
 * RC1 confidence gate가 평가된 경우(arvlCd=2 branch)에 한해 `result.confidenceTrace`가 set된다.
 * caller는 이 값을 `metrics.autoLockConfidenceBreakdown` histogram에 적재한다 (#1171).
 *
 * 본 함수는 KV I/O를 하지 않는다 (순수 pipeline). caller가 결과를 trip에 stamp + putTrip.
 */
export async function attemptAutoLock(
  inputs: AttemptAutoLockInputs,
): Promise<AutoLockAttemptResult> {
  const {
    trip,
    targetWaypoint,
    originStation,
    direction,
    seoul,
    now,
    boardingPromptState,
    lastMotionAt,
    allowedLines,
    environment,
    gateOutcome,
    selfPollPositions,
  } = inputs;
  const line = targetWaypoint.line;
  const subwayId = subwayIdForLine(line);
  if (!subwayId) return { lock: null };
  // #1439 (E6, ADR-015 §9) — targetWaypoint.line이 trip route allowedLines 밖이면 reject.
  // 정상 trip에서는 waypoint.line이 항상 route 안이라 통과, 비정상 fusion 매핑(분당선 variant
  // 등으로 waypoint 자체가 오염된 케이스)에서만 차단된다. set 미지정 시 검증 skip.
  if (allowedLines && !isLockLineAllowed({ line }, allowedLines)) return { lock: null };

  const legStations = buildLegSegmentStations(trip.waypoints, line);
  if (legStations.length === 0) return { lock: null };
  // origin은 leg의 시작점 — positions fallback이 train.stationName === origin인 케이스를
  // segmentStations.indexOf로 찾을 수 있도록 prepend. legStations 첫 원소(=waypoints[0])와
  // 중복되지 않게 dedup 한다 (이론상 origin과 waypoints[0]는 서로 다른 역이어야 하지만 방어).
  const segmentStations =
    legStations[0] === originStation ? legStations : [originStation, ...legStations];

  const arrivals = await seoul.fetchArrivals(targetWaypoint.stationName);
  if (arrivals.length === 0) return { lock: null };

  const trainCode = pickAutoTrainCode(arrivals, line, direction);
  if (!trainCode) return { lock: null };

  // #1536 (S3, Epic #1533) — environment + gateOutcome 모두 전달 시 consensusGate 분기 강제.
  // underground/mixed/unknown 환경에서 arrival(=chosen arvlCd 0~3) + lockAttachable(=trainCode
  // 단일 수렴 = true) 2-of-2 합의가 통과해야 lock 합성 진행. surface 는 base gate(=outcome.pass)
  // 가 통과하면 즉시 통과. 미전달 시 (구 호출자) skip.
  if (environment && gateOutcome) {
    const chosenForGate = arrivals.find((a) => a.trainCode === trainCode);
    const arrivalSignalPresent =
      typeof chosenForGate?.arvlCd === 'number' &&
      chosenForGate.arvlCd >= 0 &&
      chosenForGate.arvlCd <= 3;
    // #1614 Phase B — backend self-poll realtimePosition cross-match.
    // pickAutoTrainCode 가 선택한 trainCode가 line의 운행 trains 중에 실제 존재하면 true.
    // undefined / 빈 list 시 자연 undefined → consensusGate가 `?? false` fallback (strongBE 동작 유지).
    const positionTrainAgreement = selfPollPositions
      ? selfPollPositions.some((p) => p.trainCode === trainCode)
      : undefined;
    const consensus = evaluateConsensusGate(environment, {
      gateOutcome,
      arrivalSignalPresent,
      // trainCode 단일 수렴 = lockAttachable. pickAutoTrainCode 가 null 이면 함수가 이미
      // 더 위에서 return 했으므로 본 시점에서는 항상 true.
      lockAttachable: true,
      positionTrainAgreement,
    });
    if (!consensus.pass) return { lock: null };
  }

  // #1018 RC1 confidence gate — arvlCd=2(출발) at next-waypoint는 사용자가 이미 그 열차를
  // 타고 origin을 떠났거나, 반대로 그 열차가 사용자보다 먼저 출발했을 수 있다 (origin-pass 후보).
  // 추가 신호로 confidence를 합산해 임계 미달 시 null 반환 → prompt push fallback.
  const chosenEntry = arrivals.find((a) => a.trainCode === trainCode);
  let confidenceTrace: AutoLockConfidenceTrace | undefined;
  if (chosenEntry?.arvlCd === ARVL_CD_DEPARTED) {
    const score = await computeConfidence({
      trainCode,
      line,
      originStation,
      seoul,
      boardingPromptState,
      lastMotionAt,
      now,
    });
    const passed = score >= AUTO_LOCK_CONFIDENCE_THRESHOLD;
    // #1171 — trace는 통과/차단 양쪽 모두 set. caller가 분포 히스토그램에 적재해
    // 1주 운영 후 threshold 튜닝 근거로 사용한다.
    confidenceTrace = { score, passed };
    if (!passed) return { lock: null, confidenceTrace };
  }

  const lock: BoardingLockMeta = {
    trainCode,
    line,
    subwayId,
    selectedDepartureTime: now,
    segmentStations,
    expiresAt: now + AUTO_LOCK_TTL_MS,
    // #916 follow-up A — server-set 표시. POST /trips 재등록 시 incoming.boardingLock=undefined
    // 케이스에서 existing lock을 보존할지 판단하는 마커 (사용자 명시 lock과 구분).
    autoLockedAt: now,
  };
  return { lock, confidenceTrace };
}

/**
 * #1171 — confidence score 한 건을 AE에 histogram sample로 적재.
 *
 * 호출자는 `attemptAutoLock`이 반환한 `confidenceTrace.score`를 그대로 전달한다.
 * trace가 undefined인 경우(arvlCd!=2로 gate 미평가, 또는 더 이른 실패)는 호출 자체를
 * skip해야 한다 — 표본 오염 방지.
 *
 * `writeMetricDataPoints`가 0값을 skip하므로 score=0 sample은 적재되지 않는다.
 * 0점 분포 자체를 측정하려면 perf-report 측이 total - (1+2+3+4)로 역산한다 — 본 PR은
 * 최소 변경 원칙으로 기존 schema 유지.
 */
export function recordAutoLockConfidence(
  writer: AnalyticsEngineWriter,
  token: string,
  trace: AutoLockConfidenceTrace,
): void {
  const histogram: HistogramMetric = {
    kind: METRIC_KIND.AUTO_LOCK_CONFIDENCE_BREAKDOWN,
    samples: [trace.score],
  };
  writeMetricDataPoints(writer, token, histogram);
}

interface ComputeConfidenceInputs {
  trainCode: string;
  line: string;
  originStation: string;
  seoul: SeoulArrivalClient;
  boardingPromptState: BoardingPromptState | undefined;
  lastMotionAt: number | undefined;
  now: number;
}

/**
 * RC1 confidence 점수 합산 (#1018).
 *
 * (a) origin arrivals에서 같은 trainCode가 보이면 +2 (열차가 아직 origin 권역에 있음).
 * (b) boardingPromptState.fired=true 이면 +1 (사용자 탑승 확인 응답 이력).
 * (b) lastMotionAt이 RECENT_MOTION_WINDOW_MS 이내이면 +1 (최근 이동 신호).
 */
async function computeConfidence(inputs: ComputeConfidenceInputs): Promise<number> {
  const { trainCode, line, originStation, seoul, boardingPromptState, lastMotionAt, now } = inputs;

  let score = 0;

  // (a) origin arrivals 보조 검증 — same-line 열차 중 trainCode 일치 확인.
  const originArrivals = await seoul.fetchArrivals(originStation);
  const originHasTrain = originArrivals.some(
    (a) => a.trainCode === trainCode && matchLine(a.subwayNm, line),
  );
  if (originHasTrain) score += 2;

  // (b) boardingPromptState — 사용자가 이 세션에 이미 탑승 확인 응답한 경우.
  if (boardingPromptState?.fired) score += 1;

  // (b) lastMotionAt — 최근 이동 신호.
  if (lastMotionAt !== undefined && now - lastMotionAt <= RECENT_MOTION_WINDOW_MS) score += 1;

  return score;
}
