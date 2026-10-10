# V/X Acceptance — Cloudflare Analytics Engine SQL queries

Phase 0 측정 인프라 (Epic #1576) sub-task P0-5 (#1581).

ADR-017 / ADR-016 가치(V) · 손상(X) acceptance 20개 임계를 `trip_metrics` Analytics Engine dataset에서 SQL로 직접 측정하기 위한 query 카탈로그.

데이터 source: `backend/alarm-worker/src/analytics.ts` (`writeMetric`) — 6 event type을 적재.

| Event type          | blobs                                                  | doubles                                          | index            |
| ------------------- | ------------------------------------------------------ | ------------------------------------------------ | ---------------- |
| `advance`           | `[eventType, station:?, reason:?, env:?]`              | `[staleMs?, hopIndex?, motionConfidence?]`       | `tokenPrefix(8)` |
| `fire`              | `[eventType, station:?, reason:?, env:?]`              | `[staleMs?, hopIndex?, motionConfidence?]`       | `tokenPrefix(8)` |
| `suppress`          | `[eventType, station:?, reason:?, env:?]`              | `[staleMs?, hopIndex?, motionConfidence?]`       | `tokenPrefix(8)` |
| `motion-transition` | `[eventType, reason:?, env:?]`                         | `[motionConfidence?]`                            | `tokenPrefix(8)` |
| `position-upload`   | `[eventType, env:?]`                                   | `[]`                                             | `tokenPrefix(8)` |
| `trip-mutation`     | `[eventType, reason:?]`                                | `[hopIndex?]`                                    | `tokenPrefix(8)` |

> Cloudflare Analytics Engine SQL ref: <https://developers.cloudflare.com/analytics/analytics-engine/sql-api/>. Blobs 는 `blob1..blob20`, doubles `double1..double20`, index `index1`로 노출된다. dataset 이름 = `trip_metrics`.

## 운영 컨벤션

- 모든 query는 `WHERE timestamp >= NOW() - INTERVAL '7' DAY` 기본 window. dashboard에서 1h / 1d / 7d 토글.
- `tokenPrefix(8)` 충돌 확률 = trip ~수천개 동시 추적 시 무시 가능. 정확 trip-level 집계는 `index1`로 그룹.
- V 임계 = 일일 1회 cron이 SQL 실행 → 미달 시 Slack alert (`alert-rules.md`).
- X 임계 = 1건이라도 발생하면 즉시 Sentry alert (P0-2 cross-cut).

## V — 가치 실현 (daily 집계)

### V1. currentStation == SSoT mismatch %

```sql
-- mismatch %는 advance 시점의 device-vs-SSoT 비교 결과를 reason 으로 적재
SELECT
  (SUM(CASE WHEN blob3 = 'reason:ssot-mismatch' THEN 1 ELSE 0 END) * 100.0) / COUNT(*) AS mismatch_pct
FROM trip_metrics
WHERE blob1 = 'advance'
  AND timestamp >= NOW() - INTERVAL '1' DAY;
-- 임계: < 1%
```

### V2. transfer-1-stop alarm count / hop≥2 trip

```sql
WITH transfer_trips AS (
  SELECT index1 AS token
  FROM trip_metrics
  WHERE blob1 = 'trip-mutation' AND blob2 = 'reason:route-recompute'
    AND timestamp >= NOW() - INTERVAL '1' DAY
  GROUP BY index1
  HAVING MAX(double2) >= 2  -- hopIndex 최대 ≥ 2
)
SELECT
  index1 AS token,
  COUNT(*) AS alarm_count
FROM trip_metrics
WHERE blob1 = 'fire'
  AND blob3 = 'reason:transfer-1-stop'
  AND index1 IN (SELECT token FROM transfer_trips)
  AND timestamp >= NOW() - INTERVAL '1' DAY
GROUP BY index1
HAVING alarm_count != 1;  -- 임계: 위반 trip count == 0
```

### V3. destination-1-stop alarm count / hop≥1 trip

```sql
WITH dest_trips AS (
  SELECT DISTINCT index1 AS token
  FROM trip_metrics
  WHERE blob1 = 'trip-mutation'
    AND timestamp >= NOW() - INTERVAL '1' DAY
)
SELECT
  index1 AS token,
  COUNT(*) AS alarm_count
FROM trip_metrics
WHERE blob1 = 'fire'
  AND blob3 = 'reason:destination-1-stop'
  AND index1 IN (SELECT token FROM dest_trips)
  AND timestamp >= NOW() - INTERVAL '1' DAY
GROUP BY index1
HAVING alarm_count != 1;  -- 임계: 위반 trip count == 0
```

### V4. station-passed count == SSoT.passedStations.length

```sql
SELECT
  index1 AS token,
  COUNT(*) AS passed_fire_count
FROM trip_metrics
WHERE blob1 = 'fire'
  AND blob3 = 'reason:station-passed'
  AND timestamp >= NOW() - INTERVAL '1' DAY
GROUP BY index1;
-- 임계: 동일 trip의 `advance` count와 ±1 이내 (drift 검증은 dashboard JOIN)
```

### V5. 자동 종료 trip %

```sql
SELECT
  blob3 AS end_reason,
  COUNT(*) AS trip_count
FROM trip_metrics
WHERE blob1 = 'trip-mutation'
  AND blob2 = 'reason:trip-ended'
  AND timestamp >= NOW() - INTERVAL '7' DAY
GROUP BY blob3;
-- 임계: end_reason ∈ {arrival, backstop-6h, user} 합계 / 전체 ≥ 99%
```

### V6. SSoT mirror lag histogram (ms)

```sql
SELECT
  quantile(0.50)(double1) AS p50_ms,
  quantile(0.95)(double1) AS p95_ms,
  quantile(0.99)(double1) AS p99_ms
FROM trip_metrics
WHERE blob1 = 'advance'
  AND double1 IS NOT NULL  -- staleMs
  AND timestamp >= NOW() - INTERVAL '1' DAY;
-- 임계: p95 < 5000ms
```

### V7. 지하 trip advance % (≥ 90%)

```sql
WITH underground_trips AS (
  SELECT DISTINCT index1
  FROM trip_metrics
  WHERE blob4 = 'env:underground'
    AND timestamp >= NOW() - INTERVAL '1' DAY
)
SELECT
  (SUM(CASE WHEN blob1 = 'advance' THEN 1 ELSE 0 END) * 100.0) /
  NULLIF(SUM(CASE WHEN blob1 IN ('advance', 'suppress') THEN 1 ELSE 0 END), 0) AS advance_pct
FROM trip_metrics
WHERE index1 IN (SELECT index1 FROM underground_trips)
  AND blob4 = 'env:underground'
  AND timestamp >= NOW() - INTERVAL '1' DAY;
-- 임계: ≥ 90%
```

### V8a. `/position` rate (per 10min trip)

```sql
SELECT
  index1 AS token,
  COUNT(*) AS upload_count
FROM trip_metrics
WHERE blob1 = 'position-upload'
  AND timestamp >= NOW() - INTERVAL '10' MINUTE
GROUP BY index1
HAVING upload_count > 100;  -- 임계: trip 당 ≤ 100건/10분 (위반 trip == 0)
```

### V8b. `/trips` rate (per 10min trip)

```sql
SELECT
  index1 AS token,
  COUNT(*) AS mutation_count
FROM trip_metrics
WHERE blob1 = 'trip-mutation'
  AND timestamp >= NOW() - INTERVAL '10' MINUTE
GROUP BY index1
HAVING mutation_count > 10;  -- 임계: trip 당 ≤ 10건/10분
```

### V8c. Raw signal cycle rate (정지/이동 분리)

```sql
SELECT
  blob2 AS reason,  -- moving / stationary / unknown
  COUNT(*) / 60.0 AS rate_per_minute
FROM trip_metrics
WHERE blob1 = 'motion-transition'
  AND timestamp >= NOW() - INTERVAL '1' HOUR
GROUP BY blob2;
-- 임계: stationary 상태에서 cycle rate < moving 상태의 50% (배터리 mitigation)
```

### V9. suppress event rate (per hour per trip)

```sql
SELECT
  index1 AS token,
  COUNT(*) AS suppress_count
FROM trip_metrics
WHERE blob1 = 'suppress'
  AND timestamp >= NOW() - INTERVAL '1' HOUR
GROUP BY index1
HAVING suppress_count > 30;  -- 임계: trip 당 ≤ 30/시간
```

## X — 가치 손상 (1건 발생 → 즉시 alert)

### X1. wrong-station alarm

```sql
SELECT *
FROM trip_metrics
WHERE blob1 = 'fire'
  AND blob3 = 'reason:wrong-station'
  AND timestamp >= NOW() - INTERVAL '1' DAY;
-- 임계: count == 0
```

### X2. duplicate alarm (같은 trip+station에 2회 fire)

```sql
SELECT
  index1 AS token,
  blob2 AS station,
  COUNT(*) AS fire_count
FROM trip_metrics
WHERE blob1 = 'fire'
  AND timestamp >= NOW() - INTERVAL '1' DAY
GROUP BY index1, blob2
HAVING fire_count > 1;
-- 임계: 위반 row 수 == 0
```

### X3. stale alarm (lastAdvance > 5min 시점에 fire)

```sql
SELECT *
FROM trip_metrics
WHERE blob1 = 'fire'
  AND double1 > 300000  -- staleMs > 5min
  AND timestamp >= NOW() - INTERVAL '1' DAY;
-- 임계: count == 0
```

### X4. spam suppress (> 10건/trip)

```sql
SELECT
  index1 AS token,
  COUNT(*) AS suppress_count
FROM trip_metrics
WHERE blob1 = 'suppress'
  AND timestamp >= NOW() - INTERVAL '10' MINUTE
GROUP BY index1
HAVING suppress_count > 10;
-- 임계: 위반 trip count == 0
```

### X5. mirror leak (trip switch 직후 stale entry로 fire/advance)

```sql
SELECT *
FROM trip_metrics
WHERE blob1 IN ('fire', 'advance')
  AND blob3 = 'reason:mirror-leak'
  AND timestamp >= NOW() - INTERVAL '1' DAY;
-- 임계: count == 0
```

### X6. late alarm (fire 시각 > 실제 도착 + 30s)

```sql
SELECT *
FROM trip_metrics
WHERE blob1 = 'fire'
  AND blob3 = 'reason:late'
  AND double1 > 30000  -- 도착 대비 지연 ms
  AND timestamp >= NOW() - INTERVAL '1' DAY;
-- 임계: count == 0
```

### X7. env=unknown ≥ 5min trip

```sql
WITH unknown_runs AS (
  SELECT
    index1 AS token,
    MIN(timestamp) AS start_ts,
    MAX(timestamp) AS end_ts
  FROM trip_metrics
  WHERE blob4 = 'env:unknown'
    AND timestamp >= NOW() - INTERVAL '1' DAY
  GROUP BY index1
)
SELECT *
FROM unknown_runs
WHERE date_diff('minute', start_ts, end_ts) >= 5;
-- 임계: 위반 trip count == 0
```

### X8. trip 6h+ 잔존

```sql
SELECT
  index1 AS token,
  MIN(timestamp) AS first_seen,
  MAX(timestamp) AS last_seen,
  date_diff('hour', MIN(timestamp), MAX(timestamp)) AS duration_h
FROM trip_metrics
WHERE timestamp >= NOW() - INTERVAL '12' HOUR
GROUP BY index1
HAVING duration_h >= 6;
-- 임계: 위반 trip count == 0 (자동 backstop은 V5 end_reason='backstop-6h'로 잡힘)
```

### X9. app kill 후 fire (사용자 의도 외)

```sql
SELECT *
FROM trip_metrics
WHERE blob1 = 'fire'
  AND blob3 = 'reason:post-kill'
  AND timestamp >= NOW() - INTERVAL '1' DAY;
-- 임계: count == 0
```

### X10. fusion picker output ≠ input

```sql
SELECT *
FROM trip_metrics
WHERE blob1 = 'suppress'
  AND blob3 = 'reason:fusion-mismatch'
  AND timestamp >= NOW() - INTERVAL '1' DAY;
-- 임계: count == 0
```

### X11. BG scheduled queue 잔존 fire (trip 종료 후)

```sql
SELECT *
FROM trip_metrics
WHERE blob1 = 'fire'
  AND blob3 = 'reason:post-trip-end'
  AND timestamp >= NOW() - INTERVAL '1' DAY;
-- 임계: count == 0
```

## 향후 작업 (사용자 manual)

본 PR은 SQL 카탈로그 + scaffold만. 실제 dashboard 구축은 `dashboard-setup.md` 참고.
