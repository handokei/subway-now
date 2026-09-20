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

import { Hono, type Context } from 'hono';
import { AUTO_PROMPT_DEDUP_WINDOW_MS } from './autoLock';
// #2655 — 역명 정규화(#1410/#2566 drift 흡수). scheduled.ts의 transfer anchor 비교와 동일 함수를
// 써야 "sync가 stamp한 역명"과 "cron이 advance하는 waypoint 역명"이 조용히 어긋나지 않는다.
import { normalizeStationName } from '../../../src/shared/utils/normalizeStationName';
import {
  attemptBoardingAnchorResolution,
  buildLockFromKnownTrainCode,
  resolveActiveLegOrigin,
  type BoardingResolveOutcome,
} from './boardingAnchorResolver';
import {
  isNearOrigin,
  markPromptFired,
  markPromptSilenced,
  shouldStampOriginProximity,
} from './boardingPrompt';
import {
  recordBoardingPromptOutcome,
  validateBoardingPromptOutcome,
} from './boardingPromptOutcome';
import { stampPushActivity } from './cronIdleGate';
import { stampDeviceContact } from './deviceContact';
import { markTripRegistered } from './activeTripsGate';
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
import { isTransferOrDestination } from './transferDestinationGate';
import {
  advanceBoardingLockWaypoint,
  createEmptyScheduledStats,
  fireSyncSkippedStationPasses,
  isBoardingLockActive,
  maybeFireHopEndPrompt,
  runMidCycleFireOnly,
  runScheduled,
  toSilentPushSsot,
  type MidCycleTripSnapshot,
  type ScheduledDeps,
} from './scheduled';
import {
  MID_CYCLE_MIN_REMAINING_MS,
  MID_CYCLE_OFFSET_MS,
  MID_CYCLE_START_GUARD_MS,
} from './cronConstants';
import {
  createSeoulCaptureRecorder,
  flushSeoulCapture,
  buildSeoulCaptureKey,
  type SeoulCaptureRecorder,
  type SeoulCaptureCycle,
} from './seoulCapture';
import { parseSeoulCaptureRangeQuery, listSeoulCaptureKeys } from './seoulCaptureKeys';
import * as Sentry from '@sentry/cloudflare';
import {
  addValidateRejectBreadcrumb,
  captureBackendException,
  hashTripToken,
  sentryInit,
  sentryOptions,
} from './sentry';
import { recordTripEvent } from './tripEventLog';
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
import { deleteSsot, readSsot, writeSsot } from './tripPositionSsot';
import { appendUnique } from './advanceTripPosition';
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

/**
 * #2653 (SonarCloud MINOR "Log Injection via unsanitized user input", 2026-09-15) —
 * `console.log(JSON.stringify({ msg, ...meta }))` 패턴이 이 파일에 4곳 중복돼 있었다(각자
 * 인라인 람다로 재정의). 단일 공용 헬퍼로 추출한다.
 *
 * meta 값 중 문자열(예: 요청 본문 유래 `observedStationName`)에서 개행/캐리지리턴만 제거해
 * log forging(가짜 로그 줄 주입)을 차단한다. `JSON.stringify`가 이미 처리하는 따옴표/이스케이프는
 * 중복 처리하지 않는다 — 여기서는 stringify 이전 원시 문자열의 제어문자만 정규화한다. 역명에
 * 쓰이는 한글/괄호/중점 등 정상 문자는 건드리지 않는다(회귀 테스트로 고정).
 *
 * `extraContext`는 매 호출에 고정 병합할 필드(예: scheduled 핸들러의 archFlag/killSwitch)가
 * 있는 호출부용 — 기존 스프레드 순서(`{ msg, ...meta, ...extraContext }`)를 그대로 보존해
 * 출력 바이트가 기존과 동일하다(호출부 대부분은 extraContext 없이 씀).
 */
export function sanitizeLogMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    sanitized[key] = typeof value === 'string' ? value.replace(/[\r\n]/g, '') : value;
  }
  return sanitized;
}

export function createJsonLogger(
  extraContext?: Record<string, unknown>,
): (msg: string, meta?: Record<string, unknown>) => void {
  return (msg: string, meta?: Record<string, unknown>) => {
    const sanitizedMeta = meta === undefined ? undefined : sanitizeLogMeta(meta);
    console.log(JSON.stringify({ msg, ...sanitizedMeta, ...extraContext }));
  };
}

export const app = new Hono<{ Bindings: Env }>();

/**
 * #2283 리뷰 P2-2 — trip_events 기록(핫패스 `/boarding-lock/sync` 내 telemetry)이 응답 latency에
 * 얹히지 않도록 `c.executionCtx.waitUntil`로 응답 반환 이후에 완료시킨다.
 *
 * Workers 런타임은 fetch handler에 항상 ExecutionContext를 제공하지만, 기존 단위 테스트 관례
 * (`app.fetch(req, env)` — executionCtx 3번째 인자 생략, index.test.ts 전역)에서는
 * `c.executionCtx` 접근 자체가 throw한다(Hono context.js). `recordTripEvent`는 내부에서 실패를
 * 이미 swallow하므로, executionCtx 부재 시 fire-and-forget으로 degrade해도 unhandled rejection
 * 위험이 없다 — 프로덕션 동작(waitUntil로 완료 보장)에는 영향 없이 테스트 하위호환만 흡수한다.
 */
function scheduleTripEvent(c: Context<{ Bindings: Env }>, promise: Promise<void>): void {
  try {
    c.executionCtx.waitUntil(promise);
  } catch {
    void promise;
  }
}

/**
 * 백엔드 realtimePosition trainCode resolver — tap-시점(register) 즉시 시도 (POST /trips 참고).
 * `scheduleTripEvent`로 waitUntil 스케줄되므로 응답 반환 이후 실행된다.
 *
 * `getTrip`으로 최신 trip을 재조회 후 write한다 — waitUntil 실행 시점까지 cron(`scheduled.ts`
 * 의 동일 resolver 재시도)이나 다른 register가 먼저 lock을 승격/변경했을 수 있는 race를
 * 방어한다(이미 lock 있으면 skip — 어느 쪽이 먼저 승격했든 결과는 동일한 정책이라 덮어쓸
 * 필요가 없다).
 *
 * 모든 실패(네트워크/파싱/KV)는 여기서 swallow — register 응답은 이미 반환된 이후이므로
 * 예외가 밖으로 나가도 사용자에게 영향은 없지만, unhandled rejection 로그 노이즈를 막기 위해
 * 명시적으로 처리한다.
 */
