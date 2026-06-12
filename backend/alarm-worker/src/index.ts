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
import { AUTO_PROMPT_DEDUP_WINDOW_MS } from './autoLock';
import { markPromptSilenced } from './boardingPrompt';
import {
  recordBoardingPromptOutcome,
  validateBoardingPromptOutcome,
} from './boardingPromptOutcome';
import { runFallbackPushes } from './fallback';
import {
  checkRateLimit,
  generateFeedbackId,
  storeFeedback,
  validateFeedback,
} from './feedback';
import {
  dayStartFromIsoDate,
  getFeedbackStats,
  isoDateUtc,
  listFeedback,
  maybeRunDailyFeedbackStats,
  toCsv,
} from './feedbackAdmin';
import { evaluateAndMaybeAlert } from './recallAlerts';
import {
  cleanupTripWithLa,
  type LiveActivityDeps,
  type LiveActivityStats,
} from './liveActivity';
import { ackPending } from './pendingPushes';
import { appendPositionPoint } from './positionSeries';
import { appendAccelSample, isAccelSummary } from './accelSeries';
import { deleteProgress, getProgress, putProgress, type TripProgress } from './progress';
import { SeoulArrivalClient } from './seoul';
import { runScheduled } from './scheduled';
import {
  recordRecallUpload,
  validateRecallUpload,
} from './recallTelemetry';
import { MIN_RECALL_RATIO_THRESHOLD, RECALL_THRESHOLD_CRITICAL } from './metrics';
import { RECALL_DATASET, RECALL_OPS_PAGE_URL, RECALL_QUERIES } from './recallQueries';
import {
  recordPrescheduledUpload,
  validatePrescheduledUpload,
} from './prescheduledTelemetry';
import {
  recordServerProgressUpload,
  validateServerProgressUpload,
} from './serverProgressTelemetry';
import {
  recordDeltaVsEstimatorUpload,
  validateDeltaVsEstimatorUpload,
} from './deltaVsEstimatorTelemetry';
import {
  tokenPrefix,
  validateTelemetryUpload,
  writeTelemetryDataPoints,
} from './telemetry';
import { getTrip, putTrip } from './trips';
import { getQuotaStatus, incrementDailyRequestCount } from './quotaTracker';
import type {
  AccelSummary,
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

/**
 * 일일 요청 카운트 미들웨어 (#1022).
 * 모든 요청에 대해 quota KV 카운터를 +1한다. 80% 도달 시 콘솔 경고 + 선택적 webhook.
 * KV 미바인딩(개발 환경) 시 graceful no-op.
 */
app.use('*', async (c, next) => {
  if (c.env.TRIPS) {
    await incrementDailyRequestCount(c.env.TRIPS, Date.now(), c.env.QUOTA_ALERT_WEBHOOK_URL).catch(
      () => { /* quota tracking failure는 트래픽에 영향 없이 swallow */ },
    );
  }
  return next();
});

app.get('/health', (c) => c.json({ ok: true }));

/**
 * 사용자 버그 신고 (#1034, docs/requirements/12-cross-cutting.md).
 *
 * Body: `{ message: string, context?: { appVersion?, platform?, locale?, deviceModel? } }`
 *   - message: 1~2000자 (validateFeedback이 trim 후 길이 검사)
 *   - context: 옵션 — 알려진 필드만 보존, 나머지는 drop (forward compat)
 *
 * Responses:
 *   201 { ok: true, key }       — 적재 성공
 *   400 { error: 'invalid_json' | 'invalid_payload' }
 *   429 { error: 'rate_limited' } — 동일 IP 1분 5회 초과. `Retry-After`(seconds) 포함
 *   503 { error: 'feedback_unavailable' } — FEEDBACK binding 미설정 (운영자 namespace 발급 전)
 *
 * 보관: TTL 30일. 운영자가 `wrangler kv` CLI로 수거.
 *
 * Rate limit: CF-Connecting-IP 기준 분당 5회 (PR #1042 follow-up, 스팸 방지).
 *   - 헤더 부재 시 'unknown' 단일 버킷으로 fallback — 헤더가 없는 환경(테스트/로컬)도 cap 받음.
 */
app.post('/feedback', async (c) => {
  const kv = c.env.FEEDBACK;
  if (!kv) return c.json({ error: 'feedback_unavailable' }, 503);

  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const now = Date.now();
  const rl = await checkRateLimit(kv, ip, now);
  if (!rl.allowed) {
    return c.json(
      { error: 'rate_limited' },
      429,
      { 'Retry-After': String(rl.retryAfterSeconds) },
    );
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const payload = validateFeedback(body);
  if (!payload) return c.json({ error: 'invalid_payload' }, 400);

  const id = generateFeedbackId();
  const key = await storeFeedback(kv, payload, now, id);
  return c.json({ ok: true, key }, 201);
});

/**
 * 운영자용 feedback 조회 (#1042 follow-up).
 *
 * Auth: `Authorization: Bearer <ADMIN_TOKEN>` 필수. ADMIN_TOKEN secret 미설정 시 503.
 * Query: `?limit=N` (default 50, max 500) / `?before=<epochMs>` (desc 페이지네이션 cursor).
 *
 * Response 200:
 *   { entries: [{ key, receivedAt, message, context? }, ...], nextBefore: number | null }
 *   - entries: 최신 → 오래된 순 정렬.
 *   - nextBefore: 다음 페이지 호출 시 그대로 `?before=`로 전달. 더 없으면 null.
 * Response 401: { error: 'unauthorized' } — 토큰 누락/불일치.
 * Response 503: { error: 'admin_unavailable' | 'feedback_unavailable' } — secret/binding 미설정.
 */
app.get('/admin/feedback', async (c) => {
  const authError = checkAdminAuth(c.req.header('authorization'), c.env.ADMIN_TOKEN);
  if (authError) return c.json({ error: authError.code }, authError.status);
  const kv = c.env.FEEDBACK;
  if (!kv) return c.json({ error: 'feedback_unavailable' }, 503);

  const limit = parseQueryNumber(c.req.query('limit'));
  const before = parseQueryNumber(c.req.query('before'));
  const result = await listFeedback(kv, { limit, before });
  return c.json(result);
});

/**
 * 운영자용 feedback CSV export (#1042 follow-up).
 * 인증/binding 정책은 `/admin/feedback`과 동일. limit/before 동일하게 적용.
 * 성공 시 `text/csv` + Content-Disposition으로 다운로드 트리거.
 */
app.get('/admin/feedback/export.csv', async (c) => {
  const authError = checkAdminAuth(c.req.header('authorization'), c.env.ADMIN_TOKEN);
  if (authError) return c.json({ error: authError.code }, authError.status);
  const kv = c.env.FEEDBACK;
  if (!kv) return c.json({ error: 'feedback_unavailable' }, 503);

  const limit = parseQueryNumber(c.req.query('limit'));
  const before = parseQueryNumber(c.req.query('before'));
  const { entries } = await listFeedback(kv, { limit, before });
  const csv = toCsv(entries);
  return new Response(csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="feedback.csv"',
    },
  });
});

