# Plan #1835 — backend Cloudflare D1 도입

**SSoT**: 본 문서. audit 결과 BG agent 자율 갱신.

## 1. 배경

### 현재 backend DB 한계

- **KV만** — key-value, 단순 stamp/cache
- 관계형 쿼리 X — "어제 boarding-prompt blocked 횟수" SQL 불가
- 통계 / metric / 오류 로그 분석 도구 부재
- D1 미사용 (사용자 결정 2026-06-26)

### D1 가치

- **관계형 쿼리** (SQLite)
- 비용 0 — Free tier 5GB / 5M reads / 100k writes per day
- 사용자 늘어도 한참 동안 Free
- Sentry 보완 (Sentry는 외부 SaaS, D1은 우리 backend)

## 2. 채택 데이터 — 3 카테고리

### A. 오류 로그 (Phase 1)

```sql
CREATE TABLE backend_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,            -- epoch ms
  endpoint TEXT NOT NULL,
  error_type TEXT NOT NULL,
  message TEXT,
  stack TEXT,
  context TEXT,                   -- JSON (token hash, line 등)
  resolved BOOLEAN DEFAULT 0
);

CREATE INDEX idx_errors_ts ON backend_errors(ts);
CREATE INDEX idx_errors_type ON backend_errors(error_type);
```

목적: backend cron throw / API error / KV race 등 누적. Sentry와 별 — 우리 backend SQL 쿼리.

### B. Trip 메타 + acceptance metric (Phase 2)

```sql
CREATE TABLE trip_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_token_hash TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  origin_station TEXT,
  destination_station TEXT,
  line_list TEXT,                  -- JSON array
  fired_count INTEGER DEFAULT 0,
  suppressed_count INTEGER DEFAULT 0,
  silent_push_received INTEGER DEFAULT 0,
  boarding_prompt_displayed INTEGER DEFAULT 0,
  boarding_prompt_responded INTEGER DEFAULT 0,
  lock_attached BOOLEAN DEFAULT 0,
  environment_distribution TEXT,   -- JSON {surface, underground, hybrid, unknown}
  chain_complete BOOLEAN DEFAULT 0
);

CREATE INDEX idx_trips_started ON trip_metrics(started_at);
CREATE INDEX idx_trips_token ON trip_metrics(trip_token_hash);
```

목적: trip 단위 acceptance metric. "Day 3 trip chain complete 비율" 같은 SQL 쿼리.

### C. Station collaborative 매핑 (Phase 3, 사용자 N명 시)

```sql
CREATE TABLE station_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id TEXT NOT NULL,
  signal_type TEXT NOT NULL,       -- 'cell_id' | 'bssid' | 'fingerprint'
  signal_value TEXT NOT NULL,
  confidence REAL,
  observed_count INTEGER DEFAULT 1,
  last_observed_at INTEGER
);

CREATE INDEX idx_signals_station ON station_signals(station_id);
CREATE INDEX idx_signals_value ON station_signals(signal_type, signal_value);
```

목적: Phase 6.2~6.3 collaborative learning (cell ID + BSSID 매핑). 사용자 N명에서 자동 학습 누적.

→ **Phase 1+2 먼저 진행, Phase 3은 사용자 ≥10명 시 진행**

## 3. wrangler.toml 변경

```toml
# Cloudflare D1 — backend metrics + error log
# (사용자 결정 2026-06-26 — issue #1835)
#
# 운영자 1회성 등록 절차:
#   1) `wrangler d1 create subway-now-db`
#   2) 출력된 database_id를 아래 binding에 채운다
#   3) `wrangler d1 migrations apply subway-now-db --remote` (schema 마이그레이션)
#   4) `wrangler deploy`
[[d1_databases]]
binding = "DB"
database_name = "subway-now-db"
database_id = "FILL_IN_AFTER_wrangler_d1_create"
```

## 4. 코드 변경

### A. D1 binding 정의

`backend/alarm-worker/src/types.ts`:
```ts
export interface Env {
  TRIPS: KVNamespace;
  // ... 기존
  DB?: D1Database;  // optional — Free tier graceful (모든 caller `if (env.DB)` 분기)
}
```

### B. 오류 로그 helper

`backend/alarm-worker/src/d1ErrorLog.ts` (신규):
```ts
export async function logBackendError(
  db: D1Database | undefined,
  input: { endpoint: string; errorType: string; message?: string; stack?: string; context?: object }
): Promise<void> {
  if (!db) return;  // Free tier no-op
  await db.prepare(
    'INSERT INTO backend_errors (ts, endpoint, error_type, message, stack, context) VALUES (?, ?, ?, ?, ?, ?)'
  )
  .bind(Date.now(), input.endpoint, input.errorType, input.message ?? null, input.stack ?? null, JSON.stringify(input.context ?? {}))
  .run();
}
```

### C. Sentry 통합 (D1 + Sentry 양쪽 적재)

