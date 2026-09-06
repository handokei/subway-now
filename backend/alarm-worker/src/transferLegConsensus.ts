/**
 * transferLegConsensus — 환승 leg 후보 열차 consensus 엔진 + 상태기계 (#2327, consensus-A).
 *
 * 설계 SSoT: #2323 2026-08-13 설계안 코멘트 (판정식·창 산출·상태전이·fail mode 방어).
 * 08-12 실탑승(중곡 25분 침묵) 사후 페이퍼 시뮬레이션이 본 엔진의 파라미터 기준선이다:
 * W=278s(건대입구 2→7 transferTimes), H=210s(lineHeadways), hop 80s×4(stationTravelTimes).
 *
 * 본 모듈은 **순수 함수 + 상태기계**만 제공한다. Seoul API 신규 호출, D1/KV write, fire/advance
 * wire(#2329 consensus-C 범위)는 포함하지 않는다 — `pollStationsAndStamp`/`pollLinesAndStamp`
 * 산출물(관측된 열차 출발/도착 시각)을 caller가 넘겨주는 소비자 역할만 한다.
 *
 * ## 판정식
 * - T0 = transfer waypoint 통과 확정 시각. 후보 = toLine 환승역 출발 관측 열차 중
 *   `T_dep ∈ [T0+0.5W, T0+1.5W+H]` (핵심 창 [T0+W, T0+W+H], 폭=headway→기대 1대).
 *   0.5W 이전 출발(앞차/반대방향)은 hard reject — 애초에 candidates에 진입시키지 않는다.
 * - confidence: 후속 waypoint 관측에서 후보 trainCode 시각 |Δ|≤90s → match+1,
 *   |Δ|>180s 또는 3-tick 연속 미관측 → mismatch+1. `fetchedAt` age>30s(outage)인 tick은
 *   미집계 — confidence hold(소멸 유예), match/mismatch/missedTicks 모두 동결.
 * - confirmed ⟺ core 창 단일 생존(mismatch=0) ∧ match≥2. ambiguous(생존 2+)는
 *   `hopsRemainingToTerminus`가 SUPPRESS_HOPS_TO_TERMINUS 이하로 좁혀질 때까지 미해소 시 suppress.
 * - confirmed 후 mismatch 2연속 → demote(발사권 즉시 회수, terminal).
 * - 전 후보 mismatch(생존 0) → 자연 suppress (fail mode: route 오등록 대비).
 * - suppress 시 최후 생존 후보 중 최늦 T_dep을 `suppressFloorEpochMs`로 반환 —
 *   #2155 floor 위임(조기 발사 불가 방향 정합)은 caller(consensus-C) 책임.
 *
 * `LegConsensusRecord`는 trip KV 객체 내 `legConsensus` 필드로 저장된다(별도 KV row 금지 —
 * #2073 cron KV quota lesson). D1 `trip_events` kind `consensus-confirm/demote/suppress`는
 * `tripEventLog.ts`의 `TripEventKind` 유니온에 추가되어 있다 — 실제 insert 호출(wire)은
 * consensus-C(#2329) 범위.
 */

/** 판정식 임계값 — 데이터 주도 확장 시 이 상수만 변경한다(코드 분기 하드코딩 금지). */
export const MATCH_THRESHOLD_SEC = 90;
export const MISMATCH_THRESHOLD_SEC = 180;
export const STALE_AGE_THRESHOLD_SEC = 30;
export const MISSED_TICK_MISMATCH_COUNT = 3;
export const CONFIRM_MIN_MATCH_COUNT = 2;
export const DEMOTE_MISMATCH_STREAK = 2;
export const SUPPRESS_HOPS_TO_TERMINUS = 2;

/** 후보 창(candidate window) — T0/transferTimeSec(W)/headwaySec(H)로 산출. */
export interface CandidateWindow {
  /** 0.5W 이전 하한 — 이보다 이른 출발은 hard reject (앞차/반대방향). */
  earliestAllowedEpochMs: number;
  /** T0+W — 핵심 창 시작. */
  coreStartEpochMs: number;
  /** T0+W+H — 핵심 창 끝(폭=headway). */
  coreEndEpochMs: number;
  /** 1.5W+H 이후 상한 — 이보다 늦은 출발은 hard reject. */
  latestAllowedEpochMs: number;
}

/**
 * 후보 창 산출. transferTimeSec(W)/headwaySec(H)는 caller가 transferTimes/lineHeadways
 * 데이터셋에서 조회해 전달한다(본 엔진은 역/노선별 하드코딩 분기를 두지 않는다).
 */
export function computeCandidateWindow(
  t0EpochMs: number,
  transferTimeSec: number,
  headwaySec: number,
): CandidateWindow {
  const wMs = transferTimeSec * 1000;
  const hMs = headwaySec * 1000;
  return {
    earliestAllowedEpochMs: t0EpochMs + 0.5 * wMs,
    coreStartEpochMs: t0EpochMs + wMs,
    coreEndEpochMs: t0EpochMs + wMs + hMs,
    latestAllowedEpochMs: t0EpochMs + 1.5 * wMs + hMs,
  };
}

