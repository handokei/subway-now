/**
 * #1578 — Phase 0 P0-2: Backend Sentry wire.
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
 * **Cloudflare SDK 사용 방식 (Phase 0 minimal)**:
 *   `@sentry/cloudflare`는 `withSentry` HOC + `CloudflareClient` 패턴을 권장한다.
 *   Phase 0에서는 `captureMessage` (from `@sentry/core` re-export)와 자체 bound flag만
 *   사용한다. 정식 `withSentry` 적용은 후속 PR(Phase 1 측정 인프라 통합)에서.
 *   현재 모듈은 DSN 부재 시 100% no-op이라 production runtime 영향 없음.
 */

import { addBreadcrumb, captureMessage } from '@sentry/cloudflare';
import {
  hashTripToken,
  sanitizeContext,
} from '../../../src/shared/infra/monitoring/tripTokenHash';
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
 * cron `scheduled()` / `fetch` 진입부에서 1회 호출. DSN 부재 시 no-op.
 *
 * Phase 0: DSN 존재 여부만 stamp + console.info. 실제 `withSentry` HOC bind는 후속 PR.
 * 본 구현은 captureMessage 호출 시 SDK 내부에서 active client가 없으면 no-op이므로 안전.
 */
export function sentryInit(env: Env): void {
  if (initialized) return;
  if (!env.SENTRY_DSN) return;
  configuredDsn = env.SENTRY_DSN;
  initialized = true;
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
