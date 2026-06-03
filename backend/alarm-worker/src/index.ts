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
import { markPromptSilenced } from './boardingPrompt';
import { runFallbackPushes } from './fallback';
import {
  cleanupTripWithLa,
  type LiveActivityDeps,
  type LiveActivityStats,
} from './liveActivity';
import { ackPending } from './pendingPushes';
import { appendPositionPoint } from './positionSeries';
import { deleteProgress, getProgress, type TripProgress } from './progress';
import { SeoulArrivalClient } from './seoul';
import { runScheduled } from './scheduled';
import {
  tokenPrefix,
  validateTelemetryUpload,
  writeTelemetryDataPoints,
} from './telemetry';
import { getTrip, putTrip } from './trips';
import type {
  BoardingLockMeta,
  Env,
  PositionPoint,
  PromptDisplay,
  PromptGeoContext,
  Trip,
} from './types';

/**
 * HTTP DELETE 같은 단일 trip 정리 진입점에서 LA dismissal 발사하기 위한 deps.
 * scheduled.ts와 동일 ApnsConfig/hosts를 env에서 재구성한다.
 */
function buildLaDeps(env: Env): LiveActivityDeps {
  return {
    apnsConfig: {
      keyId: env.APNS_KEY_ID,
      teamId: env.APNS_TEAM_ID,
      privateKeyPem: env.APNS_PRIVATE_KEY,
      bundleId: env.APNS_BUNDLE_ID,
    },
    apnsHosts: { production: env.APNS_HOST, sandbox: env.APNS_HOST_SANDBOX },
  };
}

/** scheduled cycle 통계와 분리된, 단일 HTTP 정리용 throwaway stats. */
function makeLaStats(): LiveActivityStats {
  return { laPushSent: 0, laPushFailed: 0, laTokenCleared: 0 };
}

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

  // #762/#622 — transfer-leg sync 가설 확정용 진단 로그 (root cause 확정 후 제거).
  // wrangler tail에서 hasBoardingLock=false면 client 누락(가설 A),
  // true인데 cron이 lockMissing이면 backend merge drop(가설 C).
  console.log(
    JSON.stringify({
      msg: 'POST /trips incoming',
      tokenPrefix: tokenPrefix(incoming.token),
      hasBoardingLock: incoming.boardingLock !== undefined,
      trainCode: incoming.boardingLock?.trainCode,
      line: incoming.boardingLock?.line,
      segmentLen: incoming.boardingLock?.segmentStations.length,
    }),
  );

  // #578/#704: 디바이스가 동일 trip을 반복 POST해도(예: GPS update마다 register, 또는 cold restart
  // 후 같은 trip 재등록) backend가 이미 advance한 waypoints / 추적 baseline을 덮어쓰지 않는다.
  //
  // #704 same-session 판별 (createdAt strict 비교 폐기):
  //   1) boardingLock.trainCode가 양쪽 모두 같으면 같은 세션 (cold restart 후 createdAt이 바뀌어도 OK)
  //   2) trainCode가 한쪽이라도 없으면 createdAt drift 5s 이내일 때만 같은 세션 (lock 등록 전 단계)
  //   3) 그 외 (다른 trainCode 또는 큰 drift) → 새 세션, 전면 교체
  const existing = await getTrip(c.env.TRIPS, incoming.token);
  const isSameSession = existing !== null && evaluateSameSession(existing, incoming);
  // #705: progress KV 우선 참조. 같은 trainCode면 shift된 waypoints를 incoming에 적용.
  // 다른 trainCode/none이면 progress 폐기.
  const progress = existing !== null ? await getProgress(c.env.TRIPS, incoming.token) : null;
  const progressApplies =
    progress !== null &&
    incoming.boardingLock !== undefined &&
    progress.trainCode === incoming.boardingLock.trainCode;
  if (progress !== null && !progressApplies) {
    await deleteProgress(c.env.TRIPS, incoming.token);
  }
  const baseTrip = isSameSession
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
        // #586 C: Live Activity token/state는 별도 endpoint(`/live-activity/register`)로 관리.
        // 디바이스가 trip을 re-POST해도 register/deregister로 채워둔 값을 유지한다.
        activityPushToken: existing.activityPushToken,
        activityState: existing.activityState,
        // #706: 연속 etaMissing 카운터는 backend-only state — 디바이스가 같은 세션으로 re-register해도
        // 누적치를 보존해야 자동 종료가 정상 동작 (re-register마다 0으로 초기화되면 무한 폴링 회귀).
        consecutiveEtaMissing: existing.consecutiveEtaMissing,
        // #819: boarding-prompt 발사 카운터는 backend-only state — 디바이스가 같은 세션으로
        // re-register하더라도 trip당 1회 + 5분 silence 정책을 유지해야 한다 (re-register마다
        // reset되면 spam 회귀). promptGeoContext / promptDisplay는 incoming이 최신이라 그대로 받음.
        boardingPromptState: existing.boardingPromptState,
      }
    : incoming;

  // #705 — progress KV가 우선. 같은 trainCode면 incoming.waypoints에서 shift된 만큼 잘라낸다.
  // existing trip이 사라졌더라도(KV TTL 만료 등) progress가 살아 있으면 진행분을 그대로 복원.
  const trip = progressApplies
    ? applyProgress(baseTrip, incoming, progress)
    : baseTrip;

  await putTrip(c.env.TRIPS, trip);

  // #764/#622 — putTrip 직후 trip 상태 진단 (root cause sub-step 좁힘용, 확정 후 제거).
  // scheduled.ts의 `cron loaded trip` 로그와 cross-check해 KV 쓰기/읽기 사이에서
  // boardingLock.trainCode가 어떻게 보이는지 확정한다. existing/incoming/final을 한 줄에 모아
  // merge 분기(isSameSession / progressApplied)가 새 lock을 유지하는지 즉시 확인.
  console.log(
    JSON.stringify({
      msg: 'PUT trip after merge',
      tokenPrefix: tokenPrefix(trip.token),
      isSameSession,
      progressApplied: progressApplies,
      incomingHasLock: incoming.boardingLock !== undefined,
      existingHasLock: existing?.boardingLock !== undefined,
      finalTrainCode: trip.boardingLock?.trainCode,
    }),
  );

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

