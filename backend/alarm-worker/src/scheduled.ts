/**
 * Cron 핸들러 — 활성 트립 enumerate → 알람 윈도우(5분 이내) 트립만 폴링 → ETA 평가 → push 발사.
 */

import {
  EARLY_THRESHOLD_SEC,
  evaluatePhase,
  isSignificantEtaChange,
  shouldFire,
} from './alarm';
import { sendSilentPush, type ApnsConfig } from './apns';
import { matchLine } from './lineAlias';
import { SeoulArrivalClient, type ArrivalEntry } from './seoul';
import { deleteTrip, listTrips, putTrip } from './trips';
import type { Env, Trip, Waypoint } from './types';

/** 알람 윈도우: 알람 예상 시각 5분 이내인 트립만 폴링한다. */
const POLLING_WINDOW_MS = 5 * 60 * 1000;

export interface ScheduledStats {
  scanned: number;
  polled: number;
  pushed: number;
  errors: number;
  /** Seoul API 응답이 비어 ETA를 산출하지 못한 트립 수 (운영 가시성용). */
  etaMissing: number;
}

export interface ScheduledDeps {
  seoul: SeoulArrivalClient;
  apnsConfig: ApnsConfig;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export async function runScheduled(env: Env, deps: ScheduledDeps): Promise<ScheduledStats> {
  const now = deps.now?.() ?? Date.now();
  const log = deps.log ?? (() => undefined);
  const stats: ScheduledStats = {
    scanned: 0,
    polled: 0,
    pushed: 0,
    errors: 0,
    etaMissing: 0,
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
      const eta = pickBestEtaSeconds(arrivals, waypoint);
      if (eta === null) {
        stats.etaMissing += 1;
        log('empty arrivals — skip cycle', {
          token: trip.token.slice(0, 8),
          station: waypoint.stationName,
          line: waypoint.line,
        });
        continue;
      }

      const phase = evaluatePhase(eta);
      const etaChanged = isSignificantEtaChange(trip.lastEtaSeconds, eta);
      const phaseFires = phase !== null && shouldFire(phase, trip.lastFiredPhase);

      // 메모리 갱신: ETA가 의미있게 변하거나 phase가 발사된 경우만
      let dirty = false;
      if (etaChanged) {
        trip.lastEtaSeconds = eta;
        dirty = true;
      }

      // Push 발사 조건:
      // (1) 새 phase 도달 (phaseFires) — phaseFires는 phase !== null을 이미 포함
      // (2) phase 미도달이지만 ETA 변동이 의미있게 발생 & 5분 이내 (사용자에게 정보 갱신)
      const shouldPushPhase = phaseFires;
      const shouldPushEtaUpdate =
        !shouldPushPhase && etaChanged && eta <= EARLY_THRESHOLD_SEC * 2;

      if (shouldPushPhase || shouldPushEtaUpdate) {
        const pushPhase = phase ?? 'early';
        const result = await sendSilentPush({
          deviceToken: trip.token,
          payload: { nextWaypoint: waypoint.stationName, etaSeconds: eta, phase: pushPhase },
          config: deps.apnsConfig,
          fetchImpl: deps.fetchImpl,
          now,
        });

        if (result.ok) {
          stats.pushed += 1;
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
              // 환승역 imminent: 트립 유지하고 다음 waypoint로 진행.
              // dirty는 위(lastFiredPhase 갱신)에서 이미 true로 설정됨 → putTrip에서 shift된 상태가 저장된다.
              const completedStation = waypoint.stationName;
              trip.waypoints.shift();
              trip.lastFiredPhase = undefined;
              trip.lastEtaSeconds = undefined;
              log('waypoint completed, advancing to next', {
                token: trip.token.slice(0, 8),
                completed: completedStation,
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
          if (isUnrecoverableApnsError(result.status, result.reason)) {
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

/**
 * arrivals 중 waypoint의 line과 매칭되는 가장 빠른 ETA(seconds)를 반환.
 * 매칭 실패 시 가장 빠른 도착으로 fallback. 모두 없으면 null.
 */
export function pickBestEtaSeconds(
  arrivals: readonly ArrivalEntry[],
  waypoint: Waypoint,
): number | null {
  if (arrivals.length === 0) return null;
  const matchingLine = arrivals.filter((a) => matchLine(a.subwayNm, waypoint.line));
  const pool = matchingLine.length > 0 ? matchingLine : arrivals;
  const min = pool.reduce(
    (acc, cur) => (cur.arrivalSeconds < acc ? cur.arrivalSeconds : acc),
    Number.POSITIVE_INFINITY,
  );
  return Number.isFinite(min) ? min : null;
}

function isUnrecoverableApnsError(status: number, reason: string | undefined): boolean {
  if (status === 410) return true; // Unregistered
  if (status === 400 && reason === 'BadDeviceToken') return true;
  return false;
}
