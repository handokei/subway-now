/**
 * Cloudflare Worker entrypoint — Hono 라우터 + scheduled 핸들러.
 *
 * Routes:
 *   POST   /trips            트립 등록 (body: Trip 일부)
 *   DELETE /trips/:token     트립 해제
 *   POST   /push/ack         silent push 처리 결과 ACK (#566 P2a)
 *   GET    /health           헬스체크
 *
 * scheduled():
 *   cron every 1 min — 활성 트립 폴링 + 알람 발사
 */

import { Hono } from 'hono';
import { runFallbackPushes } from './fallback';
import { ackPending } from './pendingPushes';
import { SeoulArrivalClient } from './seoul';
import { runScheduled } from './scheduled';
import {
  tokenPrefix,
  validateTelemetryUpload,
  writeTelemetryDataPoints,
} from './telemetry';
import { deleteTrip, getTrip, putTrip } from './trips';
import type { BoardingLockMeta, Env, Trip } from './types';

export const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true }));

app.post('/trips', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const incoming = validateTrip(body);
  if (!incoming) return c.json({ error: 'invalid_trip' }, 400);

  // #578: 디바이스가 동일 trip을 반복 POST해도(예: GPS update마다 register) backend가 이미
  // advance한 waypoints / lastFiredPhase / lastEtaSeconds를 덮어쓰지 않는다.
  // 동일 세션 판별: 같은 token + 같은 createdAt. createdAt이 다르면 새 trip 세션이므로 전면 교체.
  const existing = await getTrip(c.env.TRIPS, incoming.token);
  const isSameSession = existing !== null && existing.createdAt === incoming.createdAt;
  const trip = isSameSession
    ? {
        ...incoming,
        waypoints: existing.waypoints,
        lastFiredPhase: existing.lastFiredPhase,
        lastEtaSeconds: existing.lastEtaSeconds,
        apnsEnv: existing.apnsEnv ?? incoming.apnsEnv,
        // boardingLock이 바뀌면(예: 환승 후 새 trainCode) 추적 baseline도 리셋.
        // 양쪽 모두 boardingLock이 있고 trainCode가 같을 때만 baseline 유지 — 둘 다 undefined인
        // 경우 비교가 true로 평가돼 stale epoch이 살아남는 회귀를 막는다.
        lastTrackedArrivalEpoch:
          incoming.boardingLock &&
          existing.boardingLock?.trainCode === incoming.boardingLock.trainCode
            ? existing.lastTrackedArrivalEpoch
            : undefined,
      }
    : incoming;

  await putTrip(c.env.TRIPS, trip);
  return c.json({ ok: true, token: trip.token });
});

/**
 * silent push 게이트 outcome 텔레메트리 (#498).
 * 클라가 30분 주기로 alarmLog 카운트를 누적 upload한다.
 * Trip 존재 여부는 확인하지 않는다 — 만료된 trip의 텔레메트리도 보존(데이터 완전성).
 */
app.post('/telemetry/silent-push', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const payload = validateTelemetryUpload(body);
  if (!payload) return c.json({ error: 'invalid_payload' }, 400);

  const writer = c.env.TELEMETRY;
  if (writer) {
    writeTelemetryDataPoints(writer, payload);
  }
  console.log(
    JSON.stringify({
      msg: 'telemetry uploaded',
      tokenPrefix: tokenPrefix(payload.token),
      received: payload.received,
      fired: payload.fired,
      skipped: payload.skipped,
      sink: writer ? 'ae' : 'none',
    }),
  );
  return c.json({ ok: true });
});

/**
 * silent push 처리 결과 ACK (#566 P2a).
 * 디바이스가 push를 받고 처리(fired 또는 skipped)하면 pushId + 자신의 device token을 함께 보낸다.
 * 백엔드는 KV에 저장된 pending.token과 비교 후 매칭 시에만 entry를 삭제 — 임의 echo로 인한
 * fallback 무력화 차단.
 *
 * Body: { pushId, token, outcome: 'fired'|'skipped', reason? }
 * Response: { ok: true, deleted: boolean, reason?: 'not-found'|'token-mismatch' }
 *
 * deleted=false는 정상 — push가 이미 만료(60s 초과)되거나 token 매칭 실패. 클라는 재전송 불필요.
 */
app.post('/push/ack', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const ack = validatePushAck(body);
  if (!ack) return c.json({ error: 'invalid_payload' }, 400);

  const result = await ackPending(c.env.PENDING_PUSHES, ack.pushId, ack.token);
  return c.json({ ok: true, ...result });
});

interface PushAckPayload {
  pushId: string;
  token: string;
  outcome: 'fired' | 'skipped';
  reason?: string;
}