/** 관측된 출발 시각이 후보 창 안인지(hard reject 여부). */
export function isDepartureEligible(window: CandidateWindow, departureEpochMs: number): boolean {
  return (
    departureEpochMs >= window.earliestAllowedEpochMs &&
    departureEpochMs <= window.latestAllowedEpochMs
  );
}

/** 상태기계 상태. tracking(생존 1, match 축적중)/ambiguous(생존 2+)/confirmed/demoted/suppressed. */
export type LegConsensusStatus = 'tracking' | 'ambiguous' | 'confirmed' | 'demoted' | 'suppressed';

/** 개별 후보 열차의 누적 관측 카운트. */
export interface LegConsensusCandidateState {
  trainCode: string;
  departureEpochMs: number;
  matchCount: number;
  mismatchCount: number;
  /** 연속 미관측 tick 수 — MISSED_TICK_MISMATCH_COUNT 도달 시 mismatch로 집계 후 0으로 리셋. */
  missedTicks: number;
}

/** trip KV 객체 내 `legConsensus` 필드로 영속되는 상태기계 스냅샷. */
export interface LegConsensusRecord {
  status: LegConsensusStatus;
  t0EpochMs: number;
  transferTimeSec: number;
  headwaySec: number;
  window: CandidateWindow;
  candidates: LegConsensusCandidateState[];
  confirmedTrainCode?: string;
  /** confirmed 상태에서의 연속 mismatch 카운트 — DEMOTE_MISMATCH_STREAK 도달 시 demote. */
  confirmedMismatchStreak: number;
  /** suppress 시 최후 생존 후보 중 최늦 T_dep 기반 도착 추정 — #2155 floor 위임 입력(consensus-C). */
  suppressFloorEpochMs?: number;
  updatedAt: number;
}

/** T0 시점에 관측된 toLine 환승역 출발 열차. */
export interface ObservedDeparture {
  trainCode: string;
  departureEpochMs: number;
}

/**
 * 상태기계 초기화. 창 밖 출발 관측은 candidates에서 필터링되어 애초에 진입하지 못한다
 * (반대방향/앞차 hard reject → 어떤 tick을 진행해도 confirmed 불가, acceptance ②).
 */
export function initLegConsensus(
  t0EpochMs: number,
  transferTimeSec: number,
  headwaySec: number,
  observedDepartures: readonly ObservedDeparture[],
  now: number = t0EpochMs,
): LegConsensusRecord {
  const window = computeCandidateWindow(t0EpochMs, transferTimeSec, headwaySec);
  const candidates: LegConsensusCandidateState[] = observedDepartures
    .filter((d) => isDepartureEligible(window, d.departureEpochMs))
    .map((d) => ({
      trainCode: d.trainCode,
      departureEpochMs: d.departureEpochMs,
      matchCount: 0,
      mismatchCount: 0,
      missedTicks: 0,
    }));
  return {
    status: candidates.length >= 2 ? 'ambiguous' : 'tracking',
    t0EpochMs,
    transferTimeSec,
    headwaySec,
    window,
    candidates,
    confirmedMismatchStreak: 0,
    updatedAt: now,
  };
}

/** 한 tick의 후보별 관측. deltaSec 미지정 = 이번 tick에 관측되지 않음(missed). */
export interface CandidateObservation {
  trainCode: string;
  /** 관측 시각 - 예측 시각 (초). |Δ|≤90 → match, |Δ|>180 → mismatch, 그 사이는 중립. */
  deltaSec?: number;
  /** poll 데이터의 fetchedAt 나이(초). STALE_AGE_THRESHOLD_SEC 초과 시 미집계(outage 준용). */
  fetchedAtAgeSec?: number;
}

export interface LegConsensusTick {
  now: number;
  /** 전체 outage(API 장애 등) — true면 이 tick은 모든 후보에 대해 완전 무집계(confidence hold). */
  outage?: boolean;
  observations?: readonly CandidateObservation[];
  /** 종점까지 남은 hop 수 — ambiguous suppress 데드라인 판정에만 사용. */
  hopsRemainingToTerminus?: number;
}

export type LegConsensusEventKind = 'consensus-confirm' | 'consensus-demote' | 'consensus-suppress';

/** caller(consensus-C)가 D1 trip_events에 append할 이벤트 descriptor. 본 모듈은 write하지 않는다. */
export interface LegConsensusEvent {
  kind: LegConsensusEventKind;
  trainCode?: string;
  meta?: Record<string, unknown>;
}

export interface LegConsensusStepResult {
  record: LegConsensusRecord;
  events: LegConsensusEvent[];
}

function evaluateDelta(deltaSec: number): 'match' | 'mismatch' | 'neutral' {
  const absDelta = Math.abs(deltaSec);
  if (absDelta <= MATCH_THRESHOLD_SEC) return 'match';
  if (absDelta > MISMATCH_THRESHOLD_SEC) return 'mismatch';
  return 'neutral';
}

function isStale(obs: CandidateObservation | undefined): boolean {
  return obs?.fetchedAtAgeSec !== undefined && obs.fetchedAtAgeSec > STALE_AGE_THRESHOLD_SEC;
}

