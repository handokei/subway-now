/**
 * Cron 핸들러 — 활성 트립 enumerate → 알람 윈도우(5분 이내) 트립만 폴링 → ETA 평가 → push 발사.
 */

import { ARRIVAL_CODE, TRAIN_STATUS } from './alarm';
import { evaluateAccelWindow, readAccelSeries } from './accelSeries';
import {
  sendBoardingPromptPush,
  sendReschedulePush,
  sendSilentPush,
  type ApnsConfig,
  type SendPushResult,
} from './apns';
import { flipApnsEnv, pickApnsHost } from './apnsHost';
import {
  evaluateBoardingPromptGates,
  markPromptFired,
  type GateSkipReason,
} from './boardingPrompt';
import {
  detectKalmanDrift,
  readKalmanState,
  resetKalmanForArrival,
  runKalmanStep,
  writeKalmanState,
} from './kalmanFilter';
import {
  buildLiveActivityContentState,
  cleanupTripWithLa,
  fireLiveActivityUpdate,
  type LiveActivityStats,
} from './liveActivity';
import { matchLine } from './lineAlias';
import {
  evaluateWindow,
  readSeries,
  type WindowedMetrics,
} from './positionSeries';
import { getProgress, putProgress, type TripProgress } from './progress';
import { SeoulArrivalClient, type ArrivalEntry, type PositionEntry } from './seoul';
import { phaseAllowsImminentFiring, runStationPhaseStep } from './stationPhase';
import { listTrips, putTrip } from './trips';
import type {
  ApnsEnv,
  BoardingLockMeta,
  Env,
  PositionPoint,
  StationPhaseState,
  Trip,
  Waypoint,
} from './types';

// pickApnsHost / flipApnsEnv는 ./apnsHost로 이동 (liveActivity.ts와 공유 SSOT, #482).
// 외부(테스트 / index.ts 등)가 scheduled.ts 경유로 import하던 호환성 유지를 위해 re-export.
export { flipApnsEnv, pickApnsHost };

/** 알람 윈도우: 알람 예상 시각 5분 이내인 트립만 폴링한다. */
const POLLING_WINDOW_MS = 5 * 60 * 1000;

/**
 * boardingLock 추적에서 reschedule push를 발사할 변동 임계치 (#585).
 * 새 도착 예측이 마지막으로 디바이스에 통지한 값과 이 이상 어긋날 때만 push.
 * 15s = Seoul API barvlDt 단위(60s)의 1/4 — 노이즈는 줄이고 의미있는 변동은 잡는다.
 */
export const RESCHEDULE_THRESHOLD_MS = 15_000;

/** boardingLock fallback에서 hop당 기본 소요(90s). 환승역 등 실제 hop은 후속 데이터로 정밀화. */
const FALLBACK_HOP_SEC = 90;

/**
 * LA update push 발사 임계치 (#586 D). reschedule push의 15s 임계와는 별개 — LA는 화면 표시용이라
 * 더 듬성듬성 보내도 사용자가 인지하지 못하고, APNs LA budget(앱당 분당 ~60건)이 빠듯하다.
 * 새 추정 도착 epoch이 lastLaPushEpoch와 30s 이상 차이날 때만 발사.
 */
export const LA_PUSH_THRESHOLD_MS = 30_000;

/**
 * 연속 etaMissing 임계치 (#706). 한 trip이 N회 연속 trainCode 매칭 실패면 자동 종료.
 * 운행 시간대 외(새벽)에 trainCode가 Seoul API에서 사라지면 무한 폴링하던 회귀(8h × 1/min) 방지.
 * cron 주기 60s × 5회 = 5분 — 일시적 API 누락은 흡수하고 운행 종료/탈선 신호는 잡는다.
 */
export const MAX_CONSECUTIVE_ETA_MISSING = 5;

/**
 * cron이 progress KV를 read할 때의 cacheTtl (#766/#770).
 * POST `/trips`가 putProgress 직후 같은 cron 사이클에서 옛 값을 읽지 않도록 30s까지 단축.
 * trips.ts/pendingPushes.ts의 cron read와 동일 정책. Cloudflare KV는 cacheTtl<30s 시
 * 런타임에서 `Invalid cache_ttl` 던짐(#770 hotfix).
 */
const CRON_PROGRESS_CACHE_TTL_SEC = 30;

export interface EnvHealResult {
  result: SendPushResult;
  /** retry로 정정된 새 env. 정정 발생 시에만 set. */
  correctedEnv?: ApnsEnv;
  /** 양쪽 host 모두 BadDeviceToken — 토큰 자체 무효 신호. */
  envMismatchExhausted: boolean;
}

/**
 * APNs env mismatch self-heal (#482). 1차 호출 → BadDeviceToken이면 opposite host로 1회 retry.
 * `sender`는 host를 받아 push를 보내는 클로저 — phase push / reschedule push 양쪽에서 재사용.
 *
 * 호출자 책임:
 *   - correctedEnv set → trip.apnsEnv 갱신 + envCorrected stat 카운트
 *   - envMismatchExhausted true → trip 삭제
 *   - result.ok / !ok 분기는 각 경로별 후처리에 맡김
 */
export async function sendWithEnvHeal(
  sender: (host: string) => Promise<SendPushResult>,
  currentEnv: ApnsEnv | undefined,
  apnsHosts: Record<ApnsEnv, string>,
  log: Logger,
  tokenForLog: string,
): Promise<EnvHealResult> {
  const initial = await sender(pickApnsHost(currentEnv, apnsHosts));
  if (initial.ok || !isApnsEnvMismatch(initial.status, initial.reason)) {
    return { result: initial, envMismatchExhausted: false };
  }
  const corrected = flipApnsEnv(currentEnv);
  log('apns env mismatch — retry with opposite host', {
    token: tokenForLog,
    from: currentEnv ?? 'sandbox',
    to: corrected,
  });
  const retry = await sender(apnsHosts[corrected]);
  if (retry.ok) {
    log('apns env corrected', { token: tokenForLog, to: corrected });
    return { result: retry, correctedEnv: corrected, envMismatchExhausted: false };
  }
  return {
    result: retry,
    envMismatchExhausted: isApnsEnvMismatch(retry.status, retry.reason),
  };
}

