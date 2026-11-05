-- #2268 — trip_metrics 중복 insert 방지. DELETE /trips/:token이 getTrip→cleanupTripWithLa 사이
-- 원자 가드 없이 race하면(2026-08-10 evidence: 동일 trip_token_hash 2행, 521ms차) 같은 trip 종료가
-- recordTripMetrics를 두 번 호출한다. (trip_token_hash, started_at)는 "이 trip 인스턴스의 이 종료
-- 이벤트"를 유일하게 식별 — 같은 trip이 재사용 토큰으로 나중에 다시 등록돼도 started_at
-- (createdAt)이 달라 정상 신규 행은 막지 않는다. recordTripMetrics는 `INSERT OR IGNORE`로 전환해
-- 두 번째 race 호출이 조용히 no-op되도록 한다(d1TripMetrics.ts).
-- 기존 중복 정리(2026-08-10 evidence: 원격 D1에 여러 (trip_token_hash, started_at) 그룹이 2행씩
-- 존재 확인) — unique index 생성 전 필수. 그룹당 가장 작은 id 1행만 남기고 나머지 삭제.
DELETE FROM trip_metrics
WHERE id NOT IN (
  SELECT MIN(id) FROM trip_metrics GROUP BY trip_token_hash, started_at
);

-- dedup 후 unique index 생성
CREATE UNIQUE INDEX IF NOT EXISTS idx_trip_metrics_token_started
  ON trip_metrics(trip_token_hash, started_at);
