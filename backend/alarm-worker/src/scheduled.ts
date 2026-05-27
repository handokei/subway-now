/**
 * Cron 핸들러 — 활성 트립 enumerate → 알람 윈도우(5분 이내) 트립만 폴링 → ETA 평가 → push 발사.
 */

import {
  ARRIVAL_CODE,
  EARLY_THRESHOLD_SEC,
  evaluatePhaseFromSignal,
  isSignificantEtaChange,
  shouldFire,
} from './alarm';
import { sendSilentPush, type ApnsConfig } from './apns';
import { matchLine } from './lineAlias';
import { buildAlarmKey, putPending } from './pendingPushes';
import { SeoulArrivalClient, type ArrivalEntry } from './seoul';
import { deleteTrip, listTrips, putTrip } from './trips';
import type { ApnsEnv, Env, Trip, Waypoint } from './types';

/** 알람 윈도우: 알람 예상 시각 5분 이내인 트립만 폴링한다. */
const POLLING_WINDOW_MS = 5 * 60 * 1000;

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
        let result = await sendSilentPush({
          deviceToken: trip.token,
          payload: pushPayload,
          config: deps.apnsConfig,
          host: pickApnsHost(trip.apnsEnv, deps.apnsHosts),
          fetchImpl: deps.fetchImpl,
          now,
        });

        // self-heal (#482): BadDeviceToken은 토큰 자체 무효가 아니라 host 환경 불일치인 경우가
        // 압도적이다. 반대 host로 1회 재시도하고, 성공하면 trip.apnsEnv를 정정 저장한다.
        // 양쪽 host 모두 BadDeviceToken을 내면 그제야 진짜 토큰 무효로 보고 trip을 삭제한다.
        let envMismatchExhausted = false;
        if (!result.ok && isApnsEnvMismatch(result.status, result.reason)) {
          const correctedEnv = flipApnsEnv(trip.apnsEnv);
          log('apns env mismatch — retry with opposite host', {
            token: trip.token.slice(0, 8),
            from: trip.apnsEnv ?? 'sandbox',
            to: correctedEnv,
          });
          const retryResult = await sendSilentPush({
            deviceToken: trip.token,
            payload: pushPayload,
            config: deps.apnsConfig,
            host: deps.apnsHosts[correctedEnv],
            fetchImpl: deps.fetchImpl,
            now,
          });
          if (retryResult.ok) {
            trip.apnsEnv = correctedEnv;
            dirty = true;
            stats.envCorrected += 1;
            log('apns env corrected', {
              token: trip.token.slice(0, 8),
              to: correctedEnv,
            });
          } else if (isApnsEnvMismatch(retryResult.status, retryResult.reason)) {
            // 양쪽 모두 BadDeviceToken — 토큰 자체가 무효
            envMismatchExhausted = true;
          }
          // retry 결과를 최종 result로 승격 — 하단 success/error 분기가 일관되게 동작.
          // retry가 다른 종류 에러(예: 410, PayloadTooLarge)면 그대로 그 경로에서 처리됨.
          result = retryResult;
        }

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