type Logger = (message: string, meta?: Record<string, unknown>) => void;

export interface ScheduledStats extends LiveActivityStats {
  scanned: number;
  polled: number;
  pushed: number;
  errors: number;
  /** Seoul API 응답이 비어 ETA를 산출하지 못한 트립 수 (운영 가시성용). */
  etaMissing: number;
  /**
   * BadDeviceToken으로 1차 host에서 거부됐다가 반대 host로 self-heal 성공해
   * `trip.apnsEnv`를 정정한 카운트. 운영 메트릭 — 이 값이 0이 아니면
   * 클라이언트 hint가 빌드 환경과 어긋나고 있다는 신호 (#482).
   */
  envCorrected: number;
  /**
   * BoardingLock 부재/만료로 발사 게이트에서 스킵된 트립 수 (#640).
   * 사용자가 열차 미선택 상태에서 noise push가 발사되지 않도록 차단된 결과.
   */
  lockMissing: number;
  /**
   * #816 C — lockless opt-in 토글 ON trip에서 station-passed(intermediate) push가 발사된 횟수.
   * false-positive 측정 인프라 — 사용자 dismiss/탭률은 client alarmLog로 별도 적재된다.
   * (lockMissing은 토글 OFF로 게이트 차단된 trip만 카운트되도록 유지 — 두 stat은 disjoint.)
   */
  locklessIntermediateFired: number;
  /** #819 — boarding-prompt 게이트 평가가 한 번이라도 시도된 trip 수 (lockMissing 부분집합). */
  boardingPromptEvaluated: number;
  /** #819 — 9단 AND 게이트를 모두 통과해 alert push가 발사된 횟수 (측정 인프라). */
  boardingPromptFired: number;
  /** #819 — 게이트 차단으로 미발사한 횟수 — false positive 1차 방어 효과 측정. */
  boardingPromptBlocked: number;
  /**
   * #825 — phase 분류가 'high-confidence non-APPROACHING'으로 lockless imminent 발사를
   * 차단한 횟수. 측정 인프라 — gate가 실제로 발동된 빈도 + E5 RMSE/recall과 cross-check.
   */
  phaseImminentBlocked: number;
  /**
   * #826 — arvlCd=ARRIVED ground truth로 Kalman state hard reset된 횟수 (v=0/P=R_LOW).
   * lockless ARRIVED 또는 boardingLock trainCode arrived 시점에 발사. drift 누적 차단.
   */
  kalmanReset: number;
  /**
   * #826 — 정상 cycle에서 |gpsAvgKmh - state.v| ≥ DRIFT_WARNING_THRESHOLD_KMH인 누적 횟수.
   * 누적이 의미있게 커지면 Kalman 튜닝(R/Q) 재측정 또는 reset 정책 조정 신호.
   */
  kalmanDriftWarning: number;
}

/**
 * BoardingLock이 활성 상태인지 (#640 게이트).
 * 부재거나 만료된 경우 false — push 발사 경로를 모두 차단한다.
 * type predicate로 선언해 호출부에서 `trip.boardingLock` non-null narrowing이 자동 적용된다.
 */
export function isBoardingLockActive(
  trip: Trip,
  now: number,
): trip is Trip & { boardingLock: BoardingLockMeta } {
  return trip.boardingLock !== undefined && trip.boardingLock.expiresAt > now;
}

export interface ScheduledDeps {
  seoul: SeoulArrivalClient;
  apnsConfig: ApnsConfig;
  /** APNs host 매핑. trip.apnsEnv에 따라 선택. */
  apnsHosts: Record<ApnsEnv, string>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (message: string, meta?: Record<string, unknown>) => void;
  /** pushId 발급 — 테스트에선 결정적 값을 주입한다. 기본은 crypto.randomUUID. */
  generatePushId?: () => string;
}

