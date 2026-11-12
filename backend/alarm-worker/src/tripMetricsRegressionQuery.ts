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
 * 재진행(같은 역 재소비) 감시 (#3006) — `trip_events` 기반. 신호 3종(SIGNAL_RULES), 한 트립 창 안 (token, station)별 집계.
 *
 * 술어 교체 배경: #3277 이 비취침 트립의 `prepare-alarm` 기록을 철거해 기존 단일 술어
 * (prepare-alarm 같은 역 2회+)는 비취침 트립에서 신호가 없다. 취침 트립용으로는 유지하고 두 신호를 더한다.
 *  - `prepare-alarm-repeat`: 같은 역 prepare-alarm 2회+ (취침 트립). 실측 10/31 강남구청 x4, 11/02 건대입구 x2.
 *  - `sync-dedup-repeat`: 같은 역 `cron-fire-attempt` 중 reason=`sync-station-passed-dedup` 2회+.
 *    sync 가 이미 발사한 head 를 다시 평가했다는 뜻 — head 가 앞으로 가지 못한 채 sync 가 반복된다.
 *    실측 11/02 head 성수 x2 (1973/1980). 일반 `station-passed-dedup`(sent 1 + dedup 1이 정상 dwell)은
 *    세지 않는다 — 중곡·군자·어린이대공원·청담 등 정상 5건이 거짓양성이 되기 때문이다.
 *  - `progress-reconcile`: #3282 의 되돌림 복구 행 1건+. 되돌림이 실제로 일어났다는 직접 증거(복구되어 재소비는 막힌다).
 *    `lock-reanchor`(lock epoch 시작 재고정)는 정상 경로라 세지 않는다.
 * 트립 창 경계 = `trip-end` 행, 그리고 `trip-register` 중 `existedAtRequestStart=false`(새 trip).
 * `advance` 행은 새 head 를 기록하므로 제외한다(포함하면 거짓양성 3건이 더해져 2건 -> 5건).
 * 알려진 사각: 10/31 강남구청형(sent 1 + dedup 1 이후 transition-record 억제로 행이 남지 않음)은
 * 비취침 트립에서 cron 행만으로 정상 dwell 과 구분되지 않는다 — #3282 이후엔 progress-reconcile 로 잡힌다.
 */
export const RECONSUME_COUNTED_KIND = 'prepare-alarm';
export const RECONSUME_WINDOW_BOUNDARY_KINDS = ['trip-end', 'trip-register'] as const;

export type ReconsumeSignal = 'prepare-alarm-repeat' | 'sync-dedup-repeat' | 'progress-reconcile';

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
  signal: ReconsumeSignal;
  count: number;
  eventIds: number[];
}

function metaReason(row: ReconsumeEventRow): unknown {
  if (row.meta === null) return undefined;
  try {
    const { reason } = JSON.parse(row.meta) as { reason?: unknown };
    return reason;
  } catch {
    return undefined;
  }
}

interface SignalRule {
  signal: ReconsumeSignal;
  kind: string;
  minCount: number;
  matches: (row: ReconsumeEventRow) => boolean;
}

const SYNC_DEDUP_REASON = 'sync-station-passed-dedup';

const SIGNAL_RULES: SignalRule[] = [
  { signal: 'prepare-alarm-repeat', kind: RECONSUME_COUNTED_KIND, minCount: 2, matches: () => true },
  {
    signal: 'sync-dedup-repeat',
    kind: 'cron-fire-attempt',
    minCount: 2,
    matches: (row) => metaReason(row) === SYNC_DEDUP_REASON,
  },
  { signal: 'progress-reconcile', kind: 'progress-reconcile', minCount: 1, matches: () => true },
];

const RECONSUME_SELECT_KINDS = [
  ...new Set([...SIGNAL_RULES.map(({ kind }) => kind), ...RECONSUME_WINDOW_BOUNDARY_KINDS]),
];

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

/** 순수 함수 — D1 행(어떤 순서든)에서 재소비 신호 (token, station)을 찾는다. */
export function findReconsumedStations(rows: ReconsumeEventRow[]): ReconsumedStation[] {
  const sorted = [...rows].sort((a, b) => a.ts - b.ts || a.id - b.id);
  const windowIdByToken = new Map<string, number>();
  const idsByKey = new Map<string, { rule: SignalRule; tokenHash: string; station: string; ids: number[] }>();
  for (const row of sorted) {
    const windowId = windowIdByToken.get(row.token_hash) ?? 0;
    if (startsNewTrip(row)) {
      windowIdByToken.set(row.token_hash, windowId + 1);
      continue;
    }
    const { station } = row;
    const rule = SIGNAL_RULES.find(({ kind, matches }) => kind === row.kind && matches(row));
    if (rule === undefined || station === null) continue;
    const key = `${row.token_hash}\u0000${windowId}\u0000${rule.signal}\u0000${station}`;
    const entry = idsByKey.get(key) ?? { rule, tokenHash: row.token_hash, station, ids: [] };
    entry.ids.push(row.id);
    idsByKey.set(key, entry);
  }
  return [...idsByKey.values()]
    .filter(({ rule, ids }) => ids.length >= rule.minCount)
    .map(({ rule, tokenHash, station, ids }) => ({
      tokenHash,
      station,
      signal: rule.signal,
      count: ids.length,
      eventIds: ids,
    }));
}

