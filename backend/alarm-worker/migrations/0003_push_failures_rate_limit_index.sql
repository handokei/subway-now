-- #2177 리뷰 P1 — logPushFailure rate-limit SELECT(token_hash, push_kind, ts)를 위한 인덱스.
-- 같은 (tokenHash, pushKind) 최종 실패가 RATE_LIMIT_WINDOW_MS 내 재기록되지 않도록 write 전
-- SELECT로 선확인한다. 이 인덱스 없이는 매 SELECT가 push_failures 풀스캔이 된다.
CREATE INDEX IF NOT EXISTS idx_push_failures_token_kind_ts ON push_failures(token_hash, push_kind, ts);
