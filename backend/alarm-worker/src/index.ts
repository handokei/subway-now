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
import { isNearOrigin, markPromptSilenced } from './boardingPrompt';
import {
  recordBoardingPromptOutcome,
  validateBoardingPromptOutcome,
} from './boardingPromptOutcome';
import { stampPushActivity } from './cronIdleGate';
import { runFallbackPushes } from './fallback';
import { runRetryPushes } from './retryPushes';
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
import { ackPending, stampReceived } from './pendingPushes';
import { computePushAckStats } from './pushAckStats';
import { computeAlarmLogStats } from './alarmLogStats';
import { computeBaselineCheck } from './baselineCheck';
import {
  ARCH_FLAG_DEFAULT,
  type ArchFlagValue,
  getArchFlag,
  isArchFlagValue,
  setArchFlag,
} from './archFlag';
import {
  getKillSwitch,
  isKillSwitchKey,
  isKillSwitchValue,
  KILL_SWITCH_DEFAULT,
  setKillSwitch,
} from './killSwitch';
import { getTripDoFlag, TRIP_DO_FLAG_DEFAULT } from './tripDoFlag';
import { appendPositionPoint } from './positionSeries';
import { appendAccelSample, isAccelSummary } from './accelSeries';
import { updateSsotMotion } from './motionState';
import { writeMetric } from './analytics';
import { deleteProgress, getProgress, putProgress, type TripProgress } from './progress';
import { SeoulArrivalClient } from './seoul';
import { runScheduled, toSilentPushSsot } from './scheduled';
import * as Sentry from '@sentry/cloudflare';
import {
  addValidateRejectBreadcrumb,
  captureBackendException,
  sentryInit,
  sentryOptions,
} from './sentry';
import {
  recordRecallUpload,
  validateRecallUpload,
} from './recallTelemetry';
import {
  MAX_DUMP_ENTRIES,
  readSignalDump,
  storeSignalDump,
  validateSignalDumpUpload,
} from './rawSignalDump';
import {
  storeAlarmLogForward,
  validateAlarmLogForward,
} from './alarmLogForward';
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
import {
  KNOWN_REGRESSION_IDS,
  incrementRegressionCounters,
  readRegressionCounters,
  validateRegressionUpload,
  writeRegressionDataPoints,
} from './regressionTelemetry';
import { CRON_READ_CACHE_TTL_SEC, KV_MIN_CACHE_TTL_SEC } from './kvConsistency';
import { deleteSsot, readSsot } from './tripPositionSsot';
import {
  computeObservabilityMetrics,
  readLastSuccessfulMetrics,
  readObservabilityMetrics,
  tryStoreObservabilityMetrics,
} from './observabilityMetrics';
import {
  accumulateBoardingPromptCounters,
  readBoardingPromptCounters,
} from './boardingPromptCounterAccumulator';
import {
  getDeviceTripIndex,
  getTrip,
  putDeviceTripIndex,
  putTrip,
  resetTripStateForNewRoute,
  withTripRegisterLock,
} from './trips';
import { inferWaypointsFromOriginAndDestination } from './dijkstraRoute';
import { checkTripRegisterRateLimit } from './tripRegisterRateLimit';
import {
  TRIP_STATUS_RETENTION_MS,
  readTripEndedStatus,
  deleteTripEndedStatus,
} from './tripStatus';
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
 * #1578 — Sentry init 미들웨어. DSN 미설정 시 graceful no-op (idempotent).
 */
