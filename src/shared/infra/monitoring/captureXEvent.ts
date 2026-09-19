import * as Sentry from '@sentry/react-native';
import { isSentryEnabled } from './sentryState';
import { hashTripToken, sanitizeContext } from './tripTokenHash';

export { hashTripToken };

/**
 * #1578 — Phase 0 P0-2: V/X acceptance X1~X11 자동 alert.
 *
 * ADR-017/016 V/X 표(`feedback_v_x_acceptance_full_table`)의 11개 실시간 revert
 * 조건이 발생할 때 호출. Sentry로 즉시 alert.
 *
 * **Privacy / PII 정책**:
 *   - `tripToken`은 SHA-256 후 앞 8자 hash로만 전송 (`hashTripToken`).
 *   - GPS 원본(`lat`/`lng`) 전송 금지. 호출자가 100m 단위 round 후 전달하거나 생략.
 *   - 사용자 식별자/푸시 토큰 전체 전송 금지 (앞 8자 등 축약).
 *   - 역 이름은 공개 정보로 허용.
 *
 * **graceful no-op**:
 *   - `isSentryEnabled() === false` (opt-in 미동의 or DSN 미설정) 시 즉시 return.
 *   - Sentry SDK 호출 실패 시 catch + no-op (boot path 영향 X).
 */

export type XEventName =
  | 'X1-wrong-station-alarm'
  | 'X2-duplicate-alarm'
  | 'X3-stale-alarm'
  | 'X4-spam-suppress'
  | 'X5-mirror-leak'
  | 'X6-late-alarm'
  | 'X7-env-unknown-5min'
  | 'X8-zombie-trip'
  | 'X9-app-kill-required'
  | 'X10-cascade-mismatch'
  | 'X11-bg-scheduled-leak';

export type XEventContext = Record<string, string | number | boolean | null | undefined>;

/**
 * X event 발생 시 Sentry로 즉시 alert.
 *
 * @param name X1~X11 식별자
 * @param context 진단 컨텍스트 — `tripToken`이 있으면 자동 hash. 나머지 필드는 호출자가 PII-safe 보장.
 */
export function captureXEvent(name: XEventName, context: XEventContext = {}): void {
  if (!isSentryEnabled()) return;
  try {
    const safe = sanitizeContext(context);
    Sentry.captureMessage(name, {
      level: 'error',
      tags: { xEvent: name },
      extra: safe,
    });
  } catch {
    // SDK 실패 swallow — 측정 인프라가 production path를 막지 않는다.
  }
}

