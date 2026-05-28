/**
 * Cron 핸들러 — 활성 트립 enumerate → 알람 윈도우(5분 이내) 트립만 폴링 → ETA 평가 → push 발사.
 */

import {
  ARRIVAL_CODE,
  EARLY_THRESHOLD_SEC,
  TRAIN_STATUS,
  evaluatePhaseFromSignal,
  isSignificantEtaChange,
  shouldFire,
} from './alarm';
import { sendReschedulePush, sendSilentPush, type ApnsConfig, type SendPushResult } from './apns';
import { matchLine } from './lineAlias';
import { buildAlarmKey, putPending } from './pendingPushes';
import { SeoulArrivalClient, type ArrivalEntry, type PositionEntry } from './seoul';
import { deleteTrip, listTrips, putTrip } from './trips';
import type { ApnsEnv, BoardingLockMeta, Env, Trip, Waypoint } from './types';

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

export interface ScheduledStats {
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
 * trip의 apnsEnv → APNs host 선택. 누락 시 sandbox fallback —
 * 구버전 클라이언트가 필드를 안 보낼 때 production host로 잘못 전송되어
 * `BadDeviceToken`을 받던 #482 회귀를 막기 위함. App Store/TestFlight 빌드는
 * 반드시 명시적으로 'production'을 보내야 한다.
 */
export function pickApnsHost(apnsEnv: ApnsEnv | undefined, hosts: Record<ApnsEnv, string>): string {
  return hosts[apnsEnv ?? 'sandbox'];
}

/**
 * APNs env를 반대편으로 뒤집는다. BadDeviceToken self-heal에서 1차 시도 host와
 * 반대 host로 재시도할 때 사용 (#482 D안). 누락(undefined)은 sandbox로 시작했으므로
 * production으로 뒤집는다 — `pickApnsHost`의 sandbox fallback과 짝.
 */
export function flipApnsEnv(env: ApnsEnv | undefined): ApnsEnv {
  return (env ?? 'sandbox') === 'sandbox' ? 'production' : 'sandbox';
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
  };

  for await (const trip of listTrips(env.TRIPS)) {
    stats.scanned += 1;

    if (trip.expiresAt <= now) {
      await deleteTrip(env.TRIPS, trip.token);
      continue;
    }

    if (trip.alarmAtEpochMs - now > POLLING_WINDOW_MS) {
      // 아직 알람 윈도우 진입 전 — 폴링 스킵
      continue;
    }

    stats.polled += 1;
    const waypoint = pickActiveWaypoint(trip);
    if (!waypoint) continue;

    // #585 — boardingLock 활성 trip은 trainCode 단위 추적 + reschedule push 경로로 분기.
    // 디바이스는 사전 예약 알람(#584)으로 SLA를 보장하므로 phase-based silent push는 보내지 않는다.
    if (trip.boardingLock && trip.boardingLock.expiresAt > now) {
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
        log('boarding-lock poll error', { error: String(e), token: trip.token.slice(0, 8) });
      }
      continue;
    }

