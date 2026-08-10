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

import {
  sendLiveActivityUpdate,
  sendTripEndedAlertPush,
  type LiveActivityContentState,
} from './apns';
import { pickApnsHost, sendWithEnvHeal } from './apnsHost';
import { recordTripMetrics } from './d1TripMetrics';
import { LINE_META } from './lineAlias';
import { deleteProgress } from './progress';
import { logPushFailure } from './pushFailureLog';
import { computeMultiHopContext } from './tripMultiHop';
import { deleteSsot } from './tripPositionSsot';
import {
  cleanupPendingPushesForToken,
  deleteDeviceTripIndexIfCurrent,
  deleteTrip,
  resolveTripDeviceToken,
} from './trips';
import type { ApnsEnv, Env, Trip, TripEndedReason, Waypoint } from './types';
import { writeTripEndedStatus } from './tripStatus';

// S7763 — direct re-export avoids local rebinding when only forwarding the type.
export type { MultiHopContext } from './tripMultiHop';

/**
 * stale-date까지 클라이언트가 last content-state를 신뢰할 수 있는 시간(초).
 * cron 주기(60s)의 약 1.5배 — 한 사이클 누락(네트워크 일시 단절 등)을 흡수.
 * cron 주기가 바뀌면 함께 검토 대상.
 *
 * `LA_STALE_DURATION_SEC`는 기존 호출자(waypoint 미상)·dismissal 경로의 기본값.
 * waypoint kind를 알 수 있는 update 경로는 `staleDurationSecForKind`로 정합 강화 (#1402):
 * destination은 사용자가 하차 직전이라 stale UI 표시를 더 빨리 발동시켜 잘못된
 * "도착 임박" 정체 표시를 차단(짧음). transfer는 환승 hop 길이 평균을 고려해 중간.
 * intermediate는 기존 1.5 cycle 폭 유지.
 *
 * 표는 데이터 주도 — 새 kind 추가 시 매핑만 확장하면 된다.
 */
export const LA_STALE_DURATION_SEC = 90;

const LA_STALE_BY_KIND: Record<Waypoint['kind'], number> = {
  destination: 45,
  transfer: 75,
  intermediate: 90,
};

