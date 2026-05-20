/**
 * Cloudflare Worker entrypoint — Hono 라우터 + scheduled 핸들러.
 *
 * Routes:
 *   POST   /trips            트립 등록 (body: Trip 일부)
 *   DELETE /trips/:token     트립 해제
 *   GET    /health           헬스체크
 *
 * scheduled():
 *   cron every 1 min — 활성 트립 폴링 + 알람 발사
 */

import { Hono } from 'hono';
import { SeoulArrivalClient } from './seoul';
import { runScheduled } from './scheduled';
import { deleteTrip, getTrip, putTrip } from './trips';
import type { Env, Trip } from './types';

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true }));

app.post('/trips', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const trip = validateTrip(body);
  if (!trip) return c.json({ error: 'invalid_trip' }, 400);

  await putTrip(c.env.TRIPS, trip);
  return c.json({ ok: true, token: trip.token });
});

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
  };
}

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const seoul = new SeoulArrivalClient({
      apiKey: env.SEOUL_API_KEY,
      host: env.SEOUL_API_HOST,
    });
    await runScheduled(env, {
      seoul,
      apnsConfig: {
        host: env.APNS_HOST,
        keyId: env.APNS_KEY_ID,
        teamId: env.APNS_TEAM_ID,
        privateKeyPem: env.APNS_PRIVATE_KEY,
        bundleId: env.APNS_BUNDLE_ID,
      },
      log: (msg, meta) => console.log(JSON.stringify({ msg, ...meta })),
    });
  },
};