export function validatePushAck(input: unknown): PushAckPayload | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.pushId !== 'string' || obj.pushId.length === 0) return null;
  if (typeof obj.token !== 'string' || obj.token.length === 0) return null;
  if (obj.outcome !== 'fired' && obj.outcome !== 'skipped') return null;
  const out: PushAckPayload = { pushId: obj.pushId, token: obj.token, outcome: obj.outcome };
  if (typeof obj.reason === 'string') out.reason = obj.reason;
  return out;
}

app.delete('/trips/:token', async (c) => {
  const token = c.req.param('token');
  if (!token) return c.json({ error: 'missing_token' }, 400);
  const existing = await getTrip(c.env.TRIPS, token);
  if (!existing) return c.json({ ok: true, deleted: false });
  await deleteTrip(c.env.TRIPS, token);
  return c.json({ ok: true, deleted: true });
});

export function validateTrip(input: unknown): Trip | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;

  if (typeof obj.token !== 'string' || obj.token.length === 0) return null;
  if (typeof obj.destination !== 'string') return null;
  if (!obj.route || typeof obj.route !== 'object') return null;
  if (!Array.isArray(obj.waypoints) || obj.waypoints.length === 0) return null;
  if (typeof obj.expiresAt !== 'number' || obj.expiresAt <= Date.now()) return null;
  if (typeof obj.alarmAtEpochMs !== 'number') return null;

  // waypoints 검증
  for (const w of obj.waypoints) {
    if (!w || typeof w !== 'object') return null;
    const wp = w as Record<string, unknown>;
    if (typeof wp.stationName !== 'string') return null;
    if (typeof wp.line !== 'string') return null;
    if (wp.kind !== 'transfer' && wp.kind !== 'destination' && wp.kind !== 'intermediate') return null;
  }

  return {
    token: obj.token,
    route: obj.route as Trip['route'],
    destination: obj.destination,
    waypoints: obj.waypoints as Trip['waypoints'],
    expiresAt: obj.expiresAt,
    createdAt: typeof obj.createdAt === 'number' ? obj.createdAt : Date.now(),
    alarmAtEpochMs: obj.alarmAtEpochMs,
    lastFiredPhase: obj.lastFiredPhase === 'early' || obj.lastFiredPhase === 'imminent'
      ? obj.lastFiredPhase
      : undefined,
    lastEtaSeconds: typeof obj.lastEtaSeconds === 'number' ? obj.lastEtaSeconds : undefined,
    apnsEnv: obj.apnsEnv === 'sandbox' || obj.apnsEnv === 'production' ? obj.apnsEnv : undefined,
    boardingLock: parseBoardingLock(obj.boardingLock),
    lastTrackedArrivalEpoch:
      typeof obj.lastTrackedArrivalEpoch === 'number' ? obj.lastTrackedArrivalEpoch : undefined,
  };
}

/**
 * BoardingLock metadata 파싱 (#585).
 * 한 필드라도 어긋나면 boardingLock만 drop하고 trip은 살린다 — backend는 기존 anchor 폴링으로
 * graceful fallback. 디바이스 schema 불일치로 trip 자체를 reject하면 알람이 통째로 죽으므로.
 */
function parseBoardingLock(raw: unknown): BoardingLockMeta | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.trainCode !== 'string' || o.trainCode.length === 0) return undefined;
  if (typeof o.line !== 'string' || o.line.length === 0) return undefined;
  if (typeof o.subwayId !== 'string' || o.subwayId.length === 0) return undefined;
  if (typeof o.selectedDepartureTime !== 'number') return undefined;
  if (!Array.isArray(o.segmentStations) || o.segmentStations.length === 0) return undefined;
  if (!o.segmentStations.every((s) => typeof s === 'string' && s.length > 0)) return undefined;
  if (typeof o.expiresAt !== 'number') return undefined;
  return {
    trainCode: o.trainCode,
    line: o.line,
    subwayId: o.subwayId,
    selectedDepartureTime: o.selectedDepartureTime,
    segmentStations: o.segmentStations as string[],
    expiresAt: o.expiresAt,
  };
}

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const seoul = new SeoulArrivalClient({
      apiKey: env.SEOUL_API_KEY,
      host: env.SEOUL_API_HOST,
    });
    const apnsConfig = {
      keyId: env.APNS_KEY_ID,
      teamId: env.APNS_TEAM_ID,
      privateKeyPem: env.APNS_PRIVATE_KEY,
      bundleId: env.APNS_BUNDLE_ID,
    };
    const apnsHosts = { production: env.APNS_HOST, sandbox: env.APNS_HOST_SANDBOX };
    const log = (msg: string, meta?: Record<string, unknown>) =>
      console.log(JSON.stringify({ msg, ...meta }));

    await runScheduled(env, { seoul, apnsConfig, apnsHosts, log });
    // #572 P2c — silent push 30s 미ACK entry를 alert로 fallback. 같은 cron 사이클에서 실행.
    await runFallbackPushes(env, { apnsConfig, apnsHosts, log });
  },
};
