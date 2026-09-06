/**
 * D1 backend_errors 테이블 적재 helper (#1835, Phase 1).
 *
 * Sentry와 독립. catch block에서 `logBackendError(env.DB, ...)` 단독 호출 가능.
 * `env.DB` 미바인딩 시 graceful no-op — 모든 caller는 `if (env.DB)` 분기 불필요.
 *
 * 오류 적재가 실패해도 cron/request 흐름을 차단하지 않는다 (try/catch로 swallow).
 *
 * #2227 — write 자체가 throw할 때는 `captureXEvent`(Sentry-only, D1 미의존)로 escalate한다.
 * `sentry.ts`가 이 모듈의 `logBackendError`를 D1 sink로 사용하므로, write 실패 escalate에
 * D1을 다시 타는 `captureBackendException`은 순환 재시도라 부적합 — Sentry-only 경로를 쓴다.
 */

import { captureXEvent } from './sentry';

export interface BackendErrorInput {
  endpoint: string;
  errorType: string;
  message?: string;
  stack?: string;
  context?: object;
}

/**
 * backend_errors 테이블에 오류 1건을 기록한다.
 *
 * @param db - D1 binding. undefined 시 no-op.
 * @param input - 오류 메타데이터.
 */
export async function logBackendError(
  db: D1Database | undefined,
  input: BackendErrorInput,
): Promise<void> {
  if (!db) return;
  try {
    await db
      .prepare(
        'INSERT INTO backend_errors (ts, endpoint, error_type, message, stack, context) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(
        Date.now(),
        input.endpoint,
        input.errorType,
        input.message ?? null,
        input.stack ?? null,
        JSON.stringify(input.context ?? {}),
      )
      .run();
  } catch (e) {
    console.warn(JSON.stringify({ msg: 'd1ErrorLog write failed', err: String(e) }));
    // #2227 — D1 write 무음 실패 관측 승격. D1 자체가 실패했으므로 Sentry-only 경로로 escalate.
    captureXEvent('D1-write-failure', { table: 'backend_errors', err: String(e) });
  }
}
