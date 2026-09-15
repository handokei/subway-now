/**
 * #2594 (옵션 D) — 재평가 빈도 계측.
 *
 * 배경: `reject:candidate-distance 강남구청(7) ×345/10초` 같은 집계는 "재평가 빈도"와
 * "재평가 1회당 reject 후보 수"의 곱이다(`pushCandidateRejectEntry`는 후보 1개당 1건 push —
 * candidateRejectBuffer.ts 확인됨). 이 분해 없이는 GPS fix 자체가 폭주하는지(옵션 A/C 방향)
 * 아니면 fix당 reject 후보 수가 많은 것인지(옵션 B 방향)를 코드만으로 확정할 수 없다
 * (#2594 RCA §2 "정확한 분해는 코드만으로 확정 불가").
 *
 * 본 모듈은 순수 관측이다 — GPS watch 옵션(distanceInterval/timeInterval/accuracy),
 * setUserLocation 디바운스, candidate reject 집계(candidateRejectBuffer)는 전혀 건드리지
 * 않는다. barometerState.ts와 동일한 ambient module 패턴(module-level singleton, React state
 * 아님) — record 호출 자체가 setState를 유발하지 않아 계측이 문제(재평가 폭주) 자체를 키우지
 * 않는다. ring buffer는 고정 capacity(20) O(1) 갱신 — 매 fix/재평가마다 GC 압박 없음.
 *
 * DebugModal이 5s 폴링(barometerInstrumentation과 동일 cadence)으로
 * `getReevalInstrumentationSnapshot()`을 직접 pull한다.
 */

/** ring buffer에 보관할 최근 이벤트 timestamp 수. #2618/#2626과 동일하게 가벼운 고정 capacity. */
const RING_CAPACITY = 20;

interface EventTracker {
  timestamps: number[];
}

function createEventTracker(): EventTracker {
  return { timestamps: [] };
}

function recordEvent(tracker: EventTracker, ts: number): void {
  tracker.timestamps.push(ts);
  if (tracker.timestamps.length > RING_CAPACITY) tracker.timestamps.shift();
}

export interface RateSnapshot {
  /** ring buffer에 현재 보관 중인 timestamp 수(0~RING_CAPACITY). */
  sampleCount: number;
  /** 최근 표본 구간의 평균 inter-arrival 간격(ms). 표본 2개 미만이면 null. */
  avgIntervalMs: number | null;
  /** 최근 표본 구간의 최소 inter-arrival 간격(ms). 표본 2개 미만이면 null. */
  minIntervalMs: number | null;
  /** 최근 표본 구간의 최대 inter-arrival 간격(ms). 표본 2개 미만이면 null. */
  maxIntervalMs: number | null;
  /** avgIntervalMs로 환산한 초당 이벤트 수. 표본 2개 미만이면 null. */
  perSecond: number | null;
}

function snapshotRate(tracker: EventTracker): RateSnapshot {
  const ts = tracker.timestamps;
  if (ts.length < 2) {
    return {
      sampleCount: ts.length,
      avgIntervalMs: null,
      minIntervalMs: null,
      maxIntervalMs: null,
      perSecond: null,
    };
  }
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 1; i < ts.length; i += 1) {
    const delta = ts[i] - ts[i - 1];
    sum += delta;
    if (delta < min) min = delta;
    if (delta > max) max = delta;
  }
  const avgIntervalMs = sum / (ts.length - 1);
  return {
    sampleCount: ts.length,
    avgIntervalMs,
    minIntervalMs: min,
    maxIntervalMs: max,
    perSecond: avgIntervalMs > 0 ? 1000 / avgIntervalMs : null,
  };
}

const gpsFixTracker = createEventTracker();
const candidatesRecomputeTracker = createEventTracker();
const candidateDistanceFireTracker = createEventTracker();
const candidateEnvFireTracker = createEventTracker();

let candidateDistanceFireTotal = 0;
let candidateDistanceRejectTotal = 0;
let candidateEnvFireTotal = 0;
let candidateEnvRejectTotal = 0;

