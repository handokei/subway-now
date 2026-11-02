-- #3221 PR-3a — 탑승 질문 발사 기록(prompt_fires). 계획: tasks/plan-2026-11-02-la-button-train-refresh.md §3.1.
-- 단일 writer = cron `fireBoardingPromptForAnchor`(fire-once 차단 통과 직후·LA/알림 송신 전). trip 레코드(KV) 밖이라
-- 재등록·60s 캐시 되돌림에 영향받지 않는다. 소비자: (1) LA heartbeat가 lock 없을 때 최신 발사 열차를 content에 복구,
-- (2) PR-3b `verifyLaCandidate`가 "더 새 발사가 있는가"를 판정.
--   token_hash : hashTripToken(trip.token) — trip_events와 동일.
--   station    : 질문 anchor 역(leg-1=출발역, leg-2=boardingStation).
--   line       : 노선 **코드**('7') — 정식 노선명('7호선') 아님.
--   train_code : 발사 열차. ambiguity 발사(열차 특정 실패)는 NULL — 열차 미표시.
--   issued_at  : 발사 now(epoch ms) = 알림 sentAt = LA content trainCodeIssuedAtMs.
--   decision   : 발사 사유(gateDecision: imminent / approaching / fallback-unobservable ...).
-- 보존: trip_events와 같은 7일(TRIP_EVENT_RETENTION_MS), 같은 시 단위 cleanup 게이트에서 삭제.
CREATE TABLE IF NOT EXISTS prompt_fires (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL,
  station TEXT NOT NULL,
  line TEXT NOT NULL,
  train_code TEXT,
  issued_at INTEGER NOT NULL,
  decision TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prompt_fires_anchor ON prompt_fires (token_hash, station, line, issued_at);
CREATE INDEX IF NOT EXISTS idx_prompt_fires_issued_at ON prompt_fires (issued_at);