export async function runScheduled(env: Env, deps: ScheduledDeps): Promise<ScheduledStats> {
  const now = deps.now?.() ?? Date.now();
  const log = deps.log ?? (() => undefined);
  const generatePushId = deps.generatePushId ?? (() => crypto.randomUUID());
  const stats: ScheduledStats = {
    scanned: 0,
    polled: 0,
    pushed: 0,
    errors: 0,
    etaMissing: 0,
    envCorrected: 0,
    lockMissing: 0,
    locklessIntermediateFired: 0,
    laPushSent: 0,
    laPushFailed: 0,
    laTokenCleared: 0,
    boardingPromptEvaluated: 0,
    boardingPromptFired: 0,
    boardingPromptBlocked: 0,
    phaseImminentBlocked: 0,
    kalmanReset: 0,
    kalmanDriftWarning: 0,
  };

  for await (const trip of listTrips(env.TRIPS)) {
    stats.scanned += 1;

    if (trip.expiresAt <= now) {
      // #586 D — trip 만료 시 활성 LA가 남아 있으면 dismissal push로 정리하고 KV에서 제거.
      await cleanupTripWithLa(trip, env, deps, stats, now, log);
      continue;
    }

    if (trip.alarmAtEpochMs - now > POLLING_WINDOW_MS) {
      // 아직 알람 윈도우 진입 전 — 폴링 스킵
      continue;
    }

    const waypoint = pickActiveWaypoint(trip);
    if (!waypoint) continue;

    // #764/#622 — cron이 KV에서 읽은 trip의 boardingLock 추적 (root cause sub-step 좁힘용,
    // 확정 후 제거). POST /trips의 `PUT trip after merge` 로그와 cross-check해 KV 쓰기/
    // 읽기 사이에 trainCode가 어떻게 보이는지 한 사이클 단위로 확정한다.
    log('cron loaded trip', {
      token: trip.token.slice(0, 8),
      loadedTrainCode: trip.boardingLock?.trainCode,
      waypointStation: waypoint.stationName,
    });

    // #640 — BoardingLock 게이트. 사용자가 열차를 아직 선택하지 않았거나 lock이 만료된 trip은
    // Seoul polling/push 모두 skip. 디바이스는 lock 등록 후 train-code 단위로 정확히 추적하며,
    // lock 부재 상태에서의 phase-based push는 "탑승 전 노이즈"였다.
    if (!isBoardingLockActive(trip, now)) {
      // #816 C — lockless opt-in trip은 게이트 우회. lock 없이도 intermediate waypoint 통과
      // 시 station-passed push 발사. 사용자가 명시 동의(client 토글)한 trip에 한정한다.
      // intermediate kind가 아니면(transfer/destination) 여전히 skip — trainCode 없이 발사하면
      // 잘못된 leg/방향으로 갈 위험.
      if (trip.locklessStationPassed && waypoint.kind === 'intermediate') {
        try {
          await runLocklessIntermediate(trip, waypoint, env, deps, stats, now, log, generatePushId);
        } catch (e) {
          stats.errors += 1;
          log('lockless: poll error', { error: String(e), token: trip.token.slice(0, 8) });
        }
        continue;
      }
      stats.lockMissing += 1;
      log('boarding-lock: skip cycle (lock missing or expired)', {
        token: trip.token.slice(0, 8),
        station: waypoint.stationName,
        locklessOptIn: trip.locklessStationPassed === true,
        waypointKind: waypoint.kind,
      });
      // #819 — lock 미발생 trip에 boarding-prompt 9단 게이트 평가 분기. 게이트 통과 시 alert
      // push로 "탑승 중이세요?"를 묻고, 클라이언트가 사용자 응답으로 lock을 자동 생성한다.
      // 게이트 자체가 false positive 9중 차단 (ADR Section 2)이라 phase-based 노이즈와 분리.
      try {
        await evaluateAndMaybeFireBoardingPrompt(trip, env, deps, stats, now, log, generatePushId);
      } catch (e) {
        stats.errors += 1;
        log('boarding-prompt: evaluation error', {
          error: String(e),
          token: trip.token.slice(0, 8),
        });
      }
      continue;
    }

    // `polled`는 lock-active trip의 실제 Seoul polling 사이클 수만 카운트 — lockMissing은 별도 stat.
    stats.polled += 1;
    // #585 — boardingLock 활성 trip은 trainCode 단위 추적 + reschedule push 경로로 분기.
    // 디바이스는 사전 예약 알람(#584)으로 SLA를 보장하므로 phase-based silent push는 보내지 않는다.
    try {
      await runTrainCodeTracking(
        trip,
        waypoint,
        trip.boardingLock,
        env,
        deps,
        stats,
        now,
        log,
        generatePushId,
      );
    } catch (e) {
      stats.errors += 1;
      log('boarding-lock: poll error', { error: String(e), token: trip.token.slice(0, 8) });
    }
  }

  log('scheduled run complete', {
    ...stats,
    seoulCalls: deps.seoul.stats.callCount,
  });
  return stats;
}

/** runFusionStep 반환값 — boarding-prompt / lockless-intermediate 분기에서 공통 사용. */
interface FusionStepResult {
  /** 원본 positionSeries (호출자가 evaluateBoardingPromptGates 등에 그대로 전달). */
  series: PositionPoint[];
  /** evaluateWindow 결과 — observation 유효성/window 카운트 평가용. */
  posMetrics: WindowedMetrics;
  /**
   * smoothed velocity를 fusedSpeed에 합류시킬 값 (km/h). null인 경우:
   *  - observation 무효 (Kalman skip)
   *  - prior=null 첫 cycle (state는 persist하지만 fusion 합류 제외 — #832 P2-3 정합)
   */
  kalmanKmh: number | null;
  /** 운행 phase 분류 결과. null인 경우: observation 무효 또는 nearestStationDistanceM 미수신. */
  phaseState: StationPhaseState | null;
}

/**
 * Phase 3 fusion 한 cycle pipeline (#824 E2 + #825 E3).
 *
 *   1. positionSeries + accelSeries + Kalman prior state 병렬 KV read
 *   2. evaluateWindow + evaluateAccelWindow
 *   3. observationValid 가드 — 무효면 state I/O skip (P2-1)
 *   4. runKalmanStep → writeKalmanState
 *   5. prior 부재 첫 cycle은 fusion 합류 제외 (P2-3)
 *   6. runStationPhaseStep — nearestStationDistanceM 없으면 phase null로 graceful skip (#834 wire 전)
 *
 * 호출자 책임:
 *   - phaseState non-null이면 trip.stationPhase에 stamp + putTrip 시 persist
 *   - kalmanKmh를 게이트/fusion 입력으로 전달
 *   - series는 본 함수가 fetched한 raw KV 값 — 추가 read 불필요
 */
