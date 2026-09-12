-- Phase 1: backend 오류 로그
-- backend cron throw / API error / KV race 등 누적 테이블.
-- Sentry와 별개 — 우리 backend에서 SQL로 직접 쿼리 가능.
CREATE TABLE IF NOT EXISTS backend_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  endpoint TEXT NOT NULL,
  error_type TEXT NOT NULL,
  message TEXT,
  stack TEXT,
  context TEXT,
  resolved INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_errors_ts ON backend_errors(ts);
CREATE INDEX IF NOT EXISTS idx_errors_type ON backend_errors(error_type);

-- Phase 2: trip 단위 acceptance metric
-- "Day N chain complete 비율" 같은 SQL 쿼리 지원.
-- started_at 기준 시계열. trip 종료 시 적재.
CREATE TABLE IF NOT EXISTS trip_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_token_hash TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT,
  origin_station TEXT,
  destination_station TEXT,
  line_list TEXT,
  fired_count INTEGER NOT NULL DEFAULT 0,
  suppressed_count INTEGER NOT NULL DEFAULT 0,
  silent_push_received INTEGER NOT NULL DEFAULT 0,
  boarding_prompt_displayed INTEGER NOT NULL DEFAULT 0,
  boarding_prompt_responded INTEGER NOT NULL DEFAULT 0,
  lock_attached INTEGER NOT NULL DEFAULT 0,
  environment_distribution TEXT,
  chain_complete INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_trips_started ON trip_metrics(started_at);
CREATE INDEX IF NOT EXISTS idx_trips_token ON trip_metrics(trip_token_hash);