/**
 * 클라이언트 위치 sample 송신 (#819 Phase 1).
 * BG/FG에서 backgroundLocationTask가 fix마다 호출. backend가 device token별 series를 KV에
 * 누적해 cron 사이클마다 9단 boarding-prompt 게이트 평가에 사용한다.
 *
 * Body: { token, lat, lng, accuracy, ts, motion }
 * Trip 존재 확인하지 않는다 — boarding-prompt가 켜지지 않은 디바이스라도 series는 보관해도 무해
 * (TTL 1h로 자연 폐기).
 */
app.post('/position', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const payload = validatePositionPayload(body);
  if (!payload) return c.json({ error: 'invalid_payload' }, 400);

  await appendPositionPoint(c.env.TRIPS, payload.token, payload.point);
  return c.json({ ok: true });
});

interface PositionUploadPayload {
  token: string;
  point: PositionPoint;
}

export function validatePositionPayload(input: unknown): PositionUploadPayload | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.token !== 'string' || obj.token.length === 0) return null;
  if (typeof obj.lat !== 'number' || !Number.isFinite(obj.lat)) return null;
  if (typeof obj.lng !== 'number' || !Number.isFinite(obj.lng)) return null;
  if (typeof obj.accuracy !== 'number' || !Number.isFinite(obj.accuracy) || obj.accuracy < 0) {
    return null;
  }
  if (typeof obj.ts !== 'number' || !Number.isFinite(obj.ts)) return null;
  const motion = obj.motion;
  if (
    motion !== 'stationary' &&
    motion !== 'walking' &&
    motion !== 'automotive' &&
    motion !== 'unknown'
  ) {
    return null;
  }
  return {
    token: obj.token,
    point: {
      lat: obj.lat,
      lng: obj.lng,
      accuracy: obj.accuracy,
      ts: obj.ts,
      motion,
    },
  };
}

/**
 * boarding-prompt 사용자 [미탑승]/dismiss 신호 (#819 게이트 #9).
 * 클라이언트가 사용자 응답을 받아 호출한다. silencedUntil을 set해 5분간 재발사 차단.
 *
 * Body: { token }
 * Trip 부재 시 idempotent — 200 deleted:false.
 */
