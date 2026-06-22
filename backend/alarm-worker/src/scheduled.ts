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
  type PushOrigin,
  type SilentPushPayload,
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
import { computeAllowedLines, type StationEnvironment } from './consensusGate';
import { attachTrainCodeForLeg } from './lockSwap';
import {
  advanceTripPosition,
  mapEvidenceEnvironment,
  type AdvanceBlockReason,
  type AdvanceEvidence,
  type EvidenceEnvironment,
} from './advanceTripPosition';
import {
  deleteSsot,
  readSsot,
  seedSsot,
  SSOT_CRON_READ_CACHE_TTL_SEC,
  type TripPositionSSoT,
} from './tripPositionSsot';
import {
  evaluateWindow,
  readSeries,
  type WindowedMetrics,
} from './positionSeries';
import { assertCronCacheTtl } from './kvConsistency';
import { buildAlarmKey, putPending } from './pendingPushes';
import { deleteProgress, getProgress, putProgress, type TripProgress } from './progress';
import { SeoulArrivalClient, type ArrivalEntry, type PositionEntry } from './seoul';
import { pollLinesAndStamp, readSelfPollPosition } from './selfPollPosition';
import { phaseAllowsImminentFiring, runStationPhaseStep } from './stationPhase';
import { listTrips, putTrip } from './trips';
import {
  evaluateTransferDestinationGate,
  isTransferOrDestination,
  type TransferDestinationBlockReason,
} from './transferDestinationGate';
import type {
  ApnsEnv,
  BoardingLockMeta,
  Env,
  LineNumber,
  PositionPoint,
  StationPhaseState,
  Trip,
  Waypoint,
} from './types';
import { RESCHEDULE_CHANNELS_DEFAULT } from './types';
import { writeMetric } from './analytics';

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
 * #1652 — backend cron staged trip lifecycle backstop (X8 차단).
 *
 * 배경: `consecutiveEtaMissing` 임계 종료(5/10 cycle)는 Seoul API가 trainCode를 잃을 때만 발동.
 * Seoul outage / lockless 정적 / 권한 손상 등으로 cleanup 분기에 닿지 않으면 trip이 무한 잔존
 * (10.5h 좀비 evidence, 2026-06-20 dump).
 *
 * Device-side는 T10 #1573 / PR #1594에서 `tripStartStorage.tripLifecyclePhase` +
 * `useStateRehydration.runLifecycleBackstop`이 같은 임계로 silence/force-end를 처리한다.
 * 본 backend backstop은 device가 죽거나 BG 미진입 상태에서도 trip이 KV에 무한 잔존하지
 * 않도록 하는 **마지막 line of defense** — device-side와 dual safety net.
 *
 * 정합성: 임계는 device-side `TRIP_LIFECYCLE_SILENCE_MS` / `TRIP_LIFECYCLE_FORCE_END_MS`와 1:1
 * (`src/shared/constants/realtime.ts`). 두 값이 어긋나면 한쪽이 먼저 발동해 cleanup race가 발생하므로
 * 변경 시 양쪽 동시 업데이트 필수.
 */
export const BACKEND_TRIP_LIFECYCLE_SILENCE_MS = 6 * 60 * 60 * 1000;
export const BACKEND_TRIP_LIFECYCLE_FORCE_END_MS = 9 * 60 * 60 * 1000;

/**
 * #1652 — trip lifecycle phase 판정.
 *
 * `createdAt` 기준 elapsed로 단계 분리. cron이 매 cycle iterate하면서 phase에 따라 처리 분기:
 *  - 'normal'    : 정상 운행 (createdAt < 6h). 기존 로직 그대로
 *  - 'silence'   : 6h~9h. cron skip (Seoul polling + push 모두 미발사) — KTX/장거리 trip 보호
 *  - 'force-end' : 9h+. cleanupTripWithLa('expired')로 강제 종료
 *
 * 좀비 회수가 cleanup이므로 reason='expired' 재사용 — TripEndedReason enum 변경 없이 client는
 * 이미 graceful handle. log/stats에 별도 label로 telemetry 구분.
 */
export type TripLifecyclePhase = 'normal' | 'silence' | 'force-end';

export function tripLifecyclePhase(
  trip: Pick<Trip, 'createdAt'>,
  now: number,
): TripLifecyclePhase {
  const elapsed = now - trip.createdAt;
  if (elapsed >= BACKEND_TRIP_LIFECYCLE_FORCE_END_MS) return 'force-end';
  if (elapsed >= BACKEND_TRIP_LIFECYCLE_SILENCE_MS) return 'silence';
  return 'normal';
}

/**
 * #1315 — lockless trip에서 trainCode를 확보하지 못한 cycle의 bare-arvlCd advance 보수 게이트.
 *
 * 배경(2026-06-15 trip): 사용자가 정적(용마산 근처)인데 backend가 waypoint 역의 "아무 열차"
 * arvlCd=ARRIVED만 보고 다음 역으로 advance → false positive + 알림 레이스. `pickBestArrivalSignal`
 * 은 trainCode를 바인딩하지 않으므로, 그 신호가 *사용자가 탄 열차*가 통과했다는 ground truth가
 * 아니다(다른 열차/반대 방향일 수 있음).
 *
 * 정책(ADR-010 "false positive / miss 동급" + "나쁜 신호 거부" 실시간성 정책): trainCode
 * 미확보 cycle에서는 GPS motion이 **실제 이동**(walking/automotive)을 positive하게 보일 때만
 * bare-arvlCd advance를 허용한다. `stationary`/`unknown`(샘플 없음 포함)은 보류 — 사용자가
 * 그 구간을 실제로 지났다는 독립 확증이 없다.
 *
 * 트레이드오프(PR 본문 FLAG): 지하(subsurface)에서 GPS가 끊겨 motion=unknown인 채로 사용자가
 * 실제 이동 중이면 이 게이트가 정당한 advance를 miss한다. trainCode 바인딩(우선 경로)이 그 miss를
 * 메우지만, 바인딩 자체가 9단 게이트(이동 필요)에 의존하므로 지하 정적 케이스는 여전히 사각이다.
 * 임계 완화 대신 후속 보강(예: subsurface trainCode 추론)으로 결정 — 본 PR은 false positive
 * 제거를 우선한다.
 */
export const LOCKLESS_ADVANCE_MOTION_MODES: ReadonlySet<PositionPoint['motion']> = new Set([
  'walking',
  'automotive',
]);

/**
 * #1315 — lockless 경로 motion 게이트(엄격). positive 이동(walking/automotive)일 때만 advance 허용.
 * stationary/unknown은 보류. 정적 false advance + 알림 레이스 차단이 1차 목표.
 */
export function isAdvanceAllowedByMotion(motion: PositionPoint['motion']): boolean {
  return LOCKLESS_ADVANCE_MOTION_MODES.has(motion);
}

/**
 * #1386 — lock-active vanish fallback advance(`handleEtaMissing` time-based) 전용 motion 게이트.
 *
 * @deprecated ADR-017 T5 (#1558) — `advanceBoardingLockWaypoint`가 `advanceTripPosition` 단일
 *   진입점을 통해 SSoT motion 게이트(#2)로 정지 trip을 차단한다. 본 함수는 backward-compat 용으로
 *   export를 유지하지만 신규 호출 X. vanish-fallback path는 evidence를 stamp하면 SSoT가 자동으로
 *   stationary를 차단한다 (`tripPositionSsot.motionState` + `advanceTripPosition` #2 게이트).
 *
 * 기존 동작 (참조):
 * - `stationary` → 보류, `walking`/`automotive`/`unknown` → 진행.
 * - SSoT 도입 후엔 motionState='stationary' + userIntentDeclared=false 시 자동 차단.
 *
 * 트레이드오프(이슈 #1386): `unknown` 중 실제 정지인 케이스는 못 잡는다 — SSoT motionState
 * 'unknown'도 #2 게이트를 통과하므로 동등한 트레이드오프가 유지된다.
 */
export function isFallbackAdvanceBlockedByMotion(motion: PositionPoint['motion']): boolean {
  return motion === 'stationary';
}

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

/**
 * #1539 (S6) — `Trip.passedStations` 누적 최대 길이.
 * silent push payload가 비대해지는 것을 막고(APNs payload limit 4KB), device 사전 예약 큐와
 * diff에 필요한 직전 N개 station만 유지한다(트립 누적 알림 수는 일반적으로 한 자릿수~십 수개).
 *
 * 20은 보수적 상한 — 1분 cron jitter로 device가 놓칠 수 있는 최대 통과 station 수의 2배 이상.
 */
export const PASSED_STATIONS_MAX_LEN = 20;

/**
 * #1539 (S6) — Cloudflare cron trigger의 nominal interval (60s, `wrangler.toml` `[triggers].crons`).
 * `runScheduled`가 실제 실행된 시각과 직전 60s boundary의 차이로 cron jitter를 측정한다.
 *
 * 정상 운영: jitter < 1s. Cloudflare scheduler 부하 시 수 초~수십 초까지 늘어날 수 있고,
 * device 매역 알림 누락의 1차 원인 중 하나(epic #1533 ADR-016 §3 결정 5). 이 값이 P99로
 * 추적되면 cron 윈도우 확장(S5) 영향 평가의 정량 근거가 된다.
 */
export const CRON_NOMINAL_INTERVAL_MS = 60_000;

/**
 * #1539 (S6) — `Trip.passedStations`에 stationName을 cap 적용해 누적.
 * 같은 stationName이 연속 호출되면 push하지 않는다(arrived+entering 양쪽 신호로 advance 헬퍼가
 * 1 hop에 한 번만 진입하지만 defensive). 길이 초과 시 oldest를 drop.
 *
 * pure helper — trip 객체를 mutate하고 변경 여부(dirty)를 반환해 호출자가 putTrip 분기에 사용한다.
 */
export function appendPassedStation(trip: Trip, stationName: string): boolean {
  if (stationName.length === 0) return false;
  if (trip.passedStations === undefined) {
    trip.passedStations = [stationName];
    return true;
  }
  const last = trip.passedStations[trip.passedStations.length - 1];
  if (last === stationName) return false;
  trip.passedStations.push(stationName);
  if (trip.passedStations.length > PASSED_STATIONS_MAX_LEN) {
    trip.passedStations.splice(0, trip.passedStations.length - PASSED_STATIONS_MAX_LEN);
  }
  return true;
}

/**
 * #1539 (S6) — cron jitter 측정. 실제 실행 시각과 직전 60s boundary의 차이(ms).
 * 정상 운영에서 < 1s. Cloudflare scheduler 부하 또는 cold start 시 수 초까지 늘어날 수 있다.
 *
 * 음수 반환 가능성 없음 — `now`가 boundary 이전인 case는 floor의 의미상 불가능(now ≥ boundary).
 */