async function runFusionStep(
  trip: Trip,
  env: Env,
  now: number,
  stats: ScheduledStats,
): Promise<FusionStepResult> {
  const [series, accelSeries, kalmanPrior] = await Promise.all([
    readSeries(env.TRIPS, trip.token),
    readAccelSeries(env.TRIPS, trip.token),
    readKalmanState(env.TRIPS, trip.token),
  ]);
  const posMetrics = evaluateWindow(series, now);
  const accelMetrics = evaluateAccelWindow(accelSeries, now);
  const observationValid =
    posMetrics.count > 0 && Number.isFinite(posMetrics.avgAccuracyMeters);

  if (!observationValid) {
    return { series, posMetrics, kalmanKmh: null, phaseState: null };
  }

  // #826 — drift 측정은 prior 존재 정상 cycle만. 첫 cycle은 v=gpsAvg 초기화라 delta=0으로 의미 없음.
  if (kalmanPrior !== null) {
    const drift = detectKalmanDrift(kalmanPrior, posMetrics.gpsAvgKmh);
    if (drift.warning) {
      stats.kalmanDriftWarning += 1;
    }
  }

  const kalmanState = runKalmanStep({
    prior: kalmanPrior,
    gpsAvgKmh: posMetrics.gpsAvgKmh,
    gpsAccuracyMeters: posMetrics.avgAccuracyMeters,
    accelMagnitudeStd: accelMetrics.avgMagnitudeStd,
    now,
  });
  await writeKalmanState(env.TRIPS, trip.token, kalmanState);

  // P2-3 정합 — 첫 cycle은 v=gpsAvg라 fusion에 합류 시 같은 GPS 2회 가중 → confidence 가짜
  // 상승. state는 persist 하되 fusion 입력에서는 제외.
  const kalmanKmh = kalmanPrior !== null ? kalmanState.v : null;

  // phase 분류 — 가장 최신 sample의 distance 입력. #834 wire 전까지 undefined → null 반환.
  // 직전 cycle의 kalmanPrior.v를 prevKalmanKmh로 전달해 APPROACHING(감속)/DEPARTING(가속)
  // 방향 구분 — accel magnitude만으로는 부호 부재라 분리 불가.
  const lastSample = series[series.length - 1];
  const phaseState = runStationPhaseStep(
    {
      kalmanKmh: kalmanState.v,
      prevKalmanKmh: kalmanPrior?.v,
      accelMagnitudeMean: accelMetrics.avgMagnitudeMean,
      accelMagnitudeStd: accelMetrics.avgMagnitudeStd,
      nearestStationDistanceM: lastSample?.nearestStationDistanceM,
      motion: posMetrics.motion,
      now,
    },
    trip.stationPhase,
  );

  return { series, posMetrics, kalmanKmh, phaseState };
}

/**
 * #705 — trip의 baseline/진행 상태를 progress KV에도 mirror해 POST /trips race에 무관하게 유지.
 * trainCode가 없는 호출(lock 없음)은 no-op — progress KV는 trainCode가 stamp되어야 의미가 있다.
 */
async function mirrorProgress(
  kv: KVNamespace,
  trip: Trip,
  shiftedCountDelta: number,
): Promise<void> {
  const trainCode = trip.boardingLock?.trainCode;
  if (!trainCode) return;
  // #766 — cron path는 cacheTtl=10s로 PUT 직후 stale read 방지.
  const existing = await getProgress(kv, trip.token, { cacheTtl: CRON_PROGRESS_CACHE_TTL_SEC });
  const prevShifted = existing?.trainCode === trainCode ? existing.shiftedCount : 0;
  const next: TripProgress = {
    trainCode,
    shiftedCount: prevShifted + shiftedCountDelta,
    lastTrackedArrivalEpoch: trip.lastTrackedArrivalEpoch,
    lastLaPushEpoch: trip.lastLaPushEpoch,
    consecutiveEtaMissing: trip.consecutiveEtaMissing,
  };
  const ttlSec = Math.max(60, Math.floor((trip.expiresAt - Date.now()) / 1000));
  await putProgress(kv, trip.token, next, ttlSec);
}

/**
 * boardingLock trip 추적 (#585).
 *
 * 3단계로 분리: estimate → arrival 시 waypoint 진행(early return) → 아니면 reschedule push.
 * push가 trip 도착 시점에 의미 없으므로 도착 케이스를 먼저 처리해 dirty write를 단일화.
 */
export async function runTrainCodeTracking(
  trip: Trip,
  waypoint: Waypoint,
  lock: BoardingLockMeta,
  env: Env,
  deps: ScheduledDeps,
  stats: ScheduledStats,
  now: number,
  log: Logger,
  generatePushId: () => string,
): Promise<void> {
  const estimate = await estimateBoardingLockArrival(deps, lock, waypoint, now);
  if (estimate === null) {
    stats.etaMissing += 1;
    const previousMissCount = trip.consecutiveEtaMissing ?? 0;
    const nextMissCount = previousMissCount + 1;
    log('boarding-lock: trainCode not found in arrivals or positions', {
      token: trip.token.slice(0, 8),
      trainCode: lock.trainCode,
      station: waypoint.stationName,
      consecutiveEtaMissing: nextMissCount,
    });
    if (nextMissCount >= MAX_CONSECUTIVE_ETA_MISSING) {
      // #706 — 운행 시간대 외 무한 폴링 차단. cleanupTripWithLa가 LA dismissal + deleteTrip을 묶어 정리.
      log('boarding-lock: trip auto-ended (consecutiveEtaMissing exceeded)', {
        token: trip.token.slice(0, 8),
        trainCode: lock.trainCode,
        station: waypoint.stationName,
        threshold: MAX_CONSECUTIVE_ETA_MISSING,
      });
      await cleanupTripWithLa(trip, env, deps, stats, now, log);
      return;
    }
    trip.consecutiveEtaMissing = nextMissCount;
    await putTrip(env.TRIPS, trip);
    await mirrorProgress(env.TRIPS, trip, 0);
    return;
  }

  // 성공 사이클 — 카운터가 누적된 상태였다면 reset하고 persist. 0이면 dirty write 회피.
  const hadMissCount = (trip.consecutiveEtaMissing ?? 0) > 0;
  if (hadMissCount) {
    trip.consecutiveEtaMissing = 0;
  }

  if (estimate.arrived) {
    // #826 — arvlCd=ARRIVED ground truth → Kalman state hard reset.
    // 정거장 도착은 가장 강한 신호 (실제 정차) — v=0/P=R_LOW로 drift 누적 차단.
    await writeKalmanState(env.TRIPS, trip.token, resetKalmanForArrival(now));
    stats.kalmanReset += 1;
    await advanceBoardingLockWaypoint(trip, waypoint, env, deps, stats, now, log);
    return;
  }

  const { cleanedUp } = await maybeReschedulePush(
    trip,
    waypoint,
    lock,
    estimate.epoch,
    env,
    deps,
    stats,
    now,
    log,
    generatePushId,
  );
  // trip이 KV에서 삭제됐다면 후속 putTrip은 resurrection이 되므로 즉시 종료.
  if (cleanedUp) return;
  // LA는 reschedule와 독립 평가 — reschedule 임계(15s) 미달이거나 push가 실패해도 LA 임계(30s)는 별도 게이트.
  const laDirty = await maybeFireLiveActivityUpdate(
    trip,
    waypoint,
    estimate.epoch,
    deps,
    stats,
    now,
    log,
  );
  if (laDirty || hadMissCount) {
    await putTrip(env.TRIPS, trip);
  }
  // #705 — reschedule push 성공/LA dirty/카운터 reset 어느 경로든 baseline이 바뀔 수 있으므로
  // 항상 progress 미러링. 함수 자체는 lock 없는 trip에 no-op이라 추가 비용 미미.
  await mirrorProgress(env.TRIPS, trip, 0);
}

