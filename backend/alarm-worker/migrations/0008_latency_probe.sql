-- #3168 — D1 vs KV 지연 실측 프로브 sink (관측 전용, 임시).
-- KV 무료 write 쿼터 소진으로 lock trip 시계열을 KV → D1로 옮길지 판단하려면 프로덕션 colo
-- (cron / Seoul HTTP)에서의 실제 D1 read·write / KV get 지연이 필요하다.
-- 행 수: cron ≤24/day + http ≤100/day. trip 단위 테이블(trip_events 등)은 token_hash가 필수라
-- 의미가 맞지 않아 별도 소형 테이블로 둔다. 약 3일 수집 후 프로브 코드를 제거한다.
--   source: 'cron' | 'http'
--   colo:   IATA 코드(cron=cdn-cgi/trace, http=request.cf.colo), 불명이면 'unknown'
--   d1_write_ms: INSERT 직후 UPDATE로 채운다(자기 INSERT 지연은 행 생성 시점에 알 수 없음) — nullable
CREATE TABLE IF NOT EXISTS latency_probe (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL,
  colo TEXT NOT NULL,
  d1_read_ms INTEGER NOT NULL,
  d1_write_ms INTEGER,
  kv_get_ms INTEGER NOT NULL
);