export function computeCronJitterMs(now: number): number {
  const boundary = Math.floor(now / CRON_NOMINAL_INTERVAL_MS) * CRON_NOMINAL_INTERVAL_MS;
  return now - boundary;
}
// #1402 — load-time 회귀 가드. 컴파일 시 0/10 같은 값을 silently 넣지 못하도록 module load
// 시점에 즉시 throw. 신규 callsite 추가 시 type-check + 첫 test run 양쪽에서 잡힌다.
assertCronCacheTtl(CRON_PROGRESS_CACHE_TTL_SEC);

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
  /**
   * #1315 — lockless cycle에서 trainCode 미확보 + GPS motion이 실제 이동(walking/automotive)이
   * 아니어서 bare-arvlCd advance를 보류한 누적 횟수 (`LOCKLESS_ADVANCE_MOTION_MODES` 게이트).
   * false positive(정적 상태 잘못된 station-passed) 방어 효과 측정 — 정상 운영에서 0이 아니면
   * trainCode 바인딩이 닿지 않는 lockless 정적 구간이 그만큼 있었다는 신호.
   */
  locklessMotionGateBlocked: number;
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
  /**
   * ADR-017 T4 (#1557) — `advanceTripPosition` SSoT 게이트가 차단해 매역 push가 발사되지
   * 않은 누적 횟수. 2026-06-19 정지 trip + lock active + arvlcd ARRIVED → false 발사 회귀
   * (N1)를 직접 차단하는 게이트. 0이 아니면 stationary trip / env-consensus-fail /
   * train-mismatch 등 6단 게이트 reject 분포를 production tail로 측정 가능.
   */
  arvlCdFireBlocked: number;
  /**
   * ADR-017 T4 (#1557) — `advanceTripPosition`이 'advanced' 통과 후 실제로 push 발사 시도까지
   * 도달한 누적 횟수. `arvlCdFireSuccess`(push ack 성공)와 별개 — fire 진입(SSoT 통과)
   * vs 외부 APNs 성공률을 분리 측정. `arvlCdFireBlocked`와 합쳐 SSoT 게이트의 traffic
   * 비중(blocked / fired) 분포를 추적한다.
   */
  arvlCdFireFired: number;
  /**
   * ADR-017 T5 (#1558) — `advanceBoardingLockWaypoint` 진입했지만 `advanceTripPosition` SSoT
   * 게이트가 차단해 trip.waypoints advance 가 일어나지 않은 횟수. 2026-06-19 정지 trip 매분
   * waypoint advance 회귀(8회)를 직접 차단하는 게이트. arvlcd-arrived path (T4 와 짝) +
   * vanish-fallback path 모두 본 카운터에 집계. blockReason 분포는 log 로 확인.
   */
  boardingLockWaypointAdvanceBlocked: number;
  /**
   * ADR-017 T7 (#1560) — transfer/destination kind 의 station-passed/transfer-release fire 시점에
   * `evaluateTransferDestinationGate`가 차단한 누적 횟수. SSoT.currentStationId 가 waypoint 또는
   * 직전 1 hop 아님 / lastAdvanceAt 60s stale / 미advance 분포를 production tail 로 확인. 2026-06-19
   * 정지 trip "환승임박 건대입구" false 발사(N9) 회귀를 직접 차단하는 게이트.
   */
  transferDestinationGateBlocked: number;
  /**
   * #1370 L2 — trainCode vanish 후 시간 기반 fallback advance 직전에 station-passed silent push가
   * 발사된 누적 횟수. fallback path가 어린이대공원/군자/중곡 같은 intermediate를 "지났음" 신호 없이
   * 통과하던 회귀(silent push 0건)를 닫는다.
   */
  vanishFallbackFired: number;
  /**
   * #1402 — trainCode vanish 후 hop 시간 미경과로 lock release 직전에 보장 발사한 floor
   * station-passed silent push의 누적 횟수. fallback advance(hop-elapsed) 경로가 발사하던
   * push가 release(hop-not-elapsed) 경로에서 빠져 device가 stale 채로 lock 인계되던 회귀
   * (2026-06-17 군자/용마산 침묵)를 닫는다. 발사 성공 시 PENDING_PUSHES에 등록돼 30s 내
   * ACK 없으면 alert fallback이 자동 발사된다.
   */
  vanishReleaseFired: number;
  /**
   * #1370 L3 — vanish 후 hop 시간 미경과로 lock release할 때 trip.infoModeEnabled가
   * false였던 trip을 강제 enable해 lockless 인계 경로를 살린 횟수. 0이 아니면 사용자가 opt-in
   * 토글 OFF였지만 vanish recovery로 매역 push가 복구된 trip 수.
   */
  vanishLocklessTakeover: number;
  /**
   * #1386 — lock-active fallback advance(handleEtaMissing time-based) 진입 시점에 device
   * positionSeries의 motion이 실제 이동(walking/automotive)이 아니어서 advance + station-passed
   * push를 보류한 누적 횟수. lockless 경로(`locklessMotionGateBlocked`)와 동일 정책의
   * lock-active 버전 — 사용자가 정지 중인데 backend가 hop 시간 적분만으로 false station-passed를
   * 발사하던 회귀(2026-06-16 용마산 정지 trip)를 차단한다.
   */
  vanishFallbackMotionGateBlocked: number;
  /**
   * #1539 (S6, Epic #1533 / ADR-016) — `runScheduled` 진입 시점의 cron jitter (ms).
   * 직전 60s boundary와 실제 실행 시각의 차이. 정상 운영 < 1s. 매역 알림 누락 회귀의 1차
   * 원인 중 하나로 추정되며(2026-06-19 트립 2 evidence), P50/P99 추적이 S5 윈도우 확장 효과
   * 측정의 정량 근거가 된다. 누적 metric이 아니라 매 cycle의 즉시값을 그대로 log한다.
   */
  cronJitterMs: number;
  /**
   * #1559 (T6, Epic #1553 / ADR-017) — `maybeReschedulePush` 진입 시 SSoT.motionState === 'stationary'로
   * reschedule silent push가 차단된 누적 횟수. 정지 trip에서 ETA 임계치 변동만으로 LA/scheduled queue를
   * 재발사하던 회귀(2026-06-19 15:53/15:56 evidence)를 닫는다. lock-active fallback
   * (`vanishFallbackMotionGateBlocked`) / lockless advance(`locklessMotionGateBlocked`)와 동일 정책의
   * reschedule-push 버전 — `tripPositionSsot.motionState` SSoT 단일 소스.
   */
  rescheduleBlockedMotion: number;
  /**
   * #1559 (T6) — `maybeReschedulePush` 진입 시 SSoT가 존재하지 않아(legacy trip — T1 SSoT seeding 이전에
   * 생성된 trip 또는 KV TTL 만료) motion 게이트를 적용하지 않고 기존 로직으로 fallback한 누적 횟수.
   * SSoT 마이그레이션 진행도 측정 — 모든 trip이 T1 seeding을 거치게 되면 0으로 수렴한다.
   */
  rescheduleFallbackNoSsot: number;
  /**
   * #1614 Phase A (S4 #1537) — cron 진입부 self-poll realtimePosition fetch 횟수.
   * 활성 trip line union에 대해 Seoul API를 1회 호출(KV cache miss). 호선당 30s TTL.
   * positionTrainAgreement strongCB wire의 입력 단(端) 카운터.
   */
  realtimePositionFetch: number;
  /**
   * #1614 Phase A — KV stamp 살아있어 fetch skip한 횟수. cron 1분 race에서 동일 line 재진입 시.
   */
  selfPollCacheHit: number;
  /**
   * #1614 Phase A — Seoul API throw 또는 KV write throw 등 self-poll 전반 실패 횟수.
   * 0이 아니면 cron tail에서 Seoul API rate limit / KV 장애 진단 신호.
   */
  realtimePositionFetchError: number;
  /**
   * #1614 Phase C — `fireArvlCdStationPush` 진입 시 SSoT.lastAdvanceAt이 stale(>3분 경과)이라
   * fire를 차단한 누적 횟수. transferDestinationGate(60s)보다 보수적이지만 모든 fire kind에
   * 동일 적용. 정상 운영에서는 0에 가깝고, 0이 아니면 motion 추적 cascade fail 또는 stale lock
   * misfire 회귀 신호. (transferDestinationGateBlocked와 별도 계측 — 본 가드는 intermediate 포함.)
   */
  staleLockFireSkipped: number;
  /**
   * #1652 — staged lifecycle backstop. trip이 createdAt > 6h이라 silence cycle로 skip된 누적 횟수.
   * Seoul polling + push 발사 모두 skip된 cycle 수 = 6h+ 잔존 trip × 분당 1 cycle. 정상 운영에선
   * 일반적으로 0에 수렴 (대부분 trip이 6h 이내 종료). 0이 아니면 KTX/장거리 trip 또는 좀비 trip이
   * 잔존 중이라는 신호 — 9h 도달 시 force-end로 자연 회수.
   */
  lifecycleSilenceSkipped: number;
  /**
   * #1652 — staged lifecycle backstop. trip이 createdAt > 9h이라 force-end로 cleanup된 누적 횟수.
   * 정상 운영에선 0이어야 (정상 trip + device staged backstop이 9h 이내 종료). 0이 아니면 device가
   * 죽었거나 BG 미진입 상태에서 backend가 마지막 line of defense로 cleanup한 케이스 = 회귀 신호.
   * cron tail에서 1주 0건이면 본 backstop이 dual safety net으로 동작 중임을 확인.
   */
  lifecycleForceEnded: number;
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

/**
 * #1614 Phase A — 활성 trip의 line union 수집.
 *
 * 다음 메인 루프와 같은 `listTrips`를 한 번 더 iterate해 route + waypoints의 모든 line을
 * `computeAllowedLines`로 union. 환승 route는 fromLine/toLine 모두 포함되므로 leg마다 별도 fetch
 * 필요 없이 한 cron tick에 trip이 다닐 수 있는 모든 line이 stamp된다.
 *
 * `expiresAt` 만료 trip은 skip — 메인 루프의 cleanup 분기가 어차피 처리하므로 self-poll 대상 X.
 * `alarmAtEpochMs - now > POLLING_WINDOW_MS`(아직 알람 윈도우 진입 전) trip은 포함 — 미리 line의
 * realtimePosition stamp를 적재해두면 윈도우 진입 시 첫 cycle부터 cross-match 가능.
 *
 * #1652 — staged lifecycle backstop 도달 trip은 self-poll 대상 X. 같은 cycle에 메인 루프가
 *   - silence(6h~9h): cron skip → polling 무의미
 *   - force-end(9h+): cleanupTripWithLa로 cleanup → 다음 cycle에 line union에서 자연 빠짐
 *   둘 다 Seoul 호출을 미리 줄여 quota 절감 + cron throughput 보호.
 */
