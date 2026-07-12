/**
 * #1578/#1829 — Backend Sentry wire (Phase 1 완성).
 *
 * V/X acceptance 표(X3 stale, X8 6h+ 좀비 등)의 backend-side 실시간 alert.
 *
 * **Privacy / PII 정책**:
 *   - `tripToken`은 `hashTripToken`으로 8자 hash 후 전송.
 *   - GPS 원본 좌표/푸시 토큰 전송 금지.
 *
 * **graceful no-op**:
 *   - `env.SENTRY_DSN` 미설정 시 init/capture 모두 no-op.
 *   - SDK 호출 실패 시 swallow + console.warn (cron path 영향 X).
 *
 * **Cloudflare SDK 사용 방식 (#1829 Phase 1)**:
 *   `withSentry` HOC + `CloudflareClient` 패턴.
 *   `index.ts`의 `export default`를 `Sentry.withSentry(sentryOptions, handler)` 로 wrap.
 *   `sentryInit`은 하위 호환 유지 (middleware + scheduled에서 idempotent 호출).
 */

import { addBreadcrumb, captureException, captureMessage } from '@sentry/cloudflare';
import type { CloudflareOptions } from '@sentry/cloudflare';
import {
  hashTripToken,
  sanitizeContext,
} from '../../../src/shared/infra/monitoring/tripTokenHash';
import { logBackendError } from './d1ErrorLog';
import type { Env } from './types';

export { hashTripToken };

export type BackendXEventName =
  | 'X1-wrong-station-alarm'
  | 'X3-stale-alarm'
  | 'X4-spam-suppress'
  | 'X6-late-alarm'
  | 'X8-zombie-trip'
  | 'X11-bg-scheduled-leak';

export type BackendXEventContext = Record<
  string,
  string | number | boolean | null | undefined
>;

let initialized = false;
let configuredDsn: string | null = null;

/**
 * `withSentry` HOC에 전달하는 options 콜백. DSN 미설정 시 undefined 반환 → HOC no-op.
 *
 * `index.ts`의 `export default`를 `Sentry.withSentry(sentryOptions, handler)` 로 wrap한다.
 * environment: APNS_HOST_SANDBOX 포함 여부로 sandbox 추론 (별도 APNS_ENV 필드 없음).
 * APNS_HOST가 sandbox.push.apple.com 이면 'sandbox', 아니면 'production'.
 */
export function sentryOptions(env: Env): CloudflareOptions | undefined {
  if (!env.SENTRY_DSN) return undefined;
  const isSandbox = env.APNS_HOST.includes('sandbox');
  return {
    dsn: env.SENTRY_DSN,
    environment: isSandbox ? 'sandbox' : 'production',
  };
}

/**
 * cron `scheduled()` / `fetch` middleware 에서 1회 호출. DSN 부재 시 no-op.
 * `withSentry` HOC가 SDK를 초기화하므로, 본 함수는 모듈 스코프 flag만 stamp한다.
 * captureXEvent / addValidateRejectBreadcrumb 의 guard로 계속 사용.
 */
export function sentryInit(env: Env): void {
  if (initialized) return;
  if (!env.SENTRY_DSN) return;
  configuredDsn = env.SENTRY_DSN;
  initialized = true;
}

/**
 * 예외를 Sentry + D1 `backend_errors` 두 sink 로 포착 (#2058).
 *
 * 핵심 path(cron, /trips, /signals/dump, /live-activity/register)의 catch block에서 사용.
 * 두 sink 는 각자 try/catch 로 독립 — 한 쪽이 throw/skip 되어도 다른 쪽은 계속 진행.
 *
 * - Sentry: `initialized=false` 시 skip. SDK throw 시 swallow.
 * - D1: `env.DB` 미바인딩 시 `logBackendError` 내부에서 graceful no-op. write throw 시 swallow.
 *
 * `context` 에서 `path` 를 endpoint 로 재사용한다 (없으면 'unknown').
 * `errorType` 은 Error 인스턴스면 constructor 이름, 아니면 `typeof err`.
 *
 * fire-and-forget 컨텍스트에서는 `void captureBackendException(env, err, ctx)` 로 호출 가능.
 */
export async function captureBackendException(
  env: Env,
  err: unknown,
  context?: BackendXEventContext,
): Promise<void> {
  // Sentry sink — 독립 try/catch.
  if (initialized) {
    try {
      captureException(err, context ? { extra: sanitizeContext(context) } : undefined);
    } catch (e) {
      console.warn(JSON.stringify({ msg: 'sentry captureException failed', err: String(e) }));
    }
  }

  // D1 sink — 독립 try/catch. logBackendError 자체가 db=undefined + write throw 를 swallow 하지만
  // 방어적으로 한 번 더 wrap 해 Sentry 성공 후 D1 실패로 caller 가 throw 받는 회귀를 차단한다.
  try {
    const endpoint =
      typeof context?.path === 'string' && context.path.length > 0 ? context.path : 'unknown';
    const errorType =
      err instanceof Error ? err.constructor.name : typeof err;
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    await logBackendError(env.DB, {
      endpoint,
      errorType,
      message,
      stack,
      context: context ? sanitizeContext(context) : undefined,
    });
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'd1 backend_errors sink failed', err: String(e) }));
  }
}

/**
 * X event 발생 시 즉시 alert. opt-in/DSN 미설정 시 no-op.
 *
 * `tripToken`은 자동 hash로 변환.
 */
export function captureXEvent(
  name: BackendXEventName,
  context: BackendXEventContext = {},
): void {
  if (!initialized) return;
  try {
    captureMessage(name, {
      level: 'error',
      tags: { xEvent: name },
      extra: sanitizeContext(context),
    });
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'sentry capture failed', err: String(e) }));
  }
}

/** 진단/테스트용 — DSN 등록 여부 확인. */
export function isSentryInitialized(): boolean {
  return initialized;
}

/** 진단/테스트용 — 현재 DSN(노출 가능 시). */
export function getConfiguredDsn(): string | null {
  return configuredDsn;
}

/**
 * #1731 — validateTrip reject breadcrumb.
 *
 * DSN 미설정 시 no-op (graceful). Sentry SDK 실패 시 swallow.
 * reason: reject 사유 식별자, data: sanitized payload 조각.
 */
export function addValidateRejectBreadcrumb(
  reason: string,
  data: Record<string, string | number | boolean | null | undefined>,
): void {
  if (!initialized) return;
  try {
    addBreadcrumb({ category: 'trips-validate', level: 'warning', data: { reason, ...data } });
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'sentry addBreadcrumb failed', err: String(e) }));
  }
}

/** 테스트 격리용 — 모듈 스코프 init 상태 reset. */
export function _resetSentryForTest(): void {
  initialized = false;
  configuredDsn = null;
}
