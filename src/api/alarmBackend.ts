/**
 * alarm-worker(#338) 백엔드 클라이언트.
 *
 * APNs device token + 활성 트립을 등록/해제한다. 백엔드는 cron으로 도착 정보를
 * 폴링하고 적절한 시점에 silent push로 reschedule을 트리거한다.
 *
 * URL은 `EXPO_PUBLIC_ALARM_BACKEND_URL`로만 주입된다. 미설정 시 모든 호출은
 * graceful skip(`{ok:false, skipped:true}`) — Phase 1 baseline(사전 예약만)으로 동작한다.
 */

import type { Route } from '../utils/stationRoute';
import type { ApnsEnv } from '../utils/apnsEnv';
import { createLogger } from '../utils/logger';

const log = createLogger('alarmBackend');

/** 백엔드 Trip.Waypoint와 동일 구조. backend/alarm-worker/src/types.ts와 동기화. */
export interface AlarmWaypoint {
  stationName: string;
  line: string;
  kind: 'transfer' | 'destination' | 'intermediate';
}

export interface RegisterTripPayload {
  /** APNs device token (hex) */
  token: string;
  route: NonNullable<Route>;
  /** 목적지 역 ID — stations.json id (예: "0228") */
  destination: string;
  waypoints: AlarmWaypoint[];
  /** epoch ms — 트립 등록 시각 (기본: Date.now()) */
  createdAt?: number;
  /** epoch ms — 자동 만료 시각 (기본: createdAt + 2시간) */
  expiresAt?: number;
  /** epoch ms — 알람 발사 예상 시각 (5분 윈도우 진입 판정용) */
  alarmAtEpochMs: number;
  /** APNs 토큰 환경 — backend가 sandbox/production host를 선택. */
  apnsEnv: ApnsEnv;
}

export interface AlarmBackendResult {
  ok: boolean;
  /** URL 미설정 등으로 호출이 건너뛰어진 경우 true. */
  skipped?: boolean;
  status?: number;
}

/** 기본 트립 TTL — 2시간. 백엔드 KV expiration과 정렬. */
const DEFAULT_TRIP_TTL_MS = 2 * 60 * 60 * 1000;
/** fetch 타임아웃 — 백엔드 응답 지연으로 알람 등록이 차단되지 않도록 짧게 유지. */
const REQUEST_TIMEOUT_MS = 5000;

function getBackendUrl(): string | null {
  const url = process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
  if (!url) return null;
  return url.replace(/\/$/, '');
}

async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 활성 트립을 등록한다. 백엔드 URL이 없거나 호출이 실패해도 throw하지 않고
 * `{ok:false}`를 반환 — 알람 사전 예약(#334)은 그대로 동작한다.
 */
export async function registerActiveTrip(
  payload: RegisterTripPayload,
): Promise<AlarmBackendResult> {
  const base = getBackendUrl();
  if (!base) {
    log.info('ALARM_BACKEND_URL not set — skip register');
    return { ok: false, skipped: true };
  }

  const createdAt = payload.createdAt ?? Date.now();
  const expiresAt = payload.expiresAt ?? createdAt + DEFAULT_TRIP_TTL_MS;
  const body = {
    token: payload.token,
    route: payload.route,
    destination: payload.destination,
    waypoints: payload.waypoints,
    createdAt,
    expiresAt,
    alarmAtEpochMs: payload.alarmAtEpochMs,
    apnsEnv: payload.apnsEnv,
  };

  try {
    const res = await fetchWithTimeout(`${base}/trips`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      log.warn(`register failed status=${res.status}`);
      return { ok: false, status: res.status };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    log.warn('register error', e);
    return { ok: false };
  }
}

/**
 * silent push 처리 결과 ACK (#568 P2b). 백엔드 #566 P2a `/push/ack` endpoint 호출.
 * 백엔드가 pushId 발급 시 KV에 저장한 token과 매칭해 임의 echo를 차단하므로
 * caller는 디바이스의 APNs token을 함께 전달해야 한다.
 * URL 미설정/네트워크 실패 시 throw 없이 `{ok:false}` — 본 silent push 처리는 영향 없음.
 */
export interface PushAckPayload {
  pushId: string;
  token: string;
  outcome: 'fired' | 'skipped';
  reason?: string;
}

export async function sendPushAck(payload: PushAckPayload): Promise<AlarmBackendResult> {
  const base = getBackendUrl();
  if (!base) {
    log.info('ALARM_BACKEND_URL not set — skip push ack');
    return { ok: false, skipped: true };
  }
  try {
    const res = await fetchWithTimeout(`${base}/push/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      log.warn(`push ack failed status=${res.status}`);
      return { ok: false, status: res.status };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    log.warn('push ack error', e);
    return { ok: false };
  }
}

/**
 * 활성 트립을 해제한다. URL/네트워크 실패 시에도 throw하지 않는다 — 백엔드 KV는
 * `expiresAt`으로 자동 정리되므로 클라이언트가 재시도 책임을 갖지 않는다.
 */
export async function clearActiveTrip(token: string): Promise<AlarmBackendResult> {
  const base = getBackendUrl();
  if (!base) {
    log.info('ALARM_BACKEND_URL not set — skip clear');
    return { ok: false, skipped: true };
  }
  if (!token) return { ok: false };

  try {
    const res = await fetchWithTimeout(`${base}/trips/${encodeURIComponent(token)}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      log.warn(`clear failed status=${res.status}`);
      return { ok: false, status: res.status };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    log.warn('clear error', e);
    return { ok: false };
  }
}