/**
 * 다음 waypoint에 trainCode가 도착할 시각을 추정.
 *   1순위: arrivals에서 trainCode 매칭 → barvlDt
 *   2순위: positions에서 trainCode 위치 → segmentStations 인덱스 차이 기반
 *   3순위: 둘 다 없음 → null
 *
 * arrived 판정: arrivals 경로는 arvlCd가 ENTERING(0, 진입) 또는 ARRIVED(1, 도착)인 경우.
 * positions 경로는 estimateArrivalFromPosition이 sttus와 station 매치로 결정.
 */
export async function estimateBoardingLockArrival(
  deps: ScheduledDeps,
  lock: BoardingLockMeta,
  waypoint: Waypoint,
  now: number,
): Promise<{ epoch: number; arrived: boolean } | null> {
  const arrivals = await deps.seoul.fetchArrivals(waypoint.stationName);
  const matched = arrivals.find((a) => a.trainCode === lock.trainCode);
  if (matched) {
    return {
      epoch: now + matched.arrivalSeconds * 1000,
      arrived:
        matched.arvlCd === ARRIVAL_CODE.ARRIVED || matched.arvlCd === ARRIVAL_CODE.ENTERING,
    };
  }
  const positions = await deps.seoul.fetchPositions(lock.line);
  const train = positions.find((p) => p.trainCode === lock.trainCode);
  if (!train) return null;
  const fallback = estimateArrivalFromPosition(train, waypoint.stationName, lock, now);
  if (fallback.epoch === null) return null;
  return { epoch: fallback.epoch, arrived: fallback.arrived };
}

/**
 * waypoint 진행 처리. destination 도착 또는 last intermediate 통과 시 trip 삭제.
 * baseline(lastTrackedArrivalEpoch / lastLaPushEpoch)도 함께 리셋해 새 waypoint의 첫 push를 보장.
 *
 * #586 D — stopsRemaining이 바뀌는 시점은 사용자가 즉시 보아야 할 변동(다음 hop 표시)이므로
 * ETA 임계와 무관하게 새 waypoint로 LA update를 동기 발사한다. ETA는 모르므로 0으로 보내고
 * lastLaPushEpoch는 reset 상태(undefined)로 두어 다음 폴링에서 첫 estimate가 들어오면
 * 임계 검사 없이 발사되도록 한다.
 */
export async function advanceBoardingLockWaypoint(
  trip: Trip,
  waypoint: Waypoint,
  env: Env,
  deps: ScheduledDeps,
  stats: ScheduledStats,
  now: number,
  log: Logger,
): Promise<void> {
  if (waypoint.kind === 'destination') {
    await cleanupTripWithLa(trip, env, deps, stats, now, log);
    log('boarding-lock: destination arrived, trip cleared', {
      token: trip.token.slice(0, 8),
      station: waypoint.stationName,
    });
    return;
  }
  trip.waypoints.shift();
  trip.lastTrackedArrivalEpoch = undefined;
  trip.lastLaPushEpoch = undefined;
  log('boarding-lock: waypoint advanced', {
    token: trip.token.slice(0, 8),
    completed: waypoint.stationName,
    kind: waypoint.kind,
    remaining: trip.waypoints.length,
  });
  if (trip.waypoints.length === 0) {
    await cleanupTripWithLa(trip, env, deps, stats, now, log);
    return;
  }
  // stopsRemaining 변동 즉시 LA 발사 — 사용자에게 새 hop 정보를 즉시 노출.
  const nextWaypoint = trip.waypoints[0];
  if (trip.activityPushToken && trip.activityState === 'live') {
    const contentState = buildLiveActivityContentState(
      nextWaypoint,
      0,
      trip.waypoints.length,
    );
    await fireLiveActivityUpdate(trip, contentState, deps, stats, now, log);
  }
  await putTrip(env.TRIPS, trip);
  // #705 — shift된 진행분을 progress KV에 +1 누적. 이후 POST /trips race가 trip.waypoints를
  // 다시 wipe해도 progress 기반 slice로 복원된다.
  await mirrorProgress(env.TRIPS, trip, 1);
}

/**
 * Live Activity update push 발사 헬퍼 (#586 D).
 *
 * - 새 추정 도착 epoch이 trip.lastLaPushEpoch와 LA_PUSH_THRESHOLD_MS(30s) 이상 차이날 때만 발사.
 * - activityPushToken 부재 / activityState !== 'live' / threshold 미달 시 no-op.
 * - 발사 후 trip.lastLaPushEpoch 갱신 + 410 응답 시 token clear (fireLiveActivityUpdate 내부).
 *
 * 반환 dirty=true는 호출자가 putTrip을 호출해야 함을 의미한다.
 * (lastLaPushEpoch 갱신 또는 410 token clear 둘 다 dirty)
 */
