/**
 * Live Activity push 발사 헬퍼 (#586 D / #613).
 *
 * scheduled.ts와 HTTP DELETE handler 양쪽이 공유하는 LA 발사/종료/cleanup 로직.
 * - update: 의미있는 변화 시점에 content-state 갱신
 * - end:    trip 종료(만료/도착/취소) 시 dismissal
 * - 410 BadDeviceToken은 토큰 자체 무효 — trip.activityPushToken을 비우고 state='ended'로 전이
 *
 * content-state schema (#613)는 widget의 `SubwayActivityAttributes.ContentState`에 1:1 정렬.
 * ActivityKit의 update는 content-state 전체 교체이므로, widget의 non-optional 필드
 * (stationName, lineName, lineColorHex)는 backend가 반드시 채워야 decode 실패가 없다.
 * 그 외 텍스트 필드(alarmBody/etaText/distanceText 등)는 비워 두고, widget이 `resolvedXxx`
 * 폴백 helper로 raw 필드(etaMinutes, distanceM, alarmType 등)에서 derive 한다.
 */

import { sendLiveActivityUpdate, type LiveActivityContentState } from './apns';
import { pickApnsHost } from './apnsHost';
import { LINE_META } from './lineAlias';
import { deleteProgress } from './progress';
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
 * content-state 페이로드 빌더 (#613).
 *
 * widget `SubwayActivityAttributes.ContentState`와 키가 정렬되어야 한다 (ActivityKit이
 * update 시 content-state 전체를 교체하므로, 키 불일치는 widget decode 실패 또는 UI 누락으로
 * 직결). distanceM은 backend가 모르므로 widget에서 optional로 두고 여기서는 채우지 않는다.
 *
 * alarmType은 채우지 않는다 — backend는 알람을 트리거하지 않고(디바이스 사전 예약, #584) 정보 갱신만 함.
 * widget의 긴급 모드(LockScreenView.isUrgent)는 alarmType 존재로 판정하므로, polling 정정마다
 * 긴급 UI가 강제되지 않도록 omit. 알람 트리거 시점의 별도 텍스트 push에서 채우는 것이 정상 경로.
 */
export function buildLiveActivityContentState(
  waypoint: Waypoint,
  etaSeconds: number,
  stopsRemaining: number,
): LiveActivityContentState {
  const meta = LINE_META[waypoint.line];
  return {
    stationName: waypoint.stationName,
    // LINE_META는 13개 노선을 모두 커버하지만, stations.json에 없는 신규 line code가 들어와도
    // widget의 non-optional 필드가 비지 않도록 raw line code를 fallback으로 사용한다.
    lineName: meta?.canonical ?? waypoint.line,
    lineColorHex: meta?.color ?? '#888888',
    stopsRemaining,
    etaMinutes: Math.max(0, Math.round(etaSeconds / 60)),
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
  // #705 — trip을 폐기할 때 progress entry도 함께 제거. TTL이 자연 만료를 보장하지만
  // 즉시 cleanup해야 새 동일 token trip 등록 시 stale shiftedCount가 끼지 않는다.
  await deleteProgress(env.TRIPS, trip.token);
}

