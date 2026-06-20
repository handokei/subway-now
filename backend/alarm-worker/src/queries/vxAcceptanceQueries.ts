/**
 * V/X Acceptance SQL query catalog — Phase 0 Epic #1576 / P0-5 #1581.
 *
 * 본 모듈은 `docs/observability/vx-acceptance-queries.md`의 20 임계 SQL을
 * runtime에서 사용할 수 있도록 string 상수로 export 한다 (daily cron / ad-hoc API
 * 모두 이 카탈로그를 참조). 실제 dashboard 구축은 사용자 manual — 본 PR scaffold만.
 *
 * Window는 `{WINDOW}` placeholder — caller가 `'1' DAY` / `'10' MINUTE` 등으로 치환.
 *
 * 검증: `__tests__/vxAcceptanceQueries.test.ts`가 카탈로그 shape + 필수 절(SELECT/FROM/WHERE
 * + trip_metrics 참조 + window placeholder)을 정적으로 보장한다. 실제 SQL 실행은
 * Cloudflare Analytics Engine SQL API에서만 가능 (vitest 환경에서는 검증 불가).
 */

export type VxKey =
  | 'V1' | 'V2' | 'V3' | 'V4' | 'V5' | 'V6' | 'V7'
  | 'V8a' | 'V8b' | 'V8c' | 'V9'
  | 'X1' | 'X2' | 'X3' | 'X4' | 'X5' | 'X6' | 'X7' | 'X8' | 'X9' | 'X10' | 'X11';

export interface VxQueryEntry {
  key: VxKey;
  /** 가치(V) vs 손상(X) 분류 — alert routing에 사용. */
  kind: 'value' | 'harm';
  /** 한 줄 설명 (`alert-rules.md`의 임계 일람과 일치). */
  description: string;
  /** 임계 텍스트 (예: "< 1%", "0건"). */
  threshold: string;
  /** SQL string. `{WINDOW}` placeholder를 INTERVAL 표현으로 치환. */
  sql: string;
}

const W = '{WINDOW}';