/**
 * 운영자용 feedback 일일 통계 조회 (#1080 follow-up).
 *
 * 매일 00:05 UTC cron이 어제 entry를 집계해 `stats:YYYY-MM-DD` KV에 365일 TTL로 적재.
 * 본 endpoint는 그 결과를 그대로 반환 — Worker가 즉석에서 집계하지 않는다 (CPU 비용 보호).
 *
 * Auth: `/admin/feedback`과 동일 정책 (Bearer + ADMIN_TOKEN secret).
 * Query: `?date=YYYY-MM-DD` (UTC). 미지정 시 어제 UTC 날짜 default.
 *
 * Response 200: { date, total, byPlatform, byAppVersion, byLocale }
 * Response 400: { error: 'invalid_date' } — date 형식 불일치
 * Response 404: { error: 'stats_not_found' } — 해당 날 집계가 아직 없음 (오늘 또는 미수집)
 * Response 401/503: 인증/binding 정책 동일
 */
app.get('/admin/feedback/stats', async (c) => {
  const authError = checkAdminAuth(c.req.header('authorization'), c.env.ADMIN_TOKEN);
  if (authError) return c.json({ error: authError.code }, authError.status);
  const kv = c.env.FEEDBACK;
  if (!kv) return c.json({ error: 'feedback_unavailable' }, 503);

  const requested = c.req.query('date');
  const date = requested ?? isoDateUtc(Date.now() - 24 * 60 * 60 * 1000);
  if (!Number.isFinite(dayStartFromIsoDate(date))) {
    return c.json({ error: 'invalid_date' }, 400);
  }

  const stats = await getFeedbackStats(kv, date);
  if (!stats) return c.json({ error: 'stats_not_found' }, 404);
  return c.json(stats);
});

/**
 * 운영자용 daily request quota 현황 (#1022).
 *
 * Auth: `Authorization: Bearer <ADMIN_TOKEN>` 필수.
 * Response 200: { date, count, limit, ratio, warning }
 *   - date: UTC YYYY-MM-DD
 *   - count: 오늘 요청 카운트
 *   - limit: 일일 한도 (100000)
 *   - ratio: 0~1 사용 비율
 *   - warning: ratio >= 0.8 여부
 * Response 401/503: 인증/binding 정책은 /admin/feedback과 동일.
 */
app.get('/admin/quota', async (c) => {
  const authError = checkAdminAuth(c.req.header('authorization'), c.env.ADMIN_TOKEN);
  if (authError) return c.json({ error: authError.code }, authError.status);
  const status = await getQuotaStatus(c.env.TRIPS, Date.now());
  return c.json(status);
});

interface AdminAuthError {
  code: 'admin_unavailable' | 'unauthorized';
  status: 503 | 401;
}

/**
 * Bearer 토큰 검증. configured token이 없으면 503(설정 누락) — 401과 구분해 운영자가
 * secret put을 잊은 케이스를 즉시 진단할 수 있게 한다.
 */
function checkAdminAuth(
  authHeader: string | undefined,
  configured: string | undefined,
): AdminAuthError | null {
  if (!configured) return { code: 'admin_unavailable', status: 503 };
  if (!authHeader) return { code: 'unauthorized', status: 401 };
  const prefix = 'bearer ';
  if (authHeader.length <= prefix.length) return { code: 'unauthorized', status: 401 };
  if (authHeader.slice(0, prefix.length).toLowerCase() !== prefix) {
    return { code: 'unauthorized', status: 401 };
  }
  const token = authHeader.slice(prefix.length).trimStart();
  if (!token || token !== configured) return { code: 'unauthorized', status: 401 };
  return null;
}

function parseQueryNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

app.post('/trips', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const incoming = validateTrip(body);
  if (!incoming) return c.json({ error: 'invalid_trip' }, 400);

  // #578/#704: 디바이스가 동일 trip을 반복 POST해도(예: GPS update마다 register, 또는 cold restart
  // 후 같은 trip 재등록) backend가 이미 advance한 waypoints / 추적 baseline을 덮어쓰지 않는다.
  //
  // #704 same-session 판별 (createdAt strict 비교 폐기):
  //   1) boardingLock.trainCode가 양쪽 모두 같으면 같은 세션 (cold restart 후 createdAt이 바뀌어도 OK)
  //   2) trainCode가 한쪽이라도 없으면 createdAt drift 5s 이내일 때만 같은 세션 (lock 등록 전 단계)
  //   3) 그 외 (다른 trainCode 또는 큰 drift) → 새 세션, 전면 교체
  const existing = await getTrip(c.env.TRIPS, incoming.token);
  const isSameSession = existing !== null && evaluateSameSession(existing, incoming);
  // #916 follow-up B — auto-prompt dedup 마커 보존. boardingPromptState와 달리 isSameSession=false
  // 분기에서도 같은 token + AUTO_PROMPT_DEDUP_WINDOW_MS 안이면 보존한다. 사용자가 lock 클리어 후
  // 목적지를 살짝 바꿔 새 createdAt으로 재등록하는 케이스에서 prompt 재발사를 차단 (fired+clear
  // 분기 회복). 윈도우 만료/필드 부재면 undefined로 자연 리셋 — 새 trip은 fresh prompt 평가.
  const preservedLastAutoPromptedAt =
    existing?.lastAutoPromptedAt !== undefined &&
    incoming.createdAt - existing.lastAutoPromptedAt < AUTO_PROMPT_DEDUP_WINDOW_MS
      ? existing.lastAutoPromptedAt
      : undefined;
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
        // #916 follow-up A — server-set auto-lock 보존.
        // 9단 게이트 통과로 backend가 합성한 lock(autoLockedAt 마커 보유)은 client가 lock 필드
        // 없이 재등록해도 silent하게 drop되지 않아야 한다 (cron 추적이 끊기는 회귀 차단).
        // 마커가 없는 사용자 명시 lock은 기존 정책대로 incoming.boardingLock===undefined일 때 drop —
        // 사용자가 명시적으로 lock을 해제했다는 신호로 간주.
        // incoming.boardingLock이 truthy면 (사용자가 다른 trainCode 선택 또는 client가 같은 lock
        // 재송신) 그대로 채택돼 swap 경로가 동작.
        boardingLock:
          incoming.boardingLock ??
          (existing.boardingLock?.autoLockedAt !== undefined
            ? existing.boardingLock
            : undefined),
        // boardingLock이 바뀌면(예: 환승 후 새 trainCode) 추적 baseline도 리셋.
        // 양쪽 모두 boardingLock이 있고 trainCode가 같을 때만 baseline 유지 — 둘 다 undefined인
        // 경우 비교가 true로 평가돼 stale epoch이 살아남는 회귀를 막는다.
        //
        // #916 follow-up A — incoming.boardingLock===undefined + existing auto-lock 보존 케이스도
        // 같은 lock이 유지되므로 baseline 유지 (cron 추적 연속성). 사용자 명시 lock drop 케이스는
        // 기존 정책대로 undefined로 리셋.
        lastTrackedArrivalEpoch:
          (incoming.boardingLock &&
            existing.boardingLock?.trainCode === incoming.boardingLock.trainCode) ||
          (incoming.boardingLock === undefined &&
            existing.boardingLock?.autoLockedAt !== undefined)
            ? existing.lastTrackedArrivalEpoch
            : undefined,
        // #586 C: Live Activity token/state는 별도 endpoint(`/live-activity/register`)로 관리.
        // 디바이스가 trip을 re-POST해도 register/deregister로 채워둔 값을 유지한다.
        activityPushToken: existing.activityPushToken,
        activityState: existing.activityState,
        // #706: 연속 etaMissing 카운터는 backend-only state — 디바이스가 같은 세션으로 re-register해도
        // 누적치를 보존해야 자동 종료가 정상 동작 (re-register마다 0으로 초기화되면 무한 폴링 회귀).
        // #903 (Seam G) — 지상 복귀(subsurface true→false) 시 누적 카운터 리셋. 지하 인내 임계(10)로
        // 누적된 값이 지상 임계(5)에 곧장 걸려 trip이 즉시 자동 종료되는 회귀 방지. 신호 회복 = trust restored.
        consecutiveEtaMissing:
          existing.subsurface === true && incoming.subsurface !== true
            ? 0
            : existing.consecutiveEtaMissing,
        // #819: boarding-prompt 발사 카운터는 backend-only state — 디바이스가 같은 세션으로
        // re-register하더라도 trip당 1회 + 5분 silence 정책을 유지해야 한다 (re-register마다
        // reset되면 spam 회귀). promptGeoContext / promptDisplay는 incoming이 최신이라 그대로 받음.
        boardingPromptState: existing.boardingPromptState,
        // #916 follow-up B — same session에선 같은 trip이므로 그대로 보존.
        lastAutoPromptedAt: existing.lastAutoPromptedAt,
      }
    : {
        ...incoming,
        // #916 follow-up B — 새 세션(createdAt drift > 5s)으로 판정돼 incoming으로 전면 교체되더라도
        // 같은 token + window 안이면 auto-prompt dedup 마커는 보존. backend가 직전에 auto-lock 시도/
        // 발사한 trip 컨텍스트의 재발사 ping-pong을 차단한다.
        lastAutoPromptedAt: preservedLastAutoPromptedAt,
      };

  // #705 — progress KV가 우선. 같은 trainCode면 incoming.waypoints에서 shift된 만큼 잘라낸다.
  // existing trip이 사라졌더라도(KV TTL 만료 등) progress가 살아 있으면 진행분을 그대로 복원.
  const trip = progressApplies
    ? applyProgress(baseTrip, incoming, progress)
    : baseTrip;

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
 * 매역 알림 recall KPI upload (#919, Epic #912 A4).
 *
 * Trip 1건 종료 시 client(`alarmLogTelemetry.computeAndUploadTripRecall`)가 산출한 recall %와
 * 게이트별 차단 분포를 Analytics Engine에 적재한다. 클라가 idempotency 가드를 가지므로 같은
 * tripStart 재호출은 안 옴 — backend는 단순 적재.
 *
 * Trip 존재 여부 확인 안 함 — trip이 이미 만료된 경우에도 telemetry는 보존(데이터 완전성).
 * TELEMETRY binding 미설정 시 graceful no-op (개발 환경 호환, `/telemetry/silent-push`와 동형).
 */
app.post('/telemetry/recall', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const payload = validateRecallUpload(body);
  if (!payload) return c.json({ error: 'invalid_payload' }, 400);

  const writer = c.env.TELEMETRY;
  if (writer) {
    recordRecallUpload(writer, payload);
  }
  console.log(
    JSON.stringify({
      msg: 'recall uploaded',
      tokenPrefix: tokenPrefix(payload.token),
      expectedStops: payload.expectedStops,
      firedStops: payload.firedStops,
      recallPct: payload.recallPct,
      sink: writer ? 'ae' : 'none',
    }),
  );
  return c.json({ ok: true });
});