`backend/alarm-worker/src/sentry.ts`:
```ts
export async function captureBackendException(env: Env, error: Error, context?: object) {
  // 1. Sentry (외부 SaaS)
  if (sentryInitialized) {
    Sentry.captureException(error, { contexts: { custom: context } });
  }
  // 2. D1 (우리 backend SQL)
  await logBackendError(env.DB, {
    endpoint: context?.endpoint ?? 'unknown',
    errorType: error.name,
    message: error.message,
    stack: error.stack,
    context,
  });
}
```

### D. trip_metrics 적재

`backend/alarm-worker/src/d1TripMetrics.ts` (신규):
- trip 종료 시 (DELETE /trips) 호출
- 또는 cron이 매분 누적 (선택)

### E. 마이그레이션

`backend/alarm-worker/migrations/0001_initial.sql`:
- Phase 1+2 schema (backend_errors + trip_metrics)
- Phase 3 schema는 후속 PR

## 5. 운영자 절차

```bash
cd backend/alarm-worker

# 1. D1 DB 생성
npx wrangler d1 create subway-now-db

# 출력 예시:
# ✨ Successfully created DB 'subway-now-db'
# database_id = "abc123-def456-..."

# 2. wrangler.toml에 database_id 채움 (자동 또는 우리가 Edit)

# 3. 마이그레이션 적용
npx wrangler d1 migrations apply subway-now-db --remote

# 4. deploy
npx wrangler deploy

# 5. verify
npx wrangler d1 execute subway-now-db --command "SELECT name FROM sqlite_master WHERE type='table'"
# 출력: backend_errors, trip_metrics
```

## 6. Audit 결과 (2026-06-26, BG agent 완료)

1. **wrangler 4 D1 명령어**: `wrangler d1 create` / `wrangler d1 migrations apply --remote` /
   `wrangler d1 execute --command` 모두 wrangler 4.x 정확. plan §5 명령어 그대로 유효.

2. **D1 binding type**: `Env` 인터페이스에 `DB?: D1Database` 추가 완료 (types.ts).
   `@cloudflare/workers-types` 4.x에 D1Database 내장 — 별도 import 불필요.

3. **captureBackendException과 D1 통합 path**: 기존 `captureBackendException(err, context)` 시그니처
   변경 없이 유지. caller 13곳 수정 불필요. `logBackendError`를 독립 파일(d1ErrorLog.ts)로 분리해
   catch block에서 별도 호출하는 surgical 설계 채택 — sentry.ts에 env 의존성 추가 X.

4. **trip_metrics 적재 위치**: `cleanupTripWithLa` (liveActivity.ts) 가 모든 trip 종료 경로
   (cron 4곳 + HTTP DELETE 1곳)의 단일 진입점. 여기에 `recordTripMetrics` 호출 wire 완료.

5. **Phase 3 schema**: 별도 PR로 분리 확정. 사용자 ≥10명 후 진행. 본 PR에서 migrations/
   0001_initial.sql은 Phase 1+2 schema만 포함.

## 7. Acceptance

- `npx wrangler d1 execute subway-now-db --command "SELECT COUNT(*) FROM backend_errors"` 가능
- backend cron throw 발생 시 D1에 적재 (1주 후 SQL 쿼리 가능)
- trip 종료 시 trip_metrics 적재
- Free tier 안 (5M reads/day, 100k writes/day)

## 8. Out of scope

- Phase 3 (station_signals collaborative) — 사용자 ≥10명 후
- D1 dashboard UI — Cloudflare Dashboard 활용
- SQL 쿼리 자동화 (별 PR)

## 9. Wire-completion 5단

1. Orphan: D1 helper / hook 신규 export — caller wire 검증
2. V/X dashboard: D1 SQL 쿼리 결과 (1주 통계)
3. 의존 PR: PR #1830 (Sentry wire) 머지됨 — 통합
4. 측정 plan: 1주 누적 backend_errors + trip_metrics
5. Device verify: N/A (backend only)

## 관련 메모리

- [[project_db_error_infra_backlog]] DB/오류 관리 인프라 backlog Phase 2
- Day 2 진입점: `memory/project_2026_06_25_day2_pr1819_confirmed`
- Plan #1829 RAW_SIGNALS + Sentry wire (Phase 1)

## BG agent 위임 지시

### 작업 순서

1. SSoT plan 정독
2. audit 5건
3. wrangler.toml binding 추가 (placeholder)
4. types.ts Env interface 갱신 (DB?: D1Database)
5. d1ErrorLog.ts + d1TripMetrics.ts 구현
6. sentry.ts captureBackendException 통합 (Sentry + D1 양쪽)
7. migrations/0001_initial.sql 작성
8. trip 종료 hook에서 trip_metrics 적재 wire
9. acceptance 테스트 (mock D1)
10. PR 본문에 운영자 절차 + Wire-completion 5단

### 격리 규칙

- worktree 절대 경로만
- 메인 repo `tasks/plan-1835-...`만 수정 가능
- D1 실제 binding은 사용자 운영 작업

### 자율 scope

- Phase 1+2 schema 결정 (필드 추가/삭제)
- Phase 3은 별 PR로 분리 결정
- D1 binding optional graceful
