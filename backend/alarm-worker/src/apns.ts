/**
 * APNs HTTP/2 silent push 발사기.
 *
 * Cloudflare Workers는 fetch가 자동으로 HTTP/2를 사용하며 APNs 토큰 인증(JWT)을 지원한다.
 * JWT는 ES256(secp256r1) — `jose`로 .p8 PEM을 import하여 서명한다.
 */

import { importPKCS8, SignJWT } from 'jose';
import type { AlarmPhase } from './alarm';
import type { ReschedulePushPayload } from './types';

/**
 * APNs JWT는 1시간 이내 재사용 가능. Worker 인스턴스 메모리에 캐시한다.
 * JWT는 host와 독립적(keyId/teamId 만으로 서명)이므로 self-heal에서
 * sandbox↔production host를 바꿔도 동일 JWT를 재사용한다.
 */
interface JwtCache {
  token: string;
  expiresAt: number;
}

const JWT_TTL_MS = 50 * 60 * 1000; // 50분 (APNs는 1시간이지만 여유)

let jwtCache: JwtCache | null = null;

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  privateKeyPem: string;
  bundleId: string;
}

export interface SilentPushPayload {
  nextWaypoint: string;
  etaSeconds: number;
  phase: AlarmPhase;
  /** Waypoint 종류. 클라가 intermediate일 때만 즉시 알림 발사하도록 분기 (#416). */
  kind: 'transfer' | 'destination' | 'intermediate';
  /**
   * 백엔드 발사 시점 epoch ms (#478 측정 인프라).
   * 클라 수신 시각과 비교해 silent push 도달 지연 분포 측정용.
   */
  sentAt: number;
  /**
   * push 1건의 unique 식별자 (#566 P2a).
   * 디바이스는 처리 결과를 `POST /push/ack`로 보낼 때 이 id를 echo한다.
   * P2c가 30s 미ACK push를 alert fallback으로 재발사할 때 dedup 키로도 사용.
   */
  pushId: string;
}

export async function buildApnsJwt(config: ApnsConfig, now: number = Date.now()): Promise<string> {
  if (jwtCache && jwtCache.expiresAt > now + 60_000) {
    return jwtCache.token;
  }
  const key = await importPKCS8(config.privateKeyPem, 'ES256');
  const issuedAtSec = Math.floor(now / 1000);
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: config.keyId })
    .setIssuer(config.teamId)
    .setIssuedAt(issuedAtSec)
    .sign(key);
  jwtCache = { token, expiresAt: now + JWT_TTL_MS };
  return token;
}

/** 테스트용 — 캐시 리셋. */
export function resetApnsJwtCache(): void {
  jwtCache = null;
}

export interface SendPushOptions {
  deviceToken: string;
  payload: SilentPushPayload;
  config: ApnsConfig;
  /** APNs 엔드포인트 host. trip의 apnsEnv에 따라 sandbox/production 중 선택해 전달. */
  host: string;
  fetchImpl?: typeof fetch;
  now?: number;
}

export interface SendPushResult {
  ok: boolean;
  status: number;
  reason?: string;
}

export async function sendSilentPush(options: SendPushOptions): Promise<SendPushResult> {
  const jwt = await buildApnsJwt(options.config, options.now);
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `https://${options.host}/3/device/${options.deviceToken}`;

  const body = JSON.stringify({
    aps: { 'content-available': 1 },
    data: {
      nextWaypoint: options.payload.nextWaypoint,
      etaSeconds: options.payload.etaSeconds,
      phase: options.payload.phase,
      kind: options.payload.kind,
      sentAt: options.payload.sentAt,
      pushId: options.payload.pushId,
    },
  });

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: `bearer ${jwt}`,
      'apns-topic': options.config.bundleId,
      'apns-push-type': 'background',
      'apns-priority': '5',
      'content-type': 'application/json',
    },
    body,
  });

  if (response.ok) return { ok: true, status: response.status };
  return parseApnsError(response);
}

/**
 * Alert push 발사 (#572 P2c). silent push와 헤더/payload가 다르다:
 *   - apns-push-type: alert (silent은 background)
 *   - apns-priority: 10 (silent은 5)
 *   - aps.alert: { title, body } (silent은 content-available)
 *   - aps.sound: default
 *
 * data.pushId는 silent과 동일 — 디바이스 P2e가 dedup에 사용.
 */
export interface SendAlertPushOptions {
  deviceToken: string;
  title: string;
  body: string;
  pushId: string;
  config: ApnsConfig;
  host: string;
  fetchImpl?: typeof fetch;
  now?: number;
}

export async function sendAlertPush(options: SendAlertPushOptions): Promise<SendPushResult> {
  const jwt = await buildApnsJwt(options.config, options.now);
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `https://${options.host}/3/device/${options.deviceToken}`;

  const body = JSON.stringify({
    aps: {
      alert: { title: options.title, body: options.body },
      sound: 'default',
    },
    data: { pushId: options.pushId },
  });

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: `bearer ${jwt}`,
      'apns-topic': options.config.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    },
    body,
  });

  if (response.ok) return { ok: true, status: response.status };
  return parseApnsError(response);
}