/**
 * A3 사전 예약 효과 텔레메트리 upload (#918, Epic #912 P1).
 *
 * Trip 1건 종료 시 client(`prescheduledLogTelemetry.computeAndUploadTripPrescheduled`)가 산출한
 * miss rate / station 정확도 / fire delta sample을 Analytics Engine에 적재한다.
 * recall과 동형 — client에 idempotency 가드 (LAST_UPLOADED_PRESCHEDULED_TRIP_START_KEY).
 *
 * Trip 존재 여부 확인 안 함 — trip 만료 케이스에도 telemetry 보존.
 * TELEMETRY binding 미설정 시 graceful no-op.
 */
app.post('/telemetry/prescheduled', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const payload = validatePrescheduledUpload(body);
  if (!payload) return c.json({ error: 'invalid_payload' }, 400);

  const writer = c.env.TELEMETRY;
  if (writer) {
    recordPrescheduledUpload(writer, payload);
  }
  console.log(
    JSON.stringify({
      msg: 'prescheduled uploaded',
      tokenPrefix: tokenPrefix(payload.token),
      scheduledCount: payload.scheduledCount,
      firedCount: payload.firedCount,
      stationAccurateCount: payload.stationAccurateCount,
      deltaSamples: payload.fireDeltaSamplesMs.length,
      sink: writer ? 'ae' : 'none',
      // #986 — miss trip 진단 컨텍스트. 없으면 omit (JSON.stringify가 undefined 자동 제거).
      // Logpush로 사후 root cause 분석 (AE blob에는 미적재 — free-form/PII 회피).
      missContext: payload.missContext,
    }),
  );
  return c.json({ ok: true });
});

/**
 * BFF `/progress` 폴링 수신율 텔레메트리 upload (#1173, Epic #1008 C 단기 B5).
 *
 * Client SeoulBffProgressProvider가 폴링 윈도우 단위로 attempts/received를 집계해 업로드.
 * TELEMETRY binding 미설정 시 graceful no-op (recall/prescheduled 동형).
 *
 * 본 엔드포인트는 catalog SSOT(`serverProgressReceived`)와 짝 — 95% 충족이
 * B5(server progress) optional → required 승격 게이트 측정 신호.
 */
app.post('/telemetry/server-progress', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const payload = validateServerProgressUpload(body);
  if (!payload) return c.json({ error: 'invalid_payload' }, 400);

  const writer = c.env.TELEMETRY;
  if (writer) {
    recordServerProgressUpload(writer, payload);
  }
  console.log(
    JSON.stringify({
      msg: 'server-progress uploaded',
      tokenPrefix: tokenPrefix(payload.token),
      attempts: payload.attempts,
      received: payload.received,
      sink: writer ? 'ae' : 'none',
    }),
  );
  return c.json({ ok: true });
});

