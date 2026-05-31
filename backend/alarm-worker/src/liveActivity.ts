/**
 * Live Activity push 발사 헬퍼 (#586 D).
 *
 * scheduled.ts와 HTTP DELETE handler 양쪽이 공유하는 LA 발사/종료/cleanup 로직.
 * - update: 의미있는 변화 시점에 content-state 갱신
 * - end:    trip 종료(만료/도착/취소) 시 dismissal
 * - 410 BadDeviceToken은 토큰 자체 무효 — trip.activityPushToken을 비우고 state='ended'로 전이
 *
 * content-state는 숫자/enum/epoch만 채운다 — 텍스트(stationName 등)는 디바이스 측 JS init 값 유지
 * (PR E의 widget이 누락 시 raw 필드 폴백). 이는 APNs LA payload 사이즈 절감 + 텍스트 i18n 의존 회피.
 */

import { sendLiveActivityUpdate, type LiveActivityContentState } from './apns';
import { pickApnsHost } from './apnsHost';
import { deleteTrip } from './trips';
import type { ApnsEnv, Env, Trip, Waypoint } from './types';

/**
 * stale-date까지 클라이언트가 last content-state를 신뢰할 수 있는 시간(초).
 * cron 주기(60s)의 약 1.5배 — 한 사이클 누락(네트워크 일시 단절 등)을 흡수.
 * cron 주기가 바뀌면 함께 검토 대상.
 */
export const LA_STALE_DURATION_SEC = 90;

type Logger = (message: string, meta?: Record<string, unknown>) => void;

export interface LiveActivityStats {
  laPushSent: number;
  laPushFailed: number;
  laTokenCleared: number;
}

export interface LiveActivityDeps {
  apnsConfig: import('./apns').ApnsConfig;
  apnsHosts: Record<ApnsEnv, string>;
  fetchImpl?: typeof fetch;
}

/**
 * content-state 페이로드 빌더.
 *
 * phase 필드는 보내지 않는다 — dev에서 phase 개념은 제거되었고(boardingLock 단일 경로),
 * widget(SubwayActivityAttributes)도 phase에 의존하지 않는다. 텍스트는 디바이스 측 init 값을
 * 유지하므로 숫자/enum/epoch만 채운다.
 *
 * @param stopsRemaining 다음 hop까지 남은 정거장 수 — 호출자가 계산해 전달(폴링 전/후 시점에 따라 다름).
 */
export function buildLiveActivityContentState(
  waypoint: Waypoint,
  etaSeconds: number,
  stopsRemaining: number,
  nowMs: number,
): LiveActivityContentState {
  return {
    etaSeconds,
    kind: waypoint.kind,
    stopsRemaining,
    arrivalAtSec: Math.floor(nowMs / 1000) + etaSeconds,
  };
}

export interface LiveActivityFireResult {
  /** trip의 activityPushToken/activityState가 변경되어 putTrip이 필요한지. */
  dirty: boolean;
}

/**
 * LA update push 발사. trip에 activity token이 없거나 state가 live가 아니면 no-op.
 * 410 응답 시 token clear + state='ended'로 전이 (dirty=true).
 *
 * silent/reschedule push의 env-heal(#482)은 LA에 적용하지 않는다 — LA token은 register 시점에
 * 디바이스가 apnsEnv를 확정 통지(`POST /live-activity/register`가 trip의 apnsEnv를 신뢰)하므로,
 * 토큰/환경 불일치는 곧 토큰 자체 무효를 의미. 410 분기에서 단순 clear로 흡수.
 */
export async function fireLiveActivityUpdate(
  trip: Trip,
  contentState: LiveActivityContentState,
  deps: LiveActivityDeps,
  stats: LiveActivityStats,
  now: number,
  log: Logger,
): Promise<LiveActivityFireResult> {
  if (!trip.activityPushToken || trip.activityState !== 'live') {
    return { dirty: false };
  }
  const host = pickApnsHost(trip.apnsEnv, deps.apnsHosts);
  const result = await sendLiveActivityUpdate({
    activityToken: trip.activityPushToken,
    contentState,
    event: 'update',
    staleDate: Math.floor(now / 1000) + LA_STALE_DURATION_SEC,
    config: deps.apnsConfig,
    host,
    fetchImpl: deps.fetchImpl,
    now,
  });
  if (result.ok) {
    stats.laPushSent += 1;
    return { dirty: false };
  }
  stats.laPushFailed += 1;
  log('la update failed', {
    token: trip.token.slice(0, 8),
    status: result.status,
    reason: result.reason,
  });
  if (result.status === 410) {
    trip.activityPushToken = undefined;
    trip.activityState = 'ended';
    stats.laTokenCleared += 1;
    return { dirty: true };
  }
  return { dirty: false };
}

/**
 * LA dismissal push 발사 — event='end' + dismissalDate=now. trip 정리 직전에 호출.
 * 토큰이 없거나 state가 이미 ended면 no-op. push 결과와 무관하게 trip 객체의
 * activity 필드는 비우고 state='ended'로 전이 (다음 cycle에서 중복 시도 차단).
 *
 * 호출자 책임: 이후 deleteTrip이 trip을 KV에서 제거하므로 dirty 플래그 신경 안 써도 됨.
 * `cleanupTripWithLa` wrapper가 두 동작을 묶어 처리.
 */
export async function fireLiveActivityDismissal(
  trip: Trip,
  deps: LiveActivityDeps,
  stats: LiveActivityStats,
  now: number,
  log: Logger,
): Promise<void> {
  if (!trip.activityPushToken || trip.activityState !== 'live') return;
  const host = pickApnsHost(trip.apnsEnv, deps.apnsHosts);
  const nowSec = Math.floor(now / 1000);
  const result = await sendLiveActivityUpdate({
    activityToken: trip.activityPushToken,
    contentState: {},
    event: 'end',
    staleDate: nowSec,
    dismissalDate: nowSec,
    config: deps.apnsConfig,
    host,
    fetchImpl: deps.fetchImpl,
    now,
  });
  if (result.ok) {
    stats.laPushSent += 1;
  } else {
    stats.laPushFailed += 1;
    log('la dismissal failed', {
      token: trip.token.slice(0, 8),
      status: result.status,
      reason: result.reason,
    });
    if (result.status === 410) stats.laTokenCleared += 1;
  }
  // 결과 무관 — 로컬 trip 상태를 ended로 전이. dismissal은 best-effort이며 trip은 곧 삭제됨.
  trip.activityPushToken = undefined;
  trip.activityState = 'ended';
}

/**
 * trip 정리 wrapper — LA dismissal(있을 때만) + deleteTrip을 단일 진입점으로.
 * scheduled.ts의 모든 deleteTrip 호출 + HTTP DELETE /trips/:token이 공유.
 */
export async function cleanupTripWithLa(
  trip: Trip,
  env: Env,
  deps: LiveActivityDeps,
  stats: LiveActivityStats,
  now: number,
  log: Logger,
): Promise<void> {
  await fireLiveActivityDismissal(trip, deps, stats, now, log);
  await deleteTrip(env.TRIPS, trip.token);
}