    try {
      const arrivals = await deps.seoul.fetchArrivals(waypoint.stationName);
      const signal = pickBestArrivalSignal(arrivals, waypoint);
      if (signal === null) {
        stats.etaMissing += 1;
        log('empty arrivals — skip cycle', {
          token: trip.token.slice(0, 8),
          station: waypoint.stationName,
          line: waypoint.line,
        });
        continue;
      }
      const { etaSeconds: eta, arvlCd } = signal;

      const phase = evaluatePhaseFromSignal(eta, arvlCd);
      const etaChanged = isSignificantEtaChange(trip.lastEtaSeconds, eta);
      const phaseFires = phase !== null && shouldFire(phase, trip.lastFiredPhase);
      // 중간역(intermediate)은 통과 시점(imminent)에만 발사. early phase / 정보 갱신용 push는 노이즈로 간주해 스킵.
      const isIntermediate = waypoint.kind === 'intermediate';

      // 메모리 갱신: ETA가 의미있게 변하거나 phase가 발사된 경우만
      let dirty = false;
      if (etaChanged) {
        trip.lastEtaSeconds = eta;
        dirty = true;
      }

      // Push 발사 조건:
      // (1) 새 phase 도달 — intermediate는 imminent에서만 허용
      // (2) phase 미도달이지만 ETA 변동이 의미있게 발생 & 5분 이내 (intermediate는 제외)
      const shouldPushPhase = phaseFires && (!isIntermediate || phase === 'imminent');
      const shouldPushEtaUpdate =
        !shouldPushPhase && !isIntermediate && etaChanged && eta <= EARLY_THRESHOLD_SEC * 2;

      if (shouldPushPhase || shouldPushEtaUpdate) {
        const pushPhase = phase ?? 'early';
        log('push fired', {
          token: trip.token.slice(0, 8),
          kind: waypoint.kind,
          phase: pushPhase,
          station: waypoint.stationName,
          etaSeconds: eta,
          arvlCd,
        });
        const pushId = generatePushId();
        const pushPayload = {
          nextWaypoint: waypoint.stationName,
          etaSeconds: eta,
          phase: pushPhase,
          kind: waypoint.kind,
          sentAt: now,
          pushId,
        };
        const heal = await sendWithEnvHeal(
          (host) =>
            sendSilentPush({
              deviceToken: trip.token,
              payload: pushPayload,
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
        const envMismatchExhausted = heal.envMismatchExhausted;
        const result = heal.result;

        if (result.ok) {
          stats.pushed += 1;
          // #566 P2a — silent push 발사 성공 시 pending entry 기록. ACK 또는 P2c fallback이 정리한다.
          // PENDING_PUSHES 미바인딩 시 putPending은 graceful no-op.
          await putPending(env.PENDING_PUSHES, {
            pushId,
            token: trip.token,
            alarmKey: buildAlarmKey(waypoint.stationName, pushPhase),
            sentAt: now,
            stationName: waypoint.stationName,
            kind: waypoint.kind,
            phase: pushPhase,
            etaSeconds: eta,
            // self-heal로 정정된 apnsEnv가 dirty에 반영되었더라도 현재 변수는 정정된 값.
            // 누락 시 sandbox fallback과 일관 — pickApnsHost 동등 처리.
            apnsEnv: trip.apnsEnv ?? 'sandbox',
          });
          if (shouldPushPhase) {
            trip.lastFiredPhase = phase!;
            dirty = true;
            if (phase === 'imminent') {
              if (waypoint.kind === 'destination') {
                await deleteTrip(env.TRIPS, trip.token);
                log('trip completed after destination imminent push', {
                  token: trip.token.slice(0, 8),
                });
                continue;
              }
              // 환승역/중간역 imminent: 트립 유지하고 다음 waypoint로 진행.
              // dirty는 위(lastFiredPhase 갱신)에서 이미 true로 설정됨 → putTrip에서 shift된 상태가 저장된다.
              const completedStation = waypoint.stationName;
              const completedKind = waypoint.kind;
              trip.waypoints.shift();
              trip.lastFiredPhase = undefined;
              trip.lastEtaSeconds = undefined;
              log('waypoint completed, advancing to next', {
                token: trip.token.slice(0, 8),
                completed: completedStation,
                kind: completedKind,
                remaining: trip.waypoints.length,
              });
              if (trip.waypoints.length === 0) {
                await deleteTrip(env.TRIPS, trip.token);
                continue;
              }
            }
          }
        } else {
          stats.errors += 1;
          log('apns push failed', {
            status: result.status,
            reason: result.reason,
            token: trip.token.slice(0, 8),
          });
          if (isUnrecoverableApnsError(result.status, result.reason) || envMismatchExhausted) {
            await deleteTrip(env.TRIPS, trip.token);
            continue;
          }
        }
      }

      if (dirty) {
        await putTrip(env.TRIPS, trip);
      }
    } catch (e) {
      stats.errors += 1;
      log('poll error', { error: String(e), token: trip.token.slice(0, 8) });
    }
  }

  log('scheduled run complete', {
    ...stats,
    seoulCalls: deps.seoul.stats.callCount,
  });
  return stats;
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
    log('boarding-lock: trainCode not found in arrivals or positions', {
      token: trip.token.slice(0, 8),
      trainCode: lock.trainCode,
      station: waypoint.stationName,
    });
    return;
  }

  if (estimate.arrived) {
    await advanceBoardingLockWaypoint(trip, waypoint, env, log);
    return;
  }

  await maybeReschedulePush(trip, waypoint, lock, estimate.epoch, env, deps, stats, now, log, generatePushId);
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
 * baseline(lastTrackedArrivalEpoch)도 함께 리셋해 새 waypoint의 첫 push를 보장.
 */
export async function advanceBoardingLockWaypoint(
  trip: Trip,
  waypoint: Waypoint,
  env: Env,
  log: Logger,
): Promise<void> {
  if (waypoint.kind === 'destination') {
    await deleteTrip(env.TRIPS, trip.token);
    log('boarding-lock: destination arrived, trip cleared', {
      token: trip.token.slice(0, 8),
      station: waypoint.stationName,
    });
    return;
  }
  trip.waypoints.shift();
  trip.lastTrackedArrivalEpoch = undefined;
  log('boarding-lock: waypoint advanced', {
    token: trip.token.slice(0, 8),
    completed: waypoint.stationName,
    kind: waypoint.kind,
    remaining: trip.waypoints.length,
  });
  if (trip.waypoints.length === 0) {
    await deleteTrip(env.TRIPS, trip.token);
    return;
  }
  await putTrip(env.TRIPS, trip);
}

/**
 * 임계치 이상 변동 시 reschedule silent push 발사. APNs env mismatch(#482) self-heal 포함.
 * reschedule push는 alert fallback 대상이 아니므로 PENDING_PUSHES 미등록.
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
): Promise<void> {
  const lastEpoch = trip.lastTrackedArrivalEpoch;
  if (
    lastEpoch !== undefined &&
    Math.abs(newArrivalEpoch - lastEpoch) < RESCHEDULE_THRESHOLD_MS
  ) {
    return;
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
      await deleteTrip(env.TRIPS, trip.token);
      return;
    }
  }

  if (dirty) {
    await putTrip(env.TRIPS, trip);
  }
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