/**
 * Shadow Stage 1-3 vs server progress delta 텔레메트리 upload (#1174, Epic #1008 C 단기 B5).
 *
 * Client가 같은 trip tick에서 server `BffProgressResponse.waypointIndex`와 local
 * `stationProgressEstimator` 결과가 모두 살아있을 때 |serverIdx - estimatorIdx|(arc-index hop)을
 * 누적해 폴링 윈도우 단위로 업로드한다. backend는 단순 적재 — TELEMETRY binding 미설정 시
 * graceful no-op (recall/prescheduled/server-progress 동형).
 *
 * 본 엔드포인트는 catalog SSOT(`deltaVsEstimatorIndex`)와 짝 — 1주 baseline P50/P95가
 * B5(server progress) optional → required 승격 시 P95 임계 결정 근거.
 */
app.post('/telemetry/delta-vs-estimator', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const payload = validateDeltaVsEstimatorUpload(body);
  if (!payload) return c.json({ error: 'invalid_payload' }, 400);

  const writer = c.env.TELEMETRY;
  if (writer) {
    recordDeltaVsEstimatorUpload(writer, payload);
  }
  console.log(
    JSON.stringify({
      msg: 'delta-vs-estimator uploaded',
      tokenPrefix: tokenPrefix(payload.token),
      sampleCount: payload.deltaSamples.length,
      sink: writer ? 'ae' : 'none',
    }),
  );
  return c.json({ ok: true });
});

/**
 * Recall KPI 집계 query 노출 (#919, Epic #912 A4 후속).
 *
 * 운영 대시보드(Grafana / Notion KPI 카드)가 Cloudflare Analytics Engine SQL HTTP API로
 * 그대로 호출할 수 있는 쿼리 문자열을 SSOT로 반환한다. Worker AE binding은 *write* 전용이라
 * 워커 자체가 SQL을 실행하지 않는다 — 본 엔드포인트는 query catalog + dataset metadata만 노출.
 *
 * `TELEMETRY` binding이 활성화되지 않은 환경에서도 query는 그대로 반환된다(available=false).
 * 대시보드는 available 플래그로 "데이터 미수집 중" 안내 배너를 노출할 수 있다.
 *
 * Privacy: query / dataset 메타만 노출 — 사용자 식별자/원문 미노출.
 */
app.get('/metrics/recall/summary', (c) => {
  return c.json({
    dataset: RECALL_DATASET,
    available: c.env.TELEMETRY !== undefined,
    minRecallRatioThreshold: MIN_RECALL_RATIO_THRESHOLD,
    // #1003 — alert severity 등급 분리. dashboard도 두 임계 모두 노출.
    recallThresholdCritical: RECALL_THRESHOLD_CRITICAL,
    opsPageUrl: RECALL_OPS_PAGE_URL,
    queries: RECALL_QUERIES,
  });
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
  // #823 Phase 3 E1 — 가속도 옵션 필드. 부재 또는 invalid 시 skip (positionSeries는 이미 적재됨).
  if (payload.accelSummary) {
    await appendAccelSample(c.env.TRIPS, payload.token, payload.accelSummary);
  }
  return c.json({ ok: true });
});