export async function maybeFireLiveActivityUpdate(
  trip: Trip,
  waypoint: Waypoint,
  newArrivalEpoch: number,
  deps: ScheduledDeps,
  stats: ScheduledStats,
  now: number,
  log: Logger,
): Promise<boolean> {
  if (!trip.activityPushToken || trip.activityState !== 'live') return false;
  const last = trip.lastLaPushEpoch;
  if (last !== undefined && Math.abs(newArrivalEpoch - last) < LA_PUSH_THRESHOLD_MS) {
    return false;
  }
  const etaSeconds = Math.max(0, Math.round((newArrivalEpoch - now) / 1000));
  const contentState = buildLiveActivityContentState(
    waypoint,
    etaSeconds,
    trip.waypoints.length,
  );
  const result = await fireLiveActivityUpdate(trip, contentState, deps, stats, now, log);
  if (result.dirty) {
    // 410 분기 — token이 비워졌으므로 lastLaPushEpoch는 갱신하지 않는다.
    return true;
  }
  trip.lastLaPushEpoch = newArrivalEpoch;
  return true;
}

/**
 * 임계치 이상 변동 시 reschedule silent push 발사. APNs env mismatch(#482) self-heal 포함.
 * reschedule push는 alert fallback 대상이 아니므로 PENDING_PUSHES 미등록.
 *
 * 반환값 `cleanedUp=true`는 trip이 KV에서 삭제됐음을 의미 — 호출자는 이후 putTrip을 호출하면 안 된다
 * (삭제된 trip을 in-memory 상태로 resurrect하는 것을 방지). #706에서 counter reset과 충돌하지 않게 도입.
 */
export async function maybeReschedulePush(
  trip: Trip,
  waypoint: Waypoint,
  lock: BoardingLockMeta,
  newArrivalEpoch: number,
  env: Env,
  deps: ScheduledDeps,
  stats: ScheduledStats,
  now: number,
  log: Logger,
  generatePushId: () => string,
): Promise<{ cleanedUp: boolean }> {
  const lastEpoch = trip.lastTrackedArrivalEpoch;
  if (
    lastEpoch !== undefined &&
    Math.abs(newArrivalEpoch - lastEpoch) < RESCHEDULE_THRESHOLD_MS
  ) {
    return { cleanedUp: false };
  }

  const pushId = generatePushId();
  log('reschedule push', {
    token: trip.token.slice(0, 8),
    trainCode: lock.trainCode,
    nextStation: waypoint.stationName,
    newArrivalTimeEpoch: newArrivalEpoch,
    previousEpoch: lastEpoch,
  });

  const heal = await sendWithEnvHeal(
    (host) =>
      sendReschedulePush({
        deviceToken: trip.token,
        pushId,
        trainCode: lock.trainCode,
        nextStation: waypoint.stationName,
        newArrivalTimeEpoch: newArrivalEpoch,
        sentAt: now,
        config: deps.apnsConfig,
        host,
        fetchImpl: deps.fetchImpl,
        now,
      }),
    trip.apnsEnv,
    deps.apnsHosts,
    log,
    trip.token.slice(0, 8),
  );
  let dirty = false;
  if (heal.correctedEnv) {
    trip.apnsEnv = heal.correctedEnv;
    dirty = true;
    stats.envCorrected += 1;
  }
  const envMismatchExhausted = heal.envMismatchExhausted;
  const result = heal.result;

  if (result.ok) {
    stats.pushed += 1;
    trip.lastTrackedArrivalEpoch = newArrivalEpoch;
    dirty = true;
  } else {
    stats.errors += 1;
    log('reschedule push failed', {
      status: result.status,
      reason: result.reason,
      token: trip.token.slice(0, 8),
    });
    if (isUnrecoverableApnsError(result.status, result.reason) || envMismatchExhausted) {
      // #586 D — trip이 unrecoverable로 폐기되는 경로에서도 LA가 살아있으면 dismissal로 정리.
      await cleanupTripWithLa(trip, env, deps, stats, now, log);
      return { cleanedUp: true };
    }
  }

  if (dirty) {
    await putTrip(env.TRIPS, trip);
  }
  return { cleanedUp: false };
}

/**
 * #816 C — lockless trip (사용자 opt-in)에서 intermediate waypoint 통과를 추적하고 station-passed
 * push를 발사한다. BoardingLock 없으니 trainCode 추적은 불가 — Seoul arrivals 중 best signal로
 * "그 역에 어느 열차가 진입/도착했다"만 판정한다.
 *
 * 발사 조건:
 *   1. arrivals 중 best signal의 arvlCd가 ARRIVED(1) 또는 ENTERING(0)
 *   2. dedup: 같은 waypoint에서 이미 한 번 발사한 경우 (lastFiredPhase='imminent') skip
 *
 * 발사 성공 시: waypoint shift + lastFiredPhase reset + trip 저장. waypoint 0이면 trip cleanup.
 * 사양상 transfer/destination kind는 호출 전에 분기로 차단됨 — 이 함수는 intermediate에 한정.
 */
