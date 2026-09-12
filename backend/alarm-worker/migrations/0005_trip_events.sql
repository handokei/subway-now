-- #2283 — append-only trip 이벤트 로그. KV trip 객체와 독립적으로 보존된다.
-- user-delete(DELETE /trips/:token)가 KV trip 객체 + position series까지 삭제하면
-- "환승 swap sync가 도달했는지 / advance가 발생했는지"를 사후 재구성할 방법이 없었다
-- (2026-08-11 RCA blind spot, 08-11 A' 검증 판정 불가의 직접 원인).
-- kind 최소 집합: sync-received / advance / hydrate-issued / trip-end.
-- trip_token_hash는 trip 삭제 후에도 타임라인 조회 키로 남는다 — KV FK 없음(의도적 독립).
CREATE TABLE IF NOT EXISTS trip_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  station TEXT,
  line TEXT,
  meta TEXT
);

CREATE INDEX IF NOT EXISTS idx_trip_events_ts ON trip_events(ts);
CREATE INDEX IF NOT EXISTS idx_trip_events_token_hash ON trip_events(token_hash, ts);