interface PositionUploadPayload {
  token: string;
  point: PositionPoint;
  accelSummary?: AccelSummary;
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
  // #823 — accelSummary는 옵션. 부재 또는 invalid 형식은 graceful skip (전체 payload 거부 X).
  //   E1 단계는 기존 #819 게이트와 정합. 가속도 부재는 게이트 동작에 영향 0.
  const accelSummary = isAccelSummary(obj.accelSummary) ? obj.accelSummary : undefined;
  // #828 — map matching 필드는 옵션. 짝(line+arcM)이 함께 와야 series에 적재.
  // 한쪽만 보낸 페이로드는 구버전/잘못된 클라로 간주해 두 필드를 모두 무시 (graceful).
  const mapMatchedLine =
    typeof obj.mapMatchedLine === 'string' && obj.mapMatchedLine.length > 0
      ? obj.mapMatchedLine
      : undefined;
  const mapMatchedArcM =
    typeof obj.mapMatchedArcM === 'number' && Number.isFinite(obj.mapMatchedArcM)
      ? obj.mapMatchedArcM
      : undefined;
  const hasPair = mapMatchedLine !== undefined && mapMatchedArcM !== undefined;
  // #825 — Phase 3 E3 입력. 클라가 stations.json haversine 산출해 stamp (#834에서 wire).
  // 음수/NaN/Infinity는 graceful skip (전체 payload 거부 X — 기존 mapMatched 정책과 정합).
  const nearestStationDistanceM =
    typeof obj.nearestStationDistanceM === 'number' &&
    Number.isFinite(obj.nearestStationDistanceM) &&
    obj.nearestStationDistanceM >= 0
      ? obj.nearestStationDistanceM
      : undefined;
  return {
    token: obj.token,
    point: {
      lat: obj.lat,
      lng: obj.lng,
      accuracy: obj.accuracy,
      ts: obj.ts,
      motion,
      ...(hasPair ? { mapMatchedLine, mapMatchedArcM } : {}),
      ...(nearestStationDistanceM !== undefined ? { nearestStationDistanceM } : {}),
    },
    accelSummary,
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

/**
 * boarding-prompt 응답 측정 (#827).
 *
 * 클라이언트가 "탑승했냐?" 푸시 응답을 받아 결과(boarded/dismissed)를 보고한다.
 * `/boarding-prompt/dismiss`는 trip의 silencedUntil 갱신용이고 본 endpoint는 측정 only —
 * 같은 dismiss 응답이라도 두 endpoint를 별개로 호출해야 false positive 분모/분자가 정확해진다.
 *
 * TELEMETRY binding 부재 시 graceful no-op (개발 환경 호환).
 */
app.post('/metrics/boarding-prompt', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const payload = validateBoardingPromptOutcome(body);
  if (!payload) return c.json({ error: 'invalid_payload' }, 400);

  const writer = c.env.TELEMETRY;
  if (writer) {
    recordBoardingPromptOutcome(writer, payload);
  }
  return c.json({ ok: true });
});

/**
 * Seam E (#901) — 지상 BoardingLock 정정 채널.
 *
 * 클라가 좋은 GPS fix(accuracy ≤ 50m)로 현재 정거장을 확정했을 때 호출. backend는 관측 역이
 * 진행 방향 ±1 hop 이내면 waypoints를 advance해 lock의 currentWaypoint를 사용자 실제 위치와
 * 정렬한다. cron의 Seoul 도착 폴링이 stale일 때(터널/긴 지연) silent push 누락 회귀(#622) 흡수.
 *
 * 지하 구간은 정의상 GPS 부재 → 클라가 호출하지 않는다. 호출 트리거는 클라 책임:
 *   1) accuracy ≤ 50m + 새 currentStation 확정 (debounce 5s, useBoardingLockSync)
 *   2) 지하→지상 경계 (subsurface=false 전환, Seam G barometer)
 *   3) trip 등록 직후 1회
 *
 * Body: { token, observedStationName, observedAtMs, accuracy, subsurface? }
 * Response 200:
 *   { ok, advanced, currentWaypoint, nextStation, autoLockCandidate }
 *   - advanced: 이번 sync로 waypoints가 shift됐는지 (1+ hop)
 *   - currentWaypoint: 정정 후 first waypoint stationName (없으면 null — destination 도착)
 *   - nextStation: 정정 후 first waypoint = 다음 알람 대상 (currentWaypoint와 동일, 의미상 alias)
 *   - autoLockCandidate (#916 A1): cron이 자동 lock을 부착했을 때 그 lock 메타.
 *     클라는 이 값을 보고 사용자가 직접 탭하지 않아도 boardingLock state를 hydrate 가능.
 *     없으면 null. 후속 PR에서 클라이언트가 이 필드를 처리한다.
 * Response 404: { error: 'trip_not_found' } — 클라는 다음 fix에서 자연 retry
 *
 * Trip 부재 시 lock 재생성 책임은 본 endpoint가 지지 않음 — 클라가 useApnsTripRegistration으로
 * POST /trips를 호출하면 같은 경로로 lock이 들어온다 (분리된 lock store가 없는 현 backend 구조).
 */
app.post('/boarding-lock/sync', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const payload = validateBoardingLockSync(body);
  if (!payload) return c.json({ error: 'invalid_payload' }, 400);

  const existing = await getTrip(c.env.TRIPS, payload.token);
  if (!existing) return c.json({ error: 'trip_not_found' }, 404);

  const now = Date.now();
  const advance = computeLockSyncAdvance(existing.waypoints, payload.observedStationName);

  let working: Trip = existing;
  if (advance.shiftedCount > 0) {
    const remaining = working.waypoints.slice(advance.shiftedCount);
    working = {
      ...working,
      waypoints: remaining,
      // 새 waypoint의 첫 push를 보장하기 위해 baseline reset (advanceBoardingLockWaypoint와 동형).
      lastTrackedArrivalEpoch: undefined,
      lastLaPushEpoch: undefined,
      // #900 Seam D — heartbeat 기준점도 함께 reset (baseline 동형).
      lastLaPushAt: undefined,
    };
    // progress KV mirror — POST /trips re-register 시 같은 trainCode면 shift 진행분이 보존되도록.
    await maybeMirrorLockSyncProgress(c.env.TRIPS, working, advance.shiftedCount);
  }

  // D4 (#1210) — payload trainCode가 KV lock trainCode와 다르면 환승 leg로 해석.
  // lock의 trainCode/line을 새 값으로 swap하고 consecutiveEtaMissing을 0으로 reset해
  // 신규 trainCode가 Seoul API에서 잡힐 때까지의 자동 종료(`MAX_CONSECUTIVE_ETA_MISSING`)를 차단한다.
  working = applyBoardingLockTrainCodeSwap(working, payload);

  // lock TTL refresh — 사용자가 지상에서 lock을 활성 유지 중임을 confirm.
  if (working.boardingLock) {
    working = {
      ...working,
      boardingLock: {
        ...working.boardingLock,
        expiresAt: Math.max(working.boardingLock.expiresAt, now + LOCK_TTL_REFRESH_MS),
      },
    };
  }

  await putTrip(c.env.TRIPS, working);

  const head = working.waypoints[0];
  return c.json({
    ok: true,
    advanced: advance.shiftedCount > 0,
    currentWaypoint: head ? head.stationName : null,
    nextStation: head ? head.stationName : null,
    // #916 A1 — cron auto-lock(또는 사용자 명시 lock)이 trip에 부착돼 있으면 그 메타를
    // candidate로 노출. client가 이 값으로 boardingLock UI/state를 hydrate한다.
    // segmentStations/expiresAt 등 내부 필드는 client가 트래킹할 필요가 없어 공개 표면 최소화.
    autoLockCandidate: working.boardingLock
      ? {
          trainCode: working.boardingLock.trainCode,
          line: working.boardingLock.line,
          subwayId: working.boardingLock.subwayId,
        }
      : null,
  });
});

