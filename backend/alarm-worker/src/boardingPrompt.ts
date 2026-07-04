/**
 * "탑승했냐?" 푸시 (#819 B 슬라이스) — 9단 AND 게이트 + arvlCd 우선순위 trainCode 선택.
 *
 * 게이트 (ADR Section 2):
 *   1. trip 활성 (caller가 listTrips로 보장)
 *   2. BoardingLock 없음 (caller가 lockMissing trip 분기에서만 호출)
 *   3. GPS accuracy < 50m (윈도우 평균 기준)
 *   4. 출발역 100m 이내 (마지막 sample 기준 haversine)
 *   5. 방향 cosine ≥ 0.7 (velocity vector vs 출발역→다음역)
 *   6. 60s 윈도우 sample N≥1 (#1886 RC-2 옵션 D: 사용자 paradigm 1정거장 이내 발사)
 *   7. fused speed ≥ 5 km/h AND confidence ≠ 'low'
 *   8. motion ∈ {walking, automotive}
 *   9. trip당 1회 + 5분 silence
 *
 * arvlCd 우선순위 (ADR Section 1.2):
 *   2 (출발) > 1 (도착) > 0 (진입) > 그 외 receivedAt 가까운 + 방향 매칭
 *   ambiguity → 자동 안 함 → 클라가 manual fallback.
 *
 * #1536 (S3, Epic #1533) — 환경 분기 추가.
 *   inputs.environment 가 underground / mixed / unknown 인 경우 GPS 의존 게이트
 *   (#3 accuracy / #4 origin / #5 direction / #6 window / #7 speed) 를 byPass 한다.
 *   이 게이트들은 모두 GPS series 신호에서 유도되므로 지하 GPS stale 환경에서는
 *   100% fail → 7일 누적 boardingPrompt 0건 회귀 (mem `lesson_boarding_prompt_9and_gate_gps_only`).
 *   대신 caller(scheduled.ts)가 evaluateConsensusGate(environment, signals)로 합의 게이트를
 *   적용하여 arrival + lockAttachable 2-of-2 신호로 통과 판정한다. 본 함수는 environment
 *   인자가 underground/mixed/unknown 이면 #8(motion) + #9(silence/fired) 만 평가 — caller가
 *   consensusGate 통과 책임을 진다. surface(또는 환경 미상 = undefined)는 기존 9단 AND 동작 유지.
 */

import { ARRIVAL_CODE } from './alarm';
import type { ArchFlagValue } from './archFlag';
import type { StationEnvironment } from './consensusGate';
import { fusedSpeed } from './fusedSpeed';
import { matchLine } from './lineAlias';
import {
  ACCURACY_CUTOFF_M,
  cosineDirection,
  evaluateWindow,
  haversineKm,
  type WindowedMetrics,
} from './positionSeries';
import type { ArrivalEntry } from './seoul';
import type { BoardingPromptState, PositionPoint } from './types';

/** 게이트 #4 — 출발역 거리 임계 (km 변환). */
export const ORIGIN_RADIUS_KM = 0.1;
/** 게이트 #5 — 방향 cosine 임계. */
export const DIRECTION_COSINE_THRESHOLD = 0.7;
/**
 * 게이트 #6 — 60s 윈도우 최소 sample.
 * #1886 RC-2 옵션 D: 3 → 1로 완화. 사용자 paradigm "1정거장 이내 발사" 충족을 위해
 * 지하/지상 모두 sample 1개 이상이면 평가 진행. false positive는 #8 motion + consensusGate로 차단.
 */
export const MIN_WINDOW_SAMPLES = 1;
/** 게이트 #7 — fused speed 임계 (km/h). */
export const MIN_FUSED_SPEED_KMH = 5;
/** 게이트 #9 — dismiss 후 silence 길이. */
export const DISMISS_SILENCE_MS = 5 * 60 * 1000;

export type GateOutcome =
  | { pass: true; metrics: WindowedMetrics; fusedSpeedKmh: number }
  | { pass: false; reason: GateSkipReason; metrics?: WindowedMetrics };

