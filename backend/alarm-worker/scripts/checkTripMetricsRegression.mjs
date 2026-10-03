#!/usr/bin/env node
/**
 * `trip_metrics` 회귀 런북 — 옵션 B(#2795). CI 게이트가 아니다(프로덕션 D1 조회) —
 * 수동/주기 실행.
 *
 * 쿼리 생성/응답 파싱/리포트 포맷은 `../src/checkTripMetricsRegression.ts`(vitest 커버) —
 * 이 파일은 `wrangler d1 execute --config wrangler.toml` 실행(I/O)만 하는 얇은 셸이다
 * (`fixtureFromTrip.mjs`와 동일 분리 원칙).
 *
 * **절대 bare `wrangler d1 execute`를 직접 실행하지 않는다** — CLAUDE.md #2698과 동일한
 * 이유(상위 루트 `wrangler.jsonc` 하이재킹 위험)로 `--config wrangler.toml`을 명시한다.
 *
 * Usage: node scripts/checkTripMetricsRegression.mjs [--db subway-now-db] [--local]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRegressionCheckQuery,
  formatRegressionReport,
  parseRegressionCheckResponse,
} from '../src/checkTripMetricsRegression.ts';
import { parseArgs, runCli } from './cliUtils.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
/**
 * `backend/alarm-worker/`(wrangler.toml이 있는 곳) 절대 경로 — 다른 cwd에서 실행해도
 * wrangler가 `--config`를 이 디렉토리 기준으로 찾을 수 있도록 고정한다(`fixtureFromTrip.mjs`
 * 와 동일 이유).
 */
const BACKEND_DIR = path.join(SCRIPT_DIR, '..');
const DEFAULT_DB = 'subway-now-db';
const REGRESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

const BOOLEAN_FLAGS = ['local'];

function main() {
  const args = parseArgs(process.argv.slice(2), BOOLEAN_FLAGS);
  const db = args.db ?? DEFAULT_DB;
  const local = args.local === true;

  const now = Date.now();
  const windowStart = now - REGRESSION_WINDOW_MS;
  const sql = buildRegressionCheckQuery(windowStart);

  // 절대 bare wrangler 금지(CLAUDE.md #2698) — `--config wrangler.toml` 명시.
  const d1Args = [
    'd1',
    'execute',
    db,
    local ? '--local' : '--remote',
    '--config',
    'wrangler.toml',
    '--json',
    '--command',
    sql,
  ];

  let stdout;
  try {
    stdout = runCli(SCRIPT_DIR, d1Args, { cwd: BACKEND_DIR, maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    throw new Error(`D1 조회 실패: wrangler d1 execute 실행 실패 (${err instanceof Error ? err.message : String(err)})`);
  }

  const rows = parseRegressionCheckResponse(stdout);
  console.log(formatRegressionReport(rows, now));

  // 회귀 발견 시 exit code 1 — CI 게이트는 아니지만 셸/알림 스크립트에서 체이닝 가능하도록.
  if (rows.length > 0) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
