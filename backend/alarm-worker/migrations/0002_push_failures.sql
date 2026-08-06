-- #2177 — push 발사 최종 실패 D1 기록.
-- backend_errors 는 endpoint/error_type/context(JSON) 형태라 apnsStatus/apnsReason/pushKind 같은
-- 구조화 필드로 SELECT/GROUP BY 하기엔 부적합(context json_extract 매 쿼리 필요). push 실패는
-- "사유 top N" 집계가 핵심 요구라 전용 컬럼을 가진 신규 테이블로 분리한다.
-- 성공은 기록하지 않는다(볼륨). 429/5xx transient 재시도 중간 실패도 기록하지 않고, 최종(재시도
-- 불가 판정 시점) 실패만 1건 적재한다 — CF 무료 D1 quota 보호.
CREATE TABLE IF NOT EXISTS push_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  token_hash TEXT NOT NULL,
  trip_token_hash TEXT,
  push_kind TEXT NOT NULL,
  apns_status INTEGER NOT NULL,
  apns_reason TEXT,
  apns_env TEXT,
  env_mismatch_exhausted INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_push_failures_ts ON push_failures(ts);
CREATE INDEX IF NOT EXISTS idx_push_failures_status_reason ON push_failures(apns_status, apns_reason);