export type GateSkipReason =
  | 'no-series'
  | 'window-too-small'
  | 'no-candidates'
  | 'accuracy-too-poor'
  | 'origin-too-far'
  | 'direction-mismatch'
  | 'speed-too-low'
  | 'motion-not-moving'
  | 'motion-stationary'
  | 'silenced'
  | 'already-fired';

export interface OriginCoord {
  lat: number;
  lng: number;
}

export interface NextStationCoord {
  lat: number;
  lng: number;
}

export interface EvaluateBoardingPromptInputs {
  series: readonly PositionPoint[];
  origin: OriginCoord;
  /** trip 출발역 → 다음역의 좌표 — 방향 cosine 계산용. */
  nextStation: NextStationCoord;
  now: number;
  /** trip의 boarding-prompt 상태 — 게이트 #9 평가. */
  promptState?: BoardingPromptState;
  /**
   * Phase 3 Kalman smoothed velocity (#824). 호출자가 kalmanFilter.runKalmanStep으로
   * 산출해 전달. 미적용 단계는 null/undefined — fusedSpeed가 가중치 0으로 자연 무시
   * (Phase 1/2 회귀 없음).
   */
  kalmanKmh?: number | null;
  /**
   * Pre-computed window metrics (#833). 호출자가 이미 동일 series/now로
   * `evaluateWindow`를 계산했다면(예: Kalman observation 산출용) 결과를 그대로 전달해
   * hot path redundancy를 제거한다. 미지정 시 내부에서 1회 계산 — 회귀 없음.
   */
  metrics?: WindowedMetrics;
  /**
   * #1536 (S3) — trip 환경. 'underground' | 'mixed' | 'unknown' 이면 GPS 의존 게이트
   * (#3 accuracy / #4 origin / #5 direction / #6 window / #7 speed) 를 byPass 한다.
   * 'surface' 또는 undefined(legacy 호출자) 는 기존 9단 AND 게이트를 그대로 평가한다.
   *
   * caller(scheduled.ts)가 trip.subsurface → deriveEvidenceEnvironment → mapEvidenceEnvironment
   * 로 변환된 값을 그대로 forward한다. underground 분기에서도 #8 motion + #9 silence/fired는
   * 반드시 평가 — caller는 별도로 evaluateConsensusGate(environment, signals)로 arrival+
   * lockAttachable 2-of-2 합의를 검증해야 한다(false positive 차단).
   */
  environment?: StationEnvironment;
  /**
   * #2014 (ADR-022 B8) — arrival API SSoT 아키텍처 활성화 여부.
   *
   * `'on'` 이면 GPS/motion/speed 게이트(#3~#8) 전부 skip, #9 (fired/silenced) 만 평가한다.
   * B8 정책: "boardingPrompt 발사 = arvlCd=1 도착 시 즉시. motion / speed 게이트 없음".
   * arvlCd=1 관측 자체는 caller(scheduled.ts) 가 fetchArrivals 후 별도 검사 — 본 게이트는
   * `promptState.fired` / `silencedUntil` 만으로 dedup + silence 정책을 유지해 false-positive
   * repeat push 를 차단한다.
   *
   * `'off'` 또는 undefined(legacy 호출자) 는 기존 9단 AND 게이트(또는 environment 분기) 그대로
   * 평가 — 회귀 방어.
   */
  archFlag?: ArchFlagValue;
}

/**
 * 게이트 #9 — silence / 1회 발사 dedup. promptState 부재 = 첫 시도, 통과 (null 반환).
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
 * GPS 의존 게이트 #3~#5 + #6 평가 (window + accuracy + origin + direction).
 * 통과 시 null 반환, fail 시 GateOutcome.
 */