/**
 * FG GPS watch 콜백의 실제 도착 지점에서 호출(useNearestStation.ts). 표시 게이트 통과 여부와
 * 무관하게 모든 콜백 진입을 기록해야 "실제 CoreLocation 도착 빈도"를 잰다 — 게이트 통과 fix만
 * 세면 표시 게이트에서 걸러진 burst를 놓친다.
 */
export function recordGpsFixArrival(ts: number = Date.now()): void {
  recordEvent(gpsFixTracker, ts);
}

/**
 * `candidates` useMemo(useFusedNearestStation.ts)가 실제로 528역 스캔을 재수행할 때(정지
 * backoff로 캐시를 재사용하는 분기는 제외) 호출.
 */
export function recordCandidatesRecompute(ts: number = Date.now()): void {
  recordEvent(candidatesRecomputeTracker, ts);
}

/**
 * `candidateTrains` useMemo 1회 실행(=1회 재평가) 종료 시 호출. `rejectCount`는 그 1회
 * 실행에서 `onCandidateDistanceReject`가 호출된 총 횟수 — "재평가 1회당 reject 후보 수"를
 * 분해하기 위한 값.
 */
export function recordCandidateDistanceFire(rejectCount: number, ts: number = Date.now()): void {
  recordEvent(candidateDistanceFireTracker, ts);
  candidateDistanceFireTotal += 1;
  candidateDistanceRejectTotal += rejectCount;
}

/**
 * `candidate-env` useEffect 1회 실행(=1회 재평가) 종료 시 호출. `rejectCount`는 그 1회
 * 실행에서 environment mismatch로 판정된 candidate 수.
 */
export function recordCandidateEnvFire(rejectCount: number, ts: number = Date.now()): void {
  recordEvent(candidateEnvFireTracker, ts);
  candidateEnvFireTotal += 1;
  candidateEnvRejectTotal += rejectCount;
}

export interface FireRateSnapshot extends RateSnapshot {
  /** 세션 누적 발화(재평가) 횟수 — ring buffer TTL/overwrite와 무관하게 계속 증가. */
  fireTotal: number;
  /** 세션 누적 reject 후보/열차 수. */
  rejectTotal: number;
  /** rejectTotal / fireTotal — 발화 1회당 평균 reject 수. fireTotal=0이면 null. */
  avgRejectPerFire: number | null;
}

export interface ReevalInstrumentationSnapshot {
  gpsFix: RateSnapshot;
  candidatesRecompute: RateSnapshot;
  candidateDistance: FireRateSnapshot;
  candidateEnv: FireRateSnapshot;
}

function buildFireRateSnapshot(
  tracker: EventTracker,
  fireTotal: number,
  rejectTotal: number,
): FireRateSnapshot {
  return {
    ...snapshotRate(tracker),
    fireTotal,
    rejectTotal,
    avgRejectPerFire: fireTotal > 0 ? rejectTotal / fireTotal : null,
  };
}

/** 현재 계측 스냅샷. DebugModal이 직접 pull(barometerInstrumentation과 동일 패턴). */
export function getReevalInstrumentationSnapshot(): ReevalInstrumentationSnapshot {
  return {
    gpsFix: snapshotRate(gpsFixTracker),
    candidatesRecompute: snapshotRate(candidatesRecomputeTracker),
    candidateDistance: buildFireRateSnapshot(
      candidateDistanceFireTracker,
      candidateDistanceFireTotal,
      candidateDistanceRejectTotal,
    ),
    candidateEnv: buildFireRateSnapshot(
      candidateEnvFireTracker,
      candidateEnvFireTotal,
      candidateEnvRejectTotal,
    ),
  };
}

/** 테스트 전용 — 모든 tracker/누적 카운터 초기화. */
export function resetReevalInstrumentationForTest(): void {
  gpsFixTracker.timestamps = [];
  candidatesRecomputeTracker.timestamps = [];
  candidateDistanceFireTracker.timestamps = [];
  candidateEnvFireTracker.timestamps = [];
  candidateDistanceFireTotal = 0;
  candidateDistanceRejectTotal = 0;
  candidateEnvFireTotal = 0;
  candidateEnvRejectTotal = 0;
}