export const VX_ACCEPTANCE_QUERIES: readonly VxQueryEntry[] = [
  {
    key: 'V1',
    kind: 'value',
    description: 'currentStation == SSoT mismatch %',
    threshold: '< 1%',
    sql: `SELECT (SUM(CASE WHEN blob3 = 'reason:ssot-mismatch' THEN 1 ELSE 0 END) * 100.0) / COUNT(*) AS mismatch_pct
FROM trip_metrics
WHERE blob1 = 'advance' AND timestamp >= NOW() - INTERVAL ${W};`,
  },
  {
    key: 'V2',
    kind: 'value',
    description: 'transfer-1-stop alarm count per hop≥2 trip',
    threshold: '0 violating trips',
    sql: `SELECT index1 AS token, COUNT(*) AS alarm_count
FROM trip_metrics
WHERE blob1 = 'fire' AND blob3 = 'reason:transfer-1-stop'
  AND timestamp >= NOW() - INTERVAL ${W}
GROUP BY index1 HAVING alarm_count != 1;`,
  },
  {
    key: 'V3',
    kind: 'value',
    description: 'destination-1-stop alarm count per trip',
    threshold: '0 violating trips',
    sql: `SELECT index1 AS token, COUNT(*) AS alarm_count
FROM trip_metrics
WHERE blob1 = 'fire' AND blob3 = 'reason:destination-1-stop'
  AND timestamp >= NOW() - INTERVAL ${W}
GROUP BY index1 HAVING alarm_count != 1;`,
  },
  {
    key: 'V4',
    kind: 'value',
    description: 'station-passed fire vs SSoT advance drift',
    threshold: '±1',
    sql: `SELECT index1 AS token, COUNT(*) AS passed_fire_count
FROM trip_metrics
WHERE blob1 = 'fire' AND blob3 = 'reason:station-passed'
  AND timestamp >= NOW() - INTERVAL ${W}
GROUP BY index1;`,
  },
  {
    key: 'V5',
    kind: 'value',
    description: 'auto-ended trip %',
    threshold: '≥ 99%',
    sql: `SELECT blob3 AS end_reason, COUNT(*) AS trip_count
FROM trip_metrics
WHERE blob1 = 'trip-mutation' AND blob2 = 'reason:trip-ended'
  AND timestamp >= NOW() - INTERVAL ${W}
GROUP BY blob3;`,
  },
  {
    key: 'V6',
    kind: 'value',
    description: 'SSoT mirror lag p95 (ms)',
    threshold: '< 5000ms',
    sql: `SELECT quantile(0.95)(double1) AS p95_ms
FROM trip_metrics
WHERE blob1 = 'advance' AND double1 IS NOT NULL
  AND timestamp >= NOW() - INTERVAL ${W};`,
  },
  {
    key: 'V7',
    kind: 'value',
    description: 'underground trip advance %',
    threshold: '≥ 90%',
    sql: `SELECT (SUM(CASE WHEN blob1 = 'advance' THEN 1 ELSE 0 END) * 100.0) /
  NULLIF(SUM(CASE WHEN blob1 IN ('advance', 'suppress') THEN 1 ELSE 0 END), 0) AS advance_pct
FROM trip_metrics
WHERE blob4 = 'env:underground' AND timestamp >= NOW() - INTERVAL ${W};`,
  },
  {
    key: 'V8a',
    kind: 'value',
    description: '/position rate per 10min trip',
    threshold: '≤ 100',
    sql: `SELECT index1 AS token, COUNT(*) AS upload_count
FROM trip_metrics
WHERE blob1 = 'position-upload' AND timestamp >= NOW() - INTERVAL ${W}
GROUP BY index1 HAVING upload_count > 100;`,
  },
  {
    key: 'V8b',
    kind: 'value',
    description: '/trips rate per 10min trip',
    threshold: '≤ 10',
    sql: `SELECT index1 AS token, COUNT(*) AS mutation_count
FROM trip_metrics
WHERE blob1 = 'trip-mutation' AND timestamp >= NOW() - INTERVAL ${W}
GROUP BY index1 HAVING mutation_count > 10;`,
  },
  {
    key: 'V8c',
    kind: 'value',
    description: 'stationary vs moving cycle rate',
    threshold: 'stationary < 50% moving',
    sql: `SELECT blob2 AS reason, COUNT(*) / 60.0 AS rate_per_minute
FROM trip_metrics
WHERE blob1 = 'motion-transition' AND timestamp >= NOW() - INTERVAL ${W}
GROUP BY blob2;`,
  },
  {
    key: 'V9',
    kind: 'value',
    description: 'suppress rate per trip per hour',
    threshold: '≤ 30',
    sql: `SELECT index1 AS token, COUNT(*) AS suppress_count
FROM trip_metrics
WHERE blob1 = 'suppress' AND timestamp >= NOW() - INTERVAL ${W}
GROUP BY index1 HAVING suppress_count > 30;`,
  },
  {
    key: 'X1',
    kind: 'harm',
    description: 'wrong-station alarm fired',
    threshold: '0건',
    sql: `SELECT index1 AS token, blob2 AS station, timestamp
FROM trip_metrics
WHERE blob1 = 'fire' AND blob3 = 'reason:wrong-station'
  AND timestamp >= NOW() - INTERVAL ${W};`,
  },
  {
    key: 'X2',
    kind: 'harm',
    description: 'duplicate alarm (same trip+station)',
    threshold: '0건',
    sql: `SELECT index1 AS token, blob2 AS station, COUNT(*) AS fire_count
FROM trip_metrics
WHERE blob1 = 'fire' AND timestamp >= NOW() - INTERVAL ${W}
GROUP BY index1, blob2 HAVING fire_count > 1;`,
  },
  {
    key: 'X3',
    kind: 'harm',
    description: 'stale alarm (staleMs > 5min at fire)',
    threshold: '0건',
    sql: `SELECT index1 AS token, blob2 AS station, double1 AS stale_ms
FROM trip_metrics
WHERE blob1 = 'fire' AND double1 > 300000
  AND timestamp >= NOW() - INTERVAL ${W};`,
  },
  {
    key: 'X4',
    kind: 'harm',
    description: 'spam suppress (>10/trip)',
    threshold: '0건',
    sql: `SELECT index1 AS token, COUNT(*) AS suppress_count
FROM trip_metrics
WHERE blob1 = 'suppress' AND timestamp >= NOW() - INTERVAL ${W}
GROUP BY index1 HAVING suppress_count > 10;`,
  },
  {
    key: 'X5',
    kind: 'harm',
    description: 'mirror leak (trip switch stale entry)',
    threshold: '0건',
    sql: `SELECT *
FROM trip_metrics
WHERE blob1 IN ('fire', 'advance') AND blob3 = 'reason:mirror-leak'
  AND timestamp >= NOW() - INTERVAL ${W};`,
  },
  {
    key: 'X6',
    kind: 'harm',
    description: 'late alarm (fire > arrival + 30s)',
    threshold: '0건',
    sql: `SELECT *
FROM trip_metrics
WHERE blob1 = 'fire' AND blob3 = 'reason:late' AND double1 > 30000
  AND timestamp >= NOW() - INTERVAL ${W};`,
  },
  {
    key: 'X7',
    kind: 'harm',
    description: 'env=unknown ≥ 5min trip',
    threshold: '0건',
    sql: `SELECT index1 AS token, MIN(timestamp) AS first_ts, MAX(timestamp) AS last_ts
FROM trip_metrics
WHERE blob4 = 'env:unknown' AND timestamp >= NOW() - INTERVAL ${W}
GROUP BY index1 HAVING date_diff('minute', MIN(timestamp), MAX(timestamp)) >= 5;`,
  },
  {
    key: 'X8',
    kind: 'harm',
    description: 'trip 6h+ residual',
    threshold: '0건',
    sql: `SELECT index1 AS token,
  date_diff('hour', MIN(timestamp), MAX(timestamp)) AS duration_h
FROM trip_metrics
WHERE timestamp >= NOW() - INTERVAL ${W}
GROUP BY index1 HAVING duration_h >= 6;`,
  },
  {
    key: 'X9',
    kind: 'harm',
    description: 'fire after app-kill',
    threshold: '0건',
    sql: `SELECT *
FROM trip_metrics
WHERE blob1 = 'fire' AND blob3 = 'reason:post-kill'
  AND timestamp >= NOW() - INTERVAL ${W};`,
  },
  {
    key: 'X10',
    kind: 'harm',
    description: 'fusion picker output != input',
    threshold: '0건',
    sql: `SELECT *
FROM trip_metrics
WHERE blob1 = 'suppress' AND blob3 = 'reason:fusion-mismatch'
  AND timestamp >= NOW() - INTERVAL ${W};`,
  },
  {
    key: 'X11',
    kind: 'harm',
    description: 'BG scheduled queue post-trip-end fire',
    threshold: '0건',
    sql: `SELECT *
FROM trip_metrics
WHERE blob1 = 'fire' AND blob3 = 'reason:post-trip-end'
  AND timestamp >= NOW() - INTERVAL ${W};`,
  },
] as const;

/**
 * `{WINDOW}` placeholder를 INTERVAL 표현으로 치환한 실행용 SQL을 반환.
 *
 * @param entry  카탈로그 entry.
 * @param window INTERVAL 표현 (예: `'1' DAY`, `'10' MINUTE`).
 */
export function renderQuery(entry: VxQueryEntry, window: string): string {
  return entry.sql.split('{WINDOW}').join(window);
}

/**
 * 카탈로그에서 key로 entry를 찾는다. 미존재 시 undefined.
 */
export function findQuery(key: VxKey): VxQueryEntry | undefined {
  return VX_ACCEPTANCE_QUERIES.find((q) => q.key === key);
}
