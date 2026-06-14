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
} from './apns';
import { flipApnsEnv, pickApnsHost, sendWithEnvHeal } from './apnsHost';
import {
  attemptAutoLock,
  AUTO_PROMPT_DEDUP_WINDOW_MS,
  recordAutoLockConfidence,
} from './autoLock';
import {
  evaluateBoardingPromptGates,
  markPromptFired,
  type GateSkipReason,
} from './boardingPrompt';
import {
  detectKalmanDrift,
  KALMAN_DRIFT_GRACE_MS,
  type KalmanState,
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
import { attachTrainCodeForLeg } from './lockSwap';
import {
  evaluateWindow,
  readSeries,
  type WindowedMetrics,
} from './positionSeries';
import { deleteProgress, getProgress, putProgress, type TripProgress } from './progress';
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
import { RESCHEDULE_CHANNELS_DEFAULT } from './types';

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
export const FALLBACK_HOP_SEC = 90;

/**
 * LA update push 발사 임계치 (#586 D). reschedule push의 15s 임계와는 별개 — LA는 화면 표시용이라
 * 더 듬성듬성 보내도 사용자가 인지하지 못하고, APNs LA budget(앱당 분당 ~60건)이 빠듯하다.
 * 새 추정 도착 epoch이 lastLaPushEpoch와 30s 이상 차이날 때만 발사.
 */
export const LA_PUSH_THRESHOLD_MS = 30_000;

/**
 * LA heartbeat 간격 (#900 Seam D). ETA가 정체돼 ΔETA 임계 미달이어도 마지막 LA push 후
 * 이 간격이 지나면 한 번 더 발사한다. 사용자가 BG에서도 stale content-state를 보지 않게
 * 갱신을 강제하기 위한 안전망.
 *
 * cron 60s × 임계 60_000ms = 매 cron 마다 적어도 한 번 LA refresh 보장. APNs LA budget
 * (앱당 분당 ~60건)을 단일 trip이 모두 소모해도 안전한 상한.
 */
export const LA_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * 연속 etaMissing 임계치 (#706). 한 trip이 N회 연속 trainCode 매칭 실패면 자동 종료.
 * 운행 시간대 외(새벽)에 trainCode가 Seoul API에서 사라지면 무한 폴링하던 회귀(8h × 1/min) 방지.
 * cron 주기 60s × 5회 = 5분 — 일시적 API 누락은 흡수하고 운행 종료/탈선 신호는 잡는다.
 */
export const MAX_CONSECUTIVE_ETA_MISSING = 5;

/**
 * #903 (Seam G) — 기압계 subsurface=true trip에 적용되는 인내 임계치 (10회 ≈ 10분).
 * 지하 dead zone에서 GPS/trainCode 신호 누락이 더 자주, 더 길게 발생하므로 기본 임계의 2배로 인내.
 * 너무 크면 자동 종료 효과를 잃어 무한 폴링 위험 — 2배가 절충점.
 */
export const SUBSURFACE_ETA_MISSING_TOLERANCE = 10;

/**
 * trip별 etaMissing 임계 결정. subsurface=true면 늘려 잡고, 그 외엔 기본값.
 * 클라가 매 register POST에 기압계 신호를 동봉하므로 한 trip 내에서 지상→지하 전이 시
 * threshold가 자연 갱신된다(stale 가능 윈도우는 다음 register 까지 ≤ ALARM_TIME_BUCKET_MS).
 */
export function resolveEtaMissingThreshold(trip: Pick<Trip, 'subsurface'>): number {
  return trip.subsurface === true
    ? SUBSURFACE_ETA_MISSING_TOLERANCE
    : MAX_CONSECUTIVE_ETA_MISSING;
}

/**
 * cron이 progress KV를 read할 때의 cacheTtl (#766/#770).
 * POST `/trips`가 putProgress 직후 같은 cron 사이클에서 옛 값을 읽지 않도록 30s까지 단축.
 * trips.ts/pendingPushes.ts의 cron read와 동일 정책. Cloudflare KV는 cacheTtl<30s 시
 * 런타임에서 `Invalid cache_ttl` 던짐(#770 hotfix).
 */
const CRON_PROGRESS_CACHE_TTL_SEC = 30;

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
  /**
   * #916 A1 — 9단 게이트 통과 후 backend가 `attemptAutoLock`으로 trainCode를 자동 합성해
   * `trip.boardingLock`을 부착한 누적 횟수. 사용자가 "탑승" 액션을 직접 탭하지 않아도 cron이
   * 매역 추적을 시작한 케이스 수 = 다운로드 가치 직결 신호.
   */
  autoLockSuccess: number;
  /**
   * #916 A1 — 자동 lock 후 사용자가 다른 trainCode로 swap한 케이스의 placeholder
   * (false positive 측정 인프라). 본 PR에서는 catalog 등록 + stat 필드 placeholder만 — 실제
   * client swap 신호 처리는 후속 PR (#916 A2)에서 wire한다. 현재는 항상 0.
   */
  autoLockFalsePositive: number;
  /**
   * #916 follow-up B — 직전 auto-prompt 발사 윈도우(AUTO_PROMPT_DEDUP_WINDOW_MS) 안에 다시
   * `evaluateAndMaybeFireBoardingPrompt`에 진입한 trip을 `lastAutoPromptedAt` 마커로 차단한
   * 누적 횟수. lock이 클리어/swap돼 lockMissing으로 돌아오거나 `isSameSession=false`로
   * boardingPromptState가 리셋된 케이스가 여기에 잡힌다. 0이면 회귀 방어가 발동되지 않은 상태.
   */
  boardingPromptAutoDeduped: number;
  /**
   * #917 A2 — boardingLock 활성 trip에서 Seoul arrivals의 arvlCd∈{0(ENTERING), 1(ARRIVED)}
   * 신호로 매역 station-passed silent push가 성공 발사된 누적 횟수. 매역 알림 1차 source는
   * GPS가 아니라 이 신호 — 다운로드 가치 직결(지하/지상 무관).
   */
  arvlCdFireSuccess: number;
  /**
   * #917 A2 — 같은 (trainCode, station, arvlCd) 조합에 대해 이미 발사한 dedup KV가 있어
   * 매역 push가 차단된 횟수. cron 60s × Seoul API 갱신 지연으로 같은 신호가 2~3 cycle 반복
   * 노출되는데, 클라가 같은 알림을 중복 수신하는 회귀를 차단한다.
   */
  arvlCdFireDedup: number;
  /**
   * #917 A2 — 매역 fire path 진입했지만 prereq 게이트(lock 활성 + arvlCd∈{0,1}) 실패로
   * push 미발사된 횟수. positions-fallback arrived(arvlCd=null) 등 SSOT가 arvlCd가 아닌
   * 경로를 측정한다. #640 회귀(lock 없는 trip 발사) 방어 신호 — 정상 운영에서는 0이어야 한다.
   */
  arvlCdFireMismatch: number;
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
    autoLockSuccess: 0,
    autoLockFalsePositive: 0,
    boardingPromptAutoDeduped: 0,
    arvlCdFireSuccess: 0,
    arvlCdFireDedup: 0,
    arvlCdFireMismatch: 0,
  };

  for await (const trip of listTrips(env.TRIPS)) {
    stats.scanned += 1;

    if (trip.expiresAt <= now) {
      // #586 D — trip 만료 시 활성 LA가 남아 있으면 dismissal push로 정리하고 KV에서 제거.
      // #868 — 클라 state sync용 trip-ended silent push도 함께 발사 (reason=expired).
      await cleanupTripWithLa(trip, env, deps, stats, now, log, 'expired');
      continue;
    }

    if (trip.alarmAtEpochMs - now > POLLING_WINDOW_MS) {
      // 아직 알람 윈도우 진입 전 — 폴링 스킵
      continue;
    }

    const waypoint = pickActiveWaypoint(trip);
    if (!waypoint) continue;

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
  /**
   * 정상 cycle(observationValid)의 직전 cycle Kalman state — drift 측정 입력 (#837 P2-3).
   * observation 무효 cycle 또는 KV 미존재면 null → 호출자 maybeCountDrift가 skip.
   */
  kalmanPrior: KalmanState | null;
  /** 이번 cycle predict+update 직후 state. observation 무효면 null (KV write 자체가 skip). */
  kalmanState: KalmanState | null;
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
 *   - #837 P2-3 — drift 카운트(stats.kalmanDriftWarning)는 호출자가 maybeCountDrift(prior, posMetrics, stats, now)
 *     로 수행. fusion 자체는 stats를 받지 않아 SRP 유지(HTTP path 등에서 stats 없이 재사용 가능).
 */
async function runFusionStep(
  trip: Trip,
  env: Env,
  now: number,
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
    // observation 무효 cycle은 drift도 의미 없음 — kalmanPrior=null로 반환해 호출자가 skip.
    return {
      series,
      posMetrics,
      kalmanKmh: null,
      phaseState: null,
      kalmanPrior: null,
      kalmanState: null,
    };
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

  return {
    series,
    posMetrics,
    kalmanKmh,
    phaseState,
    kalmanPrior,
    kalmanState,
  };
}

/**
 * #837 P2-3 — Kalman drift 카운트 헬퍼.
 *
 * runFusionStep에서 분리한 책임 (SRP):
 *  - fusion은 순수 pipeline (KV I/O + 계산만), stats 의존 제거 → HTTP path 등에서 dummy stats 없이 재사용.
 *  - drift 카운트는 호출자 직후에 수행 — 발생 시점/조건 동치(정상 cycle + prior 존재).
 *
 * skip 조건:
 *  - prior=null (첫 cycle, v=gpsAvg 초기화라 delta=0 의미 없음)
 *  - posMetrics가 fusion observation 무효 cycle의 것이면 호출자가 prior=null로 받음 (#826 정합)
 *  - #837 P2-2 reset grace window: prior.lastResetTs가 있고 now - lastResetTs < KALMAN_DRIFT_GRACE_MS면
 *    카운트 skip. `resetKalmanForArrival` 직후 cycle은 prior.v=0과 GPS 회복 phase 사이 |delta|가
 *    임계 근처/초과로 잡혀 kalmanReset과 동시 카운트되는 telemetry 사각지대 — 해석 불명확 해소.
 *    legacy state는 lastResetTs 미존재(undefined) — grace skip 없이 정상 평가 (회귀 없음).
 */
export function maybeCountDrift(
  prior: KalmanState | null,
  posMetrics: WindowedMetrics,
  stats: ScheduledStats,
  now: number,
): void {
  if (prior === null) return;
  if (
    prior.lastResetTs !== undefined &&
    now - prior.lastResetTs < KALMAN_DRIFT_GRACE_MS
  ) {
    return;
  }
  const drift = detectKalmanDrift(prior, posMetrics.gpsAvgKmh);
  if (drift.warning) {
    stats.kalmanDriftWarning += 1;
  }
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
    // #900 Seam D — heartbeat wall-clock도 mirror해 POST /trips race 후에도 보존.
    lastLaPushAt: trip.lastLaPushAt,
    consecutiveEtaMissing: trip.consecutiveEtaMissing,
  };
  const ttlSec = Math.max(60, Math.floor((trip.expiresAt - Date.now()) / 1000));
  await putProgress(kv, trip.token, next, ttlSec);
}

/**
 * #1285 — lockless trip의 waypoint shift를 progress KV에 mirror해 POST /trips 재등록 race 보존.
 * trip.waypoints는 이미 shift() 완료된 상태로 전달된다 — shiftedCount는 (totalWaypoints - remaining).
 * mirrorProgress(lock 경로)와 동형이지만 trainCode 없이 lockless===true 마커로 저장.
 */
async function mirrorLocklessProgress(kv: KVNamespace, trip: Trip): Promise<void> {
  // #766 — cron path는 cacheTtl=10s로 PUT 직후 stale read 방지.
  const existing = await getProgress(kv, trip.token, { cacheTtl: CRON_PROGRESS_CACHE_TTL_SEC });
  const prevShifted = existing?.lockless === true ? existing.shiftedCount : 0;
  const next: TripProgress = {
    lockless: true,
    shiftedCount: prevShifted + 1,
  };
  const ttlSec = Math.max(60, Math.floor((trip.expiresAt - Date.now()) / 1000));
  await putProgress(kv, trip.token, next, ttlSec);
}

/**
 * boardingLock trip 추적 (#585).
 *
 * 3단계로 분리: estimate → arrival 시 waypoint 진행(early return) → 아니면 reschedule push.
 * push가 trip 도착 시점에 의미 없으므로 도착 케이스를 먼저 처리해 dirty write를 단일화.
 *
 * #902 Seam F — estimate=null이고 누적 miss가 임계(VANISH_RE_ATTACH_THRESHOLD) 도달 직전이면
 * 같은 station/line의 신규 trainCode를 자동 swap 후 같은 cycle에 재estimate한다.
 */

/**
 * #902 Seam F — trainCode 사라짐 후 재attach 시도 임계.
 * `consecutiveEtaMissing`이 이 값에 도달한 미스 cycle에서 한 번 swap을 시도한다.
 * 1회로는 일시적 API 누락과 진짜 사라짐을 구분하지 못해 false swap 위험이 크므로 2로 둔다.
 * (그 미만 미스는 단순 누락으로 간주 + 카운터 증가만).
 */
export const VANISH_RE_ATTACH_THRESHOLD = 2;

/**
 * #1277 — vanish-swap 실패 후 시간 기반 waypoint advance를 시도하기까지의 추가 grace cycle 수.
 * VANISH_RE_ATTACH_THRESHOLD(2회) 시도 후 이 grace만큼 더 인내하다가 advance 또는 lock release.
 * swap 시도(2회)와 grace(1회) 합산 총 3회 miss → 시간 게이트를 통과하면 waypoint 전진.
 * subsurface grace(10회)와 무관하게 적용 — 지하에서도 무한 동결은 막는다.
 */
export const FALLBACK_ADVANCE_GRACE_CYCLES = 1;

/**
 * #917 A2 — 매역 알림 dedup KV TTL(초).
 * 같은 trainCode가 같은 역의 arvlCd∈{0,1} 신호를 cron 60s × Seoul API 갱신 지연으로 2~3 cycle
 * 반복 노출하는데, 그 윈도우 동안 push가 중복 발사되지 않도록 차단한다.
 * 한 trip 진행 중 같은 역으로 다시 돌아올 일은 없으므로 보수적으로 1시간 — KV TTL 최소(60s) 위.
 */
export const ARVLCD_FIRE_DEDUP_TTL_SEC = 60 * 60;

/**
 * #917 A2 — 매역 알림 dedup KV key prefix.
 * Key 형식: `${prefix}${token}|${trainCode}|${stationName}|${arvlCd}`
 *
 * 주의: trip token이 key에 포함된다 — 같은 train(trainCode)을 탄 여러 사용자가 같은 역에
 * 도착할 때 한 명만 push 받고 나머지가 dedup으로 silence되는 cross-trip leak을 차단한다.
 */
export const ARVLCD_FIRE_KEY_PREFIX = 'arvlcd-fire:';

/**
 * dedup KV key 빌더. arvlCd 0(ENTERING) vs 1(ARRIVED)은 별 entry로 분리(둘 다 신호).
 * token은 trip 단위 격리 — 같은 train 다른 trip이 서로 silence하지 않도록.
 */
export function arvlCdFireKey(
  token: string,
  trainCode: string,
  stationName: string,
  arvlCd: number,
): string {
  return `${ARVLCD_FIRE_KEY_PREFIX}${token}|${trainCode}|${stationName}|${arvlCd}`;
}

/**
 * arvlCd∈{0(ENTERING), 1(ARRIVED)} 신호로 매역 알림 발사 가능한지 prereq 평가 (#917 A2 가드).
 *
 * Returns:
 *   - 'fire'      — push 발사 진행
 *   - 'mismatch'  — prereq 실패. push X. arvlCdFireMismatch++로 카운트해 회귀 측정.
 *
 * 가드:
 *   1. lock 활성 (호출 전 isBoardingLockActive로 이미 검증되지만 defensive recheck)
 *   2. estimate.arvlCd가 ARRIVED(1) 또는 ENTERING(0)
 *
 * #640 회귀 차단: lock 없는 trip은 애초에 runTrainCodeTracking에 도달하지 못한다.
 * positions-fallback arrived(arvlCd=null)는 매역 알림 SSOT(arvlCd)와 다른 신호 →
 * mismatch로 분류해 push 미발사 + 운영 가시성 카운트.
 */
export function evaluateArvlCdFireGate(
  lock: BoardingLockMeta | undefined,
  estimateArvlCd: number | null,
  now: number,
): 'fire' | 'mismatch' {
  if (lock === undefined || lock.expiresAt <= now) return 'mismatch';
  if (estimateArvlCd !== ARRIVAL_CODE.ARRIVED && estimateArvlCd !== ARRIVAL_CODE.ENTERING) {
    return 'mismatch';
  }
  return 'fire';
}

/**
 * #917 A2 — boardingLock trip에서 arvlCd∈{0,1} 신호 관측 시 매역 station-passed silent push 발사.
 *
 * 호출 시점: runTrainCodeTracking이 estimate.arrived=true를 얻은 직후 advanceBoardingLockWaypoint
 * 진입 전. prereq 게이트(lock 활성 + arvlCd∈{0,1}) 통과 + dedup KV 미존재 시 발사.
 *
 * push 실패 분기 정책:
 *   - APNs env mismatch self-heal은 reschedule push와 동일 (sendWithEnvHeal 재사용)
 *   - 410 Unregistered / env exhausted 등 unrecoverable은 trip 자체 cleanup이 reschedule 경로의
 *     maybeReschedulePush에서 처리되므로 본 함수는 그 분기를 만들지 않는다 — arvlCd fire는 trip
 *     상태에 영향을 주지 않는 보조 신호로 한정 (waypoint advance / cleanup은 호출자 책임).
 *   - 일반 실패는 stats.errors++ + log만 — dedup KV는 성공 시에만 stamp해 다음 cycle 재시도 허용.
 *
 * @returns cleanedUp=true는 token unrecoverable로 trip 폐기 신호 (호출자가 advance 스킵).
 *          현재 정책상 cleanup 분기는 없고 항상 false 반환.
 */
export interface FireArvlCdStationPushInputs {
  trip: Trip;
  waypoint: Waypoint;
  lock: BoardingLockMeta;
  arvlCd: number;
  env: Env;
  deps: ScheduledDeps;
  stats: ScheduledStats;
  now: number;
  log: Logger;
  generatePushId: () => string;
}

export async function fireArvlCdStationPush(
  inputs: FireArvlCdStationPushInputs,
): Promise<{ dirty: boolean }> {
  const { trip, waypoint, lock, arvlCd, env, deps, stats, now, log, generatePushId } = inputs;
  const key = arvlCdFireKey(trip.token, lock.trainCode, waypoint.stationName, arvlCd);
  const existing = await env.TRIPS.get(key);
  if (existing !== null) {
    stats.arvlCdFireDedup += 1;
    log('arvlcd-fire: dedup skip', {
      token: trip.token.slice(0, 8),
      trainCode: lock.trainCode,
      station: waypoint.stationName,
      arvlCd,
    });
    return { dirty: false };
  }
  const pushId = generatePushId();
  log('arvlcd-fire: station-passed push', {
    token: trip.token.slice(0, 8),
    trainCode: lock.trainCode,
    station: waypoint.stationName,
    arvlCd,
    kind: waypoint.kind,
  });
  const heal = await sendWithEnvHeal(
    (host) =>
      sendSilentPush({
        deviceToken: trip.token,
        payload: {
          nextWaypoint: waypoint.stationName,
          // arvlCd∈{0,1}은 "지금 진입/도착" 신호 — eta는 사실상 0.
          etaSeconds: 0,
          phase: 'imminent',
          kind: waypoint.kind,
          sentAt: now,
          pushId,
          // Epic #1204 그룹 2 D3 (#1273) — validateTrip stamp 결과를 forward.
          // 클라이언트 `silentPushLocationGate`가 D1 estimator currentHopIndex와 매칭 시
          // 거리 검증 우회/`gate-no-location` fallback에 사용. 구 trip(부재) → undefined.
          hopIndex: waypoint.hopIndex,
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
  let dirty = false;
  if (heal.correctedEnv) {
    trip.apnsEnv = heal.correctedEnv;
    dirty = true;
    stats.envCorrected += 1;
  }
  if (!heal.result.ok) {
    stats.errors += 1;
    log('arvlcd-fire: push failed', {
      status: heal.result.status,
      reason: heal.result.reason,
      token: trip.token.slice(0, 8),
    });
    // dedup KV는 성공 시에만 stamp — 실패 push는 다음 cycle 재시도 허용.
    return { dirty };
  }
  stats.arvlCdFireSuccess += 1;
  stats.pushed += 1;
  // dedup stamp — 같은 cycle에서 Seoul API 갱신 지연으로 같은 신호가 재노출돼도 차단.
  await env.TRIPS.put(key, '1', { expirationTtl: ARVLCD_FIRE_DEDUP_TTL_SEC });
  return { dirty };
}

/**
 * #902 Seam F — trainCode 사라짐 후 swap. previous+이번 미스 = VANISH_RE_ATTACH_THRESHOLD 도달 시 시도.
 * 같은 station에 같은 line 신규 trainCode가 보이면 activeLock 교체. 호출자는 swap 결과를 사용해 재estimate.
 * `runTrainCodeTracking`의 cognitive complexity 분담용 추출 (Sonar S3776).
 */
async function attemptVanishSwap(
  trip: Trip,
  waypoint: Waypoint,
  activeLock: BoardingLockMeta,
  deps: ScheduledDeps,
  now: number,
  log: Logger,
): Promise<BoardingLockMeta | null> {
  const previousMissCount = trip.consecutiveEtaMissing ?? 0;
  if (previousMissCount + 1 < VANISH_RE_ATTACH_THRESHOLD) return null;
  const swapped = await attachTrainCodeForLeg({
    trip,
    targetWaypoint: waypoint,
    seoul: deps.seoul,
    now,
  });
  if (!swapped || swapped.trainCode === activeLock.trainCode) return null;
  log('boarding-lock: trainCode vanished, swapped', {
    token: trip.token.slice(0, 8),
    previousTrainCode: activeLock.trainCode,
    newTrainCode: swapped.trainCode,
    station: waypoint.stationName,
    consecutiveEtaMissing: previousMissCount + 1,
  });
  // segmentStations는 기존 lock 것을 유지 (이미 진행 중인 leg) — 새 trainCode/expiresAt만 채택.
  const newLock: BoardingLockMeta = {
    ...activeLock,
    trainCode: swapped.trainCode,
    expiresAt: Math.max(activeLock.expiresAt, swapped.expiresAt),
  };
  trip.boardingLock = newLock;
  trip.consecutiveEtaMissing = 0;
  return newLock;
}

/**
 * estimate가 null로 끝난 cycle 처리 — etaMissing 카운터 누적 + 임계 초과 시 trip 자동 종료.
 * runTrainCodeTracking의 cognitive complexity 분담용 추출 (Sonar S3776).
 *
 * #1277 — vanish-swap 후보 없음(지하 dead zone)으로 freeze 방지:
 *   VANISH_RE_ATTACH_THRESHOLD + FALLBACK_ADVANCE_GRACE_CYCLES miss 도달 시
 *   lastTrackedArrivalEpoch 기준 hop 시간 경과를 확인해 waypoint optimistic advance를 시도.
 *   경과 미달이면 lock release해 lockless/boardingPrompt가 인계받게 함.
 */
interface HandleEtaMissingInputs {
  trip: Trip;
  waypoint: Waypoint;
  activeLock: BoardingLockMeta;
  env: Env;
  deps: ScheduledDeps;
  stats: ScheduledStats;
  now: number;
  log: Logger;
}
async function handleEtaMissing(inputs: HandleEtaMissingInputs): Promise<void> {
  const { trip, waypoint, activeLock, env, deps, stats, now, log } = inputs;
  stats.etaMissing += 1;
  const previousMissCount = trip.consecutiveEtaMissing ?? 0;
  const nextMissCount = previousMissCount + 1;
  log('boarding-lock: trainCode not found in arrivals or positions', {
    token: trip.token.slice(0, 8),
    trainCode: activeLock.trainCode,
    station: waypoint.stationName,
    consecutiveEtaMissing: nextMissCount,
  });

  // #1277 — vanish-swap(VANISH_RE_ATTACH_THRESHOLD 도달 시 한 번 시도)이 실패한 후
  // FALLBACK_ADVANCE_GRACE_CYCLES grace를 더 기다린 시점에서 시간 기반 fallback.
  // lastTrackedArrivalEpoch가 있을 때만 활성화 — 한 번도 추적된 적 없는 trip(새벽 무운행 등)은
  // 기존 auto-end 임계 경로로 처리한다.
  // 이 분기는 auto-end 임계(threshold) 전에 평가되어 무한 동결을 막는다.
  const fallbackTrigger = VANISH_RE_ATTACH_THRESHOLD + FALLBACK_ADVANCE_GRACE_CYCLES;
  const lastEpoch = trip.lastTrackedArrivalEpoch;
  if (nextMissCount >= fallbackTrigger && lastEpoch !== undefined) {
    const hopElapsed = now >= lastEpoch + FALLBACK_HOP_SEC * 1000;
    if (hopElapsed) {
      // hop 시간 경과 → optimistic waypoint advance.
      // advance 내부에서 destination 도착이면 cleanupTripWithLa, 그 외엔 waypoints.shift().
      log('boarding-lock: trainCode vanished — time-based waypoint advance fallback', {
        token: trip.token.slice(0, 8),
        trainCode: activeLock.trainCode,
        station: waypoint.stationName,
        consecutiveEtaMissing: nextMissCount,
        lastTrackedArrivalEpoch: lastEpoch,
      });
      trip.consecutiveEtaMissing = 0;
      await advanceBoardingLockWaypoint(trip, waypoint, env, deps, stats, now, log);
      return;
    }
    // hop 시간 미경과 → lock release해 lockless/boardingPrompt가 인계받도록.
    // isBoardingLockActive=false가 되는 즉시 다음 cycle의 evaluateAndMaybeFireBoardingPrompt 경로 복구.
    log('boarding-lock: trainCode vanished — releasing lock (hop time not yet elapsed)', {
      token: trip.token.slice(0, 8),
      trainCode: activeLock.trainCode,
      station: waypoint.stationName,
      consecutiveEtaMissing: nextMissCount,
      lastTrackedArrivalEpoch: lastEpoch,
    });
    trip.boardingLock = undefined;
    trip.consecutiveEtaMissing = 0;
    await deleteProgress(env.TRIPS, trip.token);
    await putTrip(env.TRIPS, trip);
    return;
  }

  // #903 (Seam G) — subsurface=true trip은 인내 임계(10)로 분기. 지하 dead zone GPS/trainCode 일시 누락 인내.
  const threshold = resolveEtaMissingThreshold(trip);
  if (nextMissCount >= threshold) {
    // #706 — 운행 시간대 외 무한 폴링 차단. cleanupTripWithLa가 LA dismissal + deleteTrip을 묶어 정리.
    // #868 — 클라 state sync용 trip-ended silent push 발사 (reason=eta-missing).
    log('boarding-lock: trip auto-ended (consecutiveEtaMissing exceeded)', {
      token: trip.token.slice(0, 8),
      trainCode: activeLock.trainCode,
      station: waypoint.stationName,
      threshold,
      subsurface: trip.subsurface === true,
    });
    await cleanupTripWithLa(trip, env, deps, stats, now, log, 'eta-missing');
    return;
  }
  trip.consecutiveEtaMissing = nextMissCount;
  await putTrip(env.TRIPS, trip);
  await mirrorProgress(env.TRIPS, trip, 0);
}

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
  let activeLock = lock;
  let estimate = await estimateBoardingLockArrival(deps, activeLock, waypoint, now);
  if (estimate === null) {
    const swappedLock = await attemptVanishSwap(trip, waypoint, activeLock, deps, now, log);
    if (swappedLock) {
      activeLock = swappedLock;
      estimate = await estimateBoardingLockArrival(deps, activeLock, waypoint, now);
    }
  }
  if (estimate === null) {
    await handleEtaMissing({ trip, waypoint, activeLock, env, deps, stats, now, log });
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
    // #917 A2 — 매역 알림 1차 source는 arvlCd∈{0(ENTERING), 1(ARRIVED)}.
    // positions-fallback arrived(arvlCd=null)는 SSOT 다름 — mismatch로 분류해 push X.
    // prereq 게이트: lock 활성 + arvlCd∈{0,1}. #640 회귀(lock 없는 trip 발사) defensive recheck.
    const gate = evaluateArvlCdFireGate(activeLock, estimate.arvlCd, now);
    if (gate === 'fire' && estimate.arvlCd !== null) {
      const fire = await fireArvlCdStationPush({
        trip,
        waypoint,
        lock: activeLock,
        arvlCd: estimate.arvlCd,
        env,
        deps,
        stats,
        now,
        log,
        generatePushId,
      });
      if (fire.dirty) await putTrip(env.TRIPS, trip);
    } else {
      stats.arvlCdFireMismatch += 1;
      log('arvlcd-fire: mismatch (prereq failed)', {
        token: trip.token.slice(0, 8),
        trainCode: activeLock.trainCode,
        station: waypoint.stationName,
        arvlCd: estimate.arvlCd,
      });
    }
    await advanceBoardingLockWaypoint(trip, waypoint, env, deps, stats, now, log);
    return;
  }

  const { cleanedUp } = await maybeReschedulePush(
    trip,
    waypoint,
    activeLock,
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
): Promise<{ epoch: number; arrived: boolean; arvlCd: number | null } | null> {
  const arrivals = await deps.seoul.fetchArrivals(waypoint.stationName);
  const matched = arrivals.find((a) => a.trainCode === lock.trainCode);
  if (matched) {
    return {
      epoch: now + matched.arrivalSeconds * 1000,
      arrived:
        matched.arvlCd === ARRIVAL_CODE.ARRIVED || matched.arvlCd === ARRIVAL_CODE.ENTERING,
      // #917 A2 — 매역 알림 1차 source. arrivals 경로의 arvlCd를 호출자에게 노출해
      // dedup key 구성 + position-fallback arrived와 구분(positions 경로는 arvlCd=null).
      arvlCd: matched.arvlCd,
    };
  }
  const positions = await deps.seoul.fetchPositions(lock.line);
  const train = positions.find((p) => p.trainCode === lock.trainCode);
  if (!train) return null;
  const fallback = estimateArrivalFromPosition(train, waypoint.stationName, lock, now);
  if (fallback.epoch === null) return null;
  // positions 경로의 arrived는 arvlCd가 아닌 sttus 신호 — 호출자가 arvlCd 매역 fire 분기를
  // skip하도록 null 명시 (#917 A2 prereq guard).
  return { epoch: fallback.epoch, arrived: fallback.arrived, arvlCd: null };
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
    // #868 — destination 도착으로 trip 종료. 클라 state sync용 trip-ended silent push 발사.
    await cleanupTripWithLa(trip, env, deps, stats, now, log, 'destination-arrived');
    log('boarding-lock: destination arrived, trip cleared', {
      token: trip.token.slice(0, 8),
      station: waypoint.stationName,
    });
    return;
  }
  trip.waypoints.shift();
  trip.lastTrackedArrivalEpoch = undefined;
  trip.lastLaPushEpoch = undefined;
  // #900 Seam D — heartbeat 기준점도 reset. 다음 hop은 첫 LA push 후 wall-clock stamp.
  trip.lastLaPushAt = undefined;
  // #864 — transfer waypoint 통과 = 직전 train segment 종료. lock을 유지하면 다음 cycle이
  // 새 line(예: 5호선)에서 옛 trainCode(예: 7327)를 찾아 etaMissing 5회 후 trip auto-end로 사망.
  // lock을 release하면 다음 cycle은 isBoardingLockActive=false → evaluateAndMaybeFireBoardingPrompt
  // 가 사용자에게 환승 train 선택을 prompt하고, 클라이언트의 createTransferLock이 새 lock을 등록.
  // segmentStations도 직전 leg 기준이라 위치 fallback 폴링도 더는 의미 없음.
  //
  // progress KV도 같이 정리 — 옛 trainCode + shiftedCount가 stale로 남으면 token-refresh race
  // (`useApnsTripRegistration` `latestInputsRef` 옛 lock 보유) 윈도우에서 client 옛 lock POST 시
  // `progressApplies=true` 분기로 진입해 옛 lock이 backend에 다시 active로 복원되는 회귀가 가능.
  const lockReleasedOnTransfer = waypoint.kind === 'transfer' && trip.boardingLock !== undefined;
  if (lockReleasedOnTransfer) {
    trip.boardingLock = undefined;
    trip.consecutiveEtaMissing = 0;
    await deleteProgress(env.TRIPS, trip.token);
  }
  // #902 Seam F — 환승 직후 자동 trainCode swap. release한 lock 자리에 새 노선의 후보를
  // 동일 cycle 안에 부착해 다음 cycle의 lockMissing/boarding-prompt 우회 + 즉시 trainCode 추적.
  // 후보 ambiguity / arrivals 비어있음 / subwayId 매핑 누락이면 attempted=true + 결과 null →
  // 기존 lockMissing → evaluateAndMaybeFireBoardingPrompt fallback 흐름이 그대로 살아있다.
  let transferSwapAttached = false;
  if (lockReleasedOnTransfer && trip.waypoints.length > 0) {
    const next = trip.waypoints[0];
    const swapped = await attachTrainCodeForLeg({
      trip,
      targetWaypoint: next,
      seoul: deps.seoul,
      now,
    });
    if (swapped) {
      trip.boardingLock = swapped;
      transferSwapAttached = true;
    }
  }
  log('boarding-lock: waypoint advanced', {
    token: trip.token.slice(0, 8),
    completed: waypoint.stationName,
    kind: waypoint.kind,
    remaining: trip.waypoints.length,
    // P2-2: true일 때만 log key 포함 — false noise로 운영 로그 가시성 저하 방지.
    ...(lockReleasedOnTransfer ? { lockReleasedOnTransfer: true } : {}),
    ...(transferSwapAttached ? { transferSwapAttached: true } : {}),
  });
  if (trip.waypoints.length === 0) {
    // #868 — waypoints 소진(intermediate 마지막 통과)도 effective destination-arrived.
    await cleanupTripWithLa(trip, env, deps, stats, now, log, 'destination-arrived');
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
 *
 * #900 Seam D — ΔETA 임계가 미달이어도 직전 LA push 후 LA_HEARTBEAT_INTERVAL_MS(60s)가
 * 지났으면 heartbeat로 한 번 더 발사한다. ETA가 정체된 BG 구간에서 content-state가
 * stale로 남는 것을 방지하기 위한 안전망. `trip.lastLaPushAt`(epoch ms) 기반.
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
  // #900 — 둘 다 만족 안 하면 skip:
  //   (a) ΔETA ≥ LA_PUSH_THRESHOLD_MS (변동 발사)
  //   (b) heartbeat: (now − lastLaPushAt) ≥ LA_HEARTBEAT_INTERVAL_MS (정체 안전망)
  // last/lastLaPushAt이 둘 다 undefined인 첫 push는 (a) 분기에서 통과 (기존 동작).
  if (last !== undefined && Math.abs(newArrivalEpoch - last) < LA_PUSH_THRESHOLD_MS) {
    const heartbeatDue =
      trip.lastLaPushAt !== undefined && now - trip.lastLaPushAt >= LA_HEARTBEAT_INTERVAL_MS;
    if (!heartbeatDue) return false;
  }
  const etaSeconds = Math.max(0, Math.round((newArrivalEpoch - now) / 1000));
  const contentState = buildLiveActivityContentState(
    waypoint,
    etaSeconds,
    trip.waypoints.length,
  );
  const result = await fireLiveActivityUpdate(trip, contentState, deps, stats, now, log);
  if (result.dirty) {
    // 410 분기 — token이 비워졌으므로 lastLaPushEpoch/lastLaPushAt은 갱신하지 않는다.
    return true;
  }
  trip.lastLaPushEpoch = newArrivalEpoch;
  // #900 Seam D — heartbeat 게이트 기준점. 발사 시각(wall clock)을 stamp.
  trip.lastLaPushAt = now;
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
        // #918 A3 PR4 — `bl:` + `tba:` 동시 정정. 구 backend 호환을 위해 채널 상수는
        // types.ts 단일 SSOT (RESCHEDULE_CHANNELS_DEFAULT)에서 import.
        channels: RESCHEDULE_CHANNELS_DEFAULT,
        // #1193 — 중복역 trip(순환선/회차)에서 `tba:` 채널의 N번째 등장 정정. `validateTrip`이
        // POST /trips 시점에 stamp한 값(불변)을 그대로 forward해 클라이언트와 routeStops 인덱스가
        // round-trip 일치하도록 한다. 구 trip(필드 부재) → undefined → wire 생략 → 클라 0 fallback.
        occurrenceIdx: waypoint.occurrenceIdx,
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
      // #868 — 클라 state sync용 trip-ended silent push도 발사 (reason=push-unrecoverable).
      // 단, 토큰 자체가 unrecoverable이면 push도 같은 이유로 실패할 가능성이 높음 — fireTripEndedPush
      // 내부에서 graceful log만 남기고 cleanup 흐름은 계속 진행한다.
      await cleanupTripWithLa(trip, env, deps, stats, now, log, 'push-unrecoverable');
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
  // #837 P2-1 — dedup gate를 fusion + arrivals fetch + reset 이후로 이동.
  // arvlCd=ARRIVED/ENTERING은 phase보다 강한 ground truth 신호이므로, 이미 imminent 발사한
  // waypoint라도 reset은 수행해야 한다(state drift 누적 차단). push 발사만 dedup으로 차단.
  // #825 — Phase 3 E3 fusion step. 분류 결과를 trip에 stamp + imminent push 발사 가드에 사용.
  const fusion = await runFusionStep(trip, env, now);
  // #837 P2-3 — drift 카운트는 fusion 외부 (SRP). fusion 결과 직후 동일 시점/조건으로 평가.
  maybeCountDrift(fusion.kalmanPrior, fusion.posMetrics, stats, now);
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
  // #826 — fires=true(ARRIVED/ENTERING)는 ground truth 신호. push 발사 여부(phase 가드/dedup)와
  // 무관하게 Kalman state를 reset해 drift 누적을 차단한다. arvlCd가 가장 강한 신호 — phase
  // 분류는 휴리스틱이라 contradiction 시 arvlCd를 신뢰. KV write는 idempotent(v=0/P=R_LOW).
  await writeKalmanState(env.TRIPS, trip.token, resetKalmanForArrival(now));
  stats.kalmanReset += 1;
  // #837 P2-1 — dedup gate (reset 이후, push 발사 직전). 같은 waypoint에서 이미 발사했으면
  // push만 skip하고 dirty 저장 후 return (lockless 흐름은 phase 개념이 없으니 imminent 단일 stamp 사용).
  if (trip.lastFiredPhase === 'imminent') {
    if (dirty) await putTrip(env.TRIPS, trip);
    return;
  }
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
          // Epic #1204 그룹 2 D3 (#1273) — lockless intermediate도 waypoint.hopIndex forward.
          // D1 estimator의 currentHopIndex와 ±tolerance 매칭 시 거리 검증 우회 + GPS 미준비 fallback.
          hopIndex: waypoint.hopIndex,
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
      // #868 — lockless push unrecoverable로 trip 폐기 시에도 클라 state sync push 발사.
      await cleanupTripWithLa(trip, env, deps, stats, now, log, 'push-unrecoverable');
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
    // #868 — lockless trip의 effective destination-arrived도 동일 reason.
    await cleanupTripWithLa(trip, env, deps, stats, now, log, 'destination-arrived');
    return;
  }
  // 다음 waypoint를 위해 dedup stamp reset (위 shift 직후 첫 waypoint는 새 발사 대상).
  trip.lastFiredPhase = undefined;
  // #1285 — lockless shift를 progress KV에 mirror해 POST /trips 재등록 race로부터 진행분 보존.
  // lock 경로의 mirrorProgress와 동형 — token 기준 lockless 마커로 저장.
  await mirrorLocklessProgress(env.TRIPS, trip);
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

  // #916 follow-up B — fired+clear 분기 회복. 직전 auto-prompt 발사 윈도우 안에 다시 들어왔다면
  // 평가 자체를 skip — boardingPromptState가 isSameSession=false로 리셋됐거나 lock이 클리어된
  // 직후 같은 trip token이 lockMissing으로 돌아온 케이스. 같은 trip 컨텍스트의 중복 auto-prompt
  // 시도/푸시를 차단한다 (윈도우 만료 후엔 자연 재평가 — 새 leg/새 trip은 fresh).
  if (
    trip.lastAutoPromptedAt !== undefined &&
    now - trip.lastAutoPromptedAt < AUTO_PROMPT_DEDUP_WINDOW_MS
  ) {
    stats.boardingPromptAutoDeduped += 1;
    log('boarding-prompt: auto-deduped (within window)', {
      token: trip.token.slice(0, 8),
      ageMs: now - trip.lastAutoPromptedAt,
    });
    return;
  }

  stats.boardingPromptEvaluated += 1;

  const fusion = await runFusionStep(trip, env, now);
  // #837 P2-3 — drift 카운트는 fusion 외부 (SRP). fusion 결과 직후 동일 시점/조건으로 평가.
  maybeCountDrift(fusion.kalmanPrior, fusion.posMetrics, stats, now);
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
    // #833 — runFusionStep이 Kalman observation을 위해 이미 evaluateWindow를 1회 돌렸다.
    // 그 결과를 그대로 재사용해 trip당 redundant window 평가를 제거 (동작 동치).
    metrics: fusion.posMetrics,
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

  // #916 A1 — 9단 게이트 통과 시점에 backend가 직접 trainCode를 결정 가능한지 시도.
  // 성공하면 사용자에게 "탑승했냐?" 푸시 없이 lock을 자동 부착하고 cron이 매역 추적을 시작.
  // 실패(arrivals 없음/ambiguity/subwayId 매핑 누락 등) → 기존 boarding-prompt push fallback.
  // 거짓 양성 방어: 사용자가 다른 trainCode를 탭하면 client가 새 lock POST → #864/#704 분기로
  // 자연 교체. boardingPromptState도 함께 fired stamp해 같은 cycle에서 prompt 발사를 차단.
  const targetWaypoint = pickActiveWaypoint(trip);
  if (targetWaypoint) {
    const autoLockResult = await attemptAutoLock({
      trip,
      targetWaypoint,
      originStation: display.originStation,
      direction: geo.direction,
      seoul: deps.seoul,
      now,
      // #1018 RC1 confidence gate 입력 — arvlCd=2 at next-waypoint 검출 시 사용.
      boardingPromptState: trip.boardingPromptState,
      lastMotionAt: fusion.series[fusion.series.length - 1]?.ts,
    });
    // #1171 — RC1 confidence gate가 평가된 경우(arvlCd=2 branch) score 분포를 AE에 적재.
    // 1주 운영 후 본 분포로 AUTO_LOCK_CONFIDENCE_THRESHOLD 튜닝 결정.
    // gate 미평가 케이스(arvlCd!=2 / 더 이른 실패)는 trace undefined → skip.
    if (autoLockResult.confidenceTrace && env.TELEMETRY) {
      recordAutoLockConfidence(env.TELEMETRY, trip.token, autoLockResult.confidenceTrace);
    }
    const autoLock = autoLockResult.lock;
    if (autoLock) {
      trip.boardingLock = autoLock;
      trip.boardingPromptState = markPromptFired(now);
      // #916 follow-up B — auto-prompt dedup 마커. lock이 나중에 클리어돼도 window 안에서
      // 재발사를 차단한다. boardingPromptState와 별개라 isSameSession=false 리셋에도 살아남는다.
      trip.lastAutoPromptedAt = now;
      trip.consecutiveEtaMissing = 0;
      stats.autoLockSuccess += 1;
      log('boarding-prompt: auto-lock attached', {
        token: trip.token.slice(0, 8),
        trainCode: autoLock.trainCode,
        line: autoLock.line,
        originStation: display.originStation,
        fusedSpeedKmh: Math.round(outcome.fusedSpeedKmh * 10) / 10,
      });
      await putTrip(env.TRIPS, trip);
      return;
    }
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
    // #916 follow-up B — prompt push도 같은 dedup 마커를 stamp한다. dismiss + 클리어 후
    // isSameSession=false 분기로 boardingPromptState가 사라져도 window 안에서 재발사 차단.
    trip.lastAutoPromptedAt = now;
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