function evaluateGpsGeometryGates(
  inputs: EvaluateBoardingPromptInputs,
  metrics: WindowedMetrics,
): GateOutcome | null {
  if (metrics.count < MIN_WINDOW_SAMPLES) {
    // #1886 RC-2 — MIN_WINDOW_SAMPLES=1이므로 count=0(데이터 전무) 만 여기서 차단.
    // caller 및 GPS-bypass 분기의 count=0 체크와 동일 의미 — reason을 통일해 관측 편의 확보.
    return { pass: false, reason: 'no-candidates', metrics };
  }
  // no-candidates가 통과한 이후엔 start/end가 null이 될 수 없음(count ≥ 1).
  // TypeScript narrowing을 위해 명시 assert로 진행.
  if (!metrics.start || !metrics.end) {
    return { pass: false, reason: 'no-candidates', metrics };
  }
  // #3 — accuracy. 평균 accuracy가 50m 이상이면 신뢰 불가.
  if (metrics.avgAccuracyMeters >= ACCURACY_CUTOFF_M) {
    return { pass: false, reason: 'accuracy-too-poor', metrics };
  }
  // #4 — 출발역 100m 이내. 마지막 sample 기준 (가장 최신 위치).
  const originDistanceKm = haversineKm(
    metrics.end.lat,
    metrics.end.lng,
    inputs.origin.lat,
    inputs.origin.lng,
  );
  if (originDistanceKm > ORIGIN_RADIUS_KM) {
    return { pass: false, reason: 'origin-too-far', metrics };
  }
  // #5 — 방향 cosine ≥ 0.7. expected vector는 출발역 → 다음역.
  const cos = cosineDirection(
    metrics.start.lat,
    metrics.start.lng,
    metrics.end.lat,
    metrics.end.lng,
    inputs.origin.lat,
    inputs.origin.lng,
    inputs.nextStation.lat,
    inputs.nextStation.lng,
  );
  if (cos < DIRECTION_COSINE_THRESHOLD) {
    return { pass: false, reason: 'direction-mismatch', metrics };
  }
  return null;
}

/**
 * 게이트 #7 — fused speed 평가. mapMatchedKmh + kalmanKmh 가중 합산.
 * 통과 시 fusedSpeedKmh, fail 시 reason.
 */
function evaluateFusedSpeedGate(
  inputs: EvaluateBoardingPromptInputs,
  metrics: WindowedMetrics,
): { pass: true; fusedSpeedKmh: number } | { pass: false; reason: GateSkipReason } {
  const fused = fusedSpeed({
    gpsAvgKmh: metrics.gpsAvgKmh,
    gpsAccuracyMeters: metrics.avgAccuracyMeters,
    motion: metrics.motion,
    mapMatchedKmh: metrics.mapMatchedKmh,
    kalmanKmh: inputs.kalmanKmh ?? null,
  });
  if (fused.speed < MIN_FUSED_SPEED_KMH || fused.confidence === 'low') {
    return { pass: false, reason: 'speed-too-low' };
  }
  return { pass: true, fusedSpeedKmh: fused.speed };
}

/**
 * #1536 — 환경 분기 판정. underground / mixed / unknown 은 GPS 의존 게이트 byPass.
 */
function isGpsDependentBypassEnv(env: StationEnvironment | undefined): boolean {
  return env === 'underground' || env === 'mixed' || env === 'unknown';
}

/**
 * 9단 AND 게이트 평가. 한 게이트라도 실패하면 즉시 reason과 함께 fail.
 * 게이트 #1/#2는 caller가 미리 보장 (listTrips × lockMissing 분기) — 본 함수는 #3~#9만 평가.
 *
 * #1536 (S3) — `inputs.environment` 가 'underground' | 'mixed' | 'unknown' 이면 GPS 의존
 * 게이트(#3~#7) 를 byPass 한다. 지하 GPS stale 환경에서 series 신호가 항상 wrong → 100%
 * fail 회귀 차단. 이 분기에서는 #8 motion + #9 silence/fired 만 평가하며, caller(scheduled.ts)
 * 가 evaluateConsensusGate(environment, signals) 로 arrival + lockAttachable 합의를 별도 검증해
 * false positive 를 차단해야 한다. `environment` 미지정 또는 'surface' 면 기존 9단 AND 평가.
 *
 * #2014 (ADR-022 B8) — `inputs.archFlag === 'on'` 시 GPS/motion/speed 게이트(#3~#8) 전부 skip.
 * #9 (fired/silenced) 만 평가해 dedup + silence 만 유지. B8 정책 "arvlCd=1 도착 시 즉시 발사"
 * 를 지원 — arvlCd 관측 자체는 caller 가 별도로 fetchArrivals + `pickAutoTrainCode` 로 검증.
 * `fusedSpeedKmh=0` 으로 반환 (bypass 분기와 동일) — 호출자는 fusedSpeed 를 로깅 외 용도로
 * 신뢰하지 않는다.
 */