export async function runLocklessIntermediate(
  trip: Trip,
  waypoint: Waypoint,
  env: Env,
  deps: ScheduledDeps,
  stats: ScheduledStats,
  now: number,
  log: Logger,
  generatePushId: () => string,
): Promise<void> {
  // 같은 waypoint에서 이미 발사했으면 dedup (lockless 흐름은 phase 개념이 없으니 imminent 단일 stamp 사용).
  if (trip.lastFiredPhase === 'imminent') {
    return;
  }
  // #825 — Phase 3 E3 fusion step. 분류 결과를 trip에 stamp + imminent push 발사 가드에 사용.
  const fusion = await runFusionStep(trip, env, now, stats);
  let dirty = false;
  if (fusion.phaseState) {
    trip.stationPhase = fusion.phaseState;
    dirty = true;
  }
  const arrivals = await deps.seoul.fetchArrivals(waypoint.stationName);
  const signal = pickBestArrivalSignal(arrivals, waypoint);
  if (signal === null || signal.arvlCd === null) {
    stats.etaMissing += 1;
    if (dirty) await putTrip(env.TRIPS, trip);
    return;
  }
  // 발사 트리거: 해당 역에 진입(ENTERING) 또는 도착(ARRIVED). 그 외 phase는 통과 알림 부적합.
  const fires =
    signal.arvlCd === ARRIVAL_CODE.ENTERING || signal.arvlCd === ARRIVAL_CODE.ARRIVED;
  if (!fires) {
    if (dirty) await putTrip(env.TRIPS, trip);
    return;
  }
  // #826 — fires=true(ARRIVED/ENTERING)는 ground truth 신호. push 발사 여부(phase 가드)와
  // 무관하게 Kalman state를 reset해 drift 누적을 차단한다. arvlCd가 가장 강한 신호 — phase
  // 분류는 휴리스틱이라 contradiction 시 arvlCd를 신뢰.
  await writeKalmanState(env.TRIPS, trip.token, resetKalmanForArrival(now));
  stats.kalmanReset += 1;
  // #825 — high-confidence non-APPROACHING phase면 차단 (false positive 1차).
  // 신호 부재/낮은 신뢰는 기존 동작 그대로 (회귀 없음, #834 wire 전까지 자연 skip).
  if (!phaseAllowsImminentFiring(fusion.phaseState)) {
    stats.phaseImminentBlocked += 1;
    log('lockless: phase gate blocked', {
      token: trip.token.slice(0, 8),
      station: waypoint.stationName,
      phase: fusion.phaseState?.current,
      confidence: fusion.phaseState?.confidence,
    });
    if (dirty) await putTrip(env.TRIPS, trip);
    return;
  }
  const pushId = generatePushId();
  log('lockless: station-passed push', {
    token: trip.token.slice(0, 8),
    station: waypoint.stationName,
    arvlCd: signal.arvlCd,
    etaSeconds: signal.etaSeconds,
  });
  const heal = await sendWithEnvHeal(
    (host) =>
      sendSilentPush({
        deviceToken: trip.token,
        payload: {
          nextWaypoint: waypoint.stationName,
          etaSeconds: signal.etaSeconds,
          phase: 'imminent',
          kind: 'intermediate',
          sentAt: now,
          pushId,
        },
        config: deps.apnsConfig,
        host,
        fetchImpl: deps.fetchImpl,
        now,
      }),
    trip.apnsEnv,
    deps.apnsHosts,
    log,
    trip.token.slice(0, 8),
  );
  if (heal.correctedEnv) {
    trip.apnsEnv = heal.correctedEnv;
    dirty = true;
    stats.envCorrected += 1;
  }
  if (!heal.result.ok) {
    stats.errors += 1;
    log('lockless: push failed', {
      status: heal.result.status,
      reason: heal.result.reason,
      token: trip.token.slice(0, 8),
    });
    if (
      isUnrecoverableApnsError(heal.result.status, heal.result.reason) ||
      heal.envMismatchExhausted
    ) {
      await cleanupTripWithLa(trip, env, deps, stats, now, log);
      return;
    }
    if (dirty) await putTrip(env.TRIPS, trip);
    return;
  }
  // 발사 성공 — waypoint 진행 + dedup stamp + 측정 카운터.
  stats.pushed += 1;
  stats.locklessIntermediateFired += 1;
  trip.lastFiredPhase = 'imminent';
  trip.waypoints.shift();
  if (trip.waypoints.length === 0) {
    // 마지막 intermediate까지 통과 — trip 종료. lockless는 destination을 직접 다루지 않는다.
    await cleanupTripWithLa(trip, env, deps, stats, now, log);
    return;
  }
  // 다음 waypoint를 위해 dedup stamp reset (위 shift 직후 첫 waypoint는 새 발사 대상).
  trip.lastFiredPhase = undefined;
  await putTrip(env.TRIPS, trip);
}

/**
 * realtimePosition에서 trainCode 위치를 찾았을 때 다음 waypoint 도착 epoch을 추정한다.
 * segmentStations에서 현재 위치 인덱스와 목표 인덱스의 차이 × hop time(90s default).
 * 매핑 안 되면 epoch null — 호출자가 etaMissing 처리.
 * 이미 도착(sttus=ARRIVED) + 목표역 일치이면 arrived=true.
 */
export function estimateArrivalFromPosition(
  train: PositionEntry,
  targetStation: string,
  lock: BoardingLockMeta,
  now: number,
): { epoch: number | null; arrived: boolean } {
  const currentIdx = lock.segmentStations.indexOf(train.stationName);
  const targetIdx = lock.segmentStations.indexOf(targetStation);
  if (currentIdx < 0 || targetIdx < 0) return { epoch: null, arrived: false };
  // 이미 목표역에 도착했거나 지나친 경우
  if (currentIdx >= targetIdx) {
    return {
      epoch: now,
      arrived: train.trainSttus === TRAIN_STATUS.ARRIVED && train.stationName === targetStation,
    };
  }
  const hops = targetIdx - currentIdx;
  return { epoch: now + hops * FALLBACK_HOP_SEC * 1000, arrived: false };
}

/**
 * 트립의 활성 waypoint를 고른다.
 * 현재는 첫 미완료 waypoint를 사용한다. (Phase 3에서 진행률 기반 선택으로 확장 가능)
 */
export function pickActiveWaypoint(trip: Trip): Waypoint | null {
  if (trip.waypoints.length === 0) return null;
  return trip.waypoints[0];
}

export interface ArrivalSignal {
  etaSeconds: number;
  arvlCd: number | null;
}

/**
 * arrivals 중 waypoint의 line과 매칭되는 trains에서 phase trigger에 가장 적합한 신호를 선택 (#409).
 *
 * 선택 순서:
 *   1. arvlCd ∈ {0, 1} (해당 역 진입/도착) — imminent phase 직결, 즉시 채택
 *   2. arvlCd ∈ {4, 5} (전역 진입/도착) — early phase 직결, 즉시 채택
 *   3. 위 둘 모두 없으면 min ETA의 train을 채택 (ETA fallback 경로)
 *
 * 라인 매칭 실패 시 전체 arrivals로 fallback. 모두 없으면 null.
 */
