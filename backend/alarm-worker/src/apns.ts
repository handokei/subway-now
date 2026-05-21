/**
 * APNs HTTP/2 silent push 발사기.
 *
 * Cloudflare Workers는 fetch가 자동으로 HTTP/2를 사용하며 APNs 토큰 인증(JWT)을 지원한다.
 * JWT는 ES256(secp256r1) — `jose`로 .p8 PEM을 import하여 서명한다.
 */

import { importPKCS8, SignJWT } from 'jose';
import type { AlarmPhase } from './alarm';

/** APNs JWT는 1시간 이내 재사용 가능. Worker 인스턴스 메모리에 캐시한다. */
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
  let reason: string | undefined;
  try {
    const data = (await response.json()) as { reason?: string };
    reason = data?.reason;
  } catch {
    // ignore parse error
  }
  return { ok: false, status: response.status, reason };
}