/** Seam E 정정으로 lock TTL을 연장하는 길이. cron 주기 60s × 30 cycles 마진. */
export const LOCK_TTL_REFRESH_MS = 30 * 60 * 1000;

interface BoardingLockSyncPayload {
  token: string;
  observedStationName: string;
  observedAtMs: number;
  accuracy: number;
  subsurface?: boolean;
  /**
   * D4 (#1210) — 클라가 직전 fix 시점에 활성으로 보고 있는 boarding lock trainCode.
   * KV `trip.boardingLock.trainCode`와 다르면 backend가 환승 leg 진입으로 해석해 lock을 갱신하고
   * `consecutiveEtaMissing`을 0으로 reset한다 (자동 종료 차단). 구버전 클라/lock 없는 trip은 미전송.
   */
  trainCode?: string;
  /**
   * D4 (#1210) — `trainCode`와 페어. 환승 leg의 새 노선(`BoardingLockMeta.line`)을 갱신한다.
   * trainCode 없이 단독 전송은 무시 (trainCode가 primary key).
   */
  boardingLine?: string;
}

export function validateBoardingLockSync(input: unknown): BoardingLockSyncPayload | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.token !== 'string' || obj.token.length === 0) return null;
  if (typeof obj.observedStationName !== 'string' || obj.observedStationName.length === 0) {
    return null;
  }
  if (typeof obj.observedAtMs !== 'number' || !Number.isFinite(obj.observedAtMs)) return null;
  if (typeof obj.accuracy !== 'number' || !Number.isFinite(obj.accuracy) || obj.accuracy < 0) {
    return null;
  }
  const result: BoardingLockSyncPayload = {
    token: obj.token,
    observedStationName: obj.observedStationName,
    observedAtMs: obj.observedAtMs,
    accuracy: obj.accuracy,
  };
  if (typeof obj.subsurface === 'boolean') result.subsurface = obj.subsurface;
  // D4 (#1210) — trainCode/boardingLine은 optional. 빈 문자열은 누락과 동일 (보호 차원).
  if (typeof obj.trainCode === 'string' && obj.trainCode.length > 0) {
    result.trainCode = obj.trainCode;
  }
  if (typeof obj.boardingLine === 'string' && obj.boardingLine.length > 0) {
    result.boardingLine = obj.boardingLine;
  }
  return result;
}

/**
 * D4 (#1210) — payload trainCode가 KV trip.boardingLock과 불일치하면 lock의 trainCode/line을
 * 교체하고 `consecutiveEtaMissing`을 0으로 reset한다. 일치하거나 trainCode 미제공 / lock 부재면
 * no-op (trip 그대로 반환).
 *
 * 정책 근거: 환승 leg 진입 직후 backend Seoul API가 새 trainCode 응답을 받기까지 수십 초 공백이
 * 생긴다. lock의 trainCode가 옛 값이면 `runTrainCodeTracking`이 매 cycle estimate=null로 카운터를
 * 누적해 `MAX_CONSECUTIVE_ETA_MISSING` 초과 시 trip을 자동 종료한다 (#1210 evidence). 사용자가
 * Seam E sync로 새 trainCode를 보내면 KV를 즉시 갱신해 자동 종료를 차단한다.
 *
 * 순수 함수 — 호출자(handler)가 putTrip으로 영속화한다.
 */
export function applyBoardingLockTrainCodeSwap(
  trip: Trip,
  payload: BoardingLockSyncPayload,
): Trip {
  const incomingTrainCode = payload.trainCode;
  if (!incomingTrainCode) return trip;
  const lock = trip.boardingLock;
  if (!lock) return trip;
  if (lock.trainCode === incomingTrainCode) return trip;
  // 환승 leg 감지 → lock 교체 + 카운터 reset.
  return {
    ...trip,
    boardingLock: {
      ...lock,
      trainCode: incomingTrainCode,
      // boardingLine은 optional payload — 미제공 시 기존 line 유지.
      line: payload.boardingLine ?? lock.line,
    },
    consecutiveEtaMissing: 0,
  };
}