app.use('*', async (c, next) => {
  sentryInit(c.env);
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
 * #1614 Phase D — silent push 도달률 측정 RCA (S4 #1537).
 *
 * `pendingPushes.ts`의 `received:<pushId>` stamp(1h TTL) 와 `pending:<pushId>` (60s TTL) 를
 * scan해 1시간 윈도우 분포 산출. 도달률 = received / sent (sent는 별도 stats catalog에서).
 *
 * Auth: `Authorization: Bearer <ADMIN_TOKEN>` 필수 — admin 공통 정책.
 * Query: `?limit=N` (default 500, KV cost 보호).
 *
 * Response 200: { windowStart, windowEnd, pending, received, receivedByPhase, receivedByStation, receivedByPermissionMode }
 * Response 401/503: 인증/binding 정책은 /admin/feedback과 동일.
 */
app.get('/admin/push-ack-stats', async (c) => {
  const authError = checkAdminAuth(c.req.header('authorization'), c.env.ADMIN_TOKEN);
  if (authError) return c.json({ error: authError.code }, authError.status);
  // #1700 fix — write 대상(pendingPushes.ts:stampReceived)이 PENDING_PUSHES이므로
  // scan 대상도 동일 namespace여야 한다. 이전엔 TRIPS scan으로 항상 0건 반환.
  const kv = c.env.PENDING_PUSHES;
  if (!kv) return c.json({ error: 'pending_pushes_unavailable' }, 503);
  const limit = parseQueryNumber(c.req.query('limit'));
  // #1928 F-E4 — kv.list / kv.get / JSON parse throw 시 Hono error handler가
  // Cloudflare 1101 HTML response 반환하던 회귀 차단. 503 JSON으로 호출자 graceful
  // 처리 보장. observability/metrics handler(index.ts:1129~) 패턴과 정합.
  try {
    const stats = await computePushAckStats(kv, Date.now(), limit);
    return c.json(stats);
  } catch (err) {
    void captureBackendException(c.env, err, { path: 'admin/push-ack-stats' });
    return c.json({ error: 'push_ack_stats_failed' }, 503);
  }
});

/**
 * #1621 Phase A — Device R2 archive alarmLog 분포 RCA endpoint.
 *
 * `alarmLogForward.ts:storeAlarmLogForward`가 trip 종료 시 archive한 `trip-evidence/`
 * R2 object를 windowHours(default 1, max 24) 윈도우로 scan해 reason/source 분포 산출.
 * 사용자 trip 1건이 종료되면 다음 호출에서 즉시 분포 노출 — baseline 측정 자동화.
 *
 * Auth: `Authorization: Bearer <ADMIN_TOKEN>` — admin 공통 정책.
 * Query:
 *   - `?windowHours=N` (default 1, clamp 1~24)
 *   - `?limit=N` (default 50, max 500 — R2 cost 보호)
 *
 * Response 200: { windowStart, windowEnd, totalEvents, fired, suppressed, received,
 *                 reasons, sources, tripsScanned }
 * Response 401/503: 인증/binding 정책 동일 (TELEMETRY_R2 미바인딩 시 503 graceful).
 */
app.get('/admin/alarm-log-stats', async (c) => {
  const authError = checkAdminAuth(c.req.header('authorization'), c.env.ADMIN_TOKEN);
  if (authError) return c.json({ error: authError.code }, authError.status);
  const r2 = c.env.TELEMETRY_R2;
  if (!r2) return c.json({ error: 'telemetry_r2_unavailable' }, 503);
  const windowHours = parseQueryNumber(c.req.query('windowHours')) ?? 1;
  const limit = parseQueryNumber(c.req.query('limit')) ?? 50;
  const stats = await computeAlarmLogStats(r2, Date.now(), windowHours, limit);
  return c.json(stats);
});

/**
 * #1621 Phase C — Baseline 작동 verify endpoint.
 *
 * 사용자 framework: 측정 기본 만들어 놓고 측정. 사용자 1 trip 시 즉시 baseline 작동
 * (silent push 발사 + V1 mismatch 0) pass/fail 산출. V1 회복(Stage 1/2/3) 효과를
 * 사용자 trip 1건이면 바로 검증 가능.
 *
 * Auth: `Authorization: Bearer <ADMIN_TOKEN>` — admin 공통 정책.
 * Query: `?tripToken=<X>` — 필수 (활성 trip 신호 source).
 *
 * Response 200: { baseline: 'pass' | 'fail', signals: {
 *   tripActive, silentPushFired, silentPushReceived, v1Mismatch
 * }}
 * Response 400: { error: 'invalid_trip_token' } — tripToken 누락
 * Response 401/503: 인증/binding 정책 동일 (TRIPS 또는 TELEMETRY_R2 미바인딩 시 503).
 */
app.get('/admin/baseline-check', async (c) => {
  const authError = checkAdminAuth(c.req.header('authorization'), c.env.ADMIN_TOKEN);
  if (authError) return c.json({ error: authError.code }, authError.status);
  const tripToken = c.req.query('tripToken');
  if (!tripToken || tripToken.length === 0) {
    return c.json({ error: 'invalid_trip_token' }, 400);
  }
  const kv = c.env.TRIPS;
  if (!kv) return c.json({ error: 'trips_unavailable' }, 503);
  const r2 = c.env.TELEMETRY_R2;
  if (!r2) return c.json({ error: 'telemetry_r2_unavailable' }, 503);
  const result = await computeBaselineCheck(kv, r2, tripToken, Date.now());
  return c.json(result);
});

/**
 * #1982 (ADR-022 Phase 0) — Arrival API SSOT 아키텍처 Feature Flag 조회 endpoint.
 *
 * Phase 0 시점의 flag 값은 어떤 동작도 바꾸지 않는다(dormant). Phase 1 이후 caller 가
 * 결과 값을 새/구 아키텍처 분기 조건으로 사용한다. 본 endpoint 는 device DebugModal /
 * 운영자 진단에서 현재 KV 상태를 조회하는 read-only 창구.
 *
 * Auth: `Authorization: Bearer <ADMIN_TOKEN>` — admin 공통 정책.
 * Response 200: `{ value: 'on' | 'off' }`
 * Response 401/503: 인증/binding 정책 동일 (TRIPS 미바인딩 시 503).
 */
app.get('/admin/arch-flag', async (c) => {
  const authError = checkAdminAuth(c.req.header('authorization'), c.env.ADMIN_TOKEN);
  if (authError) return c.json({ error: authError.code }, authError.status);
  const kv = c.env.TRIPS;
  if (!kv) return c.json({ error: 'trips_unavailable' }, 503);
  const value = await getArchFlag(kv);
  return c.json({ value });
});

/**
 * #1982 (ADR-022 Phase 0) — Arrival API SSOT 아키텍처 Feature Flag 설정 endpoint.
 *
 * Rollback 채널: `on` 상태에서 회귀 발견 시 `off` write 만으로 즉시 되돌린다(배포 없음).
 * 유효 값은 `on` / `off` 만. 그 외 body 는 400 으로 거절 — 잘못된 KV 진입 차단.
 *
 * Auth: `Authorization: Bearer <ADMIN_TOKEN>` — admin 공통 정책.
 * Body: `{ value: 'on' | 'off' }`
 * Response 200: `{ value: 'on' | 'off' }`
 * Response 400: `{ error: 'invalid_body' }` — body 파싱 실패 / 유효하지 않은 value.
 * Response 401/503: 인증/binding 정책 동일.
 */
app.post('/admin/arch-flag', async (c) => {
  const authError = checkAdminAuth(c.req.header('authorization'), c.env.ADMIN_TOKEN);
  if (authError) return c.json({ error: authError.code }, authError.status);
  const kv = c.env.TRIPS;
  if (!kv) return c.json({ error: 'trips_unavailable' }, 503);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_body' }, 400);
  }
  const raw = (body as { value?: unknown } | null)?.value;
  if (!isArchFlagValue(raw)) {
    return c.json({ error: 'invalid_body' }, 400);
  }
  await setArchFlag(kv, raw);
  return c.json({ value: raw });
});

/**
 * #1967 (Ff-1) — 게이트 kill switch 조회 endpoint.
 *
 * 2026-06-28 Wave 1-4 audit: lockless intermediate 게이트가 kill switch 없이 머지돼
 * device 측 false alarm 회귀가 감지돼도 backend deploy(10~30분) 없이는 즉시 차단 수단이
 * 없었다. `archFlag` 와 동일한 KV read/write 어댑터 패턴 — `key` 쿼리로 대상 게이트 선택.
 *
 * Auth: `Authorization: Bearer <ADMIN_TOKEN>` — admin 공통 정책.
 * Query: `key` — 현재 유효값은 `lockless_intermediate` 하나(#1967 스코프 = Ff-1).
 * Response 200: `{ key, value: 'true' | 'false' }`
 * Response 400: `{ error: 'invalid_key' }` — key 누락/미지원.
 * Response 401/503: 인증/binding 정책 동일 (TRIPS 미바인딩 시 503).
 */
app.get('/admin/kill-switch', async (c) => {
  const authError = checkAdminAuth(c.req.header('authorization'), c.env.ADMIN_TOKEN);
  if (authError) return c.json({ error: authError.code }, authError.status);
  const key = c.req.query('key');
  if (!isKillSwitchKey(key)) {
    return c.json({ error: 'invalid_key' }, 400);
  }
  const kv = c.env.TRIPS;
  if (!kv) return c.json({ error: 'trips_unavailable' }, 503);
  const value = await getKillSwitch(kv, key);
  return c.json({ key, value });
});

/**
 * #1967 (Ff-1) — 게이트 kill switch 설정 endpoint.
 *
 * Rollback 채널: `true` 상태에서 회귀 대응이 끝나면 `false` write 만으로 즉시 게이트를
 * 되살린다(배포 없음). 유효 값은 `true` / `false` 만. 그 외 body 는 400 으로 거절.
 *
 * Auth: `Authorization: Bearer <ADMIN_TOKEN>` — admin 공통 정책.
 * Query: `key` — 현재 유효값은 `lockless_intermediate` 하나.
 * Body: `{ value: 'true' | 'false' }`
 * Response 200: `{ key, value: 'true' | 'false' }`
 * Response 400: `{ error: 'invalid_key' }` | `{ error: 'invalid_body' }`
 * Response 401/503: 인증/binding 정책 동일.
 */
app.post('/admin/kill-switch', async (c) => {
  const authError = checkAdminAuth(c.req.header('authorization'), c.env.ADMIN_TOKEN);
  if (authError) return c.json({ error: authError.code }, authError.status);
  const key = c.req.query('key');
  if (!isKillSwitchKey(key)) {
    return c.json({ error: 'invalid_key' }, 400);
  }
  const kv = c.env.TRIPS;
  if (!kv) return c.json({ error: 'trips_unavailable' }, 503);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_body' }, 400);
  }
  const raw = (body as { value?: unknown } | null)?.value;
  if (!isKillSwitchValue(raw)) {
    return c.json({ error: 'invalid_body' }, 400);
  }
  await setKillSwitch(kv, key, raw);
  return c.json({ key, value: raw });
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

/**
 * `POST /trips` dual-write — TripDO shadow seed (#2264, Epic #2260, ADR-031 Phase 1).
 *
 * flag off(default) 또는 `env.TRIP_DO` 미바인딩(개발/테스트 환경)이면 완전 no-op —
 * 기존 KV write 경로는 이 함수 호출 전에 이미 끝나 있으므로 영향 없음.
 *
 * flag on이면:
 *  1. 기존 DO row를 읽어 신규 `trip`과 다르면(divergence) 로그로 관측 — Phase 1은 cron이
 *     여전히 authoritative이므로 여기서는 관측만 하고 fire/판정에 관여하지 않는다.
 *  2. 신규 `trip`을 DO에 seed(shadow write). cron/KV 경로는 이 결과와 무관하게 그대로 진행.
 *
 * DO 호출 실패(네트워크/eviction 등)는 삼켜서 로그만 남긴다 — trip 등록 응답을 절대 차단하지
 * 않는다(archFlag/killSwitch와 동일 graceful 원칙).
 */
export async function dualWriteTripDo(env: Env, trip: Trip): Promise<void> {
  const flag = await getTripDoFlag(env.TRIPS).catch(() => TRIP_DO_FLAG_DEFAULT);
  if (flag !== 'on' || !env.TRIP_DO) return;

  try {
    const id = env.TRIP_DO.idFromName(trip.token);
    const stub = env.TRIP_DO.get(id);

    const priorRes = await stub.fetch(new Request('https://trip-do/trip'));
    const prior = (await priorRes.json()) as { trip: Trip | null };
    if (prior.trip !== null && JSON.stringify(prior.trip) !== JSON.stringify(trip)) {
      console.log(
        JSON.stringify({
          msg: 'trip-do: shadow-compare divergence (#2264)',
          tokenPrefix: tokenPrefix(trip.token),
        }),
      );
    }

    await stub.fetch(
      new Request('https://trip-do/trip', {
        method: 'POST',
        body: JSON.stringify(trip),
      }),
    );
  } catch (e) {
    console.log(
      JSON.stringify({
        msg: 'trip-do: dual-write failed (graceful, #2264)',
        tokenPrefix: tokenPrefix(trip.token),
        error: String(e),
      }),
    );
  }
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

  // #1575 (T12, ADR-017 V8 (b)) — per-token rate limit 10 req / 10 min.
  // Device register loop / cold restart 반복 / FG↔BG 빠른 전환 race로 같은 token이 분당
  // 5~10회 POST되는 사례 차단. Cloudflare Worker quota(100K/day) 보호 + dedup state 안정.
  // 정상 사용자(<10 req/10min)는 영향 없음. checkTripRegisterRateLimit은 fixed-window KV
  // counter — best-effort atomic (KV는 strict atomic 없음). cap 근처에서만 race 가능.
  //
  // #2195 (ADR-025 Decision 3) — update 요청은 create budget에서 면제한다. 판정 = 동일
  // deviceToken(incoming.token)의 기존 trip이 이미 존재하는가. #2194가 신원(rotation)을
  // 폐기해 트립 레코드는 항상 같은 key(`trip:<incoming.token>`)에 in-place로 갱신되므로,
  // 직접 조회 한 번으로 "이 POST가 route 변경 재등록(=update)인지" 판정할 수 있다(신규 UUID
  // 발급이 없어 역인덱스 fallback도 불필요 — #2194 이전 rotation 잔재는 #2175 cooldown bypass
  // 경로가 흡수).
  //
  // create 스팸 방어(Worker quota 보호)는 최초 등록(existing=null)에만 적용해 그대로 유지 —
  // update는 스팸이 아니라 같은 device가 route를 갈아타는 정상 흐름이라 카운터를 소진하지
  // 않는다(2026-08-07 tmsi34imn 실탑승 429 chain-death, ADR-025).
  //
  // client-aborted POST 카운터 선점(점검 항목): 증가는 이 시점(첫 create 시도)에만 발생하고
  // 이후 재-POST는 전부 update 판정으로 아래 분기를 건너뛰므로, 하나의 trip 생애주기 동안
  // 카운터를 소진하는 지점은 최초 create 1회로 줄어든다 — evidence의 다중 429는 매 route
  // 변경이 create로 오분류되던 것이 원인이었고 그 경로가 여기서 제거된다.
  const existingForRateLimit = await getTrip(c.env.TRIPS, incoming.token);
  if (existingForRateLimit === null) {
    const rateLimit = await checkTripRegisterRateLimit(
      c.env.TRIPS,
      incoming.token,
      Date.now(),
    );
    if (!rateLimit.allowed) {
      console.log(
        JSON.stringify({
          msg: 'trip-register: rate-limited (#1575 T12)',
          tokenPrefix: tokenPrefix(incoming.token),
          count: rateLimit.count,
          retryAfterSeconds: rateLimit.retryAfterSeconds,
        }),
      );
      return c.json(
        { error: 'rate_limited', retryAfterSeconds: rateLimit.retryAfterSeconds },
        429,
        { 'Retry-After': String(rateLimit.retryAfterSeconds) },
      );
    }
  }

  // #1604 — Route 미설정 trip(legacy collapse: waypoints=[destination only])에 대한 backend
  // Dijkstra 자동 추론. device가 currentStation 없이 trip을 시작하면 `routeToWaypoints`가
  // `[destination]`만 반환해 backend cron이 첫 waypoint=destination을 무한 폴링 → 매역 push 누락
  // → 16분 후 trip auto-end (RCA in issue body).
  //
  // 본 게이트는 `promptDisplay`(originStation + line)와 `destination`(station id) 둘 다 있을 때만
  // 동작 — 두 정보로 Dijkstra가 currentStation → destination 사이 경로를 자동 산출해 device의 정상
  // routeToWaypoints와 동일 시퀀스를 만든다. 산출 실패(미해소/동일역/도달 불가)는 incoming 그대로
  // 유지(backward-compat) — 기존 trip 동작 무변경. S1 #1534(lockSuggestion backend infer)와 같은
  // "backend = decider" 정신.
  //
  // Wire-completion: device-side는 `useApnsTripRegistration` 변경 X — 같은 endpoint로 register
  // 후 다음 cron 사이클부터 정상 waypoints로 추적된다 (revalidate-route-sig-mismatch 0건).
  if (
    incoming.waypoints.length === 1 &&
    incoming.waypoints[0].kind === 'destination' &&
    incoming.promptDisplay !== undefined
  ) {
    const inferred = inferWaypointsFromOriginAndDestination({
      originName: incoming.promptDisplay.originStation,
      originLine: incoming.promptDisplay.line,
      destinationId: incoming.destination,
      destinationName: incoming.waypoints[0].stationName,
    });
    if (inferred !== null && inferred.length > 0) {
      // occurrenceIdx 재stamp — `validateTrip`(types.ts:1723~) 규약과 동일. 중복 stationName
      // (순환선/회차)에 정확한 :n suffix 매칭을 위해 sequence 1-pass로 stamp.
      const occurrenceCount = new Map<string, number>();
      const stamped = inferred.map((wp, idx) => {
        const occIdx = occurrenceCount.get(wp.stationName) ?? 0;
        occurrenceCount.set(wp.stationName, occIdx + 1);
        return { ...wp, occurrenceIdx: occIdx, hopIndex: idx };
      });
      console.log(
        JSON.stringify({
          msg: 'trip-register: backend Dijkstra inferred waypoints (#1604)',
          tokenPrefix: tokenPrefix(incoming.token),
          origin: incoming.promptDisplay.originStation,
          originLine: incoming.promptDisplay.line,
          destinationId: incoming.destination,
          inferredCount: stamped.length,
          transferCount: stamped.filter((w) => w.kind === 'transfer').length,
        }),
      );
      incoming.waypoints = stamped;
    } else {
      console.log(
        JSON.stringify({
          msg: 'trip-register: backend Dijkstra infer skipped (no resolution)',
          tokenPrefix: tokenPrefix(incoming.token),
          origin: incoming.promptDisplay.originStation,
          originLine: incoming.promptDisplay.line,
          destinationId: incoming.destination,
        }),
      );
    }
  }

  // #1366 Layer 3 — incoming boardingLock metadata cross-validation.
  // Frontend가 환승 hop 진입 시 store 업데이트 race로 trainCode/line(새 leg) +
  // segmentStations(이전 leg) 조합의 stale metadata를 전송하면 cron에서
  // "trainCode not found in arrivals" 회귀 → consecutiveEtaMissing 누적 → trip auto-end.
  // waypoint와의 (line, stationName) 일치를 검사해 불일치하면 boardingLock 필드만 drop —
  // trip 본체는 그대로 받아 backend는 기존 anchor waypoint 폴링으로 fallback.
  if (
    incoming.boardingLock &&
    !isBoardingLockConsistentWithWaypoints(incoming.boardingLock, incoming.waypoints)
  ) {
    console.log(
      JSON.stringify({
        msg: 'boarding-lock: rejected (stale metadata, line/segment mismatch)',
        tokenPrefix: tokenPrefix(incoming.token),
        lockTrainCode: incoming.boardingLock.trainCode,
        lockLine: incoming.boardingLock.line,
        lockFirstSegment: incoming.boardingLock.segmentStations[0],
        waypointLines: incoming.waypoints.map((w) => w.line).slice(0, 4),
      }),
    );
    incoming.boardingLock = undefined;
  }

  // #578/#704: 디바이스가 동일 trip을 반복 POST해도(예: GPS update마다 register, 또는 cold restart
  // 후 같은 trip 재등록) backend가 이미 advance한 waypoints / 추적 baseline을 덮어쓰지 않는다.
  //
  // #704 same-session 판별 (createdAt strict 비교 폐기):
  //   1) boardingLock.trainCode가 양쪽 모두 같으면 같은 세션 (cold restart 후 createdAt이 바뀌어도 OK)
  //   2) trainCode가 한쪽이라도 없으면 createdAt drift 5s 이내일 때만 같은 세션 (lock 등록 전 단계)
  //   3) 그 외 (다른 trainCode 또는 큰 drift) → 새 세션, 전면 교체
  // #1425 — trip-ended retention(1시간) 안에 같은 token 재등록 차단.
  // silent push `trip-ended:eta-missing`(scheduled.ts:878) 후 device가 자동 재시도(또는
  // BG 5h 후 FG 복귀 시 useStateRehydration 보조 trigger)로 같은 token POST하면 기존 코드는
  // `getTrip()` 결과(=null, 이미 삭제됨)만 확인하고 무조건 새 trip으로 처리 → backend auto-revive
  // → dedup state reset → false fire 회귀.
  //
  // 사용자 명시 액션 trip(boardingPrompt 응답 / BoardingTrainList 직접 탭 / 새 목적지)은 client
  // 정책상 새 token으로 생성되므로 영향 없다. 같은 token 재등록 = device race or 자동 재시도 =
  // reject가 정확.
  //
  // `Date.now()` 기준 — device 시계 drift 위험을 피하려면 backend wall clock 사용해야 한다.
  const recentlyEnded = await readTripEndedStatus(c.env.TRIPS, incoming.token);
  if (recentlyEnded && Date.now() - recentlyEnded.endedAt < TRIP_STATUS_RETENTION_MS) {
    // #1663 — Seoul outage로 강제 종료된 trip은 cooldown 면제. 사용자가 재등록하면 즉시 허용.
    // 원래 #1425 cooldown 목적(device race/자동 재시도 차단)과 충돌 없음 — outage false-end는
    // 사용자 명시 재등록이며, 같은 token의 device race가 아니다.
    //
    // #2196 (ADR-025 cleanup) — 'rotated'/'superseded-by-reregister' 면제 분기는 rotation 폐기
    // (#2194)로 두 사유의 발생부 자체가 사라져 제거했다. 남은 legacy KV 엔트리는
    // `readTripEndedStatus`가 unknown value로 null 반환해 이 cooldown 블록 자체를 타지 않는다
    // (아래 `if (recentlyEnded && ...)` 진입 전에 이미 걸러짐) — 별도 회귀 없이 동등하게 degrade.
    if (recentlyEnded.endReason === 'seoul-outage') {
      console.log(
        JSON.stringify({
          msg: 'trip-recently-ended: bypass cooldown (#1663)',
          tokenPrefix: tokenPrefix(incoming.token),
          endedAt: recentlyEnded.endedAt,
          endReason: recentlyEnded.endReason,
          ageMs: Date.now() - recentlyEnded.endedAt,
        }),
      );
      // cooldown skip — 아래 getTrip / isSameSession 경로로 정상 진행
    } else {
      console.log(
        JSON.stringify({
          msg: 'trip-recently-ended: reject re-register (#1425)',
          tokenPrefix: tokenPrefix(incoming.token),
          endedAt: recentlyEnded.endedAt,
          endReason: recentlyEnded.endReason,
          ageMs: Date.now() - recentlyEnded.endedAt,
        }),
      );
      return c.json(
        { error: 'trip-recently-ended', reason: recentlyEnded.endReason },
        400,
      );
    }
  }

  // #2129 — per-token in-flight 직렬화. `getTrip → resetTripStateForNewRoute → putTrip` 사이
  // TOCTOU window에서 같은 token의 동시 POST가 interleave하면 유령 trip이 KV에 중복 생존하는
  // 회귀(2026-08-04 실탑승 evidence)가 발생한다. ADR-025(#2194) 하에서도 신원은 불변이지만
  // 이 구간을 여전히 원본 incoming token 기준으로 직렬화 — 같은 device의 두 요청이 반드시 같은
  // 큐에서 대기해 read-reset-write 사이클이 겹치지 않게 한다.
  const registerLockToken = incoming.token;
  const { trip, isSameSession } = await withTripRegisterLock(
    registerLockToken,
    async () => {
      const directExisting = await getTrip(c.env.TRIPS, incoming.token);

      // #2196 (ADR-025 cleanup) — deviceToken 역인덱스 register-time fallback을 제거했다.
      // ADR-025(#2194) 하에서 `incoming.deviceToken`은 항상 `incoming.token`과 같은 값으로
      // 고정되고(`validateTrip`), 역인덱스도 항상 자기 자신(같은 token)을 가리킨다(#2175 describe
      // block, index.test.ts "ADR-025 이후 항상 자기 자신을 가리킴"). 즉 `directExisting===null`이면
      // 역인덱스 조회도 구조적으로 같은 miss만 재확인할 뿐 — 로테이션이 있던 시절(trip.token이
      // UUID로 갈라짐)에만 의미가 있던 트립-단위 소비자였다. 역인덱스 자체(쓰기 + GET/DELETE
      // 핸들러의 legacy 조회)는 APNs token refresh 복구 용도로 그대로 존치한다(ADR-025 Consequences).
      //
      // ADR-025 (#2194) — route 변경 시 in-place reset. trip 신원(`incoming.token`, 트립 수명
      // 동안 불변)은 유지한 채, route sig(`computeRouteSignature`)가 달라지면 구 route의 잔재
      // pending push만 제거(helper 내부 `cleanupPendingPushesForToken`)하고 downstream이
      // `existing=null`로 세션을 새로 취급(dedup/notification state 리셋)하도록 한다.
      //
      // archFlag=off (default): helper 는 `{ existing: directExisting, reset: false }` no-op
      // 반환 → 기존 동작 100% 유지 (Phase 1-3 dormant).
      //
      // ADR-022 B4의 token rotation(`rotateTripTokenForNewRoute`, 새 UUID 발급 + `trip:<oldToken>`
      // delete)은 폐기됐다 — 신원 churn이 rate-limit/역인덱스/dedup 키 전체를 sync 대상으로 만들어
      // 실패 표면을 늘렸다(2026-08-07 실탑승 tmsi34imn RCA, ADR-025). `trip:<incoming.token>`
      // 레코드는 항상 같은 key로 `putTrip`이 그 자리에서 갱신한다.
      //
      // 오늘 evidence(2026-07-03): 사용자 중곡→성수 trip 시작 시 이전 trip(중곡→용마산) 잔재
      // pending push 가 계속 발사돼 `08:37:25 bg fired station-passed 성수` 관측. route reset이
      // helper 의 `cleanupPendingPushesForToken` 을 실제 호출해 잔재 pending 제거.
      const routeReset = await resetTripStateForNewRoute(c.env.TRIPS, incoming, directExisting);
      if (routeReset.reset) {
        console.log(
          JSON.stringify({
            msg: 'trip-register: route reset in-place (ADR-025, #2194)',
            tokenPrefix: tokenPrefix(incoming.token),
          }),
        );
      }
      const existing = routeReset.existing;
      const isSameSession = existing !== null && evaluateSameSession(existing, incoming);
    // #916 follow-up B — auto-prompt dedup 마커 보존. isSameSession=true(같은 trip 재등록)인 경우만
    // window 안이면 보존한다. 사용자가 lock 클리어 후 같은 trip context로 재등록하는 케이스에서
    // 중복 prompt 재발사를 차단 (fired+clear 분기 회복).
    //
    // #1886 RC-2 옵션 D — trip-scoped dedup reset.
    // isSameSession=false(새 trip 등록: 다른 경로/목적지)는 lastAutoPromptedAt을 보존하지 않는다.
    // T1→T2 연속 trip에서 T1의 dedup이 T2로 carry-over하던 회귀 차단.
    // 윈도우 만료/필드 부재면 undefined로 자연 리셋.
    const preservedLastAutoPromptedAt =
      isSameSession &&
      existing?.lastAutoPromptedAt !== undefined &&
      incoming.createdAt - existing.lastAutoPromptedAt < AUTO_PROMPT_DEDUP_WINDOW_MS
        ? existing.lastAutoPromptedAt
        : undefined;
    // #705: progress KV 우선 참조. 같은 trainCode면 shift된 waypoints를 incoming에 적용.
    // 다른 trainCode/none이면 progress 폐기.
    // #1285: lockless opt-in trip(boardingLock 없음 + infoModeEnabled===true)은
    // token 기준 lockless progress로 보존 — trainCode 없이 lockless===true 마커로 매칭.
    const progress = existing !== null ? await getProgress(c.env.TRIPS, incoming.token) : null;
    const progressApplies =
      progress !== null &&
      ((incoming.boardingLock !== undefined &&
        progress.trainCode === incoming.boardingLock.trainCode) ||
        (progress.lockless === true && incoming.infoModeEnabled === true));
    if (progress !== null && !progressApplies) {
      await deleteProgress(c.env.TRIPS, incoming.token);
    }
    const baseTrip = isSameSession
      ? {
          ...incoming,
          waypoints: existing.waypoints,
          lastFiredPhase: existing.lastFiredPhase,
          // #1367 — cross-station dedup marker는 token 단위로 보존돼야 같은 trip 재등록 race에서
          // 윈도우 안 fire가 다시 통과하지 않는다.
          lastFiredStation: existing.lastFiredStation,
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
          // #2153 — 신선도 게이트 anchor도 backend-only state. re-register마다 incoming(항상
          // undefined — device가 보내지 않는 필드)으로 덮이면 매 재등록마다 anchor가 사라져
          // createdAt fallback으로 되돌아가는 회귀가 생긴다. same session이면 그대로 보존.
          originProximityAt: existing.originProximityAt,
        }
      : {
          ...incoming,
          // #916 follow-up B — 새 세션(createdAt drift > 5s)으로 판정돼 incoming으로 전면 교체되더라도
          // 같은 token + window 안이면 auto-prompt dedup 마커는 보존. backend가 직전에 auto-lock 시도/
          // 발사한 trip 컨텍스트의 재발사 ping-pong을 차단한다.
          lastAutoPromptedAt: preservedLastAutoPromptedAt,
          // #1370 L1 — corrected apnsEnv 보존. 같은 token = 같은 디바이스 = 같은 APNs env이므로
          // session 경계(환승 후 새 trainCode 등)와 무관하게 self-heal로 정정된 env가 유지돼야 한다.
          // 보존 안 하면 새 session 첫 push마다 mismatch retry가 반복돼 첫 push latency + 일부 drop 위험
          // (#1370 evidence: 환승 후 7호선 매역 silent push 손실).
          // existing 부재(brand-new token) 또는 existing.apnsEnv 부재(legacy trip)면 incoming 값으로 자연 fallback.
          apnsEnv: existing?.apnsEnv ?? incoming.apnsEnv,
        };

    // #705 — progress KV가 우선. 같은 trainCode면 incoming.waypoints에서 shift된 만큼 잘라낸다.
    // existing trip이 사라졌더라도(KV TTL 만료 등) progress가 살아 있으면 진행분을 그대로 복원.
    const trip = progressApplies
      ? applyProgress(baseTrip, incoming, progress)
      : baseTrip;

      await putTrip(c.env.TRIPS, trip);

      // #2175 — deviceToken 역인덱스를 이번에 확정된 trip.token으로 갱신. ADR-025(#2194) 하에서
      // 신원=deviceToken이라 이 값은 항상 trip.token 자기 자신을 가리키지만(#2196), APNs token
      // refresh로 deviceToken 자체가 바뀌는 드문 이벤트를 GET/DELETE 핸들러가 복구할 수 있도록
      // 역인덱스는 그대로 존치·갱신한다. deviceToken이 없는(손상 payload) 경우는 기록하지 않는다.
      if (trip.deviceToken !== undefined) {
        await putDeviceTripIndex(c.env.TRIPS, trip.deviceToken, trip.token, trip.expiresAt);
      }

      return { trip, isSameSession };
    },
  );

  // #2144 — register 성공(putTrip 완료) 후 같은 token의 옛 tripStatus 종료 마커를 정리한다.
  // 위 cooldown 판정(#1425 reject / #1663 seoul-outage bypass)이 이미 끝난 뒤라 cooldown 의미는
  // 보존된다. 정리하지 않으면 새 trip이 활성 중에도 옛 endedAt 기록이 TTL까지 KV에 남아
  // 진단 혼선(활성 trip + '종료됨' 기록 공존)을 유발한다. KV delete 실패는 graceful —
  // register 응답을 차단하지 않는다.
  if (recentlyEnded !== null) {
    try {
      await deleteTripEndedStatus(c.env.TRIPS, registerLockToken);
    } catch (e) {
      console.log(
        JSON.stringify({
          msg: 'trip-status delete on register success failed (#2144)',
          tokenPrefix: tokenPrefix(registerLockToken),
          error: String(e),
        }),
      );
    }
  }

  // #1701 — 새 세션 분기에서는 SSoT mirror도 강제 cleanup. cleanupTripWithLa가 이미 4 종료
  // 경로에서 deleteSsot를 호출하지만, 종료 후 KV TTL 자연 만료를 기다리는 동안 같은 token으로
  // 새 trip이 등록되거나, cleanup 호출 자체가 race로 누락된 경우(예: trip TTL 만료 → cron이
  // 그냥 skip → trip + SSoT 둘 다 KV에 남음 → 새 POST /trips가 SSoT 살아있는 상태에서 등록)에
  // 옛 stationName이 device로 forward되는 회귀가 발생한다. 새 세션 판정 시 SSoT 즉시 reset해
  // 후속 lazy-seed가 새 waypoint.stationName으로 정착되도록 강제한다.
  // KV delete 실패 graceful — putTrip 성공이 우선이며 trip 등록을 차단하지 않는다.
  if (!isSameSession) {
    try {
      await deleteSsot(c.env.TRIPS, incoming.token);
    } catch (e) {
      console.log(
        JSON.stringify({
          msg: 'ssot delete on new session failed (#1701)',
          tokenPrefix: tokenPrefix(incoming.token),
          error: String(e),
        }),
      );
    }
  }

  // P0-1 (#1577) — Site 6 of 6: trip-mutation 적재 (V8b /trips rate 검증).
  writeMetric(c.env, {
    eventType: 'trip-mutation',
    tripToken: trip.token,
    reason: trip.boardingLock ? 'lock-active' : 'lockless',
    hopIndex: trip.waypoints[0]?.hopIndex,
  });

  // #2264 (Epic #2260, ADR-031 Phase 1) — TripDO shadow dual-write. flag off(default)면
  // no-op. KV write(putTrip)는 이미 위에서 완료됐으므로 실패해도 trip 등록에 영향 없다.
  await dualWriteTripDo(c.env, trip);

  // #1897 (RC-5) — KV에 박힌 권위 apnsEnv 를 device로 echo. device 는 이를 stamp 해 다음
  // register 시 build env 대신 송신 → backend self-heal(envCorrected) 발동을 0에 수렴.
  // existing.apnsEnv 가 corrected 된 경우(#1370 L1) 그 값이 그대로 device 로 전달된다.
  // 구 device는 응답에서 본 필드를 무시 (backward-compatible).
  return c.json({
    ok: true,
    token: trip.token,
    confirmedEnv: trip.apnsEnv ?? 'sandbox',
  });
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
 * 회귀 카운터 텔레메트리 upload (#1261, Epic #1204 그룹 0).
 *
 * 클라이언트가 trip 종료 시 누적된 회귀 8/10/11/12 발생 수를 보고한다.
 * 5분 sliding window + 일별 KV 카운터에 적재 + AE binding 있으면 datapoint write.
 * Trip 존재 여부 확인 안 함 — trip 만료 케이스에도 telemetry 보존(데이터 완전성).
 */
app.post('/telemetry/regression', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const payload = validateRegressionUpload(body);
  if (!payload) return c.json({ error: 'invalid_payload' }, 400);

  await incrementRegressionCounters(c.env.TRIPS, Date.now(), payload.counts);

  const writer = c.env.TELEMETRY;
  if (writer) {
    writeRegressionDataPoints(writer, payload);
  }
  console.log(
    JSON.stringify({
      msg: 'regression uploaded',
      tokenPrefix: tokenPrefix(payload.token),
      counts: payload.counts,
      sink: writer ? 'ae' : 'none',
    }),
  );
  return c.json({ ok: true });
});

/**
 * 회귀 카운트 조회 (#1261, Epic #1204 그룹 0).
 *
 * 운영자가 wrangler tail 없이 5분/일/주 추이 확인. DebugModal Regressions 섹션
 * (그룹 0 PR C)도 동일 endpoint 사용 (앱이 ADMIN_TOKEN 소지하는 운영 빌드 한정).
 * 응답은 알려진 모든 id를 포함 (0이어도 키 유지 — 클라이언트 표 안정성).
 *
 * Auth: `Authorization: Bearer <ADMIN_TOKEN>` — `/admin/feedback`, `/admin/quota`와 동일 정책.
 * 운영 지표 시계열을 비인증 노출하지 않기 위함.
 */
app.get('/admin/telemetry/regressions', async (c) => {
  const authError = checkAdminAuth(c.req.header('authorization'), c.env.ADMIN_TOKEN);
  if (authError) return c.json({ error: authError.code }, authError.status);
  const counts = await readRegressionCounters(c.env.TRIPS, Date.now());
  return c.json({ ids: KNOWN_REGRESSION_IDS, counts });
});

/**
 * Device raw signal dump upload (#1520, ADR-015 §10 P5 / PR-B).
 *
 * Trip 종료 시 device가 `useFusedNearestStation` ring buffer(capacity 120)을 한 번 보낸다.
 * KV에 `dump:{corrId}` 키로 60일 TTL 적재 — 운영자가 `/admin/signals/export?corrId=`로 조회.
 *
 * Body: { corrId, token, entries[] }
 *   - corrId: `${epoch ms}-${8 hex}` 형식 (device tripCorrId.ts와 정합)
 *   - token: APNs device token (8자 prefix만 KV에 저장 — PII 보호)
 *   - entries: RawSignalEntry[] (1~500개, schema 검증은 device 책임 — forward compat)
 *
 * Response:
 *   200 { ok: true, accepted: N }      — 정상 적재
 *   400 { error: 'invalid_json' | 'invalid_payload' }
 *   503 { error: 'raw_signals_unavailable' } — RAW_SIGNALS binding 미설정 (개발 환경 호환)
 *
 * Idempotency: 같은 corrId 재호출은 덮어쓰기 — device가 outbox flush로 retry해도
 *   server side에서 별도 dedup 불필요 (entries는 동일 trip의 동일 buffer 스냅샷).
 */
app.post('/signals/dump', async (c) => {
  const kv = c.env.RAW_SIGNALS;
  if (!kv) return c.json({ error: 'raw_signals_unavailable' }, 503);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const payload = validateSignalDumpUpload(body);
  if (!payload) return c.json({ error: 'invalid_payload' }, 400);

  try {
    await storeSignalDump(kv, payload, Date.now());
  } catch (err) {
    void captureBackendException(c.env, err, { path: 'signals/dump', corrId: payload.corrId });
    return c.json({ error: 'store_failed' }, 500);
  }

  console.log(
    JSON.stringify({
      msg: 'signal dump stored',
      tokenPrefix: tokenPrefix(payload.token),
      corrId: payload.corrId,
      entries: payload.entries.length,
      maxEntries: MAX_DUMP_ENTRIES,
    }),
  );
  return c.json({ ok: true, accepted: payload.entries.length });
});

/**
 * Device alarmLog telemetry forward (#1579, Phase 0 epic #1576 P0-3).
 *
 * Trip 종료 시 device가 alarmLog 200 + fusionLog 200 + gpsDrops 100 + backendSsotSnapshot +
 * deviceMetadata를 한 번 forward. R2 `trip-evidence/YYYY/MM/DD/{tokenPrefix}-{tripStartedAt}.ndjson`
 * 키로 90일 보관 (lifecycle 룰은 Cloudflare Dashboard에서 운영자가 수동 설정).
 *
 * Body: { token, tripStartedAt, tripEndedAt, alarmLog[], fusionLog[], gpsDrops[],
 *         backendSsotSnapshot, deviceMetadata: { os, appVersion?, locale? } }
 *
 * Response:
 *   200 { ok: true, key, size }
 *   400 { error: 'invalid_json' | 'invalid_payload' }
 *   503 { error: 'telemetry_r2_unavailable' } — TELEMETRY_R2 미바인딩 (개발 환경 호환)
 *
 * Privacy: token은 8자 prefix만 R2 key/customMetadata에 저장 (원문 미저장).
 */
app.post('/telemetry/alarm-log', async (c) => {
  const r2 = c.env.TELEMETRY_R2;
  if (!r2) return c.json({ error: 'telemetry_r2_unavailable' }, 503);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const payload = validateAlarmLogForward(body);
  if (!payload) return c.json({ error: 'invalid_payload' }, 400);

  const { key, size } = await storeAlarmLogForward(r2, payload);

  console.log(
    JSON.stringify({
      msg: 'telemetry-forward-success',
      tokenPrefix: tokenPrefix(payload.token),
      key,
      size,
      tripStartedAt: payload.tripStartedAt,
      durationMs: payload.tripEndedAt - payload.tripStartedAt,
      alarmLog: payload.alarmLog.length,
      fusionLog: payload.fusionLog.length,
      // #1706 — 별 ring 채널. 점령 회귀 측정 baseline.
      fusionTierLog: payload.fusionTierLog.length,
      gpsDrops: payload.gpsDrops.length,
    }),
  );
  return c.json({ ok: true, key, size });
});

/**
 * Raw signal dump export (#1520). 운영자가 corrId로 적재된 dump를 조회한다.
 *
 * Auth: `Authorization: Bearer <ADMIN_TOKEN>` — admin endpoint 공통 정책.
 * Query: `?corrId={cid}` — 필수.
 *
 * Response:
 *   200 { corrId, tokenPrefix, entries[], uploadedAt }
 *   400 { error: 'invalid_corrId' }
 *   404 { error: 'not_found' }
 *   401/503: 인증/binding 정책 동일 (`/admin/feedback` 패턴).
 */
app.get('/admin/signals/export', async (c) => {
  const authError = checkAdminAuth(c.req.header('authorization'), c.env.ADMIN_TOKEN);
  if (authError) return c.json({ error: authError.code }, authError.status);
  const kv = c.env.RAW_SIGNALS;
  if (!kv) return c.json({ error: 'raw_signals_unavailable' }, 503);

  const corrId = c.req.query('corrId');
  if (!corrId) return c.json({ error: 'invalid_corrId' }, 400);

  const stored = await readSignalDump(kv, corrId);
  if (!stored) {
    // invalid pattern과 not-found를 같은 응답으로 구분 — readSignalDump가 pattern 위반 시 null 반환.
    // 호출자(운영자) 입장에서 둘 다 "조회 불가" 동일 의미이므로 404로 정렬.
    return c.json({ error: 'not_found' }, 404);
  }
  return c.json({ corrId, ...stored });
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
 * Observability metrics endpoint (#1752, #1503 M3 Sub 2, #1889 RC-19).
 *
 * DebugModal(Sub 1)이 1h cron이 미리 집계한 4 KPI를 읽어 표시한다.
 * 집계 결과가 없으면(cron 미실행/첫 배포) 실시간으로 계산해 반환하고 KV에 적재.
 *
 * Auth: `Authorization: Bearer <ADMIN_TOKEN>` 필수 — admin 공통 정책.
 * Query: `?window=24h` (현재 24h만 지원 — 추후 확장 가능 구조)
 *
 * Response 200:
 *   { accuracyRatio, silentPushDeliveryRatio, locklessMissRatio, boardableMissRatio, window, timestamp }
 *   stale fallback 시 `X-Stale-Cache: true` + `X-Error: <reason>` header.
 * Response 401/503: 인증/binding 정책 동일 (TELEMETRY_R2 미바인딩 시 503 graceful)
 *
 * #1889 RC-19 — KV day-limit 초과 / compute throw 시 last-success cache로 fail-open.
 *   사용자 dashboard가 "no data" 대신 stale 데이터를 보게 한다. 에러는 Sentry breadcrumb으로
 *   forward되어 silent drop 되지 않는다.
 */
app.get('/v1/observability/metrics', async (c) => {
  const authError = checkAdminAuth(c.req.header('authorization'), c.env.ADMIN_TOKEN);
  if (authError) return c.json({ error: authError.code }, authError.status);
  const r2 = c.env.TELEMETRY_R2;
  if (!r2) return c.json({ error: 'telemetry_r2_unavailable' }, 503);

  const now = Date.now();

  // KV에 최신 1h bucket 집계가 있으면 그대로 반환 — R2 scan + list() 비용 0.
  try {
    const cached = await readObservabilityMetrics(c.env.TRIPS, now);
    if (cached) return c.json(cached);
  } catch (err) {
    // KV read 자체 실패는 day-limit과는 별개. compute로 fallthrough하되 Sentry forward.
    void captureBackendException(c.env, err, { path: 'observability/metrics', stage: 'read-cache' });
  }

  // 첫 요청 또는 KV TTL 만료(1h) 시 실시간 계산 후 KV 적재.
  try {
    const metrics = await computeObservabilityMetrics(
      r2,
      c.env.PENDING_PUSHES,
      now,
      c.env.TRIPS,
      undefined,
      c.env.DB,
    );
    const storeResult = await tryStoreObservabilityMetrics(c.env.TRIPS, metrics, now, {
      onError: (err, key) =>
        void captureBackendException(c.env, err, { path: 'observability/metrics', stage: 'kv-put', key }),
    });
    // storeResult.stored=false라도 metrics 자체는 정상이므로 200 반환. fallback caching만 실패.
    return c.json(metrics, 200, storeResult.stored ? {} : { 'X-Store-Failed': 'true' });
  } catch (err) {
    // compute 실패 (R2 outage / KV list day-limit) → last-success fallback.
    void captureBackendException(c.env, err, { path: 'observability/metrics', stage: 'compute' });
    const fallback = await readLastSuccessfulMetrics(c.env.TRIPS);
    if (fallback) {
      return c.json(fallback, 200, {
        'X-Stale-Cache': 'true',
        'X-Error': err instanceof Error ? err.message : 'compute_failed',
      });
    }
    return c.json({ error: 'metrics_unavailable' }, 503);
  }
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

  // #1370 L5 — `received` outcome은 도달률 측정용 stamp만 적재. pending entry는 보존해
  //   후속 fired/skipped ack가 P2c fallback을 정상 차단할 수 있게 한다.
  if (ack.outcome === 'received') {
    const stampResult = await stampReceived(
      c.env.PENDING_PUSHES,
      ack.pushId,
      ack.token,
      Date.now(),
      ack.permissionMode,
      // #1772 — latencyMs / batteryState forward. legacy device 미전송 시 undefined (graceful).
      ack.latencyMs,
      ack.batteryState,
    );
    return c.json({ ok: true, ...stampResult });
  }

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
  // #2153 (리뷰 P1) — boarding-prompt 신선도 게이트 anchor(`originProximityAt`)의 실시간 입력.
  // `trip.promptGeoContext.originDistanceM/originAccuracyM`는 POST /trips 재등록 시에만 갱신되는
  // 정적 스냅샷이라(useApnsTripRegistration.ts는 currentStation을 register effect deps에서 제외),
  // 재등록 트리거가 안 오면 anchor stamp 기회가 영영 안 올 수 있다(#2153 RCA). 이 10초 주기
  // /position 채널은 재등록과 무관하게 매 cycle 신선한 GPS 기준 근접 신호를 흘려 stamp 기회를
  // 보강한다 — position series/point 저장과는 독립된 side-effect(series에는 적재하지 않음).
  const { originDistanceM, originAccuracyM } = parseOriginProximityFields(body);
  await stampOriginProximityIfNeeded(
    c.env.TRIPS,
    payload.token,
    originDistanceM,
    originAccuracyM,
    Date.now(),
  );
  // #823 Phase 3 E1 — 가속도 옵션 필드. 부재 또는 invalid 시 skip (positionSeries는 이미 적재됨).
  if (payload.accelSummary) {
    await appendAccelSample(c.env.TRIPS, payload.token, payload.accelSummary);
  }
  // #1556 (T3) — SSOT.motionState 갱신. SSOT 부재(trip 미등록) 시 graceful no-op.
  // T2 advanceTripPosition 게이트 #2가 본 motionState='stationary'를 차단 입력으로 사용한다.
  await updateSsotMotion(c.env.TRIPS, payload.token, payload.point, Date.now(), {
    onTransition: (from, to) => {
      // P0-1 (#1577) — Site 5 of 6: motion-transition 적재.
      writeMetric(c.env, {
        eventType: 'motion-transition',
        tripToken: payload.token,
        reason: `${from}->${to}`,
      });
    },
  });
  // P0-1 (#1577) — Site 6 of 6: position-upload 적재 (V8a /position rate 검증).
  writeMetric(c.env, {
    eventType: 'position-upload',
    tripToken: payload.token,
    reason: payload.point.motion,
  });

  // #1534 (S1, T9b, ADR-016) — primary transport: POST /position response에 lockSuggestion +
  // originStationId 회신. silent push가 비활성 OS suspend / kill / 저전력 분기에 도달 못해도
  // device가 cycle마다 호출하는 /position 응답으로 즉시 lockSuggestion 인계. silent push payload는
  // secondary transport (`toSilentPushSsot`).
  //
  // SSOT 부재 시(trip 미등록) lockSuggestion / originStationId 누락 — graceful, device는
  // 기존 9-AND gate fallback. SSOT cacheTtl 30s 명시(KV 최소 제약 + cron 사이클 정합).
  const ssot = await readSsot(c.env.TRIPS, payload.token, {
    cacheTtl: CRON_READ_CACHE_TTL_SEC,
  });
  return c.json({
    ok: true,
    // currentStationId가 빈 문자열이 아닐 때만 forward — 빈 stationId는 device 측에서
    // "추론 미정착" 신호로 다뤄야 하므로 명시 누락 (graceful).
    ...(ssot?.currentStationId
      ? { originStationId: ssot.currentStationId }
      : {}),
    ...(ssot?.lockSuggestion ? { lockSuggestion: ssot.lockSuggestion } : {}),
    // #2261 (ADR-031 Phase 0) — full SSoT additive forward. 기존 originStationId/lockSuggestion
    // 필드는 legacy 호환을 위해 유지, 본 필드는 device가 motionState/lastAdvanceAt/passedStations/
    // alarmEvents/currentStationLine까지 mirror에 채택할 수 있게 하는 신규 채널이다. silent push
    // payload와 동일 `toSilentPushSsot` 축소를 재사용해 두 transport가 같은 wire 형태를 공유한다
    // (device backendSsotMirror는 어느 채널에서 와도 동일 schema).
    ...(ssot ? { ssot: toSilentPushSsot(ssot) } : {}),
  });
});

/**
 * #2153 — POST /position body에서 origin 근접 필드(distance/accuracy)만 별도로 뽑는다.
 * `parsePromptGeoContext`(POST /trips)의 originDistanceM/originAccuracyM 파싱과 동일 규칙
 * (finite number만 허용, 둘 중 하나라도 무효면 둘 다 생략) — 두 경로가 같은 개념을 다른 채널로
 * 보내므로 검증 규칙을 분기하지 않는다. 이 값은 position series(`PositionPoint`)에는 적재되지
 * 않는다 — anchor stamp 판단에만 쓰이는 휘발성 입력이다.
 */
export function parseOriginProximityFields(input: unknown): {
  originDistanceM?: number;
  originAccuracyM?: number;
} {
  if (!input || typeof input !== 'object') return {};
  const o = input as Record<string, unknown>;
  const originDistanceM =
    typeof o.originDistanceM === 'number' && Number.isFinite(o.originDistanceM)
      ? o.originDistanceM
      : undefined;
  const originAccuracyM =
    typeof o.originAccuracyM === 'number' && Number.isFinite(o.originAccuracyM)
      ? o.originAccuracyM
      : undefined;
  if (originDistanceM === undefined || originAccuracyM === undefined) return {};
  return { originDistanceM, originAccuracyM };
}

/**
 * #2153 (리뷰 P1) — `trip.originProximityAt`(신선도 게이트 anchor)를 `/position` 채널에서도
 * stamp할 수 있게 하는 진입점. cron(`scheduled.ts`)의 stamp 로직과 같은 `isNearOrigin` 판정을
 * 공유하되, 이 경로는 근접이 아니면(멀거나 값 부재) trip을 아예 읽지 않는다 — 매 10초 호출되는
 * 채널이므로 KV read/write 낭비를 근접 관측이 실제로 발생하는 순간으로 최소화한다.
 *
 * **KV write 최소화**: 이미 stamp된 trip(`originProximityAt !== undefined`)은 재관측해도
 * write하지 않는다 — trip당 최초 1회만 write (CF KV free tier quota 보호, #2073 lesson).
 * trip 미존재(register 전/만료)는 graceful no-op.
 */
export async function stampOriginProximityIfNeeded(
  kv: KVNamespace,
  token: string,
  originDistanceM: number | undefined,
  originAccuracyM: number | undefined,
  now: number,
): Promise<void> {
  if (!isNearOrigin(originDistanceM, originAccuracyM)) return;
  const trip = await getTrip(kv, token);
  if (!trip) return;
  if (trip.originProximityAt !== undefined) return;
  await putTrip(kv, { ...trip, originProximityAt: now });
}

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
  // #1363 — diag log 이원화. 클라가 산출한 사용자 현재역 이름. log 라벨링 전용(게이트 입력 X).
  // 빈 문자열은 omit으로 강등 (graceful).
  const currentStationName =
    typeof obj.currentStationName === 'string' && obj.currentStationName.length > 0
      ? obj.currentStationName
      : undefined;
  // #1543 (S10) — CTRadioAccessTechnology 환경 vote. iOS만 송신. 정의된 enum 외 값은 graceful drop.
  const cellularEnvironmentVote =
    obj.cellularEnvironmentVote === 'surface' ||
    obj.cellularEnvironmentVote === 'underground' ||
    obj.cellularEnvironmentVote === 'unknown'
      ? obj.cellularEnvironmentVote
      : undefined;
  // #1667 (ADR-015 strongDB) — WiFi SSID 매핑 역명. 디바이스가 lookupStationBySsid 결과를 forward.
  // 빈 문자열은 "매칭 없음"과 동일 → graceful omit (consensusGate wifiSsidMatch=false fallback).
  const wifiSsidStationName =
    typeof obj.wifiSsidStationName === 'string' && obj.wifiSsidStationName.length > 0
      ? obj.wifiSsidStationName
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
      ...(currentStationName !== undefined ? { currentStationName } : {}),
      ...(cellularEnvironmentVote !== undefined ? { cellularEnvironmentVote } : {}),
      ...(wifiSsidStationName !== undefined ? { wifiSsidStationName } : {}),
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
  //
  // W1 (#1271, Epic #1204 그룹 2) — swap 발생 여부를 본 cycle 안에서 식별해 응답
  // autoLockCandidate에 `from: 'transfer-swap'` hint 첨부. client는 hint가 있으면
  // motion gate(#1014 RC2 Gate #2)를 우회한다 — 환승 직후 사용자가 이동 중인 상태에서
  // hydrate가 영구 차단되는 회귀(피드백 7, 22:53 transfer skip)를 차단.
  //
  // #2021 (ADR-022) — archFlag='on' 시 payload.boardingLine 을 무시해 device 가 backend lock
  // 의 line 을 임의로 갱신하지 못하도록 봉인. flag 로드 실패 (KV race) 는 default('off') 로
  // fallback → 기존 동작 유지 (사용자에게 dogfood 회귀 대신 legacy 동작 노출).
  const archFlag = await getArchFlag(c.env.TRIPS).catch(() => ARCH_FLAG_DEFAULT);
  const preSwapTrainCode = working.boardingLock?.trainCode;
  working = applyBoardingLockTrainCodeSwap(working, payload, archFlag);
  const transferSwapApplied =
    preSwapTrainCode !== undefined &&
    working.boardingLock !== undefined &&
    working.boardingLock.trainCode !== preSwapTrainCode;

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

  // #1364 — read-after-write verification. Workers KV는 region간 eventually consistent —
  // PUT 직후 다른 region replica가 옛 값을 반환하면 다음 cron(43~60s 후)이 stale
  // `boardingLock.expiresAt`을 읽어 false-negative "lock missing or expired"가 발생한다(#765 회귀).
  // #1423 — cacheTtl은 KV 런타임 floor(30s) 사용. "origin 조회 강제"를 위해 cacheTtl=0을 쓰면
  // Cloudflare KV가 `Invalid cache_ttl of 0` 400 throw로 sync handler 전체 실패한다(#1364
  // 회귀, #1383 cron path fix가 본 read-after-write 경로를 cover 못 함). 1회 retry 후에도
  // propagation 확인 실패 시 5xx 반환 — client가 다음 fix에서 재시도해 데이터 정합성 회복 기회를 확보한다.
  const verifyOk = await verifyBoardingLockPersisted(c.env.TRIPS, working);
  if (!verifyOk) {
    await putTrip(c.env.TRIPS, working);
    const retryOk = await verifyBoardingLockPersisted(c.env.TRIPS, working);
    if (!retryOk) {
      return c.json({ ok: false, reason: 'sync-verification-failed' }, 503);
    }
  }

  const head = working.waypoints[0];
  return c.json({
    ok: true,
    advanced: advance.shiftedCount > 0,
    currentWaypoint: head ? head.stationName : null,
    nextStation: head ? head.stationName : null,
    // #916 A1 — cron auto-lock(또는 사용자 명시 lock)이 trip에 부착돼 있으면 그 메타를
    // candidate로 노출. client가 이 값으로 boardingLock UI/state를 hydrate한다.
    // segmentStations/expiresAt 등 내부 필드는 client가 트래킹할 필요가 없어 공개 표면 최소화.
    // #1364 P1 — `expiresAt`을 노출해 client local store가 backend 갱신값과 동기화되도록 한다.
    autoLockCandidate: working.boardingLock
      ? {
          trainCode: working.boardingLock.trainCode,
          line: working.boardingLock.line,
          subwayId: working.boardingLock.subwayId,
          expiresAt: working.boardingLock.expiresAt,
          // W1 (#1271): client motion gate 우회 hint — swap 발생 시에만 첨부.
          ...(transferSwapApplied ? { from: 'transfer-swap' as const } : {}),
        }
      : null,
  });
});

/**
 * #1364 — KV `putTrip` 직후 boardingLock이 실제로 propagation됐는지 확인.
 *
 * cacheTtl은 Cloudflare KV 런타임 최소값(`KV_MIN_CACHE_TTL_SEC` = 30)을 사용한다.
 * #1423 — 과거 댓글이 "cacheTtl=0으로 origin 조회 강제"라 명시했지만, Cloudflare KV runtime은
 * read 경로 종류와 무관하게 `cacheTtl < 30`을 거절(`Invalid cache_ttl of 0` 400). 본 함수에
 * cacheTtl=0을 넣으면 sync handler 전체가 실패해 device가 lock sync 못 함(#1423 evidence).
 *
 * 30s cacheTtl 하에서도 propagation race는 충분히 흡수된다 — sync handler가 putTrip을 호출한
 * 같은 region replica는 즉시 fresh 값을 반환하고, 다른 region이라도 30s window 안에 새 값으로
 * 정렬된다. 1회 retry로 propagation 완료를 한 번 더 확인한 뒤 실패 시 503으로 client에 retry
 * 신호를 보낸다.
 *
 * 다음 두 조건이 모두 만족할 때 true:
 *   1) 저장한 trip이 read되어야 함 (lock 없는 trip은 lock 검증 생략)
 *   2) `boardingLock.expiresAt`이 기대치 이상(propagation 완료)
 *
 * lock이 없는 trip의 경우 verification은 "trip 자체가 read 가능한가"만 본다.
 */
export async function verifyBoardingLockPersisted(
  kv: KVNamespace,
  expected: Trip,
): Promise<boolean> {
  // #1423 — cacheTtl=KV_MIN_CACHE_TTL_SEC (30). 0/<30은 CF KV가 400 throw.
  const verified = await getTrip(kv, expected.token, { cacheTtl: KV_MIN_CACHE_TTL_SEC });
  if (!verified) return false;
  if (!expected.boardingLock) return true;
  if (!verified.boardingLock) return false;
  return verified.boardingLock.expiresAt >= expected.boardingLock.expiresAt;
}

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
 *
 * #2021 (ADR-022) — archFlag='on' 시 payload.boardingLine 을 무시하고 기존 lock.line 을 그대로
 * 유지한다. Seam E 는 device 가 지상 GPS 관측을 backend 로 sync 하는 채널인데, flag=on 정책은
 * "trainCode 확정 없이는 어떤 알림도 발사 X" 이므로 device 가 보낸 line 값이 backend lock 을
 * 임의로 갱신하지 못하도록 봉인. flag=off (기본) / archFlag 미전달 시 기존 동작 100% 유지.
 * trainCode swap 자체는 flag 무관 유지 — 환승 leg 자동 종료 차단 목적은 flag on/off 공통.
 */
export function applyBoardingLockTrainCodeSwap(
  trip: Trip,
  payload: BoardingLockSyncPayload,
  archFlag?: ArchFlagValue,
): Trip {
  const incomingTrainCode = payload.trainCode;
  if (!incomingTrainCode) return trip;
  const lock = trip.boardingLock;
  if (!lock) return trip;
  if (lock.trainCode === incomingTrainCode) return trip;
  // 환승 leg 감지 → lock 교체 + 카운터 reset.
  // #2021 — flag=on 시 payload.boardingLine 무시, 기존 lock.line 유지. flag=off (기본) 는
  //   payload.boardingLine ?? lock.line (기존 D4 정책).
  const nextLine =
    archFlag === 'on' ? lock.line : payload.boardingLine ?? lock.line;
  return {
    ...trip,
    boardingLock: {
      ...lock,
      trainCode: incomingTrainCode,
      // boardingLine은 optional payload — 미제공 시 기존 line 유지.
      line: nextLine,
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
  // #1370 L5 — `received`는 도달률 stamp 전용. fired/skipped는 outcome 분리 후 pending entry 삭제.
  outcome: 'received' | 'fired' | 'skipped';
  reason?: string;
  // #1768 — 권한별 도달률 집계. legacy device 미전송 시 undefined (backward compat).
  permissionMode?: 'always' | 'whileInUse' | 'denied';
  // #1772 — silent push latency (device 계산: receivedAt - sentAt). legacy 누락 시 undefined.
  latencyMs?: number;
  // #1772 — battery state. legacy device 미전송 시 undefined (backward compat).
  batteryState?: 'normal' | 'lowPowerMode' | 'unknown';
}

export function validatePushAck(input: unknown): PushAckPayload | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.pushId !== 'string' || obj.pushId.length === 0) return null;
  if (typeof obj.token !== 'string' || obj.token.length === 0) return null;
  if (obj.outcome !== 'received' && obj.outcome !== 'fired' && obj.outcome !== 'skipped') {
    return null;
  }
  const out: PushAckPayload = { pushId: obj.pushId, token: obj.token, outcome: obj.outcome };
  if (typeof obj.reason === 'string') out.reason = obj.reason;
  if (
    obj.permissionMode === 'always' ||
    obj.permissionMode === 'whileInUse' ||
    obj.permissionMode === 'denied'
  ) {
    out.permissionMode = obj.permissionMode;
  }
  // #1772 — latencyMs: 양의 finite number만 허용. 음수/Infinity는 측정 오류.
  if (typeof obj.latencyMs === 'number' && obj.latencyMs >= 0 && Number.isFinite(obj.latencyMs)) {
    out.latencyMs = obj.latencyMs;
  }
  if (
    obj.batteryState === 'normal' ||
    obj.batteryState === 'lowPowerMode' ||
    obj.batteryState === 'unknown'
  ) {
    out.batteryState = obj.batteryState;
  }
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

/**
 * Trip status — killed-app launch reconciliation (#1339, Epic #1204).
 *
 * 디바이스가 다음 launch에서 trip 상태를 backend에 질의 → ended 응답이면 alert/sentinel 누락
 * 백스톱으로 stale route/destination/lock state를 자체 cleanup한다.
 *
 * 응답 모델:
 *   200 active     — KV에 trip이 살아 있음
 *   200 ended      — trip은 사라졌지만 종료 마커가 있고 retention(`TRIP_STATUS_RETENTION_MS`) 내
 *   404            — trip도 마커도 없음 (등록된 적 없거나 KV TTL 자연 폐기)
 *   410            — 마커는 있으나 retention 만료(expired-retention) — body로 사유 명시
 *
 * Privacy: tripToken은 디바이스가 자신의 token을 echo하는 케이스라 인증 없이 노출 가능 — 다른
 * 디바이스의 token을 추측 brute-force할 risk는 사실상 0(UUID 공간).
 */
app.get('/trips/:tripToken/status', async (c) => {
  const tripToken = c.req.param('tripToken');
  if (!tripToken) return c.json({ error: 'missing_token' }, 400);

  const now = Date.now();
  const trip = await getTrip(c.env.TRIPS, tripToken);
  if (trip) {
    return c.json({
      tripToken,
      status: 'active' as const,
      endedAt: null,
      endReason: null,
    });
  }

  // #2175 — device는 항상 실 deviceToken(=최초 등록 시 token)으로 조회한다(#2174 comment 1).
  // #2196(ADR-025 cleanup) 이후 이 fallback은 legacy(로테이션 시절 UUID 신원) trip 잔재 흡수 +
  // APNs token refresh로 deviceToken 자체가 바뀌는 드문 이벤트 복구 용도로만 존치한다.
  // deviceToken 역인덱스가 "현재 실제 trip.token"을 추적하므로 그 값으로 재조회해 active/ended를
  // 정확히 해소한다(#2174 comment 2 escape hatch, PR #2184 P1 완결 지점).
  const indexedToken = await getDeviceTripIndex(c.env.TRIPS, tripToken);
  if (indexedToken !== null && indexedToken !== tripToken) {
    const indexedTrip = await getTrip(c.env.TRIPS, indexedToken);
    if (indexedTrip) {
      return c.json({
        tripToken,
        status: 'active' as const,
        endedAt: null,
        endReason: null,
      });
    }
    const indexedEnded = await readTripEndedStatus(c.env.TRIPS, indexedToken);
    if (indexedEnded && now - indexedEnded.endedAt <= TRIP_STATUS_RETENTION_MS) {
      return c.json({
        tripToken,
        status: 'ended' as const,
        endedAt: indexedEnded.endedAt,
        endReason: indexedEnded.endReason,
      });
    }
  }

  const ended = await readTripEndedStatus(c.env.TRIPS, tripToken);
  if (!ended) {
    return c.json({ error: 'trip_not_found' }, 404);
  }

  if (now - ended.endedAt > TRIP_STATUS_RETENTION_MS) {
    return c.json({ tripToken, status: 'expired-retention' as const }, 410);
  }

  return c.json({
    tripToken,
    status: 'ended' as const,
    endedAt: ended.endedAt,
    endReason: ended.endReason,
  });
});

app.delete('/trips/:token', async (c) => {
  const token = c.req.param('token');
  if (!token) return c.json({ error: 'missing_token' }, 400);
  const directExisting = await getTrip(c.env.TRIPS, token);

  // 리뷰 P1 (#2186) — deviceToken 역인덱스 fallback. #2196(ADR-025 cleanup) 이후 이 fallback은
  // legacy(로테이션 시절 UUID 신원) trip 잔재 흡수 + APNs token refresh 복구 용도로만 존치한다
  // (GET /trips/:token/status와 동일한 패턴, #2175 comment). 직접 키 조회가 miss일 때만
  // 역인덱스로 재발견 — 직접 조회가 성공하면(대부분) 역인덱스 조회를 건너뛴다. 재발견 못하면
  // (역인덱스도 없거나 이미 정리됨) 기존대로 idempotent 200 deleted:false.
  const existing =
    directExisting ??
    (await (async () => {
      const indexedToken = await getDeviceTripIndex(c.env.TRIPS, token);
      if (indexedToken === null || indexedToken === token) return null;
      return getTrip(c.env.TRIPS, indexedToken);
    })());
  if (!existing) return c.json({ ok: true, deleted: false });
  // #2268 — device가 실제 종료 사유(예: lockless-trip-end, 사용자 탭)를 알고 있으면 optional
  // ?reason= 쿼리로 전달, D1 trip_metrics의 end_reason에 그대로 적재한다(6번째 인자
  // metricsReason, cleanupTripWithLa 참고). 기존 alert-push 게이팅용 reason(5번째 인자)은 그대로
  // undefined 유지 — DELETE 경로는 여전히 push를 새로 트리거하지 않는다(회귀 금지).
  // 길이 제한(64자)은 자유 문자열이 D1 컬럼을 오염시키는 걸 막는 최소 방어 — 값 자체 검증(allowlist)은
  // 하지 않는다(telemetry only, 분기 로직 없음).
  const metricsReason = c.req.query('reason')?.trim().slice(0, 64) || undefined;
  // 활성 LA가 있으면 dismissal push 발사 후 KV 삭제. cleanupTripWithLa가 두 동작을 묶는다
  // (deviceToken 역인덱스 정리도 그 안에서 함께 처리된다, 리뷰 P1).
  // logger는 worker console.log로 직결 — HTTP-driven cleanup의 dismissal 실패가 silent loss로
  // 사라지지 않게 운영 가시성 확보.
  await cleanupTripWithLa(
    existing,
    c.env,
    buildLaDeps(c.env),
    makeLaStats(),
    Date.now(),
    (msg, meta) => console.log(JSON.stringify({ msg, ...meta })),
    { metricsReason },
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
 * #1366 Layer 3 — boardingLock cross-validation (POST /trips merge 시점).
 *
 * Frontend가 환승 hop 진입 시 store 업데이트 race로 새 line의 trainCode를 직전 leg의
 * segmentStations와 결합해 stale metadata로 전송하는 케이스가 관측됐다
 * (item 4 8:33 환승역 즉시 재탑승 trip — lock.line='7' + waypoints는 전부 2호선).
 *
 * 게이트: lock.line이 incoming.waypoints의 어느 waypoint.line과도 일치하지 않으면
 * lock metadata는 거짓 — backend가 채택하지 않고 lock 필드만 drop한다 (trip 본체는 살림).
 *
 * 좁은 (stationName + line) 매칭 대신 line-level 매칭만 보는 이유:
 *  - Lock의 segmentStations[0]은 사용자가 탑승한 출발역. waypoints는 transfer/destination
 *    anchor만 포함하므로 출발역이 waypoint에 직접 등장하지 않을 수 있다.
 *  - 사용자가 실제 탑승한 line은 반드시 trip route의 어딘가에 등장해야 한다 — 등장하지
 *    않는다면 stale metadata로 단정한다.
 *
 * waypoints가 비어 있으면 (validateTrip이 미리 차단) false로 평가된다.
 */
export function isBoardingLockConsistentWithWaypoints(
  lock: BoardingLockMeta,
  waypoints: Trip['waypoints'],
): boolean {
  return waypoints.some((wp) => wp.line === lock.line);
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
  // #1731 — reject helper: console.warn + Sentry breadcrumb (DSN 미설정 시 no-op).
  // sanitizedPayload: token은 앞 8자만 노출 (PII mask).
  function reject(reason: string, tokenRaw?: string): null {
    const tokenPrefix = typeof tokenRaw === 'string' ? tokenRaw.slice(0, 8) : undefined;
    console.warn(`validateTrip reject: ${reason}`, JSON.stringify({ reason, tokenPrefix }));
    addValidateRejectBreadcrumb(reason, { tokenPrefix });
    return null;
  }

  if (!input || typeof input !== 'object') return reject('non-object');
  const obj = input as Record<string, unknown>;

  const tokenRaw = typeof obj.token === 'string' ? obj.token : undefined;
  if (!tokenRaw || tokenRaw.length === 0) return reject('missing-token');
  if (typeof obj.destination !== 'string') return reject('missing-destination', tokenRaw);
  if (!obj.route || typeof obj.route !== 'object') return reject('missing-route', tokenRaw);
  if (!Array.isArray(obj.waypoints) || obj.waypoints.length === 0) return reject('empty-waypoints', tokenRaw);
  if (typeof obj.expiresAt !== 'number' || obj.expiresAt <= Date.now()) return reject('invalid-expiresAt', tokenRaw);
  if (typeof obj.alarmAtEpochMs !== 'number') return reject('missing-alarmAtEpochMs', tokenRaw);

  // #1324 — degenerate trip 방어: 출발역 == 목적지면 client(stationRoute.findRoutes)가
  // `{ type: 'direct', stops: 0 }` 경로를 만든다 — 진행할 hop이 없어 방향 null/빈 탑승목록/
  // skip-cycle로 이어진다(사가정 trip 사고). frontend 경계가 1차 차단하지만, 0-stop direct
  // 경로는 backend도 거부해 어떤 client에서도 이런 trip이 등록되지 않게 한다.
  const route = obj.route as Record<string, unknown>;
  if (route.type === 'direct' && route.stops === 0) return reject('zero-stop-direct-route', tokenRaw);

  // waypoints 검증
  for (const w of obj.waypoints) {
    if (!w || typeof w !== 'object') return reject('invalid-waypoint-non-object', tokenRaw);
    const wp = w as Record<string, unknown>;
    if (typeof wp.stationName !== 'string') return reject('invalid-waypoint-stationName', tokenRaw);
    if (typeof wp.line !== 'string') return reject('invalid-waypoint-line', tokenRaw);
    if (wp.kind !== 'transfer' && wp.kind !== 'destination' && wp.kind !== 'intermediate') return reject('invalid-waypoint-kind', tokenRaw);
  }

  // #1193 — incoming waypoints 전체에 대해 occurrenceIdx를 1-pass로 stamp.
  // 같은 stationName이 중복 등장(순환선/회차)할 때 클라이언트의 `:n` suffix identifier 규약과 일치하도록
  // 0-based 인덱스를 부여. waypoint shift 진행 후에도 값은 불변 — reschedule push 시점까지 일관.
  // 클라이언트가 이미 occurrenceIdx를 보내준 경우는 그대로 신뢰 (round-trip 안정).
  // Epic #1204 그룹 2 D3 (#1273) — hopIndex는 시퀀스 0-based 위치. occurrenceIdx와 같은 1-pass에서
  // 계산하지만 별개 카운터(시퀀스 절대 위치 ≠ stationName 등장 횟수). 클라가 명시 송신한 값은 그대로 신뢰.
  const occurrenceCount = new Map<string, number>();
  const stampedWaypoints = (obj.waypoints as Array<Record<string, unknown>>).map((wp, idx) => {
    const stationName = wp.stationName as string;
    const occIdx = occurrenceCount.get(stationName) ?? 0;
    occurrenceCount.set(stationName, occIdx + 1);
    const existingOcc =
      typeof wp.occurrenceIdx === 'number' &&
      Number.isInteger(wp.occurrenceIdx) &&
      wp.occurrenceIdx >= 0
        ? wp.occurrenceIdx
        : occIdx;
    const existingHop =
      typeof wp.hopIndex === 'number' && Number.isInteger(wp.hopIndex) && wp.hopIndex >= 0
        ? wp.hopIndex
        : idx;
    return { ...wp, occurrenceIdx: existingOcc, hopIndex: existingHop } as Trip['waypoints'][number];
  });

  return {
    token: tokenRaw,
    // #2174 — 등록 시점의 실 device token을 고정. ADR-025(#2194) 하에서 `incoming.token`은
    // 트립 수명 동안 불변(이 값과 항상 동일)이지만, 레이어 명확성(신원 vs push 주소)을 위해
    // 필드 분리는 유지한다. baseTrip이 `...incoming` spread로 그대로 carry한다 (POST /trips
    // 핸들러 참고).
    deviceToken: tokenRaw,
    route: obj.route as Trip['route'],
    destination: obj.destination as string,
    waypoints: stampedWaypoints,
    expiresAt: obj.expiresAt as number,
    createdAt: typeof obj.createdAt === 'number' ? obj.createdAt : Date.now(),
    alarmAtEpochMs: obj.alarmAtEpochMs as number,
    lastFiredPhase: obj.lastFiredPhase === 'early' || obj.lastFiredPhase === 'imminent'
      ? obj.lastFiredPhase
      : undefined,
    // #1367 — cross-station dedup marker 복원. 두 필드가 모두 valid해야 채택 (KV 직렬화 신뢰).
    lastFiredStation: parseLastFiredStation(obj.lastFiredStation),
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
    // #1669 backward-compat: 구 device는 locklessStationPassed, 신 device는 infoModeEnabled 송신.
    // 둘 다 accept하고 infoModeEnabled 우선.
    infoModeEnabled:
      typeof obj.infoModeEnabled === 'boolean'
        ? obj.infoModeEnabled
        : typeof obj.locklessStationPassed === 'boolean'
          ? obj.locklessStationPassed
          : undefined,
    // #819: boarding-prompt 평가용 컨텍스트. 좌표/표시 명시 부재 시 백엔드는 lockMissing 분기에서
    // 자연 skip — 좌표 없는 평가는 게이트 #4/#5 정확도 0이라 의미 없음.
    promptGeoContext: parsePromptGeoContext(obj.promptGeoContext),
    promptDisplay: parsePromptDisplay(obj.promptDisplay),
    // #903 (Seam G): 클라이언트 기압계가 보고한 지하 진입 신호. 미송신/비boolean이면 undefined(default OFF).
    // scheduled.ts가 이 값으로 consecutiveEtaMissing threshold(5 vs 10)를 분기한다.
    subsurface: typeof obj.subsurface === 'boolean' ? obj.subsurface : undefined,
    // #1895: device locale (ko/en/ja/zh). boarding-prompt push 본문 생성에 사용.
    // 미지원/undefined는 t() 호출 시점에 ko fallback (default).
    locale:
      obj.locale === 'ko' || obj.locale === 'en' || obj.locale === 'ja' || obj.locale === 'zh'
        ? obj.locale
        : undefined,
    // #2032 (Issue D): device 취침모드 상태 저장 — monitoring 전용 (ADR-023).
    // backend push 발사 결정에 사용 금지 (types.ts sleepModeEnabled 주석 + ADR-023).
    // Legacy client (필드 미송신) 또는 비boolean은 undefined로 graceful — 기존 동작 완전 보존.
    sleepModeEnabled:
      typeof obj.sleepModeEnabled === 'boolean' ? obj.sleepModeEnabled : undefined,
    // #2280 — trip 등록 시점 SSOT 출발역명. 비어있지 않은 string만 채택 — 그 외(구 client
    // 미송신 등)는 undefined로 graceful, d1TripMetrics가 기존 passedStations fallback을 사용한다.
    originStationName:
      typeof obj.originStationName === 'string' && obj.originStationName.length > 0
        ? obj.originStationName
        : undefined,
    // #2120 — device trip 인스턴스 corrId. 재등록마다 incoming 값으로 교체(다음 POST /trips
    // 핸들러가 baseTrip을 `{...incoming, ...}`로 spread하며 corrId를 별도 보존하지 않으므로
    // 자연스럽게 최신 값으로 갱신). 미송신/비string이면 undefined — trip-ended payload에서
    // 필드 생략으로 이어져 구버전 client 호환 유지.
    corrId: typeof obj.corrId === 'string' && obj.corrId.length > 0 ? obj.corrId : undefined,
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
  // #2130 (Part B-be-1) — device가 heal 시점 GPS fix로 계산해 동봉하는 근접 게이트 입력.
  // fix가 없으면(지하 등) 필드 자체가 생략되어 undefined → backend 근접 게이트는 관대 허용.
  const originDistanceM =
    typeof o.originDistanceM === 'number' && Number.isFinite(o.originDistanceM)
      ? o.originDistanceM
      : undefined;
  const originAccuracyM =
    typeof o.originAccuracyM === 'number' && Number.isFinite(o.originAccuracyM)
      ? o.originAccuracyM
      : undefined;
  return {
    origin: { lat: oc.lat, lng: oc.lng },
    nextStation: { lat: nc.lat, lng: nc.lng },
    direction: dir,
    ...(originDistanceM !== undefined ? { originDistanceM } : {}),
    ...(originAccuracyM !== undefined ? { originAccuracyM } : {}),
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
 * #1367 — lastFiredStation marker 파싱. KV 직렬화 신뢰. 두 필드 모두 valid 시에만 채택.
 */
function parseLastFiredStation(raw: unknown): { stationName: string; epochMs: number } | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.stationName !== 'string') return undefined;
  if (typeof o.epochMs !== 'number') return undefined;
  return { stationName: o.stationName, epochMs: o.epochMs };
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

// #2073 — named export(테스트 전용). default export는 Sentry.withSentry HOC로 감싸져 있어
// `handler.scheduled`를 직접 단위 테스트하려면 HOC를 우회할 진입점이 필요하다.
export const handler = {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    sentryInit(env);
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
    // #1982 (ADR-022 Phase 0) — 매 cron cycle log 에 archFlag on/off 를 포함한다.
    // KV 미바인딩 / 미설정 케이스는 `getArchFlag` 가 default 로 fallback (dormant).
    // meta 에 우연히 같은 키가 실려 있어도 archFlag SSOT 가 이기도록 spread 순서를 뒤로 둔다.
    const archFlag = await getArchFlag(env.TRIPS).catch(() => ARCH_FLAG_DEFAULT);
    // #1967 (Ff-1) — 매 cron cycle kill switch KV 상태를 read해 log + runScheduled deps로
    // forward. KV 미바인딩/미설정/read 실패는 모두 default(false, dormant)로 fallback —
    // 게이트 판정 자체가 실패해 정상 push가 막히는 회귀를 방지한다.
    const killSwitchLocklessIntermediate = await getKillSwitch(env.TRIPS, 'lockless_intermediate')
      .then((value) => value === 'true')
      .catch(() => KILL_SWITCH_DEFAULT === 'true');
    const log = (msg: string, meta?: Record<string, unknown>) =>
      console.log(JSON.stringify({ msg, ...meta, archFlag, killSwitchLocklessIntermediate }));

    let scheduledStats: Awaited<ReturnType<typeof runScheduled>>;
    try {
      // #1995 (ADR-022 Phase 1-2) — archFlag 를 runScheduled deps 로 forward.
      // 각 caller (arvlcd / vanish / transfer-release / lockless) 가 putPending / enqueueRetryIfTransient
      // 호출 시 이 값을 전달해 flag=on 시 destination 이외 kind 는 skip.
      // #1967 (Ff-1) — killSwitchLocklessIntermediate 를 runScheduled deps 로 forward. true 시
      // lockless intermediate 게이트 평가를 즉시 건너뛴다(backend deploy 없는 emergency 채널).
      scheduledStats = await runScheduled(env, {
        seoul,
        apnsConfig,
        apnsHosts,
        log,
        archFlag,
        killSwitchLocklessIntermediate,
      });
    } catch (err) {
      void captureBackendException(env, err, { path: 'scheduled/runScheduled' });
      throw err;
    }
    // #2160 (follow-up of #2151) — boardingPrompt counter를 이번 tick의 delta로 누적 KV 키에
    // read-modify-write. delta 전부 0이면 accumulate 함수 내부에서 KV read/write 자체를 skip
    // 한다 — obs-metrics 1h 갱신 게이트와 독립적으로 매분 호출해야 tick 간 delta 유실이 없다
    // (scheduledStats는 tick마다 새로 생성되는 로컬 객체).
    //
    // write 조건 정확한 서술: "활성 trip 0" 이 아니라 "lock 미형성 trip이 활성 tick에 존재".
    // lockless 구간(C 토글=infoMode ON 등)이 유지되는 trip은 그 30~60분 내내 매분 write가
    // 정상 케이스. X11(persistent lockless 회귀)이 발생하면 이 write도 함께 폭증하므로
    // write 급증 자체가 X11 조기 탐지 신호가 될 수 있다(boardingPromptCounterAccumulator.ts
    // 상단 doc-comment 참고). 단독 사용자 기준 최악 케이스도 하루 120~180 write 수준으로
    // 무료 quota(1000 writes/day) 내 안전.
    try {
      await accumulateBoardingPromptCounters(
        env.TRIPS,
        {
          evaluated: scheduledStats.boardingPromptEvaluated,
          fired: scheduledStats.boardingPromptFired,
          blocked: scheduledStats.boardingPromptBlocked,
          skippedNoContext: scheduledStats.boardingPromptSkippedNoContext,
          skippedStale: scheduledStats.boardingPromptSkippedStale,
          skippedTooFar: scheduledStats.boardingPromptSkippedTooFar,
          skippedTrainDuplicate: scheduledStats.boardingPromptSkippedTrainDuplicate,
        },
        Date.now(),
      );
    } catch (err) {
      // KV read/put 실패 — swallow + Sentry forward. cron 자체는 throw 없이 다음 minute에 재시도.
      void captureBackendException(env, err, { path: 'scheduled/boardingPromptCounterAccumulate' });
    }
    // #2073 (Issue A) — 진짜 idle tick(활성 trip 0 + 직전 tick 근방 fire/retry 기록 없음)엔
    // pending/retry push가 존재할 수 없으므로 listPending/listRetryPushes KV list 호출 자체를
    // skip한다(2026-07-29 quota audit: KV list 720%/write 144% 초과, idle-skip이 로그만
    // 억제하던 회귀). scanned>0(실제 entry 발견)이면 marker를 재stamp해 backoff가 긴 retry도
    // 다음 tick들이 계속 idle-skip 대상에서 제외되도록 한다.
    if (scheduledStats.pendingActivityPossible) {
      // #572 P2c — silent push 60s 미ACK entry를 alert로 fallback (#1894 30s→60s 완화). 같은 cron 사이클에서 실행.
      const fallbackStats = await runFallbackPushes(env, { apnsConfig, apnsHosts, log });
      // #1721 — silent push 발사 실패(429 / 5xx) 영구 lost 차단. retry-push: prefix entry 를 backoff 만기
      // 시 재발사. KV binding 부재 시 graceful no-op (개발/테스트 환경 호환).
      // #1995 (ADR-022 Phase 1-2) — runRetryPushes 자체 재 enqueue 도 flag=on 시 destination 만 유지.
      const retryStats = await runRetryPushes(env, { apnsConfig, apnsHosts, log, archFlag });
      if (fallbackStats.scanned > 0 || retryStats.scanned > 0) {
        await stampPushActivity(env.TRIPS, Date.now());
      }
    }
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
    // #1752 — observability metrics 1h 주기 집계. cron이 매분 실행되지만 1h bucket 키가
    // 이미 KV에 있으면 readObservabilityMetrics가 null을 반환하지 않으므로 computeAndStore는
    // 실행되지 않음. TELEMETRY_R2 미바인딩 시 graceful no-op.
    //
    // #1889 RC-19 — KV day-limit 초과 / compute throw 시 swallow + Sentry forward.
    //   cron 자체는 throw 없이 다음 minute에 재시도. endpoint는 last-success fallback으로 200.
    if (env.TELEMETRY_R2) {
      const now = Date.now();
      try {
        const existing = await readObservabilityMetrics(env.TRIPS, now);
        if (!existing) {
          // #2160 (follow-up of #2151) — 별도 누적 KV 키(`boardingPromptCounterAccumulator`)에서
          // 최신 누적치를 읽어 obs-metrics 응답에 노출한다. 이전(#2151/#2156)엔 같은 tick의
          // scheduledStats 스냅샷을 그대로 실었으나, 그 tick에 우연히 활성 trip이 없으면 0으로
          // 덮여써 누적이 유실되는 문제가 있었다 — 누적은 위 accumulateBoardingPromptCounters
          // 호출이 전담하고, 여기선 read-only로 최신 값을 가져온다.
          const boardingPromptCounters = await readBoardingPromptCounters(env.TRIPS);
          const metrics = await computeObservabilityMetrics(
            env.TELEMETRY_R2,
            env.PENDING_PUSHES,
            now,
            env.TRIPS,
            boardingPromptCounters ?? undefined,
            env.DB,
          );
          const storeResult = await tryStoreObservabilityMetrics(env.TRIPS, metrics, now, {
            onError: (err, key) =>
              void captureBackendException(env, err, { path: 'scheduled/observabilityMetrics', stage: 'kv-put', key }),
          });
          log('observability metrics aggregated', {
            window: '24h',
            timestamp: now,
            stored: storeResult.stored,
          });
        }
      } catch (err) {
        // compute / read throw — swallow. cron이 매분 재시도하므로 transient 실패는 다음에 회복.
        void captureBackendException(env, err, { path: 'scheduled/observabilityMetrics', stage: 'compute' });
      }
    }
  },
};

/**
 * #1829 — withSentry HOC bind.
 * DSN 미설정(sentryOptions가 undefined 반환) 시 HOC no-op — production 동작 그대로.
 * SENTRY_DSN secret 등록 즉시 자동 활성 (redeploy 필요 없음 — wrangler secret은 실시간 반영).
 */
export default Sentry.withSentry(sentryOptions, handler);

/**
 * #2264 (Epic #2260, ADR-031 Phase 1) — `TripDO` class export. wrangler는 `main`
 * module(본 파일)에서 `wrangler.toml`의 `durable_objects.bindings.class_name = "TripDO"`와
 * 이름이 일치하는 top-level export를 찾는다. 재-export만 — 구현은 `tripDO.ts` 참조.
 */
export { TripDO } from './tripDO';