function stepConfirmed(record: LegConsensusRecord, tick: LegConsensusTick): LegConsensusStepResult {
  const obs = record.confirmedTrainCode
    ? (tick.observations ?? []).find((o) => o.trainCode === record.confirmedTrainCode)
    : undefined;

  let streak = record.confirmedMismatchStreak;
  if (obs && !isStale(obs) && obs.deltaSec !== undefined) {
    const outcome = evaluateDelta(obs.deltaSec);
    if (outcome === 'mismatch') streak += 1;
    else if (outcome === 'match') streak = 0;
  }

  if (streak >= DEMOTE_MISMATCH_STREAK) {
    return {
      record: { ...record, status: 'demoted', confirmedMismatchStreak: streak, updatedAt: tick.now },
      events: [{ kind: 'consensus-demote', trainCode: record.confirmedTrainCode }],
    };
  }
  return {
    record: { ...record, confirmedMismatchStreak: streak, updatedAt: tick.now },
    events: [],
  };
}

function stepTrackingOrAmbiguous(
  record: LegConsensusRecord,
  tick: LegConsensusTick,
): LegConsensusStepResult {
  const observationsByCode = new Map((tick.observations ?? []).map((o) => [o.trainCode, o]));

  const nextCandidates = record.candidates.map((c) => {
    const obs = observationsByCode.get(c.trainCode);
    if (!obs) {
      const missedTicks = c.missedTicks + 1;
      if (missedTicks >= MISSED_TICK_MISMATCH_COUNT) {
        return { ...c, missedTicks: 0, mismatchCount: c.mismatchCount + 1 };
      }
      return { ...c, missedTicks };
    }
    if (isStale(obs) || obs.deltaSec === undefined) {
      // outage/stale 개별 관측 — 미집계(hold), missedTicks도 동결.
      return c;
    }
    const outcome = evaluateDelta(obs.deltaSec);
    if (outcome === 'match') return { ...c, matchCount: c.matchCount + 1, missedTicks: 0 };
    if (outcome === 'mismatch') return { ...c, mismatchCount: c.mismatchCount + 1, missedTicks: 0 };
    return { ...c, missedTicks: 0 };
  });

  const survivors = nextCandidates.filter((c) => c.mismatchCount === 0);
  const latestDeparture = (list: LegConsensusCandidateState[]): number | undefined =>
    list.length === 0
      ? undefined
      : list.reduce((max, c) => Math.max(max, c.departureEpochMs), -Infinity);

  if (survivors.length === 0) {
    return {
      record: {
        ...record,
        candidates: nextCandidates,
        status: 'suppressed',
        suppressFloorEpochMs: latestDeparture(nextCandidates),
        updatedAt: tick.now,
      },
      events: [{ kind: 'consensus-suppress', meta: { reason: 'all-mismatch' } }],
    };
  }

  if (survivors.length === 1) {
    const [survivor] = survivors;
    if (survivor.matchCount >= CONFIRM_MIN_MATCH_COUNT) {
      return {
        record: {
          ...record,
          candidates: nextCandidates,
          status: 'confirmed',
          confirmedTrainCode: survivor.trainCode,
          confirmedMismatchStreak: 0,
          updatedAt: tick.now,
        },
        events: [{ kind: 'consensus-confirm', trainCode: survivor.trainCode }],
      };
    }
    return {
      record: { ...record, candidates: nextCandidates, status: 'tracking', updatedAt: tick.now },
      events: [],
    };
  }

  // survivors.length >= 2 → ambiguous. 종점 임박 시에만 suppress로 해소.
  if (
    tick.hopsRemainingToTerminus !== undefined &&
    tick.hopsRemainingToTerminus <= SUPPRESS_HOPS_TO_TERMINUS
  ) {
    return {
      record: {
        ...record,
        candidates: nextCandidates,
        status: 'suppressed',
        suppressFloorEpochMs: latestDeparture(survivors),
        updatedAt: tick.now,
      },
      events: [{ kind: 'consensus-suppress', meta: { reason: 'ambiguous-near-terminus' } }],
    };
  }

  return {
    record: { ...record, candidates: nextCandidates, status: 'ambiguous', updatedAt: tick.now },
    events: [],
  };
}

/**
 * 상태기계 1 tick 진행. `demoted`/`suppressed`는 terminal — 이후 tick은 timestamp만 갱신하고
 * 카운트/상태는 불변이다.
 */
export function stepLegConsensus(
  record: LegConsensusRecord,
  tick: LegConsensusTick,
): LegConsensusStepResult {
  if (record.status === 'demoted' || record.status === 'suppressed') {
    return { record: { ...record, updatedAt: tick.now }, events: [] };
  }

  if (tick.outage) {
    // §(4) fail mode 방어: outage=confidence hold(소멸 유예), mismatch 미집계.
    return { record: { ...record, updatedAt: tick.now }, events: [] };
  }

  if (record.status === 'confirmed') {
    return stepConfirmed(record, tick);
  }

  return stepTrackingOrAmbiguous(record, tick);
}