/**
 * Seam E 진행 판단 — 관측 역이 waypoints 시퀀스 안 어디인지 찾고 shift 개수를 산출.
 *
 * 정책:
 *   - waypoints[0] 일치: 현재 다음 hop 도달 → 1 hop advance
 *   - waypoints[1] 일치: 1 hop 앞서감 (cron이 한 사이클 늦었음) → 2 hop catch-up advance
 *   - waypoints[k≥2] 일치: k hop catch-up advance (긴 음영 후 재진입 케이스)
 *   - 미일치: 사용자가 진행 방향 뒤에 있거나 다른 트립 → no-op (lock 보존)
 *
 * "사용자 뒤 1 hop은 grace 1 cycle 후 advance"는 Seam E가 아닌 cron의 자연 추적이 담당 —
 * 본 endpoint는 GPS-확신 신호만 받아 진행 정정에 집중 (역방향 advance 안 함).
 */
export function computeLockSyncAdvance(
  waypoints: Trip['waypoints'],
  observedStationName: string,
): { shiftedCount: number } {
  const idx = waypoints.findIndex((w) => w.stationName === observedStationName);
  if (idx < 0) return { shiftedCount: 0 };
  return { shiftedCount: idx + 1 };
}

/**
 * Seam E의 advance도 progress KV에 mirror — POST /trips 재등록 race에서 shift 진행분 보존.
 * lock(trainCode) 없는 trip은 progress 자체가 의미 없어 no-op (scheduled.ts mirrorProgress와 동형).
 */
async function maybeMirrorLockSyncProgress(
  kv: KVNamespace,
  trip: Trip,
  shiftedDelta: number,
): Promise<void> {
  const trainCode = trip.boardingLock?.trainCode;
  if (!trainCode) return;
  const existing = await getProgress(kv, trip.token);
  const prevShifted = existing?.trainCode === trainCode ? existing.shiftedCount : 0;
  const next: TripProgress = {
    trainCode,
    shiftedCount: prevShifted + shiftedDelta,
    lastTrackedArrivalEpoch: trip.lastTrackedArrivalEpoch,
    lastLaPushEpoch: trip.lastLaPushEpoch,
    // #900 Seam D — heartbeat wall-clock도 mirror해 POST /trips race 후에도 보존.
    lastLaPushAt: trip.lastLaPushAt,
    consecutiveEtaMissing: trip.consecutiveEtaMissing,
  };
  const ttlSec = Math.max(60, Math.floor((trip.expiresAt - Date.now()) / 1000));
  await putProgress(kv, trip.token, next, ttlSec);
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
    // #900 Seam D — heartbeat wall-clock도 progress가 SSOT.
    lastLaPushAt: progress.lastLaPushAt,
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

  // #1193 — incoming waypoints 전체에 대해 occurrenceIdx를 1-pass로 stamp.
  // 같은 stationName이 중복 등장(순환선/회차)할 때 클라이언트의 `:n` suffix identifier 규약과 일치하도록
  // 0-based 인덱스를 부여. waypoint shift 진행 후에도 값은 불변 — reschedule push 시점까지 일관.
  // 클라이언트가 이미 occurrenceIdx를 보내준 경우는 그대로 신뢰 (round-trip 안정).
  const occurrenceCount = new Map<string, number>();
  const stampedWaypoints = (obj.waypoints as Array<Record<string, unknown>>).map((wp) => {
    const stationName = wp.stationName as string;
    const occIdx = occurrenceCount.get(stationName) ?? 0;
    occurrenceCount.set(stationName, occIdx + 1);
    const existing =
      typeof wp.occurrenceIdx === 'number' &&
      Number.isInteger(wp.occurrenceIdx) &&
      wp.occurrenceIdx >= 0
        ? wp.occurrenceIdx
        : occIdx;
    return { ...wp, occurrenceIdx: existing } as Trip['waypoints'][number];
  });

  return {
    token: obj.token,
    route: obj.route as Trip['route'],
    destination: obj.destination,
    waypoints: stampedWaypoints,
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
    // #903 (Seam G): 클라이언트 기압계가 보고한 지하 진입 신호. 미송신/비boolean이면 undefined(default OFF).
    // scheduled.ts가 이 값으로 consecutiveEtaMissing threshold(5 vs 10)를 분기한다.
    subsurface: typeof obj.subsurface === 'boolean' ? obj.subsurface : undefined,
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
    // #916 follow-up A: server-set 마커. client는 절대 송신하지 않지만 incoming 본문에 어떤 이유로
    // 같이 echo돼도 보존한다 (drop하면 서버 set lock 표시가 사라져 보존 분기가 무력화됨).
    ...(typeof o.autoLockedAt === 'number' ? { autoLockedAt: o.autoLockedAt } : {}),
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
    // #972 — low-recall trip ratio 임계 위반 시 운영 webhook 발사. dedup KV(1h)로 spam 차단.
    // binding/secret 미설정 환경에서는 graceful no-op이라 회귀 없음.
    await evaluateAndMaybeAlert(env, { fetchImpl: fetch, now: () => Date.now(), log });
    // #1080 follow-up — feedback 일일 통계 집계. 매분 cron이지만 함수가 자체적으로
    // 00:05 UTC 1분 윈도우만 동작 + 같은 날짜 키 존재 시 skip(idempotent). FEEDBACK binding
    // 부재 시 graceful no-op.
    if (env.FEEDBACK) {
      const result = await maybeRunDailyFeedbackStats(env.FEEDBACK, Date.now());
      if (result.ran) {
        log('feedback daily stats aggregated', { date: result.date });
      }
    }
  },
};