app.post('/boarding-prompt/dismiss', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const payload = validateDismissPayload(body);
  if (!payload) return c.json({ error: 'invalid_payload' }, 400);

  const existing = await getTrip(c.env.TRIPS, payload.token);
  if (!existing) return c.json({ ok: true, applied: false });

  const updated: Trip = {
    ...existing,
    boardingPromptState: markPromptSilenced(existing.boardingPromptState, Date.now()),
  };
  await putTrip(c.env.TRIPS, updated);
  return c.json({ ok: true, applied: true });
});

interface DismissPayload {
  token: string;
}

export function validateDismissPayload(input: unknown): DismissPayload | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.token !== 'string' || obj.token.length === 0) return null;
  return { token: obj.token };
}

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

/**
 * Live Activity push token 등록 (#586 C).
 * 디바이스가 ActivityKit로 Live Activity를 시작하고 update token을 발급받으면 호출.
 *
 * Body: { tripToken, activityPushToken }
 * Responses:
 *   200 { ok: true } — 등록 성공
 *   400 { error: 'invalid_json' | 'invalid_payload' }
 *   404 { error: 'trip_not_found' } — 디바이스가 trip 등록 없이 호출
 */
app.post('/live-activity/register', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const payload = validateLiveActivityRegister(body);
  if (!payload) return c.json({ error: 'invalid_payload' }, 400);

  const existing = await getTrip(c.env.TRIPS, payload.tripToken);
  if (!existing) return c.json({ error: 'trip_not_found' }, 404);

  const updated: Trip = {
    ...existing,
    activityPushToken: payload.activityPushToken,
    activityState: 'live',
  };
  await putTrip(c.env.TRIPS, updated);
  return c.json({ ok: true });
});

/**
 * Live Activity 종료 — push token clear (#586 C).
 * 디바이스가 Live Activity를 end하거나 사용자가 dismiss하면 호출.
 * activityPushToken은 비우고 activityState='ended'를 남겨 D PR에서 dismissal push 재발사 dedup에 사용.
 * 없는 trip은 idempotent — 200 deleted:false.
 */
app.delete('/live-activity/:tripToken', async (c) => {
  const tripToken = c.req.param('tripToken');
  if (!tripToken) return c.json({ error: 'missing_token' }, 400);
  const existing = await getTrip(c.env.TRIPS, tripToken);
  if (!existing) return c.json({ ok: true, deleted: false });

  const updated: Trip = {
    ...existing,
    activityPushToken: undefined,
    activityState: 'ended',
  };
  await putTrip(c.env.TRIPS, updated);
  return c.json({ ok: true, deleted: true });
});

interface LiveActivityRegisterPayload {
  tripToken: string;
  activityPushToken: string;
}

export function validateLiveActivityRegister(
  input: unknown,
): LiveActivityRegisterPayload | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.tripToken !== 'string' || obj.tripToken.length === 0) return null;
  if (typeof obj.activityPushToken !== 'string' || obj.activityPushToken.length === 0) {
    return null;
  }
  return { tripToken: obj.tripToken, activityPushToken: obj.activityPushToken };
}

app.delete('/trips/:token', async (c) => {
  const token = c.req.param('token');
  if (!token) return c.json({ error: 'missing_token' }, 400);
  const existing = await getTrip(c.env.TRIPS, token);
  if (!existing) return c.json({ ok: true, deleted: false });
  // 활성 LA가 있으면 dismissal push 발사 후 KV 삭제. cleanupTripWithLa가 두 동작을 묶는다.
  // logger는 worker console.log로 직결 — HTTP-driven cleanup의 dismissal 실패가 silent loss로
  // 사라지지 않게 운영 가시성 확보.
  await cleanupTripWithLa(
    existing,
    c.env,
    buildLaDeps(c.env),
    makeLaStats(),
    Date.now(),
    (msg, meta) => console.log(JSON.stringify({ msg, ...meta })),
  );
  return c.json({ ok: true, deleted: true });
});

/**
 * #704: 동일 세션 판별 — strict createdAt 동일성에서 trainCode 기반 + drift 허용으로 완화.
 *
 * 같은 세션 조건 (OR):
 *   1) 양쪽 boardingLock.trainCode가 일치 — cold restart로 createdAt이 바뀌어도 같은 열차면 진행 유지
 *   2) trainCode 미사용 단계라면 createdAt drift가 SESSION_DRIFT_WINDOW_MS 이내
 *
 * trainCode가 다르면 명백히 다른 열차로 새 세션 → false. lock이 한쪽만 있어도(이행 단계)
 * createdAt drift만으로 판정.
 */