export function pickBestArrivalSignal(
  arrivals: readonly ArrivalEntry[],
  waypoint: Waypoint,
): ArrivalSignal | null {
  if (arrivals.length === 0) return null;
  const matchingLine = arrivals.filter((a) => matchLine(a.subwayNm, waypoint.line));
  const pool = matchingLine.length > 0 ? matchingLine : arrivals;

  // 1순위: imminent 실측 신호 (해당 역 진입/도착).
  const imminentTrain = pool.find(
    (a) => a.arvlCd === ARRIVAL_CODE.ENTERING || a.arvlCd === ARRIVAL_CODE.ARRIVED,
  );
  if (imminentTrain) {
    return { etaSeconds: imminentTrain.arrivalSeconds, arvlCd: imminentTrain.arvlCd };
  }
  // 2순위: early 실측 신호 (전역 진입/도착).
  const earlyTrain = pool.find(
    (a) => a.arvlCd === ARRIVAL_CODE.PREV_ENTERING || a.arvlCd === ARRIVAL_CODE.PREV_ARRIVED,
  );
  if (earlyTrain) {
    return { etaSeconds: earlyTrain.arrivalSeconds, arvlCd: earlyTrain.arvlCd };
  }
  // 3순위: 실측 신호 없음 → min ETA fallback (기존 동작 유지).
  let best = pool[0];
  for (const cur of pool) {
    if (cur.arrivalSeconds < best.arrivalSeconds) best = cur;
  }
  return { etaSeconds: best.arrivalSeconds, arvlCd: best.arvlCd };
}

/**
 * BadDeviceToken은 self-heal 분기에서 처리한다 (#482 D안).
 * unrecoverable로 분류되는 것은 토큰 자체가 만료/취소된 경우뿐.
 */
function isUnrecoverableApnsError(status: number, _reason: string | undefined): boolean {
  if (status === 410) return true; // Unregistered
  return false;
}

/**
 * APNs 토큰 환경(sandbox/production)과 host가 어긋났을 때 Apple이 내는 시그널.
 * 이 조건에 한해서만 self-heal retry를 시도한다.
 */
function isApnsEnvMismatch(status: number, reason: string | undefined): boolean {
  return status === 400 && reason === 'BadDeviceToken';
}

/**
 * "탑승했냐?" 푸시 평가 + 발사 (#819 B 슬라이스).
 *
 * lockMissing 분기에서만 호출. promptGeoContext가 없으면 skip — backend는 stations 좌표를
 * 갖지 않으므로 평가 자체 불가. 9단 AND 게이트 평가는 evaluateBoardingPromptGates에 위임.
 *
 * 발사 성공:
 *   - alert push (BOARDING_PROMPT category)로 [탑승]/[미탑승] 액션 노출
 *   - trip.boardingPromptState = markPromptFired(now) → KV 저장 (게이트 #9 1회 정책)
 *   - boardingPromptFired stat +1
 *
 * 차단:
 *   - boardingPromptBlocked stat +1 (게이트 reason 로그)
 *
 * 좌표 컨텍스트 부재:
 *   - no-op (silent skip, blocked 카운트 안 함 — 게이트 평가 안 한 것과 평가 후 차단 분리)
 */
export async function evaluateAndMaybeFireBoardingPrompt(
  trip: Trip,
  env: Env,
  deps: ScheduledDeps,
  stats: ScheduledStats,
  now: number,
  log: Logger,
  generatePushId: () => string,
): Promise<void> {
  const geo = trip.promptGeoContext;
  const display = trip.promptDisplay;
  if (!geo || !display) return;

  stats.boardingPromptEvaluated += 1;

  const fusion = await runFusionStep(trip, env, now, stats);
  let dirty = false;
  // phase 분류 결과가 있으면 trip에 stamp — 다음 cycle hysteresis 입력 + lockless 가드용 상태.
  if (fusion.phaseState) {
    trip.stationPhase = fusion.phaseState;
    dirty = true;
  }

  const outcome = evaluateBoardingPromptGates({
    series: fusion.series,
    origin: geo.origin,
    nextStation: geo.nextStation,
    now,
    promptState: trip.boardingPromptState,
    kalmanKmh: fusion.kalmanKmh,
  });

  if (!outcome.pass) {
    stats.boardingPromptBlocked += 1;
    log('boarding-prompt: gate blocked', {
      token: trip.token.slice(0, 8),
      reason: outcome.reason satisfies GateSkipReason,
    });
    if (dirty) await putTrip(env.TRIPS, trip);
    return;
  }

  // 9단 통과 — alert push 발사.
  const pushId = generatePushId();
  const heal = await sendWithEnvHeal(
    (host) =>
      sendBoardingPromptPush({
        deviceToken: trip.token,
        pushId,
        title: 'Are you on board?',
        body: `${display.line} · ${display.originStation}`,
        originStation: display.originStation,
        line: display.line,
        tripToken: trip.token,
        sentAt: now,
        config: deps.apnsConfig,
        host,
        fetchImpl: deps.fetchImpl,
        now,
      }),
    trip.apnsEnv,
    deps.apnsHosts,
    log,
    trip.token.slice(0, 8),
  );

  if (heal.correctedEnv) {
    trip.apnsEnv = heal.correctedEnv;
    dirty = true;
    stats.envCorrected += 1;
  }
  if (heal.result.ok) {
    stats.boardingPromptFired += 1;
    trip.boardingPromptState = markPromptFired(now);
    dirty = true;
    log('boarding-prompt: fired', {
      token: trip.token.slice(0, 8),
      line: display.line,
      originStation: display.originStation,
      fusedSpeedKmh: Math.round(outcome.fusedSpeedKmh * 10) / 10,
    });
  } else {
    stats.errors += 1;
    log('boarding-prompt: push failed', {
      token: trip.token.slice(0, 8),
      status: heal.result.status,
      reason: heal.result.reason,
    });
  }
  if (dirty) {
    await putTrip(env.TRIPS, trip);
  }
}