export function staleDurationSecForKind(kind: Waypoint['kind'] | undefined): number {
  if (kind === undefined) return LA_STALE_DURATION_SEC;
  return LA_STALE_BY_KIND[kind];
}

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
 *
 * `trip` 인자 (#1618 R9-b) — 채워주면 multi-hop 필드(destinationName / transferStationName /
 * stopsToTransfer / secondTransferStationName / stopsAfterLastTransfer / stopsToSecondTransfer /
 * stopsFromTransfer)를 함께 emit해 ActivityKit 전체 교체 후도 JS init이 채운 "전체 trip 여정"
 * UI가 유지된다. 누락 시 (legacy 호출) 기존 5 필드만 emit — 회귀 0 / backward compat.
 *
 * **환승 호선 forward (#1654 / #1658)**: `waypoint.kind === 'transfer'`이고 `trip.waypoints[1]`이 존재하면
 * 다음 leg의 line(`trip.waypoints[1].line`)을 `lineName`/`lineColorHex`로 사용한다.
 * 환승역 waypoint는 현재 leg(경의중앙선 등)의 line을 갖지만, 사용자가 환승역에 도착하거나
 * 도착 중인 시점에는 이미 새 호선(2호선 등)으로 탑승 준비 중이므로 새 leg의 호선을 즉시 노출한다.
 * trip.waypoints는 매 advance마다 shifted SSOT라 race 없이 현재 시점을 정확히 반영한다.
 */
export function buildLiveActivityContentState(
  waypoint: Waypoint,
  etaSeconds: number,
  stopsRemaining: number,
  trip?: Trip,
): LiveActivityContentState {
  // #1654 / #1658 — 환승 waypoint 추적 중에는 다음 leg의 line을 lineName/lineColorHex에 반영한다.
  // waypoint.kind==='transfer' + trip.waypoints[1]이 존재하면 새 leg의 line을 우선 사용.
  // trip이 없거나(legacy 호출) waypoints[1] 부재(직접 환승 도착)이면 waypoint.line으로 fallback.
  const displayLine =
    waypoint.kind === 'transfer' && trip !== undefined && trip.waypoints.length > 1
      ? trip.waypoints[1].line
      : waypoint.line;
  const meta = LINE_META[displayLine];
  const base: LiveActivityContentState = {
    stationName: waypoint.stationName,
    // LINE_META는 13개 노선을 모두 커버하지만, stations.json에 없는 신규 line code가 들어와도
    // widget의 non-optional 필드가 비지 않도록 raw line code를 fallback으로 사용한다.
    lineName: meta?.canonical ?? displayLine,
    lineColorHex: meta?.color ?? '#888888',
    stopsRemaining,
    etaMinutes: Math.max(0, Math.round(etaSeconds / 60)),
  };
  if (!trip) return base;
  // multi-hop optional 필드는 존재하는 것만 spread — undefined assignment를 피해 기존 5 필드
  // toEqual 단언과 ActivityKit content-state diff 모두 깔끔.
  const multiHop = computeMultiHopContext(trip);
  return { ...base, ...multiHop };
}

export interface LiveActivityFireResult {
  /** trip의 activityPushToken/activityState가 변경되어 putTrip이 필요한지. */
  dirty: boolean;
}

/**
 * LA update push 발사. trip에 activity token이 없거나 state가 live가 아니면 no-op.
 * APNs token-invalid 응답 시 token clear + state='ended'로 전이 (dirty=true).
 *
 * silent/reschedule push의 env-heal(#482)은 LA에 적용하지 않는다 — LA token은 register 시점에
 * 디바이스가 apnsEnv를 확정 통지(`POST /live-activity/register`가 trip의 apnsEnv를 신뢰)하므로,
 * 토큰/환경 불일치는 곧 토큰 자체 무효를 의미. token-invalid 분기에서 단순 clear로 흡수.
 *
 * #1899 — token-invalid 판정 확장: 410 Unregistered + 400 BadDeviceToken 둘 다 처리.
 * APNs는 rotation 직후 짧은 window에서 옛 token으로 400 BadDeviceToken을 반환하다가 410로
 * 전환되는 패턴이 있다(T2/T3 trip 경계 race). 400을 clear 안 하면 다음 cron cycle도 같은
 * stale token으로 재시도 → BadDeviceToken 폭증 + LA UI desync. reason 문자열이 SSoT.
 */
export async function fireLiveActivityUpdate(
  trip: Trip,
  contentState: LiveActivityContentState,
  deps: LiveActivityDeps,
  stats: LiveActivityStats,
  now: number,
  log: Logger,
  waypointKind?: Waypoint['kind'],
): Promise<LiveActivityFireResult> {
  if (!trip.activityPushToken || trip.activityState !== 'live') {
    return { dirty: false };
  }
  const host = pickApnsHost(trip.apnsEnv, deps.apnsHosts);
  const result = await sendLiveActivityUpdate({
    activityToken: trip.activityPushToken,
    contentState,
    event: 'update',
    staleDate: Math.floor(now / 1000) + staleDurationSecForKind(waypointKind),
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
  if (isApnsTokenInvalid(result.status, result.reason)) {
    trip.activityPushToken = undefined;
    trip.activityState = 'ended';
    stats.laTokenCleared += 1;
    return { dirty: true };
  }
  return { dirty: false };
}

/**
 * APNs 응답이 LA token 무효(rotation/unregister/env mismatch)임을 의미하는지 판정 (#1899).
 *
 * - status=410: APNs가 token을 invalidated 처리 (가장 확정적인 신호)
 * - status=400 + reason='BadDeviceToken': trip 경계 rotation race에서 짧은 window 동안
 *   옛 token이 400으로 응답되는 패턴. 410으로 전환되기 전 cron cycle이 stale token으로
 *   재시도하면 BadDeviceToken 폭증 + LA UI desync → 즉시 clear가 정답.
 *
 * Apple HTTP/2 APNs response reference:
 *   https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns
 *
 * 다른 400 reason(`BadTopic`, `MissingTopic` 등 구성 오류)은 token 자체 문제가 아니라
 * 백엔드 코드/구성 결함 → token clear가 아니라 코드 수정 대상이라 false. reason 명시 분기로 보호.
 */
export function isApnsTokenInvalid(
  status: number | undefined,
  reason: string | undefined,
): boolean {
  if (status === 410) return true;
  if (status === 400 && reason === 'BadDeviceToken') return true;
  return false;
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
    if (isApnsTokenInvalid(result.status, result.reason)) stats.laTokenCleared += 1;
  }
  // 결과 무관 — 로컬 trip 상태를 ended로 전이. dismissal은 best-effort이며 trip은 곧 삭제됨.
  trip.activityPushToken = undefined;
  trip.activityState = 'ended';
}

/**
 * trip-ended alert push의 KV dedup 키. (tripToken, createdAt) 단위로 1회만 발사한다.
 *
 * `trip.token`은 device APNs token이라 같은 디바이스의 후속 trip이 동일 token을 재사용한다.
 * dedup을 token만으로 잡으면 사용자가 trip A 종료 후 곧이어 시작한 trip B의 종료 alert가
 * stale stamp에 막혀 사라진다(#1337 acceptance 회귀). createdAt까지 포함해 trip-instance 단위로
 * 격리한다.
 *
 * TTL은 cron race(이전 cycle이 늦게 끝나는 동안 다음 cycle 시작) 윈도우만 보호하면 충분 →
 * 10분으로 짧게 잡아 KV bloat도 줄인다. trip이 끝나면 곧 deleteTrip되므로 같은
 * (token, createdAt) 페어가 10분 후에 다시 cleanup 대상이 될 가능성은 사실상 0.
 */
const TRIP_ENDED_ALERT_DEDUP_KEY_PREFIX = 'tripEndedAlert:';
const TRIP_ENDED_ALERT_DEDUP_TTL_SEC = 10 * 60;

function tripEndedAlertDedupKey(tripToken: string, createdAt: number): string {
  return `${TRIP_ENDED_ALERT_DEDUP_KEY_PREFIX}${tripToken}:${createdAt}`;
}

/**
 * trip 정리 wrapper — LA dismissal(있을 때만) + deleteTrip을 단일 진입점으로.
 * scheduled.ts의 모든 deleteTrip 호출 + HTTP DELETE /trips/:token이 공유.
 *
 * #1337 — reason 지정 시 trip-ended **alert** push 발사 (구 silent → alert 전환). server-side
 * auto-end 경로(scheduled.ts의 cron 호출자)는 reason을 명시 전달해 killed 앱 사용자에게도 OS
 * banner로 "안내 종료"를 즉시 표시하고 클라 route/destination/lock state를 동기화한다.
 * HTTP DELETE 경로는 reason 미지정 — 이미 사용자가 destination을 clear한 시점이라 push 불필요.
 *
 * push는 LA dismissal과 별개의 budget(분당 0~1건 trip 종료 수준)이라 LA push와 직렬 발사로 충분.
 * 실패 시 graceful — log만 남기고 cleanup 흐름은 계속 진행한다.
 *
 * #2268 — `metricsReason`은 `reason`과 분리된 D1 전용 파라미터. `reason`은 alert push 발사 여부를
 * 게이팅하는 기존 계약(위 주석)을 그대로 유지 — HTTP DELETE 경로가 metrics 정확도 개선을 위해
 * 종료 사유를 함께 보내더라도 이 값이 alert push를 새로 트리거하면 안 된다(기존 "DELETE 경로는
 * push 불필요" 동작 회귀 금지). `metricsReason` 미지정 시 `reason`을 그대로 D1에 적재(기존 동작).
 */
export async function cleanupTripWithLa(
  trip: Trip,
  env: Env,
  deps: LiveActivityDeps,
  stats: LiveActivityStats,
  now: number,
  log: Logger,
  reason?: TripEndedReason,
  metricsReason?: string,
): Promise<void> {
  await fireLiveActivityDismissal(trip, deps, stats, now, log);
  if (reason) {
    await fireTripEndedAlertPush(trip, reason, env, deps, now, log);
    // #1339 — launch reconciliation 백스톱. alert push가 APNs drop/디바이스 오프라인으로
    // 누락된 케이스에서 디바이스가 다음 launch 시 GET /trips/:token/status로 종료 사실을
    // 확인하고 자체 cleanup한다. KV write 실패는 cleanup 흐름을 차단하지 않는다 —
    // alert push가 best-effort라면 retention도 best-effort.
    try {
      await writeTripEndedStatus(env.TRIPS, trip.token, reason, now);
    } catch (e) {
      log('trip-status write failed', {
        token: trip.token.slice(0, 8),
        reason,
        error: String(e),
      });
    }
  }
  await deleteTrip(env.TRIPS, trip.token);
  // 리뷰 P1 (#2175) — 이 trip이 소유한 deviceToken 역인덱스도 함께 정리(현재도 이 trip.token을
  // 가리킬 때만, race guard는 `deleteDeviceTripIndexIfCurrent` 참고). 정리하지 않으면 로테이션
  // 이후 trip이 이 경로(만료/도착/HTTP DELETE 등)로 종료될 때마다 인덱스가 이미 사라진
  // token을 계속 가리켜, 다음 재등록의 직접 키 조회 miss 시 무의미한 역인덱스 조회 1회가
  // 추가된다(기능 회귀는 아니지만 방치된 고아 인덱스 — 명시 정리로 SSoT를 맞춘다).
  await deleteDeviceTripIndexIfCurrent(env.TRIPS, trip);
  // #705 — trip을 폐기할 때 progress entry도 함께 제거. TTL이 자연 만료를 보장하지만
  // 즉시 cleanup해야 새 동일 token trip 등록 시 stale shiftedCount가 끼지 않는다.
  await deleteProgress(env.TRIPS, trip.token);
  // #2230 — trip 종료 시 잔여 PENDING_PUSHES entry도 함께 정리. arvlCd fire/lockless intermediate
  // push 등이 남긴 pending entry가 trip 삭제 후에도 KV에 잔존하면, 이미 죽은 trip에 대해 다음
  // alert fallback cron이 무의미한 재발사를 시도할 수 있다(RCA #2230 follow-up B: destination
  // cleanup 경로에서 PENDING_PUSHES 미정리). KV 미바인딩/실패는 graceful — cleanup 흐름 차단 X.
  if (env.PENDING_PUSHES) {
    try {
      await cleanupPendingPushesForToken(env.PENDING_PUSHES, resolveTripDeviceToken(trip));
    } catch (e) {
      log('pending-pushes cleanup failed', {
        token: trip.token.slice(0, 8),
        error: String(e),
      });
    }
  }
  // #1701 — SSoT mirror row(`ssot:<token>`)도 함께 제거. trip TTL(최대 9h+)이 자연 만료를
  // 보장하지만, 같은 token 새 trip 등록 시 lazy-seed가 `ssot === null` 조건이라 옛 SSoT가
  // 살아있으면 새 trip의 stationName이 아닌 옛 trip stationName이 그대로 device로 forward되어
  // cross-trip stale mirror 누수 (evidence: 7-018 어린이대공원, 6-038 봉화산). 즉시 cleanup해
  // 새 trip seed가 비어있는 stationName으로 정착되도록 강제한다.
  // KV write 실패 graceful — alert push와 마찬가지로 best-effort. cleanup 흐름 차단 X.
  try {
    await deleteSsot(env.TRIPS, trip.token);
  } catch (e) {
    log('ssot delete failed', {
      token: trip.token.slice(0, 8),
      error: String(e),
    });
  }
  // #1835 — D1 trip_metrics 적재. 미바인딩(env.DB undefined) 시 내부에서 graceful no-op.
  // cleanup 흐름 차단 없음 — recordTripMetrics 자체가 try/catch로 swallow.
  // #2268 — metricsReason이 있으면 alert-push 게이팅용 reason 대신 그 값을 적재(위 헤더 주석).
  await recordTripMetrics(env.DB, trip, metricsReason ?? reason, now);
}

/**
 * trip-ended alert push 발사 (#1337). LA dismissal과 직렬로 1회 발사.
 *
 * KV `tripEndedAlert:{tripToken}` set-if-absent 게이트로 같은 trip의 종료 alert가 cron race로
 * 중복 발사되는 것을 차단. 이미 발사 기록이 있으면 silent skip.
 *
 * 실패는 fire-and-forget 성격이지만 흐름 일관성을 위해 await — APNs latency는 cron 1 cycle 안에서
 * 흡수. fireLiveActivityDismissal과 마찬가지로 trip 상태 변경 없이 best-effort.
 */
async function fireTripEndedAlertPush(
  trip: Trip,
  reason: TripEndedReason,
  env: Env,
  deps: LiveActivityDeps,
  now: number,
  log: Logger,
): Promise<void> {
  const dedupKey = tripEndedAlertDedupKey(trip.token, trip.createdAt);
  const existing = await env.TRIPS.get(dedupKey);
  if (existing !== null) {
    log('trip-ended alert: dedup skip', {
      token: trip.token.slice(0, 8),
      reason,
    });
    return;
  }
  const pushId = crypto.randomUUID();
  // #1933 — 외부 contract 보호. `'la-stale-backstop'`은 backend 내부 식별자로만 사용하고
  // alert push payload에는 client가 인식하는 기존 reason(`'expired'`)으로 매핑한다 —
  // force-end(9h) 패턴과 동일한 backward-compat. client는 새 enum 분기를 추가하지 않아도
  // `'unknown'`으로 normalize되지 않고 기존 graceful handler가 그대로 동작한다.
  const externalReason: TripEndedReason =
    reason === 'la-stale-backstop' ? 'expired' : reason;
  // JWT 서명 / network reject 등의 throw가 cleanup 흐름을 차단하지 않도록 swallow.
  // trip-ended push는 graceful fail-soft — graceful loss 시 클라는 다음 FG hydrate에서 회복.
  try {
    // #1283 — 다른 push 경로(reschedule/lockless/arvlcd)와 동일하게 env-heal 적용.
    // trip.apnsEnv가 stale/오설정이면 BadDeviceToken → opposite host 1회 retry로 종료 푸시 도달.
    // trip은 곧 deleteTrip되므로 correctedEnv KV 반영은 불필요 — retry 성공만으로 충분(로그만 남김).
    const heal = await sendWithEnvHeal(
      (host) =>
        sendTripEndedAlertPush({
          // #2174 — 로테이션 이후에도 실 토큰 발사를 보장. trip.token은 신원 전용(로테이션 시 UUID로 교체).
          deviceToken: resolveTripDeviceToken(trip),
          pushId,
          reason: externalReason,
          sentAt: now,
          // race 가드(#868 P1-2) — push 도착 시점에 클라가 trip 갈아탔으면 ACTIVE_TRIP_KEY 불일치로 cleanup skip.
          tripToken: trip.token,
          // #2120 — 인스턴스 corrId 동봉. trip.corrId 미보유(구 레코드)는 undefined → payload 필드 생략.
          corrId: trip.corrId,
          config: deps.apnsConfig,
          host,
          fetchImpl: deps.fetchImpl,
          now,
        }),
      trip.apnsEnv,
      deps.apnsHosts,
      log,
      trip.token.slice(0, 8),
      { deviceToken: resolveTripDeviceToken(trip), db: env.DB, tripToken: trip.token },
    );
    if (!heal.result.ok) {
      log('trip-ended push failed', {
        token: trip.token.slice(0, 8),
        reason,
        status: heal.result.status,
        pushReason: heal.result.reason,
      });
      // #2177 — trip-ended push는 retry queue를 타지 않는 fire-and-forget 경로(다음 cron
      // cycle에 자연 재시도) — 직접 기록.
      await logPushFailure(env.DB, {
        // #2185 — token_hash는 실 APNs 발사 주소(deviceToken) 기준. trip.token은 신원(로테이션 시 UUID)이라
        // 별도로 trip_token_hash에 남긴다.
        token: resolveTripDeviceToken(trip),
        tripToken: trip.token,
        pushKind: 'trip-ended',
        apnsStatus: heal.result.status,
        apnsReason: heal.result.reason,
        apnsEnv: trip.apnsEnv,
        envMismatchExhausted: heal.envMismatchExhausted,
      });
      // 실패 시에는 dedup stamp를 남기지 않아 다음 cron cycle에서 재시도 허용.
      return;
    }
  } catch (e) {
    log('trip-ended push threw', {
      token: trip.token.slice(0, 8),
      reason,
      error: String(e),
    });
    return;
  }
  // 성공 push만 dedup stamp — 같은 trip의 후속 cleanup race가 중복 alert를 발사하지 못하도록.
  await env.TRIPS.put(dedupKey, '1', { expirationTtl: TRIP_ENDED_ALERT_DEDUP_TTL_SEC });
}