export const SESSION_DRIFT_WINDOW_MS = 5_000;

export function evaluateSameSession(existing: Trip, incoming: Trip): boolean {
  const existingCode = existing.boardingLock?.trainCode;
  const incomingCode = incoming.boardingLock?.trainCode;
  if (existingCode && incomingCode) {
    return existingCode === incomingCode;
  }
  return Math.abs(existing.createdAt - incoming.createdAt) <= SESSION_DRIFT_WINDOW_MS;
}

/**
 * #705: progress KV에 기록된 shiftedCount/baseline을 incoming trip에 적용.
 *
 * - waypoints: `incoming.waypoints.slice(shiftedCount)`로 잘라 backend 진행분 반영
 *   (전부 소진된 경우는 호출부가 isSameSession 분기로 trip.waypoints를 보존하므로
 *    여기서 빈 배열로 깎이는 회귀가 발생하지 않음)
 * - baseline (lastTrackedArrivalEpoch, lastLaPushEpoch, consecutiveEtaMissing):
 *   progress가 더 최신 — POST race에 무관한 source of truth.
 */
export function applyProgress(
  base: Trip,
  incoming: Trip,
  progress: TripProgress,
): Trip {
  const sliced = incoming.waypoints.slice(progress.shiftedCount);
  const waypoints = sliced.length > 0 ? sliced : base.waypoints;
  return {
    ...base,
    waypoints,
    lastTrackedArrivalEpoch: progress.lastTrackedArrivalEpoch,
    lastLaPushEpoch: progress.lastLaPushEpoch,
    consecutiveEtaMissing: progress.consecutiveEtaMissing,
  };
}

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
    // #706: 디바이스는 이 필드를 보내지 않지만 기존 trip에서 같은 세션으로 re-register 될 때
    // POST /trips merge 단계에서 existing 값을 보존한다 (consecutiveEtaMissing 누적이 유지되어야 자동 종료가 정상 동작).
    consecutiveEtaMissing:
      typeof obj.consecutiveEtaMissing === 'number' ? obj.consecutiveEtaMissing : undefined,
    // #816 C: 사용자 명시 opt-in 토글값. 미송신 또는 boolean 아니면 undefined (default OFF).
    locklessStationPassed:
      typeof obj.locklessStationPassed === 'boolean' ? obj.locklessStationPassed : undefined,
    // #819: boarding-prompt 평가용 컨텍스트. 좌표/표시 명시 부재 시 백엔드는 lockMissing 분기에서
    // 자연 skip — 좌표 없는 평가는 게이트 #4/#5 정확도 0이라 의미 없음.
    promptGeoContext: parsePromptGeoContext(obj.promptGeoContext),
    promptDisplay: parsePromptDisplay(obj.promptDisplay),
  };
}

function parsePromptGeoContext(raw: unknown): PromptGeoContext | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const origin = o.origin;
  const next = o.nextStation;
  if (!origin || typeof origin !== 'object') return undefined;
  if (!next || typeof next !== 'object') return undefined;
  const oc = origin as Record<string, unknown>;
  const nc = next as Record<string, unknown>;
  if (typeof oc.lat !== 'number' || !Number.isFinite(oc.lat)) return undefined;
  if (typeof oc.lng !== 'number' || !Number.isFinite(oc.lng)) return undefined;
  if (typeof nc.lat !== 'number' || !Number.isFinite(nc.lat)) return undefined;
  if (typeof nc.lng !== 'number' || !Number.isFinite(nc.lng)) return undefined;
  const direction = o.direction;
  const dir = direction === 'up' || direction === 'down' ? direction : null;
  return {
    origin: { lat: oc.lat, lng: oc.lng },
    nextStation: { lat: nc.lat, lng: nc.lng },
    direction: dir,
  };
}

function parsePromptDisplay(raw: unknown): PromptDisplay | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.originStation !== 'string' || o.originStation.length === 0) return undefined;
  if (typeof o.line !== 'string' || o.line.length === 0) return undefined;
  return { originStation: o.originStation, line: o.line };
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
