/**
 * `trip_metrics` 회귀 감지 공유 SQL 술어 — SSoT (#2795, 코드리뷰 PR #2797 F3).
 *
 * 옵션 A(`tripMetricsRegressionScan.ts`, bind 파라미터로 `wrangler`/D1 API 경유)와 옵션 B
 * (`checkTripMetricsRegression.ts`, `wrangler d1 execute --command`는 bind를 지원하지 않아
 * 리터럴 SQL)가 각자 WHERE 절 문자열을 복붙해 갖고 있었다 — "SSoT" 주석과 달리 실제로는
 * 갈라져 있었고, window 비교 컬럼을 고치는 F1 수정이 한쪽에만 반영될 뻔했다. 이제 두
 * caller가 이 모듈 하나(`buildRegressionSql`)만 호출한다 — 조건을 바꾸려면 여기 한 곳만
 * 고치면 A/B 둘 다 반영된다.
 *
 * 회귀 정의: 최근 1일 내 **완료**(ended_at)된 명시 의향(lock 또는 boardingPrompt 응답) trip이
 * fired_count=0. window 비교는 `started_at`이 아니라 `ended_at` 기준이다 — 어제 시작해
 * 오늘 fired_count=0으로 끝난 장기 trip(진짜 실패 증상)을 `started_at` 기준으로는 놓친다.
 */

/** 공유 SELECT 컬럼 목록. */
export const REGRESSION_SELECT_COLUMNS =
  'trip_token_hash, started_at, ended_at, origin_station, destination_station, ' +
  'lock_attached, boarding_prompt_responded, fired_count, end_reason';

/** window 비교를 제외한 공유 WHERE 조건(SSoT) — "완료 + 명시 의향 + 미발사". */
export const REGRESSION_WHERE_BASE = `ended_at IS NOT NULL
  AND (lock_attached = 1 OR boarding_prompt_responded = 1)
  AND fired_count = 0`;

/**
 * 회귀 후보 SELECT SQL을 조립한다.
 *
 * @param windowExprSql — `ended_at >` 뒤에 그대로 삽입되는 SQL 조각. bind 파라미터를 쓰는
 *   caller(옵션 A)는 `'?'`를 넘기고 실제 값은 `.bind(windowStart)`로 전달한다. bind를
 *   지원하지 않는 `wrangler d1 execute --command`(옵션 B)는 `String(windowStartMs)` 리터럴을
 *   넘긴다 — 두 caller 모두 사용자 입력이 아니라 자신이 계산한 epoch ms 숫자이므로 injection
 *   위험이 없다.
 */
export function buildRegressionSql(windowExprSql: string): string {
  return `SELECT ${REGRESSION_SELECT_COLUMNS}
FROM trip_metrics
WHERE ${REGRESSION_WHERE_BASE}
  AND ended_at > ${windowExprSql}
ORDER BY started_at DESC;`;
}

/**
 * 재진행(같은 역 재소비) 감시 (#3006 PR-0) — `trip_events` 기반.
 *
 * 술어: 한 트립 창 안에서 같은 (token_hash, station)의 `prepare-alarm` 행이 2개 이상.
 * 트립 창 경계 = `trip-end` 행, 그리고 `trip-register` 중 `existedAtRequestStart=false`(새 trip).
 * `advance` 행은 새 head를 기록하므로 제외한다(포함하면 거짓양성 3건이 더해져 2건 -> 5건).
 * 알려진 사각: 준비 알람 짝이 없는 순수 intermediate sync 재전진은 행이 없어 못 잡는다.
 */
export const RECONSUME_COUNTED_KIND = 'prepare-alarm';
export const RECONSUME_WINDOW_BOUNDARY_KINDS = ['trip-end', 'trip-register'] as const;
const RECONSUME_SELECT_KINDS = [RECONSUME_COUNTED_KIND, ...RECONSUME_WINDOW_BOUNDARY_KINDS];

export const RECONSUME_SELECT_COLUMNS = 'id, ts, token_hash, kind, station, meta';

export interface ReconsumeEventRow {
  id: number;
  ts: number;
  token_hash: string;
  kind: string;
  station: string | null;
  meta: string | null;
}

export interface ReconsumedStation {
  tokenHash: string;
  station: string;
  count: number;
  eventIds: number[];
}

/** `windowExprSql` 의미는 `buildRegressionSql`과 동일(옵션 A는 `'?'`, 옵션 B는 리터럴). */
export function buildReconsumeSql(windowExprSql: string): string {
  const kinds = RECONSUME_SELECT_KINDS.map((k) => `'${k}'`).join(', ');
  return `SELECT ${RECONSUME_SELECT_COLUMNS}
FROM trip_events
WHERE kind IN (${kinds})
  AND ts > ${windowExprSql}
ORDER BY token_hash, ts, id;`;
}

function startsNewTrip(row: ReconsumeEventRow): boolean {
  if (row.kind === 'trip-end') return true;
  if (row.kind !== 'trip-register' || row.meta === null) return false;
  try {
    const { existedAtRequestStart } = JSON.parse(row.meta) as { existedAtRequestStart?: unknown };
    return existedAtRequestStart === false;
  } catch {
    return false;
  }
}

/** 순수 함수 — D1 행(어떤 순서든)에서 재소비 (token, station)을 찾는다. */
export function findReconsumedStations(rows: ReconsumeEventRow[]): ReconsumedStation[] {
  const sorted = [...rows].sort((a, b) => a.ts - b.ts || a.id - b.id);
  const windowIdByToken = new Map<string, number>();
  const idsByKey = new Map<string, { tokenHash: string; station: string; ids: number[] }>();
  for (const row of sorted) {
    const windowId = windowIdByToken.get(row.token_hash) ?? 0;
    if (startsNewTrip(row)) {
      windowIdByToken.set(row.token_hash, windowId + 1);
      continue;
    }
    if (row.kind !== RECONSUME_COUNTED_KIND || row.station === null) continue;
    const key = `${row.token_hash}\u0000${windowId}\u0000${row.station}`;
    const entry = idsByKey.get(key) ?? { tokenHash: row.token_hash, station: row.station, ids: [] };
    entry.ids.push(row.id);
    idsByKey.set(key, entry);
  }
  return [...idsByKey.values()]
    .filter(({ ids }) => ids.length >= 2)
    .map(({ tokenHash, station, ids }) => ({ tokenHash, station, count: ids.length, eventIds: ids }));
}