async function resolveBoardingAnchorAtRegister(env: Env, trip: Trip): Promise<void> {
  try {
    const seoul = new SeoulArrivalClient({ apiKey: env.SEOUL_API_KEY, host: env.SEOUL_API_HOST });
    // break #2 (#2323 rework) — register-time(POST /trips, 사용자의 실제 탭이 트리거)만 leg 2
    // (currentLegAnchor) 자동 승격을 허용한다. cron(`scheduled.ts`)은 매 사이클 배경 폴링이라
    // 이 옵션 없이 호출해 leg 2를 절대 조용히 승격시키지 않는다 — answer-driven 원칙.
    const anchorLock = await attemptBoardingAnchorResolution(trip, seoul, Date.now(), {
      allowLegTransfer: true,
    });
    if (!anchorLock) return;

    const latest = await getTrip(env.TRIPS, trip.token);
    if (!latest || latest.boardingLock !== undefined) return;

    const resolvedTrip: Trip = {
      ...latest,
      boardingLock: anchorLock,
      consecutiveEtaMissing: 0,
      lastTrackedArrivalEpoch: undefined,
      lastLaPushEpoch: undefined,
      lastLaPushAt: undefined,
    };
    await putTrip(env.TRIPS, resolvedTrip);
    console.log(
      JSON.stringify({
        msg: 'boarding-anchor: trainCode resolved at register (tap-time)',
        tokenPrefix: tokenPrefix(trip.token),
        trainCode: anchorLock.trainCode,
      }),
    );
  } catch (e) {
    console.log(
      JSON.stringify({
        msg: 'boarding-anchor: tap-time resolution error (register unaffected)',
        tokenPrefix: tokenPrefix(trip.token),
        error: String(e),
      }),
    );
  }
}

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
 * #2592 (Epic #2239 P1 후속) — seoul-capture R2 캡처 key 목록 조회 endpoint.
 *
 * `fixtureFromTrip`(#2586/PR#2588)이 R2 캡처 목록을 얻으려면 지금까지 `aws s3api
 * list-objects` + R2 S3 호환 API 토큰이 필요했다. wrangler에는 `r2 object list`가
 * 없고(4.131 확인) 사용자에게 별도 R2 토큰 발급을 요구하는 건 불필요한 마찰이라, worker
 * 자신의 TELEMETRY_R2 바인딩으로 목록만 읽어 반환한다(객체 본문은 반환하지 않음 —
 * 다운로드는 `wrangler r2 object get --remote` 그대로 유지). 스캔 로직은 `seoulCaptureKeys.ts`
 * (단위테스트도 그쪽에 위치) — 라우트는 위임만 한다.
 *
 * Auth: `Authorization: Bearer <ADMIN_TOKEN>` — admin 공통 정책.
 * Query: `?from=<epochMs>&to=<epochMs>` — 둘 다 선택. 미지정 시 전체 범위.
 *
 * V/X: curl -H "Authorization: Bearer $ADMIN_TOKEN" \
 *   "https://<worker>/admin/seoul-capture/keys?from=1757750000000&to=1757760000000"
 *
 * Response 200: `{ keys: string[], count: number }`
 * Response 400: `{ error: 'invalid_range' }` — from/to가 비숫자(공백 포함)이거나 from > to.
 * Response 400: `{ error: 'range_too_wide' }` — from~to 걸치는 날짜 45일 초과 또는 매칭 key 5000개 초과.
 * Response 401/503: 인증/binding 정책 동일 (TELEMETRY_R2 미바인딩 시 503).
 */
app.get('/admin/seoul-capture/keys', async (c) => {
  const authError = checkAdminAuth(c.req.header('authorization'), c.env.ADMIN_TOKEN);
  if (authError) return c.json({ error: authError.code }, authError.status);
  const r2 = c.env.TELEMETRY_R2;
  if (!r2) return c.json({ error: 'telemetry_r2_unavailable' }, 503);

  const range = parseSeoulCaptureRangeQuery(c.req.query('from'), c.req.query('to'));
  if ('error' in range) return c.json({ error: range.error }, 400);

  const result = await listSeoulCaptureKeys(r2, range.from, range.to);
  if ('error' in result) return c.json({ error: result.error }, 400);
  return c.json({ keys: result.keys, count: result.keys.length });
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
  // #2562 (ADR-038 Phase 2) — 재합성 트리거 확장. 기존엔 `length===1 && kind==='destination'`
  // (device가 목적지만 보낸 케이스)만 재합성했으나, cold-start(currentStation=null) register 시
  // device `routeToWaypoints`의 `intermediateWaypoints`가 [] 반환 → sparse-multi
  // (예: [건대입구(transfer), 뚝섬(destination)], intermediate 0개)로 도착한다. 이 경우 backend
  // `estimateBoardingLockArrival`이 waypoints[0](=건대입구)만 폴링해 중곡/군자/어린이 매역 발사가
  // 구조적으로 불가(#2560 lock 승격돼도 침묵). + boarding-prompt 방면(=waypoints[0])이 다음
  // 물리역 아닌 transfer/destination으로 오표시(2026-09-11 "용마산→뚝섬"). 두 증상 공통 상류.
  // → intermediate가 하나도 없으면(sparse) origin+destination으로 full path를 재합성한다.
  // 재합성 결과가 기존보다 waypoint를 늘렸을 때만 채택(정상 device 전송분 회귀 0).
  const hasIntermediateWaypoint = incoming.waypoints.some((w) => w.kind === 'intermediate');
  const destinationWaypointName =
    incoming.waypoints.find((w) => w.kind === 'destination')?.stationName ??
    incoming.waypoints[incoming.waypoints.length - 1]?.stationName;
  if (
    !hasIntermediateWaypoint &&
    destinationWaypointName !== undefined &&
    incoming.promptDisplay !== undefined
  ) {
    const inferred = inferWaypointsFromOriginAndDestination({
      originName: incoming.promptDisplay.originStation,
      originLine: incoming.promptDisplay.line,
      destinationId: incoming.destination,
      destinationName: destinationWaypointName,
    });
    if (inferred !== null && inferred.length > incoming.waypoints.length) {
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
      const routeReset = await resetTripStateForNewRoute(c.env.TRIPS, incoming, directExisting, {
        db: c.env.DB,
      });
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
    // #2651 (PR #2772 리뷰, 스펙 4항 재검토) — 최초 구현은 여기에 `promptOptIn===true`도 OR로
    // 추가했으나(무탭 trip의 progress 되감김 방지 의도) dead code였다: `progress.lockless===true`
    // 레코드의 **유일한 write 지점**(`mirrorLocklessProgress`, scheduled.ts)은
    // `runLocklessIntermediate` 내부에서만 호출되고, 그 함수 자체가
    // `trip.infoModeEnabled && waypoint.kind === 'intermediate'`(scheduled.ts dispatch)일 때만
    // 진입한다 — 즉 `promptOptIn===true && infoModeEnabled!==true`인 trip은 애초에
    // `progress.lockless===true` 레코드가 생성되지 않으므로, 이 read-side OR은 절대 참이 될 수
    // 없는 조건을 추가한 것에 불과했다. 원 조건(infoModeEnabled 단독)으로 되돌린다.
    const progress = existing !== null ? await getProgress(c.env.TRIPS, incoming.token) : null;
    const progressApplies =
      progress !== null &&
      ((incoming.boardingLock !== undefined &&
        progress.trainCode === incoming.boardingLock.trainCode) ||
        (progress.lockless === true && incoming.infoModeEnabled === true));
    if (progress !== null && !progressApplies) {
      await deleteProgress(c.env.TRIPS, incoming.token);
    }
    // #2554 (ADR-038 Phase 0) — same-session 재등록 시 보존할 boardingLock 산출(auto/manual 무관).
    // incoming이 있으면 그대로 채택(swap/재송신). 없으면 existing lock을 현재 waypoints와 정합할
    // 때만 보존한다 — 환승 후 stale leg-1 lock이 leg-2 waypoints에 살아남는 회귀를 차단(정합 실패
    // 시 drop → lockMissing → leg-2 프롬프트 정상). new-session 분기는 `...incoming`으로 자연 처리.
    const carriedBoardingLock =
      incoming.boardingLock ??
      (isSameSession &&
      existing !== null &&
      existing.boardingLock !== undefined &&
      isBoardingLockConsistentWithWaypoints(existing.boardingLock, existing.waypoints)
        ? existing.boardingLock
        : undefined);
    const baseTrip = isSameSession
      ? {
          ...incoming,
          waypoints: existing.waypoints,
          // #2628 (리뷰 P1-3) — createdAt(세션 시작 시각)을 existing 값으로 고정한다. 이전에는
          // `...incoming` spread가 매 재등록마다 incoming.createdAt(client가 보낸 값)으로
          // 덮어썼다 — device(`resolveTripCreatedAt`, useApnsTripRegistration.ts)는 같은
          // sessionKey 동안 값을 ref에 캐싱해 보통 불변으로 재송신하지만, 그 불변성은 client
          // 구현에 대한 신뢰일 뿐 backend가 직접 보장하지 않았다. `evaluateSameSession`의
          // createdAt-drift 분기(트레인코드 미사용 시 ≤5s 허용)를 통과할 때마다 backend가 그
          // incoming 값을 그대로 영속화하면, client 버그/다른 코드 경로가 매 재등록마다 조금씩
          // 다른 값을 보내는 경우 "진짜 세션 시작"이 수십~수백 회 재등록에 걸쳐 서서히
          // 밀릴 수 있다 — trip_metrics.started_at(D1)과 fired_count 집계 window(`trip.createdAt`
          // ~`endedAt`)의 하한이 이 값을 그대로 쓰므로 window가 진짜 세션 시작보다 늦게 시작해
          // 그 사이 발사된 cron-fire-attempt가 누락될 수 있다. existing.createdAt으로 고정해
          // client 송신값과 무관하게 backend가 직접 불변성을 보장한다.
          createdAt: existing.createdAt,
          lastFiredPhase: existing.lastFiredPhase,
          // #1367 — cross-station dedup marker는 token 단위로 보존돼야 같은 trip 재등록 race에서
          // 윈도우 안 fire가 다시 통과하지 않는다.
          lastFiredStation: existing.lastFiredStation,
          lastEtaSeconds: existing.lastEtaSeconds,
          apnsEnv: existing.apnsEnv ?? incoming.apnsEnv,
          // #2554 (ADR-038 Phase 0) — boardingLock durable화. 재등록 시 device가 lock을 payload에
          // 안 실어도(incoming.boardingLock===undefined) existing lock을 auto/manual 구분 없이 보존한다.
          //
          // 기존(#916 follow-up A)은 backend auto-lock(autoLockedAt 마커)만 보존하고 사용자 수동
          // lock은 "명시 해제"로 오간주해 drop했다. 그러나 device는 GPS update마다 재등록(#578)하고
          // 그때마다 lock을 payload에 안 실을 수 있어, 수동 lock이 소실 → cron이 lockMissing으로
          // 판정 → "탑승하셨나요?" 프롬프트 재발사 회귀(2026-09-09 7→2 라이드 confirmed)의 root였다.
          // 명시 해제는 trip-end(trip 삭제) 또는 다른 trainCode swap(incoming truthy)으로만 일어나고
          // "lock만 풀고 trip 유지"하는 순수 release 경로는 존재하지 않으므로("undefined=release"
          // 채널 폐기 안전). lock은 TTL(LOCK_TTL_REFRESH_MS 30분, /boarding-lock/sync가 활성 중 갱신)로만
          // 자연 만료한다 (option 2, 사용자 결정 2026-09-09).
          //
          // 단, 보존은 lock이 현재 waypoints와 여전히 정합할 때만(carriedBoardingLock 산출 참조) —
          // 환승 후 stale leg-1 lock(line 7)이 leg-2(line 2) waypoints에 살아남아 leg-2 탑승
          // 프롬프트를 억제하는 회귀를 차단한다. inconsistent면 drop → 다음 cycle lockMissing →
          // leg-2 프롬프트 정상 발사. incoming.boardingLock이 truthy면(다른 trainCode 선택 또는 같은
          // lock 재송신) 그대로 채택돼 swap 경로가 동작.
          boardingLock: carriedBoardingLock,
          // 추적 baseline은 같은 lock이 유지될 때만 보존(cron 추적 연속성). swap(다른 trainCode)/
          // drop(inconsistent/부재)이면 리셋 — 새 head waypoint의 첫 push를 보장한다.
          lastTrackedArrivalEpoch:
            (incoming.boardingLock === undefined && carriedBoardingLock !== undefined) ||
            (incoming.boardingLock !== undefined &&
              existing.boardingLock?.trainCode === incoming.boardingLock.trainCode)
              ? existing.lastTrackedArrivalEpoch
              : undefined,
          // #586 C: Live Activity token/state는 별도 endpoint(`/live-activity/register`)로 관리.
          // 디바이스가 trip을 re-POST해도 register/deregister로 채워둔 값을 유지한다.
          activityPushToken: existing.activityPushToken,
          activityState: existing.activityState,
          // #706: 연속 etaMissing 카운터는 backend-only state — 디바이스가 같은 세션으로 re-register해도
          // 누적치를 보존해야 자동 종료가 정상 동작 (re-register마다 0으로 초기화되면 무한 폴링 회귀).
          // #903 (Seam G) — 구 버전은 여기서 지상 복귀(subsurface true→false) 전환 시 카운터를
          // 0으로 리셋했다(지하 인내 임계 10 누적분이 지상 임계 5에 곧장 걸려 즉시 자동 종료되는
          // 회귀 방지 목적). #2644가 `resolveEtaMissingThreshold`의 입력을 trip.subsurface에서
          // waypoint의 stations.json environment로 교체하면서 그 회귀 자체가 성립하지 않게 됐다
          // (threshold는 이제 device register 시점 신호가 아니라 그 cycle의 waypoint 정적 속성으로
          // 결정) — 이 리셋은 더 이상 아무 회귀도 막지 않는 죽은 분기라 제거한다.
          consecutiveEtaMissing: existing.consecutiveEtaMissing,
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
          // #2547 — leg-2 anchor 계열도 backend-only state(device는 이 필드들을 보내지 않음 →
          // incoming은 항상 undefined). same-session 재등록마다 덮이면 환승 후 stamp된 anchor가
          // walk-gate 경과 전에 소실돼 leg-2 탑승 프롬프트/lock이 영영 발사되지 않는 회귀가 생긴다
          // (originProximityAt #2153과 동일 클래스). legResolveStreak도 함께 보존해야 #2540의
          // K회 연속확증 카운터가 재등록마다 리셋돼 승격이 무력화되지 않는다.
          currentLegAnchor: existing.currentLegAnchor,
          legBoardingEligibleAt: existing.legBoardingEligibleAt,
          legBoardingPromptState: existing.legBoardingPromptState,
          legResolveStreak: existing.legResolveStreak,
          // #2628 — lock 생애 이력 / boarding-prompt 응답 stamp도 backend-only state. same-session
          // 재등록마다 `...incoming`(둘 다 안 보내는 필드)로 덮이면, lock이 이번 요청 시점에 일시
          // 해제돼 있어도(예: disembark 후 GPS update 재등록) putTrip의 자동 stamp(현재 boardingLock
          // 유무만 봄)가 커버 못하는 "과거에 부착됐었다"는 사실이 소실된다. 명시 보존으로 방지.
          lockEverAttached: existing.lockEverAttached,
          boardingPromptResponded: existing.boardingPromptResponded,
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

      // #2452 — cron listTrips() list-quota 게이트 마커. REGISTER 성공(생성/업데이트 공통)
      // 시에만 stamp한다 — POST /position에서는 절대 stamp하지 않는다(#2450 write throttle을
      // 되돌리지 않기 위함). TTL은 trip.expiresAt에 정렬(activeTripsGate.ts 참조). KV write
      // 실패는 graceful하지만 register 응답 차단 없이 관측 가능하도록 로그를 남긴다 — 이 마커가
      // 유실되면 cron이 이 trip을 영영 스캔하지 못할 수 있는 유일한 실패 지점이기 때문
      // (cron 쪽 refreshActiveTripsMarker는 마커가 이미 있을 때만 동작).
      try {
        await markTripRegistered(c.env.TRIPS, trip.expiresAt, Date.now());
      } catch (e) {
        console.log(
          JSON.stringify({
            msg: 'active-trips marker stamp on register failed (#2452)',
            tokenPrefix: tokenPrefix(trip.token),
            error: String(e),
          }),
        );
      }

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

  // 백엔드 realtimePosition trainCode resolver (committed architecture, 2026-09-03) — tap-시점
  // 즉시 시도. 실제 열차는 탑승역에서 ~20-30s 안에 떠난다 — cron(≤60s 주기)만 기다리면 dwell
  // window를 놓쳐 station 정확 일치 매칭이 영구 실패할 위험이 있다(열차가 이미 다음 역으로
  // 넘어가 버림). anchor(promptDisplay + infoModeEnabled=true)가 backend에 처음 도달하는 이
  // 시점 — 즉 탭 직후, 열차가 아직 탑승역에 있을 가능성이 가장 높은 시점 — 에 1회 즉시 시도해
  // 그 창을 잡는다. `scheduleTripEvent`와 동일 waitUntil 패턴으로 register 응답 latency에
  // 얹지 않고, 실패/예외는 전부 swallow — register 자체(위에서 이미 persist 완료)는 절대
  // 실패시키지 않는다. cron(`scheduled.ts`)은 retry로 그대로 유지 — 이 tap-time 시도가
  // 실패해도(dwell window를 못 잡았거나 ambiguous) 다음 cycle이 계속 재평가한다.
  if (trip.infoModeEnabled === true && trip.boardingLock === undefined) {
    scheduleTripEvent(c, resolveBoardingAnchorAtRegister(c.env, trip));
  }

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
  // #2617 (코드리뷰 반영) — fallback implicit ACK 입력. `/position`은 FG 폴링과 BG location
  // task가 같은 주기로 호출하는 공유 채널이라 "도달했다" 자체는 FG를 증명하지 않는다
  // (deviceContact.ts RCA 참고) — `appState==='fg'`일 때만 stamp한다. BG 접촉을 implicit ACK로
  // 오인하면 BG 사용자의 fallback 안전망이 꺼진다. 핫패스 응답 latency에 얹지 않도록
  // waitUntil로 스케줄(#2283 관례, `scheduleTripEvent` 재사용).
  if (payload.appState === 'fg') {
    scheduleTripEvent(
      c,
      stampDeviceContact(c.env.TRIPS, hashTripToken(payload.token), Date.now()),
    );
  }
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
 * **KV write 최소화**: 이미 stamp된 trip은 `shouldStampOriginProximity`
 * (`ORIGIN_PROXIMITY_RENEWAL_MS`, 5분) 주기 미달이면 재관측해도 write하지 않는다 —
 * 매 10초 호출마다 쓰지 않고 스로틀링 (CF KV free tier quota 보호, #2073 lesson).
 * trip 미존재(register 전/만료)는 graceful no-op.
 *
 * #2358 (RCA) — 최초 1회만 stamp하고 영구 고정하면(#2153 원안) 출발역에서 계속 대기 중인 실
 * 시나리오가 신선도 창(15분)을 넘기는 순간 근접이 실시간으로 계속 확인되는 중에도 영구히
 * boarding-prompt가 막힌다. 근접이 관측되는 동안 anchor를 주기적으로 재stamp해 이 채널
 * (10초 주기)이 신선도 게이트를 계속 갱신하는 실질적 주 경로가 되게 한다.
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
  if (!shouldStampOriginProximity(trip.originProximityAt, now)) return;
  await putTrip(kv, { ...trip, originProximityAt: now });
}

interface PositionUploadPayload {
  token: string;
  point: PositionPoint;
  accelSummary?: AccelSummary;
  /**
   * #2617 (코드리뷰 반영) — FG 폴링(`useFgPositionUpload`) vs BG location task
   * (`backgroundLocationTask`) 판별 계약. `/position`은 두 채널이 같은 ~10초 주기로 호출하므로
   * 이 필드 없이는 "엔드포인트 도달" 자체가 FG를 증명하지 못한다 — fallback implicit ACK
   * (`stampDeviceContact`)는 `appState==='fg'`일 때만 채택한다. 구버전 클라(필드 미전송)는
   * undefined로 파싱돼 BG로 보수 취급(stamp 생략) — fallback 안전망을 끄지 않는다.
   */
  appState?: 'fg' | 'bg';
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
  // 빈 문자열은 "매칭 없음"과 동일 → graceful omit.
  // #2765 (게이트 전수감사 A) — 이 값을 소비하던 consensusGate strongDB(`wifiSsidMatch`)는
  // 생산자 0건이 감사로 확정돼 제거됐다. 현재 intake-only(types.ts:747 참조) — 저장만 되고
  // backend 게이트 판정에는 쓰이지 않는다.
  const wifiSsidStationName =
    typeof obj.wifiSsidStationName === 'string' && obj.wifiSsidStationName.length > 0
      ? obj.wifiSsidStationName
      : undefined;
  // #2617 — FG/BG 판별 계약. 정의된 값 외(구버전 클라 미전송 포함)는 undefined로 강등해
  // implicit ACK 판정 쪽에서 보수적으로 BG 취급하게 한다.
  const appState =
    obj.appState === 'fg' || obj.appState === 'bg' ? obj.appState : undefined;
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
    ...(appState !== undefined ? { appState } : {}),
  };
}

/**
 * boarding-prompt 사용자 [미탑승]/dismiss 신호 (#819 게이트 #9).
 * 클라이언트가 사용자 응답을 받아 호출한다. silencedUntil을 set해 5분간 재발사 차단.
 *
 * `POST /trips/:token/boarding-confirm`의 action='not-boarded'와 완전히 동일한 의미(구/병행
 * 클라가 쓰는 경로) — #2628(리뷰 P1-2) `markBoardingPromptResponded` 공용 헬퍼로 동일하게
 * boarding_prompt_responded를 stamp한다. 두 경로 중 하나만 stamp하면 그 경로만 쓰는 클라의
 * trip은 계속 0으로 남는다.
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

  const updated: Trip = markBoardingPromptResponded({
    ...existing,
    boardingPromptState: markPromptSilenced(existing.boardingPromptState, Date.now()),
  });
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
 * #2628 (리뷰 P1-2) — boarding-prompt 응답 stamp 공용 헬퍼. `POST
 * /trips/:token/boarding-confirm`(action 무관)과 `POST /boarding-prompt/dismiss`(구/병행
 * 클라가 쓰는 'not-boarded'의 동의어 경로) 둘 다 사용자가 boarding-prompt에 응답했다는 동일
 * ground truth를 나른다 — 한쪽만 stamp하면 그 경로를 쓰는 클라의 trip은
 * `trip_metrics.boarding_prompt_responded`가 계속 0으로 남는다.
 */
function markBoardingPromptResponded(trip: Trip): Trip {
  return { ...trip, boardingPromptResponded: true };
}

/**
 * #2527 — LA 인터랙티브 버튼(App Intent)이 앱을 열지 않고(BG) 직접 호출해 leg 락 체인을
 * 완결하는 엔드포인트. 기존 device 흐름(`useBoardingPromptResponder.handleResponse`/
 * `tryAutoLock`, `handleHopEndResponse`)을 서버-사이드로 재현한다 — 새 정책을 만들지 않는다.
 *
 * Body: `{ action: 'boarded' | 'disembarked' | 'not-boarded', station: string, line: string }`
 *
 * #2739 (정정 — 이전 버전은 아래 내용이 틀렸다) — station/line은 더 이상 진단 echo로만 쓰이지
 * 않는다. `attemptBoardingAnchorResolution`에 `tapAnchor`로 전달되어, trip 자신의
 * `currentLegAnchor`(도보 게이트 통과)/`promptDisplay`가 **둘 다 없을 때만** 1순위 fallback
 * anchor로 쓰인다 — 이미 있는 backend anchor(및 그 게이트)는 그대로 우선하며 절대 우회되지
 * 않는다. route(waypoints/originStationName)와 정합하지 않는 station/line은 거부되고 사유가
 * D1(`outcome:'invalid-route'`)에 남는다. 근거: 탭은 사용자가 승차역·노선을 직접 실어 보내는
 * 가장 강한 명시 의향이고(ADR-010), backend anchor가 아직 없는 상태에서 그 정보를 버리는 것은
 * 판정 근거 자체가 없는 것과 같다(#2739).
 *
 * 의미 매핑(#2527 이슈 본문):
 *   - `boarded` — register-time resolver(`index.ts` `resolveBoardingAnchorAtRegister`)와 동일한
 *     `attemptBoardingAnchorResolution(trip, seoul, now, { allowLegTransfer: true, tapAnchor })`를
 *     재사용. 이미 `boardingLock`이 있으면 재평가하지 않는다(#1729 active lock 재평가 금지와
 *     동일 원칙, POST /trips register-time 가드 재현). 정확히 1개 resolve되면 lock 승격 + 해당
 *     leg의 prompt state를 `markPromptFired`로 갱신(재발사 dedup 목적 — 새 필드 없이 기존 함수
 *     재사용). ambiguous/none/invalid-route면 락 생성 금지(#1729) — `infoModeEnabled=true`
 *     stamp만 반영.
 *   - `disembarked` — 환승 하차 확정(#2278 "사용자 명시 [하차함] 응답 = ground truth"와 동일
 *     신뢰 수준). `trip.boardingLock`을 해제한다. waypoint/currentLegAnchor는 건드리지 않는다 —
 *     그 advance는 cron(`scheduled.ts` transfer 블록, arvlCd 기반)의 책임 그대로이며, 이미
 *     advance됐다면(currentLegAnchor 존재) 본 분기는 boardingLock을 건드리지 않는다. #2628
 *     (리뷰 P1-1) — lock 유무와 무관하게 이 요청 자체가 boarding-prompt 응답이라 핸들러 끝
 *     공통 경로에서 항상 1회 putTrip한다(더 이상 lock 보유 시에만 쓰는 no-op이 아니다).
 *   - `not-boarded` — `POST /boarding-prompt/dismiss`와 완전히 동일한 의미(재현) —
 *     `boardingPromptState`를 `markPromptSilenced`로 갱신해 5분 재발사를 차단한다. 락 생성 없음.
 *
 * Response 200: `{ ok: true, lockState: 'leg1' | 'leg2' | 'released' | 'none' }`
 * Response 404: `{ error: 'trip_not_found' }`
 * Response 400: `{ error: 'invalid_json' | 'invalid_payload' | 'missing_token' }`
 */
app.post('/trips/:token/boarding-confirm', async (c) => {
  const token = c.req.param('token');
  if (!token) return c.json({ error: 'missing_token' }, 400);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const payload = validateBoardingConfirmPayload(body);
  if (!payload) return c.json({ error: 'invalid_payload' }, 400);

  const existing = await getTrip(c.env.TRIPS, token);
  if (!existing) return c.json({ error: 'trip_not_found' }, 404);

  const now = Date.now();
  let lockState: 'leg1' | 'leg2' | 'released' | 'none' = 'none';
  let resolveOutcome: BoardingResolveOutcome | undefined;
  // #2739 요구사항 4 — anchor 출처(D1 meta용). activeOrigin(currentLegAnchor/promptDisplay)이
  // 있으면 그 출처, 없고 walk-gate도 아니면 탭이 시도된 것 — resolve 성공 여부와 무관하게
  // "무엇을 근거로 시도했는지"를 남긴다(invalid-route 거부도 anchorSource:'tap'으로 남는다).
  let anchorSource: 'tap' | 'currentLegAnchor' | 'promptDisplay' | undefined;
  let working: Trip = existing;

  if (payload.action === 'boarded') {
    if (working.infoModeEnabled !== true) {
      working = { ...working, infoModeEnabled: true };
    }
    // #1729 — 이미 active lock이 있으면 재평가하지 않는다(register-time과 동일 가드).
    if (working.boardingLock === undefined) {
      try {
        const seoul = new SeoulArrivalClient({
          apiKey: c.env.SEOUL_API_KEY,
          host: c.env.SEOUL_API_HOST,
        });
        // #2739 — 기존 backend anchor(currentLegAnchor 게이트 통과 / promptDisplay)가 있는지
        // 미리 확인해 anchorSource를 정한다. activeOrigin이 있으면 탭 fallback 분기 자체에
        // 진입하지 않으므로(resolver 내부 동일 판정) 회귀 없음 — 요구사항 2.
        const activeOrigin = resolveActiveLegOrigin(working, now, { allowLegTransfer: true });
        const isWalkGated =
          working.currentLegAnchor !== undefined &&
          (working.legBoardingEligibleAt === undefined || now < working.legBoardingEligibleAt);
        if (activeOrigin) {
          anchorSource = working.currentLegAnchor !== undefined ? 'currentLegAnchor' : 'promptDisplay';
        } else if (!isWalkGated) {
          anchorSource = 'tap';
        }

        let tapAdvance: { waypoints: Trip['waypoints']; boardingStation: string; line: string } | undefined;
        const anchorLock = await attemptBoardingAnchorResolution(
          working,
          seoul,
          now,
          { allowLegTransfer: true, tapAnchor: { boardingStation: payload.station, line: payload.line } },
          // ADR-037 D2b (#2535, 진단 계측 only) — resolve outcome 관측. lock 판정/생성 자체는
          // anchorLock 반환값 그대로 사용 — 이 콜백은 D1 append 용 부가 관측이다.
          (outcome) => {
            resolveOutcome = outcome;
          },
          // #2739 — 탭이 leg 2+(환승 지점) 경유로 채택되면 waypoints가 그 leg부터 다시 시작하도록
          // advance 정보를 받는다. 아래에서 lock과 함께 반영해야 다음 cron이 올바른 정거장
          // (환승 직후 waypoint)을 추적한다.
          (advance) => {
            tapAdvance = advance;
          },
        );
        if (anchorLock) {
          if (tapAdvance) {
            // #2739 — 탭 = 사용자가 이미 물리적으로 그 환승 지점에 있었다는 명시 확인이므로
            // 도보 게이트는 즉시 통과된 것으로 stamp한다(#2515 게이트 자체는 currentLegAnchor가
            // 아직 없을 때만 이 분기에 온다 — 기존 게이트 우회가 아니라 새 anchor 최초 생성).
            working = {
              ...working,
              waypoints: tapAdvance.waypoints,
              currentLegAnchor: { boardingStation: tapAdvance.boardingStation, line: tapAdvance.line },
              legBoardingEligibleAt: now,
              legBoardingPromptState: undefined,
              legResolveStreak: undefined,
            };
          }
          const isLeg2 = isLegTwoActive(working, now);
          working = {
            ...working,
            boardingLock: anchorLock,
            consecutiveEtaMissing: 0,
            lastTrackedArrivalEpoch: undefined,
            lastLaPushEpoch: undefined,
            lastLaPushAt: undefined,
            ...(isLeg2
              ? { legBoardingPromptState: markPromptFired(now, working.legBoardingPromptState, anchorLock.trainCode) }
              : { boardingPromptState: markPromptFired(now, working.boardingPromptState, anchorLock.trainCode) }),
          };
          lockState = isLeg2 ? 'leg2' : 'leg1';
        }
      } catch {
        // SonarCloud S5145 — tokenPrefix(token)도 token(URL param)이 user-controlled라
        // 신규코드 게이트에서 taint로 잡힌다. 정적 msg만 남기고 error 내용도 로깅하지 않는다
        // (Error 메시지에 요청 파생 문자열이 섞일 수 있어 안전하지 않음).
        console.log(JSON.stringify({ msg: 'boarding-confirm: boarded resolution error' }));
      }
    } else {
      lockState = isLegTwoActive(working, now) ? 'leg2' : 'leg1';
    }
  } else if (payload.action === 'disembarked') {
    if (existing.boardingLock !== undefined) {
      working = { ...existing, boardingLock: undefined, consecutiveEtaMissing: 0 };
      await deleteProgress(c.env.TRIPS, token);
    }
    lockState = 'released';
  } else {
    // 'not-boarded' — POST /boarding-prompt/dismiss와 동일 의미(재현).
    working = {
      ...existing,
      boardingPromptState: markPromptSilenced(existing.boardingPromptState, now),
    };
    lockState = 'none';
  }

  // #2628 (리뷰 P1-1) — 이 endpoint가 boarding-prompt 응답 채널. action/분기 결과(락 보유 여부
  // 포함) 무관하게 "요청 자체가 응답"이므로 분기 공통 경로에서 1회만 stamp + write한다. 이전
  // 버전은 stamp가 분기별 putTrip 안에 있어 disembarked인데 existing.boardingLock===undefined인
  // 케이스(lock이 이미 해제/만료된 상태에서 응답)가 putTrip 자체를 타지 않아 responded=0으로
  // 남았다(이 PR이 수리하려던 하드코딩 0 갭이 그 분기에서 재발) — 공통 경로로 올려 근본 차단.
  await putTrip(c.env.TRIPS, markBoardingPromptResponded(working));

  // SonarCloud S5145 — token(URL param)/station/line/action은 전부 요청에서 유래한
  // user-controlled 값이라 신규코드 게이트에서 taint로 잡힌다(tokenPrefix로 마스킹해도
  // 원본이 user-controlled라는 taint 자체는 남는다). lockState는 서버 resolver가 계산한
  // enum('leg1'|'leg2'|'released'|'none')뿐이라 안전 — 이것만 남긴다. token 상관관계는
  // 기존 resolver 로그('boarding-anchor: trainCode resolved')와 D1 trip_metrics(token_hash)가
  // 이미 커버한다.
  console.log(JSON.stringify({ msg: 'boarding-confirm', lockState }));
  // ADR-037 D2b (#2535, 진단 계측 only) — 탭 처리 1건당 정확히 1회 D1 append. HTTP 요청 단위라
  // #2073 quota throttle 불필요(매 tick 반복 호출이 아니다). push/advance/lock 동작 무변경 —
  // 위에서 이미 확정된 lockState/resolveOutcome을 관측만 한다.
  await recordTripEvent(c.env.DB, {
    tokenHash: hashTripToken(token),
    kind: 'boarding-confirm-result',
    meta: buildBoardingConfirmEventMeta(lockState, resolveOutcome, anchorSource),
  });
  return c.json({ ok: true, lockState });
});

/**
 * ADR-037 D2b (#2535, 진단 계측 only) — `boarding-confirm-result` D1 이벤트 meta 빌더(순수 함수,
 * 테스트 용이). `resolveOutcome`은 `action==='boarded'`이고 신규 resolve를 실제로 시도했을 때만
 * 존재 — 그 외(이미 lock 활성/disembarked/not-boarded)는 undefined라 meta에서 생략한다.
 *
 * #2739 요구사항 4 — `anchorSource`(`'tap' | 'currentLegAnchor' | 'promptDisplay'`)도 같은 규칙
 * (undefined면 생략)으로 남긴다. resolve를 시도조차 안 한 경로(이미 lock 활성/disembarked/
 * not-boarded/walk-gated)는 anchorSource도 undefined다.
 */
export function buildBoardingConfirmEventMeta(
  lockState: 'leg1' | 'leg2' | 'released' | 'none',
  resolveOutcome: BoardingResolveOutcome | undefined,
  anchorSource: 'tap' | 'currentLegAnchor' | 'promptDisplay' | undefined,
): {
  lockState: 'leg1' | 'leg2' | 'released' | 'none';
  outcome?: BoardingResolveOutcome;
  anchorSource?: 'tap' | 'currentLegAnchor' | 'promptDisplay';
} {
  return {
    lockState,
    ...(resolveOutcome !== undefined ? { outcome: resolveOutcome } : {}),
    ...(anchorSource !== undefined ? { anchorSource } : {}),
  };
}

interface BoardingConfirmPayload {
  action: 'boarded' | 'disembarked' | 'not-boarded';
  station: string;
  line: string;
}

export function validateBoardingConfirmPayload(input: unknown): BoardingConfirmPayload | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  if (
    obj.action !== 'boarded' &&
    obj.action !== 'disembarked' &&
    obj.action !== 'not-boarded'
  ) {
    return null;
  }
  if (typeof obj.station !== 'string' || obj.station.length === 0) return null;
  if (typeof obj.line !== 'string' || obj.line.length === 0) return null;
  return { action: obj.action, station: obj.station, line: obj.line };
}

/**
 * `resolveActiveLegOrigin`이 `currentLegAnchor` 분기를 선택하는 조건(#2515 도보시간 게이트)과
 * 동일 판정을 boolean으로 노출 — leg1/leg2 lockState 라벨링에만 쓰는 얕은 미러(순환 import
 * 회피, `lockSwap.ts`/`boardingAnchorResolver.ts`가 이미 쓰는 것과 동일 선례).
 */
function isLegTwoActive(trip: Trip, now: number): boolean {
  return (
    trip.currentLegAnchor !== undefined &&
    trip.legBoardingEligibleAt !== undefined &&
    now >= trip.legBoardingEligibleAt
  );
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
 *   { ok, advanced, currentWaypoint, nextStation }
 *   - advanced: 이번 sync로 waypoints가 shift됐는지 (1+ hop)
 *   - currentWaypoint: 정정 후 first waypoint stationName (없으면 null — destination 도착)
 *   - nextStation: 정정 후 first waypoint = 다음 알람 대상 (currentWaypoint와 동일, 의미상 alias)
 *   - #2352 — `autoLockCandidate` 필드는 삭제됐다(구 #916 A1). 사용자가 직접 탭하지 않은
 *     trainCode를 client가 무탭으로 hydrate하는 채널은 사용자 "무탭 오토락 전량 삭제" 결정(#2342)의
 *     backend-driven 잔존분이었다 — client가 이미 lock을 갖고 있으면 no-op이지만, client local
 *     store가 비어 있는데 backend Trip에 boardingLock이 남아있는 edge case(재설치/storage race
 *     등)에서 사용자 명시 없이 lock을 재생성했다. 명시 탭(createLockFromTrain) / boardingPrompt
 *     응답 lock 경로는 이 endpoint와 무관하게 그대로 유지된다.
 * Response 404: { error: 'trip_not_found' } — 클라는 다음 fix에서 자연 retry
 *
 * Trip 부재 시 lock 재생성 책임은 본 endpoint가 지지 않음 — 클라가 useApnsTripRegistration으로
 * POST /trips를 호출하면 같은 경로로 lock이 들어온다 (분리된 lock store가 없는 현 backend 구조).
 */
/**
 * #2672 — `/boarding-lock/sync` 안에서 `scheduled.ts` 함수(`maybeFireHopEndPrompt` /
 * `advanceBoardingLockWaypoint`)를 부를 때 쓰는 `ScheduledDeps` 조립. 두 호출부가 같은 구성을
 * 손으로 두 번 쓰면 한쪽만 바뀌는 drift가 생기므로 단일 지점으로 모은다.
 */
function buildSyncScheduledDeps(env: Env, archFlag: ArchFlagValue): ScheduledDeps {
  return {
    seoul: new SeoulArrivalClient({ apiKey: env.SEOUL_API_KEY, host: env.SEOUL_API_HOST }),
    apnsConfig: {
      keyId: env.APNS_KEY_ID,
      teamId: env.APNS_TEAM_ID,
      privateKeyPem: env.APNS_PRIVATE_KEY,
      bundleId: env.APNS_BUNDLE_ID,
    },
    apnsHosts: { production: env.APNS_HOST, sandbox: env.APNS_HOST_SANDBOX },
    archFlag,
  };
}

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
  // #2283 — D1 append-only 관측. KV trip 객체와 독립적으로 sync 도달을 보존한다(user-delete 시
  // KV가 사라져도 사후 재구성 가능해야 함). DB 미바인딩/실패는 recordTripEvent 내부 graceful no-op.
  // #2283 리뷰 P2-2 — 핫패스 응답 latency에 얹지 않도록 waitUntil로 스케줄(scheduleTripEvent 참고).
  const tokenHash = hashTripToken(payload.token);
  // #2617 (코드리뷰 반영) — fallback implicit ACK 입력. `/boarding-lock/sync`는 FG 전용
  // 액션이다 — 발신 훅(`useBoardingLockSync`)이 React `useEffect`로만 트리거되고 BG location
  // task(`backgroundLocationTask`, headless JS 콜백)는 이 API를 호출하지 않는다(`/position`과
  // 달리 BG/FG 공유 채널이 아님) — 그래서 `/position`과 달리 별도 appState 게이트 없이 항상
  // stamp한다. 핫패스 응답 latency에 얹지 않도록 waitUntil로 스케줄(#2283 관례).
  scheduleTripEvent(c, stampDeviceContact(c.env.TRIPS, tokenHash, now));
  scheduleTripEvent(
    c,
    recordTripEvent(c.env.DB, {
      tokenHash,
      kind: 'sync-received',
      station: payload.observedStationName,
    }),
  );
  const advance = computeLockSyncAdvance(existing.waypoints, payload.observedStationName);
  // #2655 — 사용자가 환승역에 **도착한 시각**을 backend advance 타이밍과 분리해 기록한다.
  // device sync는 accuracy≤50m 게이트를 통과한 확정 관측이라(`useBoardingLockSync`) "지금 이 역에
  // 있다"의 ground truth로 다룬다(#2645가 하차 확정에 쓰는 것과 동일 근거). 아래 transfer stamp
  // (`advanceBoardingLockWaypoint`)가 이 값을 도보 게이트 기준점으로 쓴다 — cron이 지하 침묵으로
  // 수 분 늦게 advance해도 도보 시계는 실제 도착 시각부터 흐른다.
  //
  // advance 여부와 무관하게 stamp한다: 정작 문제가 된 케이스는 sync가 waypoint를 소비하지 못한
  // (drift 가드/유예) 채 cron이 한참 뒤에 advance하는 조합이다. 같은 역은 **최초 관측만** 유지해
  // 재보고로 시계가 뒤로 밀리지 않게 한다.
  // 코드리뷰 P2-2 — 이름만으로 배열 전체를 뒤지면 순환선 재방문/동명 역 라우팅에서 **훨씬 뒤에 올**
  // transfer가 먼저 stamp될 수 있다. 남은 waypoint 중 **가장 앞선** transfer(=진짜 다음 환승)만
  // 대상으로 한다.
  const nextTransfer = existing.waypoints.find((wp) => wp.kind === 'transfer');
  const upcomingTransfer =
    nextTransfer &&
    normalizeStationName(nextTransfer.stationName) ===
      normalizeStationName(payload.observedStationName)
      ? nextTransfer
      : undefined;
  if (
    upcomingTransfer &&
    normalizeStationName(existing.transferObservedAt?.stationName ?? '') !==
      normalizeStationName(upcomingTransfer.stationName)
  ) {
    existing.transferObservedAt = {
      stationName: upcomingTransfer.stationName,
      line: upcomingTransfer.line,
      atMs: now,
    };
    // #2672 — "하차하셨나요?" 프롬프트도 이 관측 시점에 발사한다.
    //
    // 기존에는 `advanceBoardingLockWaypoint`(= backend가 환승 waypoint를 실제로 소비하는 순간)
    // 에서만 발사됐다. lock 활성 구간에서 그 소비는 cron이 잠긴 trainCode를 환승역에서 확증해야
    // 일어나는데 지하에서 그 신호가 침묵한다 — 2026-09-16 실측: 사용자는 06:34:59에 건대입구에
    // 도착했는데 프롬프트는 **06:41:10**(+6분)에 떴고, 그 사이 도착한 중간역 알림들보다 뒤에
    // 깔려 순서까지 뒤집혔다("하차하셨나요?"가 이미 지나간 역 알림 뒤에).
    //
    // device sync 관측은 accuracy≤50m 게이트를 통과한 "사용자가 지금 이 역에 있다"는 확증이라
    // 열차 위치 확증보다 늦을 이유가 없다. 중복 발사는 기존 leg-key dedup
    // (`hopEndPromptState` + `evaluateHopEndPromptGates`)이 그대로 흡수한다 — 뒤이어 cron이
    // advance하며 같은 프롬프트를 시도해도 silenced로 떨어진다(새 dedup 채널 없음).
    //
    // `nextWaypointOverride`: 이 시점엔 아직 waypoint를 소비하지 않았을 수 있어 `waypoints[0]`이
    // 환승역 자신일 수 있다. 안내 문구의 "다음 역"이 틀리지 않도록 배열에서 환승역 **다음** 항목을
    // 명시 전달한다(없으면 null — 문구에서 다음역 부분만 생략, 기존 graceful 계약과 동일).
    const transferIdx = existing.waypoints.indexOf(upcomingTransfer);
    const nextLegWaypoint = existing.waypoints[transferIdx + 1] ?? null;
    const syncLog = createJsonLogger();
    try {
      await maybeFireHopEndPrompt({
        trip: existing,
        transferWaypoint: upcomingTransfer,
        deps: buildSyncScheduledDeps(
          c.env,
          await getArchFlag(c.env.TRIPS).catch(() => ARCH_FLAG_DEFAULT),
        ),
        stats: createEmptyScheduledStats(now),
        now,
        log: syncLog,
        generatePushId: () => crypto.randomUUID(),
        env: c.env,
        nextWaypointOverride: nextLegWaypoint,
      });
    } catch (e) {
      // 프롬프트 발사 실패가 이 엔드포인트 전체를 500으로 만들면 안 된다 — `/boarding-lock/sync`는
      // waypoint advance / lock 승격 / SSoT 동기화까지 싣고 있는 주 채널이라, 부가 알림 하나 때문에
      // 그 전부가 죽는 쪽이 훨씬 큰 손실이다(APNs 설정 오류·키 만료가 곧장 추적 중단으로 번진다).
      syncLog('boarding-lock/sync: hop-end prompt on observation failed (swallowed)', {
        token: existing.token.slice(0, 8),
        station: upcomingTransfer.stationName,
        error: String(e),
      });
    }
  }

  let working: Trip = existing;
  // #2645 PR 코드리뷰 (코드리뷰 HIGH-1/HIGH-2/MEDIUM-3/LOW-5, 2026-09-15) — 실제로 적용된 hop 수.
  // `advance.shiftedCount`(요청/관측값)와 다를 수 있다 — drift 가드, 관측역-intermediate defer,
  // `advanceBoardingLockWaypoint`의 gps-far 유예 등으로 루프가 조기 중단되면 적용치가 더 작다.
  // 아래 D1 관측 / SSoT write / HTTP 응답 모두 요청값이 아니라 이 실제 적용값을 SSoT로 삼는다.
  let appliedShiftedCount = 0;
  if (advance.shiftedCount > 0) {
    const consumedWaypoints = existing.waypoints.slice(0, advance.shiftedCount);
    // #2645 — consumed 범위(관측역 자신 포함) 안에 transfer/destination waypoint가 있으면 전용
    // 경로(아래)로 처리한다. 열차가 이미 환승역을 떠나 arvlCd/positions를 못 잡는 상황에서도
    // "사용자가 그 역에 있었다"는 이 sync 관측 자체가 독립 확증이기 때문 — cron의
    // `estimateBoardingLockArrival`이 구조적으로 못 잡는 걸 여기서 잡는다(이슈 #2645 근본 fix).
    // 그 외(순수 intermediate 소비)는 기존 bulk-slice 경로를 그대로 유지한다.
    const transferOrDestConsumed = consumedWaypoints.filter(isTransferOrDestination);

    if (transferOrDestConsumed.length > 0) {
      const apnsConfig = {
        keyId: c.env.APNS_KEY_ID,
        teamId: c.env.APNS_TEAM_ID,
        privateKeyPem: c.env.APNS_PRIVATE_KEY,
        bundleId: c.env.APNS_BUNDLE_ID,
      };
      const apnsHosts = { production: c.env.APNS_HOST, sandbox: c.env.APNS_HOST_SANDBOX };
      const log = createJsonLogger();
      const archFlag = await getArchFlag(c.env.TRIPS).catch(() => ARCH_FLAG_DEFAULT);

      // #2625 — 관측역 이전에 건너뛴 intermediate station-passed waypoint는 기존 경로로 발사.
      // 이 분기에서는 아래 advanceBoardingLockWaypoint 루프가 trip.waypoints를 순차 전진시키므로
      // (그 결과에 의존해 이어지는 lock 승격/TTL/SSoT 로직을 진행해야 함) fire-and-forget
      // (waitUntil)이 아니라 inline으로 await한다 — transfer/destination이 섞이지 않은 순수
      // intermediate 소비(아래 else 분기)는 기존과 동일하게 waitUntil을 유지.
      const skippedStationPassed =
        advance.shiftedCount > 1 ? existing.waypoints.slice(0, advance.shiftedCount - 1) : [];
      if (skippedStationPassed.length > 0 && isBoardingLockActive(existing, now)) {
        await fireSyncSkippedStationPasses(
          c.env,
          existing,
          skippedStationPassed,
          existing.boardingLock,
          { apnsConfig, apnsHosts, archFlag },
          now,
          log,
          () => crypto.randomUUID(),
        );
      }

      // #2645 — transfer/destination waypoint를 `advanceBoardingLockWaypoint`(scheduled.ts)로
      // 순차 처리한다. cron의 arvlCd-확증 transfer advance와 **동일한 함수** — 환승 alert
      // (transfer-release push) / 하차 프롬프트(hop-end) / lock 해제(isRealLineChange) / sleep·
      // prepare 알람 / waypoints 전진을 전부 그 안에서 기존 로직 그대로 재사용한다(새 채널 없음).
      // evidence를 넘기지 않아(undefined) `advanceTripPosition`의 6단 게이트를 건너뛴다 — 이
      // sync 관측 자체가 device GPS/WiFi 확증(ground truth)이므로 cron 전용 motion/environment
      // 합의 게이트를 다시 통과시킬 필요가 없다(기존 legacy-caller 계약과 동일 패턴).
      // 중간에 끼인 intermediate waypoint(관측역이 아닌 것)는 Phase 1에서 이미 발사됐으므로 여기서는
      // 재발사 없이 배열에서만 제거한다. 관측역 자신이 intermediate이면(즉 transfer/destination이
      // 그보다 앞에 있었던 드문 catch-up 케이스) 기존 정책대로 cron에 위임 — 건드리지 않고 멈춘다.
      // #2672 (코드리뷰 P2-1) — 이 핸들러의 두 호출부가 같은 조립을 각자 쓰지 않도록 헬퍼 공유.
      const scheduledDeps: ScheduledDeps = buildSyncScheduledDeps(c.env, archFlag);
      // #2645 PR 코드리뷰 HIGH-1 (코드리뷰 확정) — waypoints 배열을 독립 스냅샷으로 clone한다.
      // `completeWaypointAdvance`(scheduled.ts)는 `trip.waypoints = trip.waypoints.slice(1)`로
      // 인자를 in-place mutate한다. cursor가 `existing`과 객체 참조를 공유하면(과거 `cursor =
      // existing`) 이 mutate가 `existing.waypoints`까지 잘라내 이후 SSoT write 블록의
      // `existing.waypoints[...]` 인덱싱이 밀린 원소(예: 다음 leg의 다른 노선)를 잡는 회귀가
      // 있었다 — 건대입구(7호선) 환승에서 성수(2호선)로 currentStationLine이 잘못 찍히거나,
      // 배열이 짧아지면 undefined 인덱싱으로 500까지 가능했다.
      let cursor: Trip = { ...existing, waypoints: [...existing.waypoints] };
      let tripEnded = false;
      try {
        for (let i = 0; i < consumedWaypoints.length; i++) {
          const wp = consumedWaypoints[i];
          const isObserved = i === consumedWaypoints.length - 1;
          if (cursor.waypoints[0]?.stationName !== wp.stationName) {
            // 방어적 drift 가드 — KV last-write-wins 하에서 동시 요청이 먼저 이 waypoint를
            // 처리했을 가능성. 남은 항목은 다음 sync/cron cycle 재평가에 맡기고 멈춘다.
            break;
          }
          if (!isTransferOrDestination(wp)) {
            if (isObserved) break; // 관측역 자신이 intermediate — 기존 정책대로 cron에 위임.
            cursor = { ...cursor, waypoints: cursor.waypoints.slice(1) };
            appliedShiftedCount += 1;
            continue;
          }
          const stats = createEmptyScheduledStats(now);
          // #2645 PR 코드리뷰 HIGH-2 (코드리뷰 확정) — putTrip 직후 같은 요청 안에서 getTrip으로 재읽기하지
          // 않는다. 기본 cacheTtl(60s)에 이 요청 앞부분(2336 read)이 이미 colo 캐시를 옛 값으로
          // 덥혀놨을 수 있어, 재읽기가 stale을 반환하면 이 함수 끝의 무조건 `putTrip(working)`이
          // 방금 적용한 advance를 되돌리고 이미 release한 lock을 되살린다(push는 이미 나간 뒤라
          // 사용자는 "해제됐다가 되살아난 옛 trainCode lock"을 갖게 됨, #864 실패 모드).
          // `advanceBoardingLockWaypoint`는 넘겨받은 trip 객체(cursor)를 in-place mutate하고
          // 결과를 반환값으로 알려주므로 그 mutate된 cursor 자체를 계속 신뢰한다.
          const result = await advanceBoardingLockWaypoint(
            cursor,
            wp,
            c.env,
            scheduledDeps,
            stats,
            now,
            log,
            undefined,
            () => crypto.randomUUID(),
          );
          if (!result.consumed) break; // gps-far 유예 등 — trip 보존, 더 진행하지 않는다.
          appliedShiftedCount += 1;
          if (result.tripEnded) {
            tripEnded = true;
            break;
          }
        }
      } catch (e) {
        // #2645 PR 코드리뷰 MEDIUM-4 (코드리뷰 확정) — 루프 중 실패해도 이미 나간 push(환승 alert/하차
        // 프롬프트)는 되돌릴 수 없다. 여기서 그대로 throw하면 이후 persist/verify/SSoT 단계를
        // 전부 건너뛰어 "push는 나갔는데 trip 상태는 진행 전"인 반쪽 상태로 500이 된다 — 지금까지
        // 실제로 적용된 진행분(appliedShiftedCount, cursor)을 그대로 들고 persist 단계로 넘어간다.
        log('boarding-lock/sync: transfer/destination advance loop error (partial progress persisted)', {
          token: existing.token.slice(0, 8),
          error: String(e),
          appliedShiftedCount,
        });
      }

      if (tripEnded) {
        if (appliedShiftedCount > 0) {
          scheduleTripEvent(
            c,
            recordTripEvent(c.env.DB, {
              tokenHash,
              kind: 'advance',
              station: undefined,
              meta: { shiftedCount: appliedShiftedCount },
            }),
          );
        }
        // destination 도착으로 trip이 종료됨(advanceBoardingLockWaypoint 내부 cleanup) — 이후
        // lock 승격/TTL refresh/putTrip/SSoT sync-write는 대상 trip이 없어 전부 moot.
        return c.json({
          ok: true,
          advanced: appliedShiftedCount > 0,
          currentWaypoint: null,
          nextStation: null,
        });
      }
      working = cursor;
      // progress KV mirror — POST /trips re-register 시 같은 trainCode면 shift 진행분이 보존되도록.
      await maybeMirrorLockSyncProgress(c.env.TRIPS, working, appliedShiftedCount);
    } else {
      // 기존 경로 — 순수 intermediate 소비(transfer/destination 없음), 변경 없음. 이 분기는
      // 드리프트/유예 없이 항상 요청된 전체를 적용한다.
      appliedShiftedCount = advance.shiftedCount;
      //
      // #2625 코드리뷰 P1-1 — sync 관측역 자신(`existing.waypoints[advance.shiftedCount - 1]`)은
      // 제외하고, 그 *이전에* 건너뛴 station-passed waypoint만 보존한다. `/boarding-lock/sync`는
      // GPS 반경 근접 + 5s 디바운스로도 트리거되는 약한 신호라, 관측역 자신까지 여기서 쏘면
      // 단일 hop(shiftedCount===1)마다 조기 도착 오탐이 나가고 그 dedup stamp가 뒤이은 정확한
      // arvlCd 확증 cron 발사를 억제해버린다(정확한 발사를 부정확한 발사로 대체). 관측역 자신은
      // 기존 cron 경로에 맡긴다 — `shiftedCount > 1`(즉 이전에 건너뛴 waypoint가 1개 이상)일
      // 때만 대상이 존재한다. 발사 대상 waypoint는 슬라이스 *이전* `existing.waypoints`에서
      // 뽑아야 원래 인덱스가 보존돼 `buildStationNotifContent`의 남은 정거장 계산이 정확하다
      // (코드리뷰 P1-3 — 슬라이스 후 배열을 넘기면 indexOf가 -1이 돼 환승 대신 목적지를 가리킴).
      const skippedStationPassed =
        advance.shiftedCount > 1 ? existing.waypoints.slice(0, advance.shiftedCount - 1) : [];
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
      // #2625 — 관측역 이전에 건너뛴 station-passed waypoint를 발사+계측. 코드리뷰 P1-4 —
      // `existing.boardingLock` 존재만으로 판단하지 않고 다른 모든 발사 경로와 동일하게
      // `isBoardingLockActive`(만료 검사 포함)를 강제한다 — 만료된 lock의 stale trainCode로
      // 발사되는 것을 막는다. lock 비활성(lockless 포함)이면 매역 알림 발사 자체가 이 backend
      // 아키텍처 밖(#2506 이후 committed architecture, lock 기반)이라 대상이 없다 —
      // `maybeMirrorLockSyncProgress`와 동일 전제.
      if (skippedStationPassed.length > 0 && isBoardingLockActive(existing, now)) {
        const lock = existing.boardingLock;
        const apnsConfig = {
          keyId: c.env.APNS_KEY_ID,
          teamId: c.env.APNS_TEAM_ID,
          privateKeyPem: c.env.APNS_PRIVATE_KEY,
          bundleId: c.env.APNS_BUNDLE_ID,
        };
        const apnsHosts = { production: c.env.APNS_HOST, sandbox: c.env.APNS_HOST_SANDBOX };
        const log = createJsonLogger();
        // #2283 리뷰 P2-2 관례 — archFlag read + push 발사 모두 응답 latency에 얹지 않도록
        // waitUntil 체인 안에서 수행한다. 코드리뷰 P1-6 — 다른 발사 경로와 동일하게 archFlag를
        // forward해야 archFlag='on' 시 `boardingLine`이 undefined로 실려 device lockless
        // opt-out 게이트를 우회하지 않는다.
        scheduleTripEvent(
          c,
          getArchFlag(c.env.TRIPS)
            .catch(() => ARCH_FLAG_DEFAULT)
            .then((archFlag) =>
              fireSyncSkippedStationPasses(
                c.env,
                // 코드리뷰 P1-3 — 슬라이스 이전(pre-slice) trip 스냅샷을 넘긴다. `waypoints`가
                // 원본 순서를 그대로 유지해야 `buildStationNotifContent`가 건너뛴 waypoint의
                // 올바른 위치에서 남은 정거장/환승 여부를 계산한다.
                existing,
                skippedStationPassed,
                lock,
                { apnsConfig, apnsHosts, archFlag },
                now,
                log,
                () => crypto.randomUUID(),
              ),
            )
            .then(() => undefined),
        );
      }
    }

    // #2645 PR 코드리뷰 LOW-5 (코드리뷰 확정) — D1 'advance' 이벤트를 요청값이 아니라 실제 적용값으로
    // 기록한다(위 두 분기 공통 지점). 조기 종료(드리프트 가드/관측역-intermediate defer/gps-far
    // 유예)로 `appliedShiftedCount < advance.shiftedCount`면 이 시점의 `working.waypoints[0]`이
    // 실제 도달한 head다.
    if (appliedShiftedCount > 0) {
      const advancedHead = working.waypoints[0];
      scheduleTripEvent(
        c,
        recordTripEvent(c.env.DB, {
          tokenHash,
          kind: 'advance',
          station: advancedHead ? advancedHead.stationName : undefined,
          meta: { shiftedCount: appliedShiftedCount },
        }),
      );
    }
  }

  // #2560 (ADR-038 Phase 2, ROOT fix) — lock 승격. backend가 active boardingLock이 없는데 device가
  // 확정 trainCode(D4 #1210)를 sync로 보냈으면(사용자 탭 = ground truth), 그 trainCode로 lock을 합성해
  // 부착한다. POST /trips 경로가 lock을 못 실었거나(레이스) infoModeEnabled lockless로 흘러
  // runTrainCodeTracking에 못 들어가 leg-1 매역 발사가 전멸하던 회귀(2026-09-10/11 실측, cron-fire-attempt=0)
  // 를 sync 채널로 확실히 복구한다. line이 waypoints와 정합할 때만 부착(stale trainCode drop). 부착 시
  // baseline reset으로 다음 cron이 이 lock으로 즉시 추적 시작.
  if (
    working.boardingLock === undefined &&
    payload.trainCode !== undefined &&
    payload.boardingLine !== undefined
  ) {
    const promoted = buildLockFromKnownTrainCode(
      working.waypoints,
      payload.trainCode,
      payload.boardingLine,
      payload.observedStationName,
      now,
    );
    if (promoted && isBoardingLockConsistentWithWaypoints(promoted, working.waypoints)) {
      working = {
        ...working,
        boardingLock: promoted,
        lastTrackedArrivalEpoch: undefined,
        lastLaPushEpoch: undefined,
        lastLaPushAt: undefined,
        consecutiveEtaMissing: 0,
      };
      scheduleTripEvent(
        c,
        recordTripEvent(c.env.DB, {
          tokenHash,
          kind: 'sync-received',
          station: promoted.segmentStations[0],
          meta: { promotedLock: true, trainCode: promoted.trainCode, line: promoted.line },
        }),
      );
    }
  }

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

  // #2624 — advance 이원화 fix. sync 기반 waypoint advance(위)가 tripPositionSsot을 건드리지
  // 않아 mirror/LA가 죽은 SSoT를 따라가는 회귀(2026-09-15 실 라이드 b00dd879)를 막는다. 사용자
  // 접점(device sync 관측)은 ground truth이므로 advanceTripPosition의 합의 게이트는 미적용
  // (#2623 소관 유지) — 단조성 가드만 적용: cron(advanceTripPosition)이 이미 이 waypoint
  // 프레임 상 더 앞선 station으로 SSoT를 전진시켰다면 후퇴시키지 않는다.
  //
  // 코드리뷰 반영(P2-5) — trip persist(putTrip + read-after-write verify) 성공 이후로 이동.
  // verify가 실패해 503을 반환하는 경로에서는 waypoint/SSoT 둘 다 미전진 상태로 남는다
  // (이전엔 SSoT가 putTrip보다 먼저 확정돼 waypoint/SSoT가 서로 다른 실패 시맨틱을 가졌다).
  //
  // 코드리뷰 반영(P1-1/P1-2) — read를 이 지점까지 최대한 늦춰 "다른 요청(cron
  // advanceTripPosition / POST /position)이 이 read와 write 사이에 alarmEvents/motionEvidence/
  // legConsensus/lockSuggestion을 갱신했는데 우리가 stale 전체를 덮어써 되돌리는" race 창을
  // 구조적으로 좁힌다. KV는 CAS가 없어 read-modify-write가 원자적이지 않다는 한계는
  // advanceTripPosition.ts 상단 주석("last write wins" 허용)과 동일하게 이 PR 스코프에서도
  // 유지한다 — 완전 원자화(Durable Object 등)는 별도 이슈로 분리 검토.
  // cacheTtl은 KV 런타임 floor(CRON_READ_CACHE_TTL_SEC=30s) 명시 — assertKvCacheTtl 규약 준수.
  //
  // #2645 PR 코드리뷰 MEDIUM-3 (코드리뷰 확정) — `advance.shiftedCount`(요청값)이 아니라 `appliedShiftedCount`
  // (실제 적용값)로 게이트한다. destination sync가 series stale로 advance가 중단됐는데(trip은
  // 보존) SSoT만 목적지로 점프하던 발산(#2624가 고친 것과 동형 회귀)을 차단한다.
  if (appliedShiftedCount > 0) {
    const freshSsot = await readSsot(c.env.TRIPS, payload.token, {
      cacheTtl: CRON_READ_CACHE_TTL_SEC,
    });
    // #2645 PR 코드리뷰 HIGH-1 (코드리뷰 확정) — `existing.waypoints`는 위 루프에서 더 이상 mutate되지
    // 않는다(cursor가 독립 clone) — 여기서 그대로 원본 순서로 인덱싱해도 안전하다.
    // advance.shiftedCount = idx+1이므로 observedStationName은 existing.waypoints[idx]와
    // 항상 일치(computeLockSyncAdvance가 findIndex로 idx를 산출했으므로 배열 범위 내 보장,
    // Waypoint.line은 required 필드) — 단, `appliedShiftedCount`가 요청값보다 작을 수 있으므로
    // (조기 중단) 실제로 도달한 마지막 waypoint는 `appliedShiftedCount - 1` 인덱스다.
    const matchedWaypoint = existing.waypoints[appliedShiftedCount - 1];
    if (freshSsot && matchedWaypoint && freshSsot.currentStationId !== matchedWaypoint.stationName) {
      if (
        isSsotSyncAdvanceMonotonic(
          existing.waypoints,
          freshSsot.currentStationId,
          matchedWaypoint.stationName,
        )
      ) {
        // 코드리뷰 반영(P1-3) — advanceTripPosition.ts:564와 동형: advance 시 "이전"
        // currentStationId를 passedStations에 stamp. catch-up(appliedShiftedCount>1) 시에는 그
        // 사이 건너뛴 중간 waypoint(index 0..appliedShiftedCount-2)도 함께 passed로 확정한다 —
        // ssotFireGate의 gate-station-already-passed / trip_metrics origin 소비부가 스킵된
        // 중간역을 놓치지 않도록.
        const skippedIntermediate = existing.waypoints
          .slice(0, appliedShiftedCount - 1)
          .map((w) => w.stationName);
        let passedStations = freshSsot.passedStations;
        for (const stationName of [freshSsot.currentStationId, ...skippedIntermediate]) {
          passedStations = appendUnique(passedStations, stationName);
        }
        await writeSsot(
          c.env.TRIPS,
          {
            ...freshSsot,
            // #2645 PR 코드리뷰 MEDIUM-3 — 요청 payload의 observedStationName이 아니라 실제로 적용된
            // matchedWaypoint.stationName을 SSoT에 기록한다. 전체 적용(appliedShiftedCount ===
            // advance.shiftedCount) 시에는 둘이 항상 동일(computeLockSyncAdvance가 매칭한 바로
            // 그 station)하지만, 조기 중단 시에는 관측값과 실제 도달점이 달라질 수 있다.
            currentStationId: matchedWaypoint.stationName,
            currentStationLine: matchedWaypoint.line,
            passedStations,
            // 코드리뷰 반영(P1-4a) — device 관측 시각(payload.observedAtMs)은 클록 skew에
            // 노출돼 과거로 이동할 수 있고, scheduled.ts의 stale-fire 3분 가드가 이를 오판해
            // 매역 발사를 막을 수 있다. 서버 수신 시각(`now`)을 stamp한다 — 다른 서버측
            // evidence(advanceTripPosition.ts:566 evidence.ts, 그러나 그쪽은 caller가 이미
            // 신뢰된 서버측 fetch 시각을 forward)와 동일하게 서버 시계를 SSoT.
            lastAdvanceAt: now,
            // 신규 어휘 — device sync 채널로 advance됐음을 구분(cron advanceTripPosition
            // evidence와 혼동 방지). device 측 소비부(`backendSsotMirror.ts`/`DebugModal.tsx`)는
            // lastAdvanceEvidence를 임의 string으로만 다뤄 분기하지 않는다(확인 완료) — 신규
            // 값 추가가 안전하다.
            lastAdvanceEvidence: 'device-sync',
            // 코드리뷰 반영(P2-7) — 직접 FG device 접촉(이 endpoint 자체가 FG 전용, 상단 #2617
            // 주석 참고)이므로 isDeviceSyncStale 판정 갱신 — suspend 후 재개 시 false staleness로
            // motion 게이트 오판을 막는다(motionState.ts:215 updateSsotMotion과 동일 정책).
            lastDeviceSyncAt: now,
          },
          { expiresAt: working.expiresAt },
        );
      }
    }
  }

  const head = working.waypoints[0];
  // #2352 — 구 hydrate-issued D1 관측(#2283/#2308)은 autoLockCandidate 응답 필드 노출을 전제로
  // 한 계측이었다. 필드 삭제로 "hydrate 받을 수 있는 응답이 나갔다"는 사실 자체가 더 이상 발생하지
  // 않으므로 함께 제거 — 없는 채널을 있다고 관측하는 오탐 신호를 막는다.
  return c.json({
    ok: true,
    // #2645 PR 코드리뷰 MEDIUM-3 — 요청값(advance.shiftedCount)이 아니라 실제 적용값.
    advanced: appliedShiftedCount > 0,
    currentWaypoint: head ? head.stationName : null,
    nextStation: head ? head.stationName : null,
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
 * #2624 — sync 기반 SSoT advance의 단조성 가드.
 *
 * `waypoints`(sync 도달 시점의 pre-slice 잔여 경로)를 프레임으로 삼아, SSoT.currentStationId와
 * candidate(sync 관측역)의 상대 순서를 비교한다.
 *
 *   - SSoT.currentStationId가 이 waypoints 프레임에 없으면(이미 지나간 역이거나 이 경로 프레임보다
 *     뒤에 있는 경우) 후퇴 우려가 없어 허용(true).
 *   - candidate가 이 waypoints 프레임에 없으면(호출부가 항상 findIndex-matched 역만 넘기므로
 *     실질 발생 X, defense-in-depth) 허용(true).
 *   - 둘 다 프레임 내에 있고 candidate가 SSoT보다 앞선 index(더 이른 순번)면 후퇴 — 차단(false).
 *     cron(`advanceTripPosition`)이 이미 이 sync보다 앞서 SSoT를 전진시킨 경우가 여기 해당.
 */
export function isSsotSyncAdvanceMonotonic(
  waypoints: Trip['waypoints'],
  ssotCurrentStationId: string,
  candidateStationName: string,
): boolean {
  const ssotIdx = waypoints.findIndex((w) => w.stationName === ssotCurrentStationId);
  if (ssotIdx < 0) return true;
  const candidateIdx = waypoints.findIndex((w) => w.stationName === candidateStationName);
  if (candidateIdx < 0) return true;
  return candidateIdx >= ssotIdx;
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
    // #2308 — head 정체성 anchor. count 대신 hopIndex로 재등록 시 slice해 route 재계산에도
    // 단조 전진을 보장한다 (applyProgress 참고).
    headHopIndex: trip.waypoints[0]?.hopIndex,
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
    createJsonLogger(),
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
 * #2308 — 단조 전진 불변식: progress에 기록된 head waypoint(`headHopIndex`)를 incoming
 * waypoints 시퀀스에서 다시 찾아 그 지점부터 slice한다.
 *
 * `progress.shiftedCount`(카운트)만으로 slice하면, POST /trips 재등록 사이에 incoming의
 * waypoints 시퀀스 자체가 바뀐 경우(route 재계산 / 환승 leg 재산출 / 기기가 origin부터 다시
 * 산출한 full route 재전송 등) count는 유효 범위 안에 있어도 완전히 다른(구노선) waypoint를
 * head로 재anchor한다 — 아침 07:37~07:44 trip_events 되감김(#2308 RCA) 재현 경로.
 *
 * `headHopIndex`는 waypoint의 원본 시퀀스 위치로 shift와 무관하게 불변(types.ts Waypoint.hopIndex
 * 계약) — count 대신 이 값으로 incoming에서 "같은 waypoint"를 재식별하면 시퀀스가 바뀌어도 head
 * 정체성이 보존된다. incoming에 해당 hopIndex가 없으면(진짜 다른 route로 재계산된 경우) count
 * 기반 추정은 신뢰할 수 없으므로 slice를 포기하고 `base.waypoints`(이미 advance된 현재 진행분)를
 * 그대로 보존한다 — 절대 뒤로 되감기지 않는다.
 *
 * `headHopIndex`가 없는 legacy progress(구 client / 구 progress 엔트리)는 기존 count 기반
 * 정책으로 fallback해 하위호환을 유지한다.
 */
export function applyProgress(
  base: Trip,
  incoming: Trip,
  progress: TripProgress,
): Trip {
  const waypoints = resolveProgressWaypoints(base.waypoints, incoming.waypoints, progress);
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

export function resolveProgressWaypoints(
  baseWaypoints: Trip['waypoints'],
  incomingWaypoints: Trip['waypoints'],
  progress: TripProgress,
): Trip['waypoints'] {
  if (progress.headHopIndex !== undefined) {
    const idx = incomingWaypoints.findIndex((w) => w.hopIndex === progress.headHopIndex);
    // #2308 — 단조 전진 불변식: 못 찾으면(route 시퀀스 자체가 다름) count로 추측 slice하지
    // 않고 이미 advance된 base.waypoints를 그대로 유지 — 구노선 되감김 차단.
    return idx >= 0 ? incomingWaypoints.slice(idx) : baseWaypoints;
  }
  // legacy fallback — headHopIndex 없는 구 progress 엔트리는 기존 count 기반 정책.
  const sliced = incomingWaypoints.slice(progress.shiftedCount);
  return sliced.length > 0 ? sliced : baseWaypoints;
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
    // #2651 — boarding-prompt opt-in 시그널(useNavigationStore.navigationActive forward).
    // 미송신/비boolean이면 undefined(default false, 기존 gate-less 발사 동작 보존 X — 신규 게이트
    // 자체가 opt-in 없으면 완전 침묵으로 바뀌는 것이 이번 이슈의 목적).
    promptOptIn: typeof obj.promptOptIn === 'boolean' ? obj.promptOptIn : undefined,
    // #2524 — 탑승 커밋(PENDING lock) 시그널. 미송신/비boolean이면 undefined(default false, 기존
    // lockless "통과" 동작 보존).
    boardingCommitted:
      typeof obj.boardingCommitted === 'boolean' ? obj.boardingCommitted : undefined,
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

/**
 * #2579 (Epic #2239 P0-a, 리뷰 반영) — seoul-capture recorder를 R2로 flush할지 판정 + 스케줄.
 * `handler.scheduled`의 정상 완료 경로/throw 경로 양쪽에서 호출된다 — runScheduled가
 * throw해도 그 cycle의 recorder.entries(RCA에 가장 필요한 실패 cycle)가 유실되지 않도록.
 *
 * - `scanned`가 확보된(정상 완료) 경우: `scanned > 0` 게이트로 idle cycle write 0 유지.
 * - `scanned`가 없는(throw) 경우: 게이트를 `entries.length > 0`만으로 완화 — stats 자체를
 *   구할 수 없었던 실패 cycle이므로 scanned 게이트를 적용할 수 없다.
 * - active cycle(scanned>0)인데 entries가 0건이면 캡처 자체가 죽은 blackout 신호이므로
 *   flush 없이도 관측 가능하도록 로그 1줄을 남긴다.
 */
function scheduleSeoulCaptureFlush(
  env: Env,
  ctx: ExecutionContext,
  log: (msg: string, meta?: Record<string, unknown>) => void,
  cycleStartMs: number,
  recorder: SeoulCaptureRecorder,
  scanned: number | undefined,
): void {
  if (!env.TELEMETRY_R2) return;

  if (recorder.entries.length === 0) {
    if (scanned !== undefined && scanned > 0) {
      log('seoul-capture empty on active cycle', { scanned });
    }
    return;
  }

  // 정상 완료 경로인데 idle(scanned=0)이면 write 0 게이트 유지 (#2073 lesson).
  if (scanned !== undefined && scanned <= 0) return;

  const cycle: SeoulCaptureCycle = {
    schemaVersion: 1,
    cycleStartMs,
    // throw 경로는 runScheduled stats를 구하지 못해 실 scanned 값을 모른다 — -1 sentinel로
    // "cycle 실패로 scanned 미확보"를 표시(0과 구분, RCA에서 실패 cycle 식별용).
    scanned: scanned ?? -1,
    seoulCalls: recorder.entries.length,
    entries: recorder.entries,
    ...(recorder.droppedEntries > 0 ? { droppedEntries: recorder.droppedEntries } : {}),
  };
  const r2 = env.TELEMETRY_R2;
  const key = buildSeoulCaptureKey(cycleStartMs);
  const bytes = recorder.totalBodyBytes;
  ctx.waitUntil(
    flushSeoulCapture(r2, cycle)
      .then(() => log('seoul-capture flushed', { key, entries: cycle.entries.length, bytes }))
      .catch((err) => void captureBackendException(env, err, { path: 'scheduled/seoulCapture' })),
  );
}

/**
 * #2615 (재설계, 코드리뷰 F5/F7) — 순수 함수로 분리한 mid-cycle 시작 가드. `elapsedMs`(pass가
 * 실제로 시작하려는 시각 - cron cycle 시작 시각)가 `MID_CYCLE_START_GUARD_MS`를 넘으면 다음
 * cron tick(t+60)과 겹칠 위험이 있어 true(guarded=skip)를 반환한다. 대기(setTimeout) 이후
 * 최종 확인용 — F5 드리프트 보정 후에도 극단적으로 콜백 실행 자체가 지연된 경우의 이중 안전판.
 */
export function isMidCycleStartGuarded(elapsedMs: number): boolean {
  return elapsedMs >= MID_CYCLE_START_GUARD_MS;
}

/**
 * #2615 (재설계, 코드리뷰 10건 판정 — denylist runScheduled 재진입 → allowlist in-memory
 * 연속) — 1차 `runScheduled`가 반환한 `stats.midCycleSnapshot`(lock-active인데 이번 tick에
 * 미확증인 trip 목록)을 클로저로 들고 있다가 `MID_CYCLE_OFFSET_MS`(30s) 뒤 `runMidCycleFireOnly`
 * (fire-only, KV/SSoT 상태 변형 0)로 넘긴다. `runScheduled`를 재진입하지 않는다.
 *
 * F5 — t+30 anchor 드리프트 보정: 1차 pass 자체가 처리에 걸린 시간(`elapsedSoFar`)만큼
 * 대기 시간에서 빼 `cycleStartMs + MID_CYCLE_OFFSET_MS`에 최대한 가깝게 착지시킨다. 보정
 * 후 남은 대기가 `MID_CYCLE_MIN_REMAINING_MS`(10s) 미만이면(이미 늦었거나 거의 안 남았으면)
 * 스케줄 자체를 스킵한다 — 짧은 대기 뒤 곧바로 다음 cron과 경합할 실익이 없다.
 * F7 — 가드 상수(`MID_CYCLE_START_GUARD_MS`)는 `CRON_INTERVAL_MS - 10_000`으로 파생해
 * cron 주기가 바뀌어도 magic number 재조정 없이 따라오게 한다.
 *
 * 리스크 관리(이슈 본문 + 리뷰 반영):
 *   1. double-fire — mid pass는 KV dedup GET을 하지 않고 in-memory로만 이번 pass 내 중복을
 *      막는다(`runMidCycleFireOnly`). cross-cycle 중복은 device의 동일 collapse-id가 1개로
 *      교체 — D1엔 `midCycle:true` meta로 구분되는 중복 fire-attempt가 남을 수 있음(트레이드오프).
 *   2. quota — `polled > 0`(lock-active trip 존재) 게이트로 idle cycle 추가 호출 0. mid pass는
 *      스냅샷의 trip만 재조회(광역 self-poll 없음) + KV는 발사 성공 시 best-effort 1 put만.
 *   3. 겹침 — 위 F5 사전 보정 + `isMidCycleStartGuarded` 사후 확인의 이중 가드.
 *
 * fresh `SeoulArrivalClient`를 사용해 1차 pass의 15s in-memory 캐시와 분리한다.
 */
function scheduleMidCyclePass(
  env: Env,
  ctx: ExecutionContext,
  cycleStartMs: number,
  polled: number,
  snapshot: readonly MidCycleTripSnapshot[],
  archFlag: ArchFlagValue,
  log: (msg: string, meta?: Record<string, unknown>) => void,
): void {
  if (!(polled > 0) || !snapshot || snapshot.length === 0) return;

  const elapsedSoFar = Date.now() - cycleStartMs;
  const remainingMs = MID_CYCLE_OFFSET_MS - elapsedSoFar;
  if (remainingMs < MID_CYCLE_MIN_REMAINING_MS) {
    log('mid-cycle: skip (insufficient remaining time before t+30 anchor)', {
      elapsedSoFar,
      remainingMs,
    });
    return;
  }

  ctx.waitUntil(
    new Promise<void>((resolve) => setTimeout(resolve, remainingMs)).then(async () => {
      const elapsedMs = Date.now() - cycleStartMs;
      if (isMidCycleStartGuarded(elapsedMs)) {
        log('mid-cycle: skip (start guard, would overlap next cron)', { elapsedMs });
        return;
      }
      const seoul = new SeoulArrivalClient({ apiKey: env.SEOUL_API_KEY, host: env.SEOUL_API_HOST });
      const apnsConfig = {
        keyId: env.APNS_KEY_ID,
        teamId: env.APNS_TEAM_ID,
        privateKeyPem: env.APNS_PRIVATE_KEY,
        bundleId: env.APNS_BUNDLE_ID,
      };
      const apnsHosts = { production: env.APNS_HOST, sandbox: env.APNS_HOST_SANDBOX };
      try {
        const midStats = await runMidCycleFireOnly(
          env,
          snapshot,
          { seoul, apnsConfig, apnsHosts, archFlag },
          Date.now(),
          log,
          () => crypto.randomUUID(),
        );
        log('mid-cycle pass complete', { ...midStats });
      } catch (err) {
        void captureBackendException(env, err, { path: 'scheduled/midCyclePass' });
      }
    }),
  );
}

// #2073 — named export(테스트 전용). default export는 Sentry.withSentry HOC로 감싸져 있어
// `handler.scheduled`를 직접 단위 테스트하려면 HOC를 우회할 진입점이 필요하다.
export const handler = {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    sentryInit(env);
    // #2579 (Epic #2239 P0-a) — cron cycle 동안의 Seoul API raw 요청/응답을 fetchImpl
    // 레벨에서 캡처한다. 파싱 로직(seoul.ts)은 그대로, recorder는 순수 관찰자.
    const cycleStartMs = Date.now();
    const seoulCaptureRecorder = createSeoulCaptureRecorder(env.SEOUL_API_KEY);
    const seoul = new SeoulArrivalClient({
      apiKey: env.SEOUL_API_KEY,
      host: env.SEOUL_API_HOST,
      fetchImpl: seoulCaptureRecorder.fetchImpl,
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
    const log = createJsonLogger({ archFlag, killSwitchLocklessIntermediate });

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
      // #2579 리뷰 — runScheduled가 throw해도 이번 cycle의 seoul-capture entries(RCA에
      // 가장 필요한 실패 cycle)를 유실하지 않도록 rethrow 전에 flush 스케줄.
      // scanned를 구하지 못했으므로 scanned 게이트 없이 entries>0이면 flush(함수 내부 처리).
      scheduleSeoulCaptureFlush(env, ctx, log, cycleStartMs, seoulCaptureRecorder, undefined);
      throw err;
    }
    // #2615 (서비스체인① 1단계, 재설계) — 1차 pass가 만든 mid-cycle 스냅샷(lock-active인데
    // 이번 tick에 미확증인 trip)을 t+30 경량 fire-only pass로 넘긴다. runScheduled가 throw한
    // cycle(위 catch → throw)은 scheduledStats를 구하지 못하므로 이 라인에 도달하지 않는다 —
    // 2차 pass도 자연히 skip(보수적).
    scheduleMidCyclePass(
      env,
      ctx,
      cycleStartMs,
      scheduledStats.polled,
      scheduledStats.midCycleSnapshot,
      archFlag,
      log,
    );
    // #2579 (Epic #2239 P0-a) — active trip이 있던 cycle(scanned>0)에 한해 캡처를 R2로
    // flush. idle cycle write 0 게이트(#2073 lesson 재발 금지). flush 실패는 cron 본
    // 흐름에 영향을 주면 안 되므로 waitUntil + swallow (함수 내부 처리).
    scheduleSeoulCaptureFlush(env, ctx, log, cycleStartMs, seoulCaptureRecorder, scheduledStats.scanned);
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
          skippedEmpty: scheduledStats.boardingPromptSkippedEmpty,
          skippedTrainDuplicate: scheduledStats.boardingPromptSkippedTrainDuplicate,
          // #2651 (PR #2772 전체 리뷰, 항목 6a) — opt-in 게이트 skip도 forward해야 1주 측정
          // plan이 "무의향 trip이 실제로 차단되는지"를 obs-metrics에서 관측할 수 있다.
          skippedNoOptIn: scheduledStats.boardingPromptSkippedNoOptIn,
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
