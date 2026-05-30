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

/**
 * 백엔드 Trip.boardingLock과 동일 구조 (#622). backend/alarm-worker/src/types.ts의
 * `BoardingLockMeta`와 schema 동기화 — backend parseBoardingLock(index.ts:272)이 모든 필드를 검증한다.
 * 한 필드라도 어긋나면 backend가 boardingLock만 drop하고 trip은 살린다.
 */
export interface AlarmBoardingLock {
  /** Seoul API btrainNo (예: "7246") — 사용자가 탭한 열차. */
  trainCode: string;
  /** 현재 leg의 노선 (Waypoint.line과 동일 표기). */
  line: string;
  /** Seoul API subwayId (예: "1007") — 환승 노선 구분용. */
  subwayId: string;
  /** 사용자가 선택한 열차 출발 시각 (epoch ms) — 보통 client BoardingLock.boardedAt. */
  selectedDepartureTime: number;
  /** 현 BoardingLock 구간 내 정차역 시퀀스 (출발역 → 구간 끝). backend가 indexOf로 위치 계산. */
  segmentStations: string[];
  /** Lock 자동 만료 시각 (epoch ms). */
  expiresAt: number;
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
  /**
   * BoardingLock metadata (#622). 사용자가 탑승 열차를 확정한 경우 함께 보내 backend가 trainCode
   * 기준으로 추적·reschedule 가능. 없으면 backend는 기존 anchor waypoint 폴링으로 fallback.
   */
  boardingLock?: AlarmBoardingLock;
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
/**
 * register dedup 시 `alarmAtEpochMs`를 묶는 버킷(ms).
 *
 * `alarmAtEpochMs = now + ETA*1000`이므로 Open API ETA가 30~60초 단위로 흔들리면
 * 매 GPS 폴링마다 다른 값이 된다. 버킷 단위(60s)로 떨어뜨려 동일 트립의 잔jitter를
 * 흡수한다. 정확한 발사 시각은 백엔드 cron이 reschedule로 자체 보정한다.
 */
const ALARM_TIME_BUCKET_MS = 60 * 1000;

/**
 * 마지막으로 백엔드에 성공적으로 등록된 트립 페이로드의 해시.
 *
 * 디바이스 hook(`useApnsTripRegistration`)이 GPS/ETA 변동마다 useEffect를
 * 재실행하는 경우 의미상 동일한 페이로드로 POST /trips가 분당 수회 폭주한다(#581).
 * 모듈 레벨에 마지막 해시를 보관해 동일 페이로드는 fetch 없이 `{ok:true, skipped:true}`로
 * 응답한다. `clearActiveTrip` 호출 시 초기화되어 같은 트립의 재등록(예: 사용자가
 * 트립을 종료 후 곧바로 다시 시작)도 정상 동작한다.
 */
let lastRegisteredHash: string | null = null;

function buildRegisterHash(body: {
  token: string;
  route: NonNullable<Route>;
  destination: string;
  waypoints: AlarmWaypoint[];
  alarmAtEpochMs: number;
  apnsEnv: ApnsEnv;
  boardingLock?: AlarmBoardingLock;
}): string {
  return JSON.stringify({
    token: body.token,
    route: body.route,
    destination: body.destination,
    waypoints: body.waypoints,
    alarmBucket: Math.floor(body.alarmAtEpochMs / ALARM_TIME_BUCKET_MS),
    apnsEnv: body.apnsEnv,
    // boardingLock 변경 — trainCode/line 또는 segmentStations 갱신 시 즉시 재등록 보장.
    // expiresAt은 dedup 대상 아님 (시간 흐름으로 자연 변동).
    boardingLockKey: body.boardingLock
      ? `${body.boardingLock.trainCode}|${body.boardingLock.line}|${body.boardingLock.subwayId}|${body.boardingLock.segmentStations.join(',')}`
      : null,
  });
}

/** 테스트용 — 모듈 dedup 상태 초기화. */
export function __resetAlarmBackendDedup(): void {
  lastRegisteredHash = null;
}

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

  const hash = buildRegisterHash({
    token: payload.token,
    route: payload.route,
    destination: payload.destination,
    waypoints: payload.waypoints,
    alarmAtEpochMs: payload.alarmAtEpochMs,
    apnsEnv: payload.apnsEnv,
    boardingLock: payload.boardingLock,
  });
  if (hash === lastRegisteredHash) {
    return { ok: true, skipped: true };
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
    // boardingLock은 있을 때만 송신 (없으면 backend는 기존 anchor 폴링).
    ...(payload.boardingLock ? { boardingLock: payload.boardingLock } : {}),
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
    lastRegisteredHash = hash;
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
  // 트립 종료 후 동일 트립을 다시 시작할 수 있도록 dedup 캐시를 초기화한다.
  // URL 미설정/네트워크 실패 경로에서도 초기화해야 클라이언트가 register dedup에
  // 의도치 않게 갇히지 않는다.
  lastRegisteredHash = null;

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

/**
 * Live Activity push token 등록 (#586 B/C).
 * native가 emit한 push token hex를 backend의 trip 레코드에 보관한다.
 * URL 미설정/네트워크 실패는 throw 없이 `{ok:false}` — LA 자체는 정상 동작한다.
 */
export async function registerLiveActivityToken(
  tripToken: string,
  activityPushToken: string,
): Promise<AlarmBackendResult> {
  const base = getBackendUrl();
  if (!base) {
    log.info('ALARM_BACKEND_URL not set — skip LA register');
    return { ok: false, skipped: true };
  }
  try {
    const res = await fetchWithTimeout(`${base}/live-activity/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tripToken, activityPushToken }),
    });
    if (!res.ok) {
      log.warn(`LA register failed status=${res.status}`);
      return { ok: false, status: res.status };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    log.warn('LA register error', e);
    return { ok: false };
  }
}

/**
 * Live Activity push token 해제 (#586 B/C).
 * trip이 끝났거나 사용자가 LA를 dismiss했을 때 호출.
 */
export async function clearLiveActivityToken(
  tripToken: string,
): Promise<AlarmBackendResult> {
  const base = getBackendUrl();
  if (!base) {
    log.info('ALARM_BACKEND_URL not set — skip LA clear');
    return { ok: false, skipped: true };
  }
  if (!tripToken) return { ok: false };
  try {
    const res = await fetchWithTimeout(
      `${base}/live-activity/${encodeURIComponent(tripToken)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      log.warn(`LA clear failed status=${res.status}`);
      return { ok: false, status: res.status };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    log.warn('LA clear error', e);
    return { ok: false };
  }
}