export function evaluateBoardingPromptGates(
  inputs: EvaluateBoardingPromptInputs,
): GateOutcome {
  // #9 — silence / 1회 발사 dedup (가장 cheap한 가드 우선).
  const silenceOutcome = evaluateSilenceGate(inputs.promptState, inputs.now);
  if (silenceOutcome) return silenceOutcome;

  // #833 — 호출자가 동일 series/now로 이미 evaluateWindow를 돌렸다면 결과 재사용.
  const metrics = inputs.metrics ?? evaluateWindow(inputs.series, inputs.now);

  // #2014 (ADR-022 B8) — archFlag=on 시 #9 만 평가 후 즉시 pass. 나머지 게이트는 skip.
  // arvlCd=1 관측 기반 fire 정책은 caller(scheduled.ts) 가 별도 검증한다.
  if (inputs.archFlag === 'on') {
    return { pass: true, metrics, fusedSpeedKmh: 0 };
  }

  const gpsDependentBypass = isGpsDependentBypassEnv(inputs.environment);

  // surface / undefined 만 GPS 의존 게이트 평가 — underground/mixed/unknown 은 byPass.
  if (!gpsDependentBypass) {
    const geomOutcome = evaluateGpsGeometryGates(inputs, metrics);
    if (geomOutcome) return geomOutcome;
  }

  // #8 — motion 게이트. 환경에 따라 정책이 다르다.
  //
  // GPS-bypass 환경(underground/mixed/unknown):
  //   iOS CMMotionActivity는 trip 시작 직후 5~10분 lag으로 unknown 상태가 normal.
  //   지하에서는 walking/automotive 수렴까지 시간이 더 필요하므로 unknown 허용.
  //   단, count=0(series 완전 비어 있음)은 "warmup lag"이 아닌 "데이터 전무" — no-candidates로 차단.
  //   (#1886 RC-2: window-too-small → no-candidates로 reason 통일)
  //   stationary만 차단 — 이동 중 아님이 확실한 경우만.
  //   caller consensusGate(arrival+lockAttachable 2-of-2)가 false positive를 추가 차단.
  //   (#1820: Day 2 production 36건 evidence — environment=unknown + motion=unknown 100% 차단)
  //
  // GPS 환경(surface/undefined):
  //   기존 정책 유지 — walking/automotive만 통과.
  if (gpsDependentBypass) {
    if (metrics.count === 0) {
      return { pass: false, reason: 'no-candidates', metrics };
    }
    if (metrics.motion === 'stationary') {
      return { pass: false, reason: 'motion-stationary', metrics };
    }
    // walking / automotive / unknown 모두 통과
  } else {
    if (metrics.motion !== 'walking' && metrics.motion !== 'automotive') {
      return { pass: false, reason: 'motion-not-moving', metrics };
    }
  }

  // #7 — fused speed. GPS bypass 분기는 fusedSpeed 산출 자체가 의미 없어 0 으로 표기.
  if (gpsDependentBypass) {
    return { pass: true, metrics, fusedSpeedKmh: 0 };
  }
  const speedOutcome = evaluateFusedSpeedGate(inputs, metrics);
  if (!speedOutcome.pass) {
    return { pass: false, reason: speedOutcome.reason, metrics };
  }
  return { pass: true, metrics, fusedSpeedKmh: speedOutcome.fusedSpeedKmh };
}

/**
 * trip의 boarding-prompt state를 발사 시점 또는 dismiss 시점에 갱신해 반환.
 * caller는 결과를 trip에 set 후 KV 저장.
 */
export function markPromptFired(now: number): BoardingPromptState {
  return { fired: true, lastFiredAt: now };
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