async function collectActiveLines(env: Env, now: number): Promise<Set<LineNumber>> {
  const lines = new Set<LineNumber>();
  for await (const trip of listTrips(env.TRIPS)) {
    if (trip.expiresAt <= now) continue;
    if (tripLifecyclePhase(trip, now) !== 'normal') continue;
    for (const line of computeAllowedLines(trip.route, trip.waypoints)) {
      lines.add(line);
    }
  }
  return lines;
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
    locklessMotionGateBlocked: 0,
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
    arvlCdFireBlocked: 0,
    arvlCdFireFired: 0,
    boardingLockWaypointAdvanceBlocked: 0,
    transferDestinationGateBlocked: 0,
    vanishFallbackFired: 0,
    vanishReleaseFired: 0,
    vanishLocklessTakeover: 0,
    vanishFallbackMotionGateBlocked: 0,
    // #1539 (S6) — cron jitter (실행 시각 - 직전 60s boundary). 매 cycle 즉시값으로 stamp.
    cronJitterMs: computeCronJitterMs(now),
    // #1559 (T6) — reschedule push motion 게이트 차단/fallback 누적.
    rescheduleBlockedMotion: 0,
    rescheduleFallbackNoSsot: 0,
    // #1614 Phase A (S4) — backend self-poll realtimePosition stats.
    realtimePositionFetch: 0,
    selfPollCacheHit: 0,
    realtimePositionFetchError: 0,
    // #1614 Phase C — stale SSoT 가드 fire 차단.
    staleLockFireSkipped: 0,
    // #1652 — staged lifecycle backstop (X8). 6h~9h skip / 9h+ force-end.
    lifecycleSilenceSkipped: 0,
    lifecycleForceEnded: 0,
  };
  // #1539 (S6) — cron jitter 즉시 log. 누적 stat이 아니라 매 cycle 1줄 → tail에서 P50/P99 산출.
  log('scheduled: cron jitter', { jitterMs: stats.cronJitterMs });

  // #1614 Phase A (S4 #1537) — 활성 trip line union 추출 + Seoul realtimePosition 전수 self-poll.
  // 1차 iterate: 활성 trip의 route + waypoints에서 line set 수집 (computeAllowedLines 활용 — 환승
  // route는 transfers의 fromLine/toLine 모두 포함). 2차 iterate(아래 메인 루프)는 그대로 폴링 ·
  // push 발사 흐름 유지. KV stamp는 advanceTripPosition site들이 lock.trainCode cross-match에 사용.
  const activeLines = await collectActiveLines(env, now);
  const selfPollStats = await pollLinesAndStamp(env.TRIPS, deps.seoul, activeLines, now);
  stats.realtimePositionFetch += selfPollStats.fetched;
  stats.selfPollCacheHit += selfPollStats.cacheHit;
  stats.realtimePositionFetchError += selfPollStats.error;
  if (activeLines.size > 0) {
    log('self-poll: realtimePosition', {
      lines: activeLines.size,
      fetched: selfPollStats.fetched,
      cacheHit: selfPollStats.cacheHit,
      error: selfPollStats.error,
    });
  }

  for await (const trip of listTrips(env.TRIPS)) {
    stats.scanned += 1;

    if (trip.expiresAt <= now) {
      // #586 D — trip 만료 시 활성 LA가 남아 있으면 dismissal push로 정리하고 KV에서 제거.
      // #868 — 클라 state sync용 trip-ended silent push도 함께 발사 (reason=expired).
      await cleanupTripWithLa(trip, env, deps, stats, now, log, 'expired');
      continue;
    }

    // #1652 — staged lifecycle backstop (X8 차단). expiresAt 만료 분기 직후 게이트.
    // device-side (T10 #1573 / PR #1594)가 staged backstop을 처리하지만 device가 죽거나 BG 미진입
    // 시 trip이 backend KV에 무한 잔존(10.5h 좀비 evidence). backend 마지막 line of defense.
    //   - silence (6h~9h): cron skip — KTX/장거리 trip 보호. Seoul polling + push 모두 미발사.
    //   - force-end (9h+) : cleanupTripWithLa로 강제 종료. reason='expired' 재사용 (client는 이미
    //     graceful handle, 신규 enum 추가 없이 backward-compat). log/stats로 telemetry 구분.
    const lifecyclePhase = tripLifecyclePhase(trip, now);
    if (lifecyclePhase === 'force-end') {
      stats.lifecycleForceEnded += 1;
      log('lifecycle: force-end (>9h)', {
        token: trip.token.slice(0, 8),
        elapsedMs: now - trip.createdAt,
      });
      await cleanupTripWithLa(trip, env, deps, stats, now, log, 'expired');
      continue;
    }
    if (lifecyclePhase === 'silence') {
      stats.lifecycleSilenceSkipped += 1;
      log('lifecycle: silence cycle skipped (>6h)', {
        token: trip.token.slice(0, 8),
        elapsedMs: now - trip.createdAt,
      });
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
      if (trip.infoModeEnabled && waypoint.kind === 'intermediate') {
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
        locklessOptIn: trip.infoModeEnabled === true,
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

/**
 * #1363 — 시리즈에서 가장 최근 `currentStationName`을 추출. log 진단(`waypoint` vs
 * `currentStation`) 이원화 용도. 클라가 stamp한 사용자 현재 추정역 이름이고, 가장 최근 sample이
 * 누락한 경우 직전 sample에서 backfill한다(클라가 fix마다 매번 stamp하지 않는 케이스 대응).
 * 시리즈 전체에서 stamp가 한 번도 없으면 undefined → log 키 자체 omit (graceful).
 */
export function pickLatestCurrentStationName(series: readonly PositionPoint[]): string | undefined {
  for (let i = series.length - 1; i >= 0; i--) {
    const name = series[i].currentStationName;
    if (typeof name === 'string' && name.length > 0) return name;
  }
  return undefined;
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
 * #1367 — cross-station 동일 phase 다중 banner 차단 윈도우(ms).
 * 짧은 cron 간격(60s)에서 hop이 advance한 직후 다음 hop의 첫 fire가 즉시 또 발사되어 device에서
 * "같은 분에 두 알림" 패턴이 발생하던 회귀(이슈 evidence) 차단용. 윈도우 안이면 한 번만 통과한다.
 * 60s 이상 hop이 진행됐다면 정상 시퀀스이므로 통과 — 사용자 가치 손실 없음.
 */
export const SAME_PHASE_STATION_DEDUP_WINDOW_MS = 45_000;

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
 *
 * @deprecated ADR-017 T2 (#1555) — 본 게이트는 분산된 fire path 잔존 호출자 보존용. 신규 호출자는
 *   `advanceTripPosition` (단일 mutation 진입점)을 사용해 6단 게이트(seed/motion/env/type/train
 *   identity/lockless arvlcd 단독)를 전부 거치게 해야 한다. T4~T7 reader migration에서 호출자
 *   교체가 완료되면 본 함수는 제거 예정.
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
 * #1370 — station-passed imminent push payload 빌더. arvlCd path와 vanish-fallback path가
 * 같은 payload 모양을 공유 (lock self-describing, subsurface flag, hopIndex forward 등). SonarCloud
 * 중복 차단 + 새 필드 추가 시 단일 지점 갱신을 위해 헬퍼로 추출.
 */
interface BuildStationPassedImminentPayloadInputs {
  trip: Trip;
  waypoint: Waypoint;
  lock: BoardingLockMeta;
  pushId: string;
  now: number;
  /**
   * #1402 — 발사 경로(origin) stamp. 좀비 알림 RCA + alarmLog `pushOrigin` 매핑용.
   * arvlCd 경로 = 'arvlcd', vanish fallback advance 직전 = 'vanish-fallback',
   * vanish lock release 직전 floor = 'vanish-release'.
   */
  origin: PushOrigin;
  /**
   * #1438 (E5) — backend → device lock release sync 채널. 이 push 발사와 동시에 backend가
   * `trip.boardingLock`을 release한 경우 reason을 forward해 device가 즉시 store sync 가능.
   * floor fire(vanish-release)에서만 'vanish'로 전달 — 다른 경로(arvlcd, vanish-fallback)는
   * lock을 release하지 않으므로 undefined.
   */
  lockReleasedReason?: 'transfer' | 'vanish';
  /**
   * #1561 (T8, ADR-017 / S2 #1535 흡수) — backend가 보유한 TripPositionSSoT 권위 스냅샷.
   *
   * 정의된 경우 silent push payload에 `ssot` 필드로 forward → device cascade picker가 `backend-ssot`
   * tier(최상위)로 채택. 미전달(undefined) 시 payload에서 자연 누락 → device는 기존 cascade fallback.
   *
   * SSoT는 caller가 `readSsot(env.TRIPS, trip.token, { cacheTtl: CRON_READ_CACHE_TTL_SEC })`로
   * 로드해 전달. read 실패 시 undefined를 그대로 전달해 wire에서 자연 누락하는 정책 — backend SSoT가
   * 부재한 trip(seed 전 / KV race)도 push 발사 자체는 막지 않는다(graceful).
   */
  ssot?: TripPositionSSoT | null;
}
/**
 * #1561 (T8) — silent push payload에 forward되는 SSoT 스냅샷의 passedStations 최근 N개 한도.
 * 4호선 전 구간(40+ 역) 같은 긴 trip에서도 payload 크기 폭주 차단. device는 자체 누적 + 본 forward로
 * 짧은 history만 cross-check.
 */
const SSOT_FORWARD_PASSED_STATIONS_MAX = 5;

/**
 * #1561 (T8) — `TripPositionSSoT`를 silent push payload에 forward할 수 있는 `SilentPushSsotPayload`
 * 형태로 축소. null/undefined는 그대로 통과시켜 caller가 wire 자연 누락 분기를 단순화.
 */
export function toSilentPushSsot(
  ssot: TripPositionSSoT | null | undefined,
): SilentPushPayload['ssot'] {
  if (ssot == null) return undefined;
  return {
    currentStationId: ssot.currentStationId,
    motionState: ssot.motionState,
    lastAdvanceEvidence: ssot.lastAdvanceEvidence,
    lastAdvanceAt: ssot.lastAdvanceAt,
    passedStations: ssot.passedStations.slice(-SSOT_FORWARD_PASSED_STATIONS_MAX),
    // #1534 (S1, T9b) — backend lockSuggestion forward. 부재 시 wire 자연 누락
    // (apns.ts JSON serializer는 undefined 필드 omit). device cascade picker는 기존 tier fallback.
    ...(ssot.lockSuggestion ? { lockSuggestion: ssot.lockSuggestion } : {}),
    // #1572 (T9) — backend alarmEvents forward. 부재 시 wire 자연 누락. device 측 evaluateSsotFireGate가
    // mirror에서 read해 5 fire path 게이트 A/B로 사용. SSOT_FORWARD_PASSED_STATIONS_MAX와 별개 cap —
    // alarmEvents는 source에서 이미 ALARM_EVENTS_CAP=50으로 제한돼 추가 slice 불필요.
    ...(ssot.alarmEvents ? { alarmEvents: ssot.alarmEvents } : {}),
  };
}

function buildStationPassedImminentPayload(
  inputs: BuildStationPassedImminentPayloadInputs,
): Parameters<typeof sendSilentPush>[0]['payload'] {
  const { trip, waypoint, lock, pushId, now, origin, lockReleasedReason, ssot } = inputs;
  return {
    nextWaypoint: waypoint.stationName,
    // arvlCd∈{0,1}은 "지금 진입/도착" 신호 — eta는 사실상 0. vanish-fallback도 동일 의미.
    etaSeconds: 0,
    phase: 'imminent',
    kind: waypoint.kind,
    sentAt: now,
    pushId,
    // Epic #1204 그룹 2 D3 (#1273) — validateTrip stamp 결과를 forward.
    // 클라이언트 `silentPushLocationGate`가 D1 estimator currentHopIndex와 매칭 시
    // 거리 검증 우회/`gate-no-location` fallback에 사용. 구 trip(부재) → undefined.
    hopIndex: waypoint.hopIndex,
    // #1365 — server-authoritative occupiedLine. 환승역에서 디바이스가 같은 hop index에
    // 다른 line의 stop과 cross-validation 가능. waypoint.line을 그대로 forward.
    occupiedLine: waypoint.line,
    // #1307 — server-authoritative subsurface. 지하 trip의 intermediate push는
    // 디바이스 GPS 게이트(out-of-range 오거부)를 우회하도록 flag를 전달.
    subsurface: trip.subsurface === true,
    // #1322 — lock-path fire의 노선/열차를 self-describing으로 전달. 디바이스가 로컬 lock
    // 없이도(지하 auto-lock hydration window) line sanity-guard를 돌려 발사할 수 있게 한다.
    boardingLine: lock.line,
    trainCode: lock.trainCode,
    // #1399 — 좀비 알림 cleanup. push 발사 시점의 active trip token을 stamp해 device가
    // ACTIVE_TRIP_KEY와 비교해 만료 token push를 drop. trip-ended cleanup 후 늦게 도착한
    // stale silent push 차단(S8 14:19 좀비 회귀).
    tripToken: trip.token,
    // #1402 — 발사 경로 stamp. device alarmLog와 backend tail이 같은 값으로 1:1 매핑.
    origin,
    // #1438 (E5) — lock release sync. 정의된 경우에만 wire (apns.ts JSON serializer가 undefined 누락).
    lockReleasedReason,
    // #1539 (S6) — backend 누적 passedStations forward. 빈 배열/undefined는 apns.ts JSON
    // serializer가 자연 누락. device backfill diff(S5 후속 wiring PR)에서 사용.
    passedStations: trip.passedStations,
    // #1561 (T8, ADR-017 / S2 흡수) — TripPositionSSoT 권위 forward. null/undefined는 apns.ts JSON
    // serializer가 자연 누락 → device cascade picker는 기존 tier fallback. caller가 SSoT를 읽어
    // 명시 전달. payload size 폭주 차단 위해 passedStations는 최근 5개로 잘려 forward된다.
    ssot: toSilentPushSsot(ssot),
  };
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

/**
 * #1614 Phase C — stale SSoT lock false-fire 차단 임계.
 *
 * `transferDestinationGate.TRANSFER_DESTINATION_FRESH_WINDOW_MS` (60s) 는 transfer/destination
 * kind 만 보호. 본 임계는 intermediate 포함 모든 arvlCd fire 에 적용 — transfer 게이트보다 보수적
 * (3분) 으로 두어 정상 운영(역 간 hop 평균 1~2분 + cron jitter) 을 차단하지 않으면서, 멈춘 trip
 * 의 stale lock 에서 cron 누적 misfire(2026-06-19 evidence) 를 차단한다.
 *
 * `lastAdvanceAt===0` (lazy-seed 직후, 미advance) 은 본 가드 dormant — T4 motion 게이트의
 * 'unknown' 통과 정책과 동일 ([[transferDestinationGate.isSsotAdvanceRecent]] 와 같은 의미론).
 */
export const STALE_LOCK_FIRE_THRESHOLD_MS = 3 * 60 * 1000;

export async function fireArvlCdStationPush(
  inputs: FireArvlCdStationPushInputs,
): Promise<{ dirty: boolean }> {
  const { trip, waypoint, lock, arvlCd, env, deps, stats, now, log, generatePushId } = inputs;
  // #1614 Phase C — stale SSoT 가드. SSoT.lastAdvanceAt > 0 이고 3분 초과면 fire skip.
  // transferDestinationGate (60s) 보다 보수적이지만 intermediate 까지 보호. lazy-seed (==0) 통과.
  // SSoT 부재 trip (legacy) 도 통과 — 본 가드는 SSoT 활성화 후 stale 진단 만.
  const ssotForStale = await readSsot(env.TRIPS, trip.token, {
    cacheTtl: SSOT_CRON_READ_CACHE_TTL_SEC,
  });
  if (
    ssotForStale !== null &&
    ssotForStale.lastAdvanceAt > 0 &&
    now - ssotForStale.lastAdvanceAt > STALE_LOCK_FIRE_THRESHOLD_MS
  ) {
    stats.staleLockFireSkipped += 1;
    log('arvlcd-fire: stale SSoT skip', {
      token: trip.token.slice(0, 8),
      trainCode: lock.trainCode,
      station: waypoint.stationName,
      lastAdvanceAt: ssotForStale.lastAdvanceAt,
      staleMs: now - ssotForStale.lastAdvanceAt,
    });
    writeMetric(env, {
      eventType: 'suppress',
      tripToken: trip.token,
      stationId: waypoint.stationName,
      reason: 'stale-lock-fire',
      hopIndex: waypoint.hopIndex,
      staleMs: now - ssotForStale.lastAdvanceAt,
    });
    return { dirty: false };
  }
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
    // P0-1 (#1577) — Site 2 of 6: cross-category station dedup suppress.
    writeMetric(env, {
      eventType: 'suppress',
      tripToken: trip.token,
      stationId: waypoint.stationName,
      reason: 'arvlcd-dedup',
      hopIndex: waypoint.hopIndex,
    });
    return { dirty: false };
  }

  // #1367 — cross-station 동시 fire 차단. 같은 trip에서 이전 station-passed push로부터
  // SAME_PHASE_STATION_DEDUP_WINDOW_MS 이내에 *다른* station 발사는 보류 (client 채널 2 banner 회귀 차단).
  // 같은 station 재발사는 위 per-(token,trainCode,station,arvlCd) 게이트가 처리하므로 여기선 다른 station만 본다.
  const lastFired = trip.lastFiredStation;
  if (
    lastFired !== undefined &&
    lastFired.stationName !== waypoint.stationName &&
    now - lastFired.epochMs < SAME_PHASE_STATION_DEDUP_WINDOW_MS
  ) {
    stats.arvlCdFireDedup += 1;
    log('arvlcd-fire: cross-station dedup skip', {
      token: trip.token.slice(0, 8),
      trainCode: lock.trainCode,
      station: waypoint.stationName,
      previousStation: lastFired.stationName,
      sinceMs: now - lastFired.epochMs,
      arvlCd,
    });
    // P0-1 (#1577) — Site 2 of 6: cross-station dedup suppress.
    writeMetric(env, {
      eventType: 'suppress',
      tripToken: trip.token,
      stationId: waypoint.stationName,
      reason: 'cross-station-dedup',
      hopIndex: waypoint.hopIndex,
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
  // #1561 (T8, ADR-017 / S2 흡수) — fire 직전 SSoT 권위 스냅샷 forward.
  // #1614 Phase C — stale guard 단계에서 이미 read한 ssotForStale 재사용 (KV read 1회 절약).
  const heal = await sendWithEnvHeal(
    (host) =>
      sendSilentPush({
        deviceToken: trip.token,
        payload: buildStationPassedImminentPayload({
          trip,
          waypoint,
          lock,
          pushId,
          now,
          origin: 'arvlcd',
          ssot: ssotForStale,
        }),
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
    // #1633 — corrected env 즉시 KV persist. 후속 caller putTrip이 early-return / race /
    // exception으로 누락되거나 KV eventual consistency로 다음 cron이 stale read해도, 본
    // 즉시 write가 origin 갱신을 보장해 같은 trip의 후속 push가 mismatch retry로 1초 지연
    // → device gate-station-already-passed로 drop되는 회귀(2026-06-22 evidence)를 차단.
    // putTrip은 idempotent하며 caller의 후속 putTrip은 자연 dedup(같은 in-memory snapshot).
    await putTrip(env.TRIPS, trip);
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
  // #1402 — 30s alert fallback 안전망 등록. silent push가 30s 내 ACK되지 않으면
  // runFallbackPushes가 alert(소리) push를 발사. arvlCd 경로는 가장 흔한 발사 경로이므로
  // 여기서도 안전망을 가동해 "하차 침묵 0" acceptance를 보강한다.
  await putPending(env.PENDING_PUSHES, {
    pushId,
    token: trip.token,
    alarmKey: buildAlarmKey(waypoint.stationName, 'imminent'),
    sentAt: now,
    stationName: waypoint.stationName,
    kind: waypoint.kind,
    phase: 'imminent',
    etaSeconds: 0,
    apnsEnv: trip.apnsEnv ?? 'sandbox',
  });
  // dedup stamp — 같은 cycle에서 Seoul API 갱신 지연으로 같은 신호가 재노출돼도 차단.
  await env.TRIPS.put(key, '1', { expirationTtl: ARVLCD_FIRE_DEDUP_TTL_SEC });
  // #1367 — cross-station dedup용 마지막 fire 마커. 성공 시에만 stamp(실패는 다음 cycle 재시도 허용).
  trip.lastFiredStation = { stationName: waypoint.stationName, epochMs: now };
  dirty = true;
  // P0-1 (#1577) — Site 3 of 6: arvlcd fire 적재 (X3 stale fire 검증).
  writeMetric(env, {
    eventType: 'fire',
    tripToken: trip.token,
    stationId: waypoint.stationName,
    reason: `arvlcd:${waypoint.kind}`,
    hopIndex: waypoint.hopIndex,
    staleMs: ssotForStale?.lastAdvanceAt ? now - ssotForStale.lastAdvanceAt : undefined,
  });
  return { dirty };
}

/**
 * ADR-017 T4 (#1557) — `advanceTripPosition` SSoT 게이트를 통과한 경우에만 매역 arvlCd push를
 * 발사하는 thin wrapper.
 *
 * 호출 흐름:
 *   1. SSoT 부재 시 lazy-seed (currentStationId = waypoint.stationName). T1/T2 마이그레이션
 *      이전 trip 호환. seed 직후 candidate=current이지만 `appendUnique`가 noop 처리.
 *   2. `advanceTripPosition` 6단 게이트 호출.
 *   3. `blocked` → push 발사 X. `arvlCdFireBlocked` 카운트 + reason log. Trip mutation 없음.
 *   4. `advanced` → `arvlCdFireFired` 카운트 후 기존 `fireArvlCdStationPush` 위임 (cross-station
 *      dedup + APNs send + envHeal + pending fallback 안전망 등 기존 wiring 재사용).
 *
 * Trip mutation은 fire 성공 시 `fireArvlCdStationPush`의 dirty 결과를 그대로 forward — 호출자
 * (`handleBoardingLockTracking`)가 putTrip을 결정한다.
 *
 * @returns dirty=true는 trip 객체가 in-place mutate되어 caller가 putTrip 필요.
 */
async function tryAdvanceAndFireArvlcd(inputs: {
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
}): Promise<{ dirty: boolean }> {
  const { trip, waypoint, lock, arvlCd, env, deps, stats, now, log, generatePushId } = inputs;
  let ssot = await readSsot(env.TRIPS, trip.token, { cacheTtl: SSOT_CRON_READ_CACHE_TTL_SEC });
  if (ssot === null) {
    // Lazy-seed for legacy trips (T1 미마이그레이션). motionState='unknown'로 시작 — T3가
    // device upload로 motion 갱신을 시작하면 게이트 #2가 자동 활성화.
    ssot = await seedSsot(env.TRIPS, trip.token, waypoint.stationName, {
      expiresAt: trip.expiresAt,
    });
    log('arvlcd-fire: lazy-seed ssot', {
      token: trip.token.slice(0, 8),
      currentStationId: waypoint.stationName,
    });
  }
  // ADR-017 T7 (#1560) — transfer/destination kind 발사 직전 추가 SSoT 일관성 검증.
  // pre-advance SSoT 스냅샷으로 (1) currentStationId가 transfer/destination waypoint 또는
  // 직전 1 hop 인지 (2) 마지막 advance 가 60s 이내 신선한지 확인. intermediate kind는 본 게이트
  // 우회 — T4/T5 6단 게이트만으로 충분. 정지 trip "환승임박 건대입구" false fire(N9) 차단.
  if (isTransferOrDestination(waypoint)) {
    const transferGate = evaluateTransferDestinationGate(ssot, trip, waypoint, now);
    if (!transferGate.pass) {
      stats.arvlCdFireBlocked += 1;
      stats.transferDestinationGateBlocked += 1;
      log('arvlcd-fire: transfer/destination gate blocked', {
        token: trip.token.slice(0, 8),
        trainCode: lock.trainCode,
        station: waypoint.stationName,
        kind: waypoint.kind,
        reason: transferGate.blockReason satisfies TransferDestinationBlockReason | undefined,
        ssotCurrent: ssot.currentStationId,
        ssotLastAdvanceAt: ssot.lastAdvanceAt,
      });
      return { dirty: false };
    }
  }
  const outcome = await advanceTripPosition(
    env.TRIPS,
    trip.token,
    waypoint.stationName,
    {
      type: 'arvlcd-confirmed-train',
      stationId: waypoint.stationName,
      ts: now,
      environment: deriveEvidenceEnvironment(trip),
      arvlcdTrainCode: lock.trainCode,
      arvlCd,
    },
    {
      // lock 활성 = base 합의 surrogate. consensusGate가 surface는 base만으로, underground는
      // arrival + lockAttachable 2-of-2로, mixed/unknown은 base + arrival + lockAttachable 모두로
      // 검증. lock 활성 trip에서 lockAttachable 단일 trainCode 수렴은 lock 부착 자체가 증거.
      gatePassed: true,
      lockAttachable: true,
    },
  );
  if (outcome.result !== 'advanced') {
    stats.arvlCdFireBlocked += 1;
    log('arvlcd-fire: blocked', {
      token: trip.token.slice(0, 8),
      trainCode: lock.trainCode,
      station: waypoint.stationName,
      reason: outcome.blockReason satisfies AdvanceBlockReason | undefined,
    });
    // P0-1 (#1577) — Site 1 of 6: advance suppress 적재 (V/X X3/X8 검증).
    writeMetric(env, {
      eventType: 'suppress',
      tripToken: trip.token,
      stationId: waypoint.stationName,
      reason: outcome.blockReason ?? 'advance-blocked',
      environment: deriveEvidenceEnvironment(trip),
      hopIndex: waypoint.hopIndex,
    });
    return { dirty: false };
  }
  stats.arvlCdFireFired += 1;
  // P0-1 (#1577) — Site 1 of 6: advance 적재 (V8 적재 카운터).
  writeMetric(env, {
    eventType: 'advance',
    tripToken: trip.token,
    stationId: waypoint.stationName,
    reason: 'arvlcd-confirmed-train',
    environment: deriveEvidenceEnvironment(trip),
    hopIndex: waypoint.hopIndex,
  });
  return fireArvlCdStationPush({
    trip,
    waypoint,
    lock,
    arvlCd,
    env,
    deps,
    stats,
    now,
    log,
    generatePushId,
  });
}

/**
 * Trip.subsurface → EvidenceEnvironment 매핑. `consensusGate.StationEnvironment` 어휘로 변환은
 * `mapEvidenceEnvironment`가 담당하므로 본 함수는 device upload 어휘만 산출한다.
 */
function deriveEvidenceEnvironment(trip: Trip): EvidenceEnvironment {
  if (trip.subsurface === true) return 'underground';
  if (trip.subsurface === false) return 'surface';
  return 'unknown';
}

/**
 * #1536 (S3) — Trip.subsurface → consensusGate.StationEnvironment 매핑.
 *
 * `deriveEvidenceEnvironment` (EvidenceEnvironment 어휘) 결과를 `mapEvidenceEnvironment`
 * 로 한 단계 변환해 single source 유지 (S4144 회피). trip 데이터 자체가 device 어휘인
 * `subsurface` boolean 만 갖고 'mixed' 표현이 없으므로 mapping 결과는 underground / surface
 * / unknown 셋 중 하나(추후 trip.environment 필드 도입 시 'mixed' 분기 자연 확장).
 */
function deriveTripEnvironment(trip: Trip): StationEnvironment {
  return mapEvidenceEnvironment(deriveEvidenceEnvironment(trip));
}

/**
 * #1370 L2 — trainCode vanish 후 시간 기반 fallback advance 직전에 발사하는 station-passed silent push.
 *
 * arvlCd fire 경로와 모양은 같지만 SSOT가 다르다 — arvlCd∈{0,1}이 아니라 "trainCode 사라짐 + hop 시간
 * 경과 = optimistic 통과"를 신호로 채택. 디바이스 payload는 `arvlCd=null` (vanish-fallback 표식)으로
 * 보내되 phase/kind는 imminent + 원본 waypoint.kind. dedup key는 arvlCd path와 분리 namespace
 * (`vanish:`)을 사용해 cross-pollute 차단.
 *
 * 실패 분기 정책: arvlCd path와 동일 — push 실패는 stats.errors++만 누적, trip 자체는 호출자
 * (`advanceBoardingLockWaypoint`)가 계속 진행한다. 추가 cleanup 분기 없음.
 */
interface FireVanishFallbackStationPushInputs {
  trip: Trip;
  waypoint: Waypoint;
  lock: BoardingLockMeta;
  env: Env;
  deps: ScheduledDeps;
  stats: ScheduledStats;
  now: number;
  log: Logger;
  generatePushId: () => string;
  /**
   * #1402 — 발사 경로 식별자. 기존 hop-elapsed advance 직전 fire는 `'vanish-fallback'`,
   * 신규 hop-not-elapsed lock release 직전 floor fire는 `'vanish-release'`. dedup key는
   * origin별로 격리해 두 경로가 같은 station에서 둘 다 한 번씩 발사될 수 있게 한다 — release
   * 후 lock 재부착(swap 성공)으로 같은 station에서 advance 경로가 추가 발사되는 시나리오를
   * 차단하지 않기 위함.
   */
  origin: 'vanish-fallback' | 'vanish-release';
}

export const VANISH_FALLBACK_FIRE_KEY_PREFIX = 'vanish-fallback-fire:';
export const VANISH_RELEASE_FIRE_KEY_PREFIX = 'vanish-release-fire:';

export function vanishFallbackFireKey(
  token: string,
  trainCode: string,
  stationName: string,
): string {
  return `${VANISH_FALLBACK_FIRE_KEY_PREFIX}${token}|${trainCode}|${stationName}`;
}

export function vanishReleaseFireKey(
  token: string,
  trainCode: string,
  stationName: string,
): string {
  return `${VANISH_RELEASE_FIRE_KEY_PREFIX}${token}|${trainCode}|${stationName}`;
}

export async function fireVanishFallbackStationPush(
  inputs: FireVanishFallbackStationPushInputs,
): Promise<void> {
  const { trip, waypoint, lock, env, deps, stats, now, log, generatePushId, origin } = inputs;
  const key =
    origin === 'vanish-release'
      ? vanishReleaseFireKey(trip.token, lock.trainCode, waypoint.stationName)
      : vanishFallbackFireKey(trip.token, lock.trainCode, waypoint.stationName);
  const logPrefix = origin === 'vanish-release' ? 'vanish-release-fire' : 'vanish-fallback-fire';
  const existing = await env.TRIPS.get(key);
  if (existing !== null) {
    log(`${logPrefix}: dedup skip`, {
      token: trip.token.slice(0, 8),
      trainCode: lock.trainCode,
      station: waypoint.stationName,
    });
    // P0-1 (#1577) — Site 4 of 6: vanish-fallback dedup suppress.
    writeMetric(env, {
      eventType: 'suppress',
      tripToken: trip.token,
      stationId: waypoint.stationName,
      reason: `${origin}-dedup`,
      hopIndex: waypoint.hopIndex,
    });
    return;
  }
  // #1561 (T8, ADR-017 / S2 흡수) — fire 직전 SSoT 권위 스냅샷 forward (arvlcd-fire와 동일 패턴).
  const ssot = await readSsot(env.TRIPS, trip.token, {
    cacheTtl: SSOT_CRON_READ_CACHE_TTL_SEC,
  });
  // ADR-017 T7 (#1560) — transfer/destination kind 발사 직전 SSoT 위치 + 신선도 일관성 검증.
  // SSoT 부재 trip(legacy)은 본 게이트 통과시켜 기존 vanish-fallback 흐름 유지 — graceful.
  if (ssot !== null && isTransferOrDestination(waypoint)) {
    const transferGate = evaluateTransferDestinationGate(ssot, trip, waypoint, now);
    if (!transferGate.pass) {
      stats.transferDestinationGateBlocked += 1;
      log(`${logPrefix}: transfer/destination gate blocked`, {
        token: trip.token.slice(0, 8),
        trainCode: lock.trainCode,
        station: waypoint.stationName,
        kind: waypoint.kind,
        origin,
        reason: transferGate.blockReason satisfies TransferDestinationBlockReason | undefined,
        ssotCurrent: ssot.currentStationId,
        ssotLastAdvanceAt: ssot.lastAdvanceAt,
      });
      return;
    }
  }
  const pushId = generatePushId();
  log(`${logPrefix}: station-passed push`, {
    token: trip.token.slice(0, 8),
    trainCode: lock.trainCode,
    station: waypoint.stationName,
    kind: waypoint.kind,
    origin,
  });
  // #1438 (E5) — vanish-release origin은 직후 caller가 `trip.boardingLock = undefined`로 lock을
  // release하므로 device에 `lockReleasedReason='vanish'`를 forward해 store sync. vanish-fallback은
  // 직후 `advanceBoardingLockWaypoint`로 흘러가 그 함수가 transfer 시 별도로 release를 통지한다.
  const lockReleasedReason: 'vanish' | undefined = origin === 'vanish-release' ? 'vanish' : undefined;
  const heal = await sendWithEnvHeal(
    (host) =>
      sendSilentPush({
        deviceToken: trip.token,
        payload: buildStationPassedImminentPayload({
          trip,
          waypoint,
          lock,
          pushId,
          now,
          origin,
          lockReleasedReason,
          ssot,
        }),
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
    stats.envCorrected += 1;
    // #1633 — corrected env 즉시 KV persist. vanish-fallback / vanish-release 경로는 본 함수가
    // void 반환이라 호출자가 dirty 신호 없이 putTrip 결정. 후속 putTrip은 advanceBoardingLockWaypoint
    // 또는 명시 putTrip이 있지만 race/early-return 시 누락 가능 — 본 즉시 write로 영구 보존.
    await putTrip(env.TRIPS, trip);
  }
  if (!heal.result.ok) {
    stats.errors += 1;
    log(`${logPrefix}: push failed`, {
      status: heal.result.status,
      reason: heal.result.reason,
      token: trip.token.slice(0, 8),
    });
    // dedup KV는 성공 시에만 stamp — 실패 push는 다음 cycle 재시도 허용.
    return;
  }
  stats.pushed += 1;
  if (origin === 'vanish-release') {
    stats.vanishReleaseFired += 1;
  } else {
    stats.vanishFallbackFired += 1;
  }
  // P0-1 (#1577) — Site 4 of 6: vanish fire 적재 (transfer/destination imminent 포함).
  writeMetric(env, {
    eventType: 'fire',
    tripToken: trip.token,
    stationId: waypoint.stationName,
    reason: `${origin}:${waypoint.kind}`,
    hopIndex: waypoint.hopIndex,
    staleMs: ssot?.lastAdvanceAt ? now - ssot.lastAdvanceAt : undefined,
  });
  // #1402 — 30s alert fallback 안전망 등록. listPending → runFallbackPushes가 30s 내 ACK
  // 없으면 alert(소리) fallback 발사. vanish 경로는 silent push가 가장 잘 누락되는 경로라
  // 안전망 가동이 acceptance("하차 침묵 0")의 핵심. PENDING_PUSHES 미바인딩(dev/test 호환)
  // 시 putPending은 graceful no-op.
  await putPending(env.PENDING_PUSHES, {
    pushId,
    token: trip.token,
    alarmKey: buildAlarmKey(waypoint.stationName, 'imminent'),
    sentAt: now,
    stationName: waypoint.stationName,
    kind: waypoint.kind,
    phase: 'imminent',
    etaSeconds: 0,
    apnsEnv: trip.apnsEnv ?? 'sandbox',
  });
  await env.TRIPS.put(key, '1', { expirationTtl: ARVLCD_FIRE_DEDUP_TTL_SEC });
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
    // #1439 (E6, ADR-015 §9) — vanish-swap이 trip route 외 line으로 잘못 매핑되지 않도록.
    allowedLines: computeAllowedLines(trip.route, trip.waypoints),
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
  generatePushId: () => string;
}
async function handleEtaMissing(inputs: HandleEtaMissingInputs): Promise<void> {
  const { trip, waypoint, activeLock, env, deps, stats, now, log, generatePushId } = inputs;
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
      // #1386 — hop 시간이 경과했더라도 device motion이 명확히 stationary면 advance 보류.
      // 2026-06-16 용마산 정지 trip 회귀: 사용자가 정지 중인데 backend가 hop 시간만 보고 false
      // station-passed를 발사. lockless 경로(#1315)는 stationary/unknown 모두 보류로 더 엄격이지만,
      // lock-active fallback은 한 번이라도 정상 추적된 trip이라 unknown(센서 미지원/권한 거절)을
      // 보류하면 다수 사용자가 freeze. `stationary` 신호가 있을 때만 게이트 진입(이슈 #1386).
      // 카운터(consecutiveEtaMissing)는 누적 유지 — motion이 회복되면 다음 cycle에서 정상 advance,
      // 회복 안 되면 기존 auto-end 임계(`resolveEtaMissingThreshold`) 경로가 종료를 보장한다.
      const positionSeries = await readSeries(env.TRIPS, trip.token);
      const fallbackMotion = evaluateWindow(positionSeries, now).motion;
      if (isFallbackAdvanceBlockedByMotion(fallbackMotion)) {
        stats.vanishFallbackMotionGateBlocked += 1;
        log('boarding-lock: vanish fallback motion gate blocked (not moving)', {
          token: trip.token.slice(0, 8),
          trainCode: activeLock.trainCode,
          station: waypoint.stationName,
          consecutiveEtaMissing: nextMissCount,
          lastTrackedArrivalEpoch: lastEpoch,
          motion: fallbackMotion,
        });
        trip.consecutiveEtaMissing = nextMissCount;
        await putTrip(env.TRIPS, trip);
        return;
      }
      // hop 시간 경과 → optimistic waypoint advance.
      // advance 내부에서 destination 도착이면 cleanupTripWithLa, 그 외엔 waypoints.shift().
      log('boarding-lock: trainCode vanished — time-based waypoint advance fallback', {
        token: trip.token.slice(0, 8),
        trainCode: activeLock.trainCode,
        station: waypoint.stationName,
        consecutiveEtaMissing: nextMissCount,
        lastTrackedArrivalEpoch: lastEpoch,
        motion: fallbackMotion,
      });
      trip.consecutiveEtaMissing = 0;
      // #1370 L2 — fallback advance 전에 station-passed silent push를 발사한다.
      // advanceBoardingLockWaypoint는 LA update + (destination 시) trip-ended push만 발사하므로
      // intermediate/transfer waypoint를 "지났다"는 신호가 사용자에게 도달하지 않는 회귀가 있었다
      // (어린이대공원/군자/중곡 silent push 0건). vanish fallback도 ground truth 신호로 취급해
      // arvlCd∈{0,1}과 동등하게 station-passed push를 발사한다.
      //
      // #1399 — destination/transfer 포함 모든 kind에 대해 발사. 기존엔 destination을 skip해
      // advanceBoardingLockWaypoint의 trip-ended push만 사용자에게 도달했으나, 그 경로는
      // alert payload(`aps.alert`)로 system banner를 띄우는 데에 의존한다. vanish 상황(지하 +
      // backend trainCode 누락)에서 trip-ended가 trip token 검증/cleanup race로 지연/소실되면
      // 사용자는 종착역 하차 알림을 받지 못한다. station-passed imminent push를 destination에도
      // 발사해 device 측 banner 발사 경로(채널 2)도 확보한다. surface 중복은 device 측
      // pushId/firedPushIds dedup으로 흡수.
      await fireVanishFallbackStationPush({
        trip,
        waypoint,
        lock: activeLock,
        env,
        deps,
        stats,
        now,
        log,
        generatePushId,
        origin: 'vanish-fallback',
      });
      // ADR-017 T5 (#1558) — vanish-fallback path 도 SSoT 단일 진입점을 통과해야 trip.waypoints
      // 가 advance 한다. evidence type 은 `arvlcd-confirmed-train` — lock 활성 시점에서 vanish 직전
      // 마지막으로 확정된 trainCode 가 ground truth 이고, 본 fallback 은 hop 시간 + 직전 lock 으로
      // optimistic advance 를 취급하기 때문. SSoT motionState='stationary' 이면 #2 게이트가 차단해
      // 기존 `isFallbackAdvanceBlockedByMotion` 보다 광범위(정지 trip 어떤 경로도)로 보호한다.
      await advanceBoardingLockWaypoint(trip, waypoint, env, deps, stats, now, log, {
        type: 'arvlcd-confirmed-train',
        stationId: waypoint.stationName,
        ts: now,
        environment: deriveEvidenceEnvironment(trip),
        arvlcdTrainCode: activeLock.trainCode,
      });
      return;
    }
    // hop 시간 미경과 → lock release해 lockless/boardingPrompt가 인계받도록.
    // isBoardingLockActive=false가 되는 즉시 다음 cycle의 evaluateAndMaybeFireBoardingPrompt 경로 복구.
    // #1370 L3 — lock release 후 lockless 인계가 실제로 작동하려면 trip.infoModeEnabled가
    // true여야 한다(`if (!isBoardingLockActive) → if (trip.infoModeEnabled && intermediate)`).
    // OFF인 trip은 다음 cycle에서 lockMissing으로 spin하며 군자/중곡까지 push 0건. vanish fallback은
    // 시스템이 trainCode를 잃은 상황이므로 lockless 인계를 강제 enable해 매역 push 경로를 복구한다.
    //
    // #1402 — lock release 전 floor station-passed push를 보장 발사한다. 종전 release 경로는
    // push 0건으로 device가 stale 채로 lockless 인계만 받았고, lockless 인계 직후 GPS가 잠시라도
    // 추가 누락되면 다음 station push까지 침묵 ≥ 1 cycle. release 직전 floor push 1건이
    // PENDING_PUSHES에 등록되면 30s 내 ACK 없을 때 alert fallback이 자동 발사돼 "하차 침묵 0"
    // acceptance를 충족(2026-06-17 군자/용마산 회귀). 발사 자체가 false positive를 만들 수
    // 있어 ADR-010 "false positive / miss 동급" 원칙에 따라 lock-active fallback과 같은
    // motion gate(`isFallbackAdvanceBlockedByMotion`)를 통과한 경우에만 fire.
    const releaseMotionSeries = await readSeries(env.TRIPS, trip.token);
    const releaseMotion = evaluateWindow(releaseMotionSeries, now).motion;
    if (!isFallbackAdvanceBlockedByMotion(releaseMotion)) {
      await fireVanishFallbackStationPush({
        trip,
        waypoint,
        lock: activeLock,
        env,
        deps,
        stats,
        now,
        log,
        generatePushId,
        origin: 'vanish-release',
      });
    } else {
      stats.vanishFallbackMotionGateBlocked += 1;
      log('vanish-release-fire: motion gate blocked (not moving)', {
        token: trip.token.slice(0, 8),
        trainCode: activeLock.trainCode,
        station: waypoint.stationName,
        motion: releaseMotion,
      });
    }
    log('boarding-lock: trainCode vanished — releasing lock (hop time not yet elapsed)', {
      token: trip.token.slice(0, 8),
      trainCode: activeLock.trainCode,
      station: waypoint.stationName,
      consecutiveEtaMissing: nextMissCount,
      lastTrackedArrivalEpoch: lastEpoch,
      locklessTakeoverEnabled: trip.infoModeEnabled !== true,
    });
    trip.boardingLock = undefined;
    trip.consecutiveEtaMissing = 0;
    trip.infoModeEnabled = true;
    stats.vanishLocklessTakeover += 1;
    await deleteProgress(env.TRIPS, trip.token);
    await putTrip(env.TRIPS, trip);
    return;
  }

  // #903 (Seam G) — subsurface=true trip은 인내 임계(10)로 분기. 지하 dead zone GPS/trainCode 일시 누락 인내.
  const threshold = resolveEtaMissingThreshold(trip);
  if (nextMissCount >= threshold) {
    // #1663 — Seoul API HTTP error가 이 cron 사이클에 1건이라도 관측됐으면 'seoul-outage'로 구분.
    // trip auto-end 원인이 Seoul API 장애(일시 HTTP error)였다고 판별해 #1425 cooldown을 면제한다.
    // httpErrorCount는 SeoulArrivalClient 인스턴스 수명(= cron 1 cycle) 범위라 cron scope 내에서만 유효.
    const endReason: import('./types').TripEndedReason =
      deps.seoul.stats.httpErrorCount > 0 ? 'seoul-outage' : 'eta-missing';
    // #706 — 운행 시간대 외 무한 폴링 차단. cleanupTripWithLa가 LA dismissal + deleteTrip을 묶어 정리.
    // #868 — 클라 state sync용 trip-ended silent push 발사.
    log('boarding-lock: trip auto-ended (consecutiveEtaMissing exceeded)', {
      token: trip.token.slice(0, 8),
      trainCode: activeLock.trainCode,
      station: waypoint.stationName,
      threshold,
      subsurface: trip.subsurface === true,
      endReason,
      seoulHttpErrors: deps.seoul.stats.httpErrorCount,
    });
    await cleanupTripWithLa(trip, env, deps, stats, now, log, endReason);
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
    await handleEtaMissing({
      trip,
      waypoint,
      activeLock,
      env,
      deps,
      stats,
      now,
      log,
      generatePushId,
    });
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
    // prereq 게이트(레거시): lock 활성 + arvlCd∈{0,1}. #640 회귀(lock 없는 trip 발사) defensive recheck.
    const legacyGate = evaluateArvlCdFireGate(activeLock, estimate.arvlCd, now);
    if (legacyGate === 'fire' && estimate.arvlCd !== null) {
      // ADR-017 T4 (#1557) — 분산된 fire 게이트를 `advanceTripPosition` 단일 진입점으로 통합.
      // 6단 게이트(seed/motion/env/type/train identity/lockless arvlcd 단독)를 통과한 advance
      // 결과만 push 발사로 이어진다. 2026-06-19 정지 trip false 발사 회귀(N1)를 직접 차단.
      //
      // SSoT 부재 (legacy trip / 마이그레이션 전) → lazy-seed로 currentStationId=waypoint.stationName
      // 정착. T3 motion state machine wire 전이므로 motionState='unknown' — 정지 게이트는 dormant
      // 상태이지만, T3가 device upload로 motionState='stationary'를 stamp하기 시작하면 자동 활성화.
      const fireOutcome = await tryAdvanceAndFireArvlcd({
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
      if (fireOutcome.dirty) await putTrip(env.TRIPS, trip);
    } else {
      stats.arvlCdFireMismatch += 1;
      log('arvlcd-fire: mismatch (prereq failed)', {
        token: trip.token.slice(0, 8),
        trainCode: activeLock.trainCode,
        station: waypoint.stationName,
        arvlCd: estimate.arvlCd,
      });
    }
    // ADR-017 T5 (#1558) — arvlcd-arrived path 도 SSoT 단일 진입점을 통과해야 trip.waypoints
    // 가 advance 한다. T4 가 fire 를 게이트했더라도 본 진행분(waypoints shift / passedStations
    // stamp / progress 누적) 자체는 SSoT 동의 후만 적용. arvlCd=null (positions-fallback arrived)
    // 경로는 evidence 가 없으므로 legacy 호출(evidence X)로 backward-compat 진행 — 정지 trip 보호는
    // T6/T7 의 lockless / positions reader migration 에서 같은 패턴으로 닫는다.
    const arvlCdEvidence = estimate.arvlCd !== null
      ? ({
          type: 'arvlcd-confirmed-train',
          stationId: waypoint.stationName,
          ts: now,
          environment: deriveEvidenceEnvironment(trip),
          arvlcdTrainCode: activeLock.trainCode,
          arvlCd: estimate.arvlCd,
        } satisfies AdvanceEvidence)
      : undefined;
    await advanceBoardingLockWaypoint(
      trip,
      waypoint,
      env,
      deps,
      stats,
      now,
      log,
      arvlCdEvidence,
    );
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
  // ADR-017 T5 (#1558) — SSoT advance evidence. 호출자가 stamp 한 evidence로
  // `advanceTripPosition` 6단 게이트 통과 시에만 trip.waypoints 를 advance 한다.
  // optional 인 이유: legacy 호출자(테스트 fixture, T6 reader migration 미적용 path)는
  // evidence 없이 호출 가능 — 그 경우 SSoT 게이트를 skip 하고 기존 동작 그대로 진행한다.
  // 새 호출자는 반드시 evidence 를 전달해야 한다.
  evidence?: AdvanceEvidence,
): Promise<void> {
  // ADR-017 T5 (#1558) — SSoT 통합 게이트.
  // evidence 가 제공되면 `advanceTripPosition`이 동의해야만 trip.waypoints / cleanup 이 진행된다.
  // 정지 trip + arvlcd ARRIVED → SSoT motion 게이트(#2)가 blocked('motion-stationary') 반환 →
  // trip mutation X (2026-06-19 정지 trip 8회 waypoint advance 회귀 직접 차단).
  if (evidence !== undefined) {
    // T4 `tryAdvanceAndFireArvlcd` 와 같은 lazy-seed 정책 — legacy trip (SSoT 미정착) 은
    // currentStationId=waypoint.stationName 로 seed 후 정상 advance. motionState='unknown' 으로
    // 시작하므로 정지 게이트는 dormant 이지만 T3 motion state machine 갱신 후 자동 활성화.
    // seed 없이 바로 advanceTripPosition 을 호출하면 #1 Seed 게이트가 blocked('no-seed') 반환 →
    // legacy 호출자가 모두 frozen 되는 회귀 발생.
    const existingSsot = await readSsot(env.TRIPS, trip.token, {
      cacheTtl: SSOT_CRON_READ_CACHE_TTL_SEC,
    });
    if (existingSsot === null) {
      await seedSsot(env.TRIPS, trip.token, waypoint.stationName, {
        expiresAt: trip.expiresAt,
      });
      log('boarding-lock: lazy-seed ssot for waypoint advance', {
        token: trip.token.slice(0, 8),
        currentStationId: waypoint.stationName,
      });
    }
    const outcome = await advanceTripPosition(
      env.TRIPS,
      trip.token,
      waypoint.stationName,
      evidence,
      {
        // lock 활성 = base 합의 surrogate (T4 `tryAdvanceAndFireArvlcd` 와 같은 정책).
        gatePassed: true,
        lockAttachable: trip.boardingLock !== undefined,
      },
    );
    if (outcome.result !== 'advanced') {
      stats.boardingLockWaypointAdvanceBlocked += 1;
      log('boarding-lock: waypoint advance blocked by ssot gate', {
        token: trip.token.slice(0, 8),
        station: waypoint.stationName,
        kind: waypoint.kind,
        reason: outcome.blockReason satisfies AdvanceBlockReason | undefined,
        evidenceType: evidence.type,
      });
      // P0-1 (#1577) — Site 1 of 6: boarding-lock waypoint advance suppress.
      writeMetric(env, {
        eventType: 'suppress',
        tripToken: trip.token,
        stationId: waypoint.stationName,
        reason: outcome.blockReason ?? 'lock-advance-blocked',
        hopIndex: waypoint.hopIndex,
      });
      return;
    }
    // P0-1 (#1577) — Site 1 of 6: boarding-lock waypoint advance.
    writeMetric(env, {
      eventType: 'advance',
      tripToken: trip.token,
      stationId: waypoint.stationName,
      reason: evidence.type,
      hopIndex: waypoint.hopIndex,
    });
  }

  if (waypoint.kind === 'destination') {
    // #868 — destination 도착으로 trip 종료. 클라 state sync용 trip-ended silent push 발사.
    await cleanupTripWithLa(trip, env, deps, stats, now, log, 'destination-arrived');
    // ADR-017 T5 (#1558) — trip 종료 시 SSoT 도 cleanup. cleanupTripWithLa 가 throw 하면
    // SSoT 가 남아있을 수 있으나 본 PR 스코프 외 (다음 cron 의 stale 정리 path 는 후속 PR).
    await deleteSsot(env.TRIPS, trip.token);
    log('boarding-lock: destination arrived, trip cleared', {
      token: trip.token.slice(0, 8),
      station: waypoint.stationName,
    });
    return;
  }
  // #1539 (S6) — waypoint advance 시점 직전 station 누적. silent push payload로 forward되어
  // device가 사전 예약 큐와 diff하여 cron 1분 race로 누락된 station-passed를 backfill 발사한다
  // (S5 머지 후 후속 wiring PR). 본 PR은 backend → device 데이터 plumbing만.
  appendPassedStation(trip, waypoint.stationName);
  // ADR-017 T5 (#1558) — immutable slice 로 mutation race 방지 (.shift 는 in-place).
  trip.waypoints = trip.waypoints.slice(1);
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
  // #1438 (E5) — release 직전 lock 스냅샷. 직후 fire에서 buildStationPassedImminentPayload가
  // line/trainCode self-describing 필드(boardingLine/trainCode)를 채우는 데 사용한다.
  const releasedLockSnapshot = lockReleasedOnTransfer ? trip.boardingLock : undefined;
  if (lockReleasedOnTransfer) {
    trip.boardingLock = undefined;
    trip.consecutiveEtaMissing = 0;
    await deleteProgress(env.TRIPS, trip.token);
  }
  // #1438 (E5) — backend → device lock release sync. 환승 waypoint 통과로 backend가 lock을
  // release한 즉시 device에 silent push로 통보해 로컬 useBoardingLockStore와 sync한다. 종전에는
  // device가 backend release를 인지하지 못해 leg 1 lock이 21분간 잔존하다 자연 만료에 의존했고,
  // 그 시간 동안 leg 2 boardingPrompt 발사가 차단됐다 (2026-06-18 evidence). 본 push는 station-passed
  // 알림 본문(arvlCd/vanish path와 같은 payload 모양)이 아니라 lock-only sync 신호 — etaSeconds=0,
  // phase='imminent', kind=waypoint.kind. device의 fireWithGate는 station-passed 동등 처리를 하지만,
  // payload.lockReleasedReason='transfer'가 우선 처리돼 store sync 후 본 처리 흐름을 그대로 진행한다.
  if (lockReleasedOnTransfer && releasedLockSnapshot !== undefined) {
    const pushId = crypto.randomUUID();
    // #1561 (T8, ADR-017 / S2 흡수) — transfer-release fire 직전 SSoT 권위 스냅샷 forward.
    const ssotForTransfer = await readSsot(env.TRIPS, trip.token, {
      cacheTtl: SSOT_CRON_READ_CACHE_TTL_SEC,
    });
    const transferHeal = await sendWithEnvHeal(
      (host) =>
        sendSilentPush({
          deviceToken: trip.token,
          payload: buildStationPassedImminentPayload({
            trip,
            waypoint,
            lock: releasedLockSnapshot,
            pushId,
            now,
            origin: 'transfer-release',
            lockReleasedReason: 'transfer',
            ssot: ssotForTransfer,
          }),
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
    // #1633 — transfer-release fire의 corrected env capture. 종전엔 결과 discard로
    // trip.apnsEnv 가 in-memory mutate 되지 않아 line 2217 putTrip 이 OLD value 를 쓰고,
    // 환승 후 leg 2 의 후속 push 들이 매번 mismatch retry 로 1초 지연된다. 즉시 write 로
    // corrected env 영구 보존.
    if (transferHeal.correctedEnv) {
      trip.apnsEnv = transferHeal.correctedEnv;
      stats.envCorrected += 1;
      await putTrip(env.TRIPS, trip);
    }
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
      // #1439 (E6, ADR-015 §9) — transfer-swap이 trip route 외 line으로 잘못 매핑되지 않도록.
      allowedLines: computeAllowedLines(trip.route, trip.waypoints),
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
    // ADR-017 T5 (#1558) — trip 종료 시 SSoT cleanup.
    await deleteSsot(env.TRIPS, trip.token);
    return;
  }
  // stopsRemaining 변동 즉시 LA 발사 — 사용자에게 새 hop 정보를 즉시 노출.
  const nextWaypoint = trip.waypoints[0];
  if (trip.activityPushToken && trip.activityState === 'live') {
    const contentState = buildLiveActivityContentState(
      nextWaypoint,
      0,
      trip.waypoints.length,
      trip,
    );
    await fireLiveActivityUpdate(trip, contentState, deps, stats, now, log, nextWaypoint.kind);
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
    trip,
  );
  const result = await fireLiveActivityUpdate(trip, contentState, deps, stats, now, log, waypoint.kind);
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
  // #1559 (T6, Epic #1553 / ADR-017) — SSoT.motionState 게이트.
  // 정지 trip에서도 ETA 임계치 변동만으로 reschedule silent push가 발사되던 회귀
  // (2026-06-19 15:53/15:56 evidence) 차단. SSoT 부재 시(legacy trip — T1 seeding 이전 또는
  // KV TTL 만료)는 backward compat을 위해 fallback. cron read는 SSOT_CRON_READ_CACHE_TTL_SEC
  // (30s)로 같은 사이클 내 stale read 방지.
  const ssot = await readSsot(env.TRIPS, trip.token, {
    cacheTtl: SSOT_CRON_READ_CACHE_TTL_SEC,
  });
  if (ssot === null) {
    log('reschedule push: no-ssot fallback', { token: trip.token.slice(0, 8) });
    stats.rescheduleFallbackNoSsot += 1;
  } else if (ssot.motionState === 'stationary') {
    log('reschedule push: blocked (motion-stationary)', {
      token: trip.token.slice(0, 8),
    });
    stats.rescheduleBlockedMotion += 1;
    return { cleanedUp: false };
  }

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
    // #1633 — reschedule push corrected env 즉시 KV persist. 후속 maybeReschedulePush 호출이
    // 다음 cron까지 1분 간격이라 그 사이 device re-POST나 cron stale read로 mismatch가 반복될
    // 수 있다. 즉시 write로 race window 차단.
    await putTrip(env.TRIPS, trip);
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
 * #1315 — lockless trip에서 탑승 열차의 trainCode를 확보해 `trip.boardingLock`을 부착 시도한다.
 *
 * `evaluateAndMaybeFireBoardingPrompt`의 auto-lock 경로(#916 A1)와 동일한 9단 게이트
 * (`evaluateBoardingPromptGates`) + `attemptAutoLock`을 재사용한다 — 게이트가 통과하는 시점
 * (사용자가 실제 이동 중 + 단일 후보 trainCode)에만 lock을 합성한다. 부착 성공 시 다음 cron
 * 사이클의 `isBoardingLockActive` 게이트가 trip을 `runTrainCodeTracking`으로 라우팅 →
 * lock 경로와 동일하게 `arrivals.find(a => a.trainCode === lock.trainCode)`로 *그 열차*만 추적한다.
 *
 * 좌표 컨텍스트(`promptGeoContext`/`promptDisplay`) 부재 시 바인딩 자체가 불가하므로 false 반환
 * (backend는 stations 좌표를 갖지 않아 게이트 평가 불가 — 기존 boarding-prompt 정책과 동일).
 *
 * 반환: lock을 부착하고 putTrip까지 완료했으면 true (호출자는 즉시 return — 이번 cycle은 발사 안 함).
 * 부착 못 했으면 false (호출자는 기존 bare-arvlCd 경로로 진행하되 motion 게이트로 보수 차단).
 *
 * 본 함수는 `fusion`을 재사용해 중복 KV read를 피한다(arrivals fetch는 attemptAutoLock 내부 1회).
 */
async function maybeBindLocklessTrainCode(
  trip: Trip,
  waypoint: Waypoint,
  fusion: FusionStepResult,
  env: Env,
  deps: ScheduledDeps,
  stats: ScheduledStats,
  now: number,
  log: Logger,
): Promise<boolean> {
  const geo = trip.promptGeoContext;
  const display = trip.promptDisplay;
  if (!geo || !display) return false;

  // 9단 AND 게이트 — 사용자가 실제 이동 중일 때만 통과 (정적/저신뢰는 false positive 차단).
  // boarding-prompt 경로와 동일하게 fusion 결과(series/kalman/metrics)를 그대로 입력으로 전달.
  // #1536 (S3) — 환경 분기. underground/unknown 은 GPS 의존 게이트(#3~#7) 를 byPass.
  const environment = deriveTripEnvironment(trip);
  const outcome = evaluateBoardingPromptGates({
    series: fusion.series,
    origin: geo.origin,
    nextStation: geo.nextStation,
    now,
    promptState: trip.boardingPromptState,
    kalmanKmh: fusion.kalmanKmh,
    metrics: fusion.posMetrics,
    environment,
  });
  if (!outcome.pass) return false;
  // #1536 (S3) — environment-aware consensusGate. underground 분기는 arrival +
  // lockAttachable 2-of-2 합의로 false positive 차단. arrivals 는 attemptAutoLock 이
  // fetch 하므로 본 함수에서는 lockAttachable 신호만 forward 하고 consensusGate 의 분기
  // 자체는 attemptAutoLock 내부에서 평가한다. caller 는 outcome.pass(motion+silence) 만
  // 사용해 auto-lock 시도 진입을 허용.
  // #1614 Phase B (S4 #1537) — backend self-poll positionTrainAgreement forward. cron 진입부에서
  // stamp된 `realtime-position:<line>` KV를 read해, pickAutoTrainCode 가 선택할 candidate
  // trainCode가 line에서 실제 운행 중인지 검사. caller 시점에는 trainCode 가 아직 결정 안 됐으므로
  // line의 positions list 자체를 forward — attemptAutoLock 가 pickAutoTrainCode 결과를 그 list 와
  // cross-match (Phase B-2 함수에서 처리). 본 caller 는 raw list 전달만 담당.
  const selfPollPositions = await readSelfPollPosition(env.TRIPS, waypoint.line);
  const autoLockResult = await attemptAutoLock({
    trip,
    targetWaypoint: waypoint,
    originStation: display.originStation,
    direction: geo.direction,
    seoul: deps.seoul,
    now,
    boardingPromptState: trip.boardingPromptState,
    lastMotionAt: fusion.series[fusion.series.length - 1]?.ts,
    // #1439 (E6, ADR-015 §9) — lockless auto-lock 합성도 route 외 line이면 reject.
    allowedLines: computeAllowedLines(trip.route, trip.waypoints),
    // #1536 (S3) — environment + gateOutcome forward. attemptAutoLock 이 환경 분기
    // consensusGate 평가로 surface 통과 / underground arrival+lockAttachable 합의 강제.
    environment,
    gateOutcome: outcome,
    // #1614 Phase B — self-poll 결과를 attemptAutoLock 에 forward. 함수 내부에서 trainCode 결정
    // 직후 cross-match 후 consensusGate 입력으로 positionTrainAgreement 전달.
    selfPollPositions: selfPollPositions?.positions,
    // #1667 (ADR-015 strongDB) — 마지막 position point의 WiFi SSID 매핑 역명 forward.
    // undefined(iOS WiFi 미연결/Android/시리즈 없음) 시 consensusGate가 자연 false fallback.
    wifiSsidStationName: fusion.series[fusion.series.length - 1]?.wifiSsidStationName,
  });
  if (autoLockResult.confidenceTrace && env.TELEMETRY) {
    recordAutoLockConfidence(env.TELEMETRY, trip.token, autoLockResult.confidenceTrace);
  }
  const autoLock = autoLockResult.lock;
  if (!autoLock) return false;

  // boarding-prompt auto-lock 성공 블록과 동형 — lock 부착 + dedup 마커 + 카운터.
  trip.boardingLock = autoLock;
  trip.boardingPromptState = markPromptFired(now);
  trip.lastAutoPromptedAt = now;
  trip.consecutiveEtaMissing = 0;
  stats.autoLockSuccess += 1;
  log('lockless: auto-lock attached', {
    token: trip.token.slice(0, 8),
    trainCode: autoLock.trainCode,
    line: autoLock.line,
    originStation: display.originStation,
  });
  await putTrip(env.TRIPS, trip);
  return true;
}

/**
 * #816 C — lockless trip (사용자 opt-in)에서 intermediate waypoint 통과를 추적하고 station-passed
 * push를 발사한다.
 *
 * #1315 — 우선 `maybeBindLocklessTrainCode`로 탑승 열차의 trainCode 확보를 시도한다(9단 게이트
 * 통과 시). 확보되면 다음 cycle이 lock 경로(trainCode 매칭)로 *그 열차*만 추적 — lockless 안정성의
 * 핵심. trainCode 미확보 cycle에서만 아래 bare-arvlCd 경로로 진행하되, GPS motion이 실제 이동
 * (walking/automotive)을 보일 때만 advance를 허용한다(`LOCKLESS_ADVANCE_MOTION_MODES`). 정적/
 * 저신뢰 cycle은 보류 — `pickBestArrivalSignal`의 "아무 열차" arvlCd는 *사용자 열차* ground truth가
 * 아니므로 false positive(2026-06-15 용마산 정적 false advance) 차단.
 *
 * 발사 조건(trainCode 미확보 cycle):
 *   1. arrivals 중 best signal의 arvlCd가 ARRIVED(1) 또는 ENTERING(0)
 *   2. GPS motion ∈ {walking, automotive} (실제 이동 확증)
 *   3. dedup: 같은 waypoint에서 이미 한 번 발사한 경우 (lastFiredPhase='imminent') skip
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
  // #1315 — bare-arvlCd 발사 전에 탑승 열차 trainCode 확보를 우선 시도한다. 성공 시 lock이
  // 부착되고(putTrip 완료) 다음 cron 사이클이 lock 경로로 *그 열차*만 추적 — 이번 cycle은 발사 안 함.
  if (await maybeBindLocklessTrainCode(trip, waypoint, fusion, env, deps, stats, now, log)) {
    return;
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
  // #1363 — log 진단 이원화. `waypoint`(trip 다음 정거장) ↔ `currentStation`(사용자 추정 현재역)
  // 혼동 방지. 클라가 송신한 latest point의 currentStationName을 추출(있으면), log object에 동시 적재.
  const currentStationName = pickLatestCurrentStationName(fusion.series);
  if (!phaseAllowsImminentFiring(fusion.phaseState)) {
    stats.phaseImminentBlocked += 1;
    log('lockless: phase gate blocked', {
      token: trip.token.slice(0, 8),
      waypoint: waypoint.stationName,
      ...(currentStationName !== undefined ? { currentStation: currentStationName } : {}),
      phase: fusion.phaseState?.current,
      confidence: fusion.phaseState?.confidence,
    });
    if (dirty) await putTrip(env.TRIPS, trip);
    return;
  }
  // #1315 — trainCode 미확보 cycle의 보수 게이트. `pickBestArrivalSignal`의 arvlCd는 waypoint
  // 역의 "아무 열차" 신호라 *사용자 열차*가 통과했다는 ground truth가 아니다. GPS motion이 실제
  // 이동(walking/automotive)을 positive하게 보일 때만 advance를 허용 — 정적/저신뢰(stationary/
  // unknown, 샘플 없음 포함)는 보류해 false positive(정적 false advance + 알림 레이스)를 차단한다.
  // #1386 — lock-active vanish fallback도 같은 헬퍼(`isAdvanceAllowedByMotion`)를 공유한다.
  if (!isAdvanceAllowedByMotion(fusion.posMetrics.motion)) {
    stats.locklessMotionGateBlocked += 1;
    log('lockless: motion gate blocked (no trainCode, not moving)', {
      token: trip.token.slice(0, 8),
      waypoint: waypoint.stationName,
      ...(currentStationName !== undefined ? { currentStation: currentStationName } : {}),
      motion: fusion.posMetrics.motion,
      arvlCd: signal.arvlCd,
    });
    if (dirty) await putTrip(env.TRIPS, trip);
    return;
  }
  const pushId = generatePushId();
  log('lockless: station-passed push', {
    token: trip.token.slice(0, 8),
    waypoint: waypoint.stationName,
    ...(currentStationName !== undefined ? { currentStation: currentStationName } : {}),
    arvlCd: signal.arvlCd,
    etaSeconds: signal.etaSeconds,
  });
  // #1561 (T8, ADR-017 / S2 흡수) — lockless fire 직전 SSoT 권위 스냅샷 forward.
  const locklessSsot = await readSsot(env.TRIPS, trip.token, {
    cacheTtl: SSOT_CRON_READ_CACHE_TTL_SEC,
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
          // #1365 — server-authoritative occupiedLine. 환승역에서 디바이스가 같은 hop index에
          // 다른 line의 stop과 cross-validation 가능. waypoint.line을 그대로 forward.
          occupiedLine: waypoint.line,
          // #1307 — server-authoritative subsurface. lockless intermediate도 지하에선
          // 디바이스 GPS 게이트(out-of-range 오거부)를 우회하도록 flag를 전달.
          subsurface: trip.subsurface === true,
          // #1399 — 좀비 알림 cleanup. lockless intermediate push에도 tripToken stamp.
          // trip-ended cleanup 후 늦게 도착한 stale push를 ACTIVE_TRIP_KEY mismatch로 drop.
          tripToken: trip.token,
          // #1402 — 발사 경로 stamp. device alarmLog에 pushOrigin=lockless로 기록.
          origin: 'lockless' as const,
          // #1539 (S6) — backend 누적 passedStations forward. 빈 배열/undefined는 apns.ts JSON
          // serializer가 자연 누락. device backfill diff(S5 후속 wiring PR)에서 사용.
          passedStations: trip.passedStations,
          // #1561 (T8, ADR-017 / S2 흡수) — TripPositionSSoT 권위 forward. null/undefined는 apns.ts
          // JSON serializer가 자연 누락 → device cascade picker는 기존 tier fallback. lockless trip은
          // backend SSoT가 가장 신뢰 높은 단일 신호 (lock 부재 환경).
          ssot: toSilentPushSsot(locklessSsot),
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
    // #1633 — lockless intermediate corrected env 즉시 KV persist. lockless는 매역 fire 경로라
    // 다음 push까지 짧은 간격(~60s)이지만, 본 cycle 내 후속 코드가 cleanupTripWithLa로 early
    // return하면 putTrip이 호출되지 않는다. 즉시 write로 corrected env 영구 보존.
    await putTrip(env.TRIPS, trip);
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
  // #1402 — 30s alert fallback 안전망 등록. shift 전 stationName으로 등록해 alert 본문이
  // 사용자가 실제로 통과한 station을 가리키게 한다. lockless intermediate는 lock 경로보다
  // device-side validation이 느슨해 silent push 누락 시 안전망 가동이 더 절실한 경로.
  await putPending(env.PENDING_PUSHES, {
    pushId,
    token: trip.token,
    alarmKey: buildAlarmKey(waypoint.stationName, 'imminent'),
    sentAt: now,
    stationName: waypoint.stationName,
    kind: 'intermediate',
    phase: 'imminent',
    etaSeconds: signal.etaSeconds,
    apnsEnv: trip.apnsEnv ?? 'sandbox',
  });
  trip.lastFiredPhase = 'imminent';
  // #1539 (S6) — lockless intermediate 통과 시점도 동일하게 stationName 누적. lock 경로와 동등
  // 정확도 보장 의무(ADR-014: 사용자 명시 의향 trip = lock 활성과 동급).
  appendPassedStation(trip, waypoint.stationName);
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

  // #1536 (S3) — 환경 분기. underground/unknown 은 GPS 의존 게이트(#3~#7) 를 byPass.
  // 결과(outcome.pass) 는 motion+silence/fired 만 보장하므로 caller 는 별도 consensusGate
  // 로 arrival+lockAttachable 합의를 검증해야 false positive 차단.
  const environment = deriveTripEnvironment(trip);
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
    environment,
  });

  if (!outcome.pass) {
    stats.boardingPromptBlocked += 1;
    log('boarding-prompt: gate blocked', {
      token: trip.token.slice(0, 8),
      reason: outcome.reason satisfies GateSkipReason,
      environment,
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
      // #1439 (E6, ADR-015 §9) — boarding-prompt auto-lock 합성도 route 외 line이면 reject.
      allowedLines: computeAllowedLines(trip.route, trip.waypoints),
      // #1536 (S3) — environment + gateOutcome forward. 환경 분기 consensusGate 강제.
      environment,
      gateOutcome: outcome,
      // #1667 (ADR-015 strongDB) — 마지막 position point의 WiFi SSID 매핑 역명 forward.
      // undefined(iOS WiFi 미연결/Android/시리즈 없음) 시 consensusGate가 자연 false fallback.
      wifiSsidStationName: fusion.series[fusion.series.length - 1]?.wifiSsidStationName,
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
        // #1536 (S3, T13) — cron loop 경로. POST /trips instant path 와 source 구분.
        triggerKind: 'cron',
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
    // #1633 — boarding-prompt corrected env 즉시 KV persist. dirty 후속 putTrip(line 2990)이
    // 정상 경로지만, 본 함수가 trip 종료 / cleanup 경로로 분기하면 누락 가능. 즉시 write로
    // corrected env가 영구 보존돼 후속 cron / push가 mismatch retry 없이 정상 호스트로 직행.
    await putTrip(env.TRIPS, trip);
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