/**
 * Reschedule silent push (#585). 디바이스 사전 예약 알람(#584)의 도착 시각이 backend 관측과
 * 어긋났을 때 발사. 디바이스는 받아서 기존 예약 cancel + newArrivalTimeEpoch로 재예약한다.
 *
 * silent push와 동일 헤더(background, priority 5)지만 payload의 `kind: 'reschedule'`로 구분.
 * 일반 phase silent push와 달리 alert fallback 대상이 아니다 — 정정 신호 미도달 시 디바이스의
 * 사전 예약이 SLA를 보장하므로 graceful.
 */
export interface SendReschedulePushOptions {
  deviceToken: string;
  pushId: string;
  trainCode: string;
  nextStation: string;
  newArrivalTimeEpoch: number;
  sentAt: number;
  config: ApnsConfig;
  host: string;
  fetchImpl?: typeof fetch;
  now?: number;
}

export async function sendReschedulePush(
  options: SendReschedulePushOptions,
): Promise<SendPushResult> {
  const jwt = await buildApnsJwt(options.config, options.now);
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `https://${options.host}/3/device/${options.deviceToken}`;

  const payload: ReschedulePushPayload = {
    pushId: options.pushId,
    kind: 'reschedule',
    trainCode: options.trainCode,
    nextStation: options.nextStation,
    newArrivalTimeEpoch: options.newArrivalTimeEpoch,
    sentAt: options.sentAt,
  };

  const body = JSON.stringify({ aps: { 'content-available': 1 }, data: payload });

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: `bearer ${jwt}`,
      'apns-topic': options.config.bundleId,
      'apns-push-type': 'background',
      'apns-priority': '5',
      'content-type': 'application/json',
    },
    body,
  });

  if (response.ok) return { ok: true, status: response.status };
  return parseApnsError(response);
}

/**
 * Live Activity update/end push (#586 C). ActivityKit Live Activity의 content-state를
 * 갱신하거나 종료한다. 일반 silent/alert push와 헤더가 다르다:
 *   - apns-topic: ${bundleId}.push-type.liveactivity
 *   - apns-push-type: liveactivity
 *   - apns-priority: 10 (기본) — 호출자가 5로 낮춰 비중요 update를 발사할 수 있음
 *
 * payload:
 *   { aps: { timestamp, event: 'update'|'end', 'content-state': {...},
 *            'stale-date'?, 'dismissal-date'? } }
 *
 * deviceToken 자리에는 `Trip.activityPushToken`을 넣는다. 410 응답은 caller가 trip의
 * activityPushToken을 clear하는 신호 (실제 clear는 PR D에서 발사 path와 함께 구현).
 */
export interface LiveActivityContentState {
  [key: string]: unknown;
}

export interface SendLiveActivityUpdateOptions {
  activityToken: string;
  contentState: LiveActivityContentState;
  event: 'update' | 'end';
  /** epoch seconds — APNs가 dedup/순서 보장에 사용. 누락 시 now. */
  timestamp?: number;
  /** epoch seconds — 이 시각 이후 content-state는 stale 표시. */
  staleDate?: number;
  /** epoch seconds — end 이벤트와 함께 보내면 Live Activity가 이 시각에 자동 dismiss. */
  dismissalDate?: number;
  /** APNs priority. 기본 10 (즉시 전송). 5로 보내면 throttle 대상이 됨. */
  priority?: 5 | 10;
  config: ApnsConfig;
  host: string;
  fetchImpl?: typeof fetch;
  now?: number;
}

export async function sendLiveActivityUpdate(
  options: SendLiveActivityUpdateOptions,
): Promise<SendPushResult> {
  const jwt = await buildApnsJwt(options.config, options.now);
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `https://${options.host}/3/device/${options.activityToken}`;
  const nowSec = Math.floor((options.now ?? Date.now()) / 1000);

  const aps: Record<string, unknown> = {
    timestamp: options.timestamp ?? nowSec,
    event: options.event,
    'content-state': options.contentState,
  };
  if (options.staleDate !== undefined) aps['stale-date'] = options.staleDate;
  if (options.dismissalDate !== undefined) aps['dismissal-date'] = options.dismissalDate;

  const body = JSON.stringify({ aps });
  const priority = options.priority ?? 10;

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: `bearer ${jwt}`,
      'apns-topic': `${options.config.bundleId}.push-type.liveactivity`,
      'apns-push-type': 'liveactivity',
      'apns-priority': String(priority),
      'content-type': 'application/json',
    },
    body,
  });

  if (response.ok) return { ok: true, status: response.status };
  return parseApnsError(response);
}

async function parseApnsError(response: Response): Promise<SendPushResult> {
  let reason: string | undefined;
  try {
    const data = (await response.json()) as { reason?: string };
    reason = data?.reason;
  } catch {
    // ignore parse error
  }
  return { ok: false, status: response.status, reason };
}
