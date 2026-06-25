/**
 * D1 backend_errors 테이블 적재 helper (#1835, Phase 1).
 *
 * Sentry와 독립. catch block에서 `logBackendError(env.DB, ...)` 단독 호출 가능.
 * `env.DB` 미바인딩 시 graceful no-op — 모든 caller는 `if (env.DB)` 분기 불필요.
 *
 * 오류 적재가 실패해도 cron/request 흐름을 차단하지 않는다 (try/catch로 swallow).
 */

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
  }
}