/**
 * lockless 환승 후 leg-2 프롬프트 누락 감시 (#3357 항목 3, #3350 b00dd879 형태의 재발 감시) — `trip_events` 기반.
 *
 * 회귀 정의: lockless trip(환승 hop-end 이전에 `lock-attached` 행 없음)이 환승역 T에서 hop-end 신호를 남겼는데(= 환승역 도착 관측),
 * 그 뒤 같은 트립 창에서 T의 leg-2 흔적(아래 3종)이 한 건도 없다. "leg-1에서 못 했어도 leg-2는 제대로 진행" 결정(11/12)의 사후 감시다.
 *  - 환승 관측 신호: `hop-end-prompt` 행, 또는 `la-boarding-start` 중 meta.path=`hop-end-prompt`(route 가 D1 에 없어 sync-received 만으로는 환승역인지 알 수 없다).
 *  - leg-2 흔적: ① `leg-boarding-prompt`(station=T, meta.leg!=='origin') ② `la-boarding-start`(path=boarding-prompt, station=T, line!=환승 전 노선)
 *    ③ `lock-attached`(station=T, line!=환승 전 노선).
 * 오탐 방지: 진행 중 트립은 hop-end 후 `LEG2_EVIDENCE_GRACE_MS` 동안 판정을 보류한다(트립 종료 `trip-end` 가 있으면 즉시 판정).
 * 알려진 사각: ① hop-end 가 안 찍히는 환승 관측(sync 만) ② 환승 전 leg-1 에서 lock 이 붙었다 풀린 트립(lockless 아님) ③ D1 trip_events 보존 ~6일.
 */
export const LEG2_EVIDENCE_GRACE_MS = 30 * 60_000;
/** 트립 최대 길이(expiresAt 3h) — window 하한 앞쪽을 이만큼 더 읽어 hop-end 이전 lock-attached 를 놓치지 않는다. */
export const LEG2_WATCH_PRE_ROLL_MS = 3 * 3600_000;

const LEG2_WATCH_KINDS = ['hop-end-prompt', 'la-boarding-start', 'leg-boarding-prompt', 'lock-attached', 'trip-register', 'trip-end'] as const;
export const LEG2_WATCH_SELECT_COLUMNS = 'id, ts, token_hash, kind, station, line, meta';

export interface TripEventRow extends ReconsumeEventRow {
  line: string | null;
}

export interface Leg2PromptMiss {
  tokenHash: string;
  station: string;
  /** 환승 전(leg-1) 노선. */
  transferLine: string | null;
  transferAt: number;
  eventIds: number[];
}

/** `windowExprSql` 의미는 `buildRegressionSql`과 동일(옵션 A는 `'?'`, 옵션 B는 리터럴). */
export function buildLeg2WatchSql(windowExprSql: string): string {
  const kinds = LEG2_WATCH_KINDS.map((k) => `'${k}'`).join(', ');
  return `SELECT ${LEG2_WATCH_SELECT_COLUMNS}
FROM trip_events
WHERE kind IN (${kinds})
  AND ts > ${windowExprSql} - ${LEG2_WATCH_PRE_ROLL_MS}
ORDER BY token_hash, ts, id;`;
}

function metaOf(row: TripEventRow): Record<string, unknown> {
  if (row.meta === null) return {};
  try {
    return JSON.parse(row.meta) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const isHopEndSignal = (row: TripEventRow): boolean =>
  row.kind === 'hop-end-prompt' || (row.kind === 'la-boarding-start' && metaOf(row).path === 'hop-end-prompt');

function isLeg2Evidence(row: TripEventRow, station: string, transferLine: string | null): boolean {
  if (row.station !== station) return false;
  if (row.kind === 'leg-boarding-prompt') return metaOf(row).leg !== 'origin';
  if (row.kind === 'la-boarding-start') return metaOf(row).path === 'boarding-prompt' && row.line !== transferLine;
  if (row.kind === 'lock-attached') return row.line !== transferLine;
  return false;
}

/** 순수 함수 — D1 행(어떤 순서든)에서 lockless 환승 후 leg-2 흔적이 없는 (token, 환승역)을 찾는다. `windowStartMs` 이전의 hop-end 는 보고하지 않는다. */
export function findLocklessLeg2Misses(rows: TripEventRow[], now: number, windowStartMs: number): Leg2PromptMiss[] {
  const sorted = [...rows].sort((a, b) => a.ts - b.ts || a.id - b.id);
  const windows = new Map<string, TripEventRow[]>();
  const windowIdByToken = new Map<string, number>();
  for (const row of sorted) {
    const windowId = windowIdByToken.get(row.token_hash) ?? 0;
    if (startsNewTrip(row)) windowIdByToken.set(row.token_hash, windowId + 1);
    const key = `${row.token_hash}\u0000${windowId}`;
    windows.set(key, [...(windows.get(key) ?? []), row]);
  }
  const misses: Leg2PromptMiss[] = [];
  for (const windowRows of windows.values()) {
    const ended = windowRows.some(({ kind }) => kind === 'trip-end');
    const signalsByStation = new Map<string, TripEventRow[]>();
    for (const row of windowRows.filter(isHopEndSignal)) {
      if (row.station === null) continue;
      signalsByStation.set(row.station, [...(signalsByStation.get(row.station) ?? []), row]);
    }
    for (const [station, signals] of signalsByStation) {
      const [first] = signals;
      const { ts: transferAt, line: transferLine, token_hash: tokenHash } = first;
      if (transferAt < windowStartMs) continue;
      if (!ended && now - transferAt <= LEG2_EVIDENCE_GRACE_MS) continue;
      if (windowRows.some((r) => r.kind === 'lock-attached' && r.ts <= transferAt)) continue;
      if (windowRows.some((r) => r.ts >= transferAt && isLeg2Evidence(r, station, transferLine))) continue;
      misses.push({ tokenHash, station, transferLine, transferAt, eventIds: signals.map(({ id }) => id) });
    }
  }
  return misses.sort((a, b) => a.transferAt - b.transferAt);
}
