/**
 * Alarm-log stats aggregator (#1621 Phase A).
 *
 * 배경
 * ====
 * `alarmLogForward.ts:storeAlarmLogForward`가 trip 종료 시 device가 forward한 alarmLog/fusionLog
 * snapshot을 R2 `trip-evidence/YYYY/MM/DD/{tokenPrefix}-{tripStartedAt}.ndjson` 키로 90일 보관한다.
 * 본 모듈은 그 archive를 1h 윈도우로 scan해 reason/source 별 분포를 산출 — `/admin/alarm-log-stats`
 * RCA endpoint가 노출.
 *
 * 측정 신호
 * =========
 * - `totalEvents`: 1h 윈도우 안에 archive된 alarmLog entry 수
 * - `fired`/`suppressed`/`received`: outcome 분포
 * - `reasons`: AlarmLogReason 분포 (e.g. `cross-trip-mirror-leak`, `lockless-forward-only-block`)
 * - `sources`: AlarmLogSource 분포 (e.g. `silent-push-fired`, `fg-arvlcd`)
 * - `tripsScanned`: 윈도우 안에 scan된 trip-evidence object 수
 *
 * R2 cost
 * =======
 * `r2.list({ prefix })` + 각 object get. windowHours 안에 종료된 trip만 scan (cursor pagination).
 * `limit` param으로 cap (default 50 trips, max 500). 평소 production 1h ~ <10 trips 예상.
 *
 * Privacy
 * =======
 * archive 자체가 token 8자 prefix만 저장 — 본 endpoint도 동일 보장. 응답에는 stats만 노출,
 * 개별 trip identifier/원문 미포함.
 */

const TRIP_EVIDENCE_PREFIX = 'trip-evidence/';
const MS_PER_HOUR = 60 * 60 * 1000;

/** 단일 alarmLog entry 최소 shape — 사후 분석에 필요한 필드만 narrow.  */
interface AlarmLogEntryLike {
  ts?: number;
  source?: string;
  outcome?: string;
  reason?: string;
}

/**
 * `/admin/alarm-log-stats` 응답 shape.
 *
 * - `windowStart` / `windowEnd`: 측정 윈도우 (epoch ms)
 * - `totalEvents`: 윈도우 안 alarmLog entry 총 수
 * - `fired` / `suppressed` / `received`: outcome 분포
 * - `reasons`: AlarmLogReason 분포 — top-20 정렬
 * - `sources`: AlarmLogSource 분포 — top-20 정렬
 * - `tripsScanned`: 윈도우 안 scan된 trip-evidence object 수
 */
export interface AlarmLogStatsResponse {
  windowStart: number;
  windowEnd: number;
  totalEvents: number;
  fired: number;
  suppressed: number;
  received: number;
  reasons: Record<string, number>;
  sources: Record<string, number>;
  tripsScanned: number;
}

/** parse 결과를 outcome/source/reason 카운터에 누적. shape mismatch entry는 silent drop. */
function accumulateEntry(
  entry: AlarmLogEntryLike,
  outcomeCounts: Record<string, number>,
  reasonCounts: Record<string, number>,
  sourceCounts: Record<string, number>,
): void {
  if (typeof entry.outcome === 'string' && entry.outcome.length > 0) {
    outcomeCounts[entry.outcome] = (outcomeCounts[entry.outcome] ?? 0) + 1;
  }
  if (typeof entry.source === 'string' && entry.source.length > 0) {
    sourceCounts[entry.source] = (sourceCounts[entry.source] ?? 0) + 1;
  }
  if (typeof entry.reason === 'string' && entry.reason.length > 0) {
    reasonCounts[entry.reason] = (reasonCounts[entry.reason] ?? 0) + 1;
  }
}

/** ndjson 본문에서 alarmLog 줄만 추려 entries 추출. malformed 줄/kind는 silent drop. */
function extractAlarmLogEntries(body: string): AlarmLogEntryLike[] {
  const out: AlarmLogEntryLike[] = [];
  for (const line of body.split('\n')) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const obj = parsed as { kind?: unknown; entries?: unknown };
    if (obj.kind !== 'alarmLog') continue;
    if (!Array.isArray(obj.entries)) continue;
    for (const e of obj.entries) {
      if (e && typeof e === 'object') out.push(e as AlarmLogEntryLike);
    }
  }
  return out;
}

/** `customMetadata.tripEndedAt`이 윈도우 안인지 판정. metadata 미존재 시 false (skip). */
function isObjectInWindow(
  meta: Record<string, string> | undefined,
  windowStart: number,
  windowEnd: number,
): boolean {
  if (!meta) return false;
  const rawEnd = meta.tripEndedAt;
  if (typeof rawEnd !== 'string') return false;
  const ended = Number.parseInt(rawEnd, 10);
  if (!Number.isFinite(ended)) return false;
  return ended >= windowStart && ended <= windowEnd;
}

/** top-N entry만 추출 (response size 보호 — reason/source 다양성 100+ 가능). */
function topN(dict: Record<string, number>, n: number): Record<string, number> {
  const sorted = Object.entries(dict)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
  return Object.fromEntries(sorted);
}

/**
 * R2 archive scan으로 windowHours 윈도우 안 alarmLog 분포 산출.
 *
 * @param r2 TELEMETRY_R2 bucket
 * @param now 현재 epoch ms (윈도우 계산 기준)
 * @param windowHours 윈도우 (default 1, 1~24 clamp)
 * @param limit 최대 enumerate trip-evidence object 수 (default 50, max 500)
 */
export async function computeAlarmLogStats(
  r2: R2Bucket,
  now: number,
  windowHours = 1,
  limit = 50,
): Promise<AlarmLogStatsResponse> {
  const safeWindowHours = Math.max(1, Math.min(24, windowHours));
  const safeLimit = Math.max(1, Math.min(500, limit));
  const windowStart = now - safeWindowHours * MS_PER_HOUR;
  const windowEnd = now;

  const outcomeCounts: Record<string, number> = {};
  const reasonCounts: Record<string, number> = {};
  const sourceCounts: Record<string, number> = {};
  let totalEvents = 0;
  let tripsScanned = 0;

  let cursor: string | undefined;
  let enumerated = 0;
  do {
    const result = await r2.list({
      prefix: TRIP_EVIDENCE_PREFIX,
      cursor,
      limit: Math.min(safeLimit - enumerated, 1000),
    });
    for (const obj of result.objects) {
      if (enumerated >= safeLimit) break;
      enumerated += 1;
      if (!isObjectInWindow(obj.customMetadata, windowStart, windowEnd)) continue;
      const archived = await r2.get(obj.key);
      if (!archived) continue;
      const body = await archived.text();
      const entries = extractAlarmLogEntries(body);
      if (entries.length === 0) continue;
      tripsScanned += 1;
      for (const e of entries) {
        totalEvents += 1;
        accumulateEntry(e, outcomeCounts, reasonCounts, sourceCounts);
      }
    }
    cursor = result.truncated && enumerated < safeLimit ? result.cursor : undefined;
  } while (cursor);

  return {
    windowStart,
    windowEnd,
    totalEvents,
    fired: outcomeCounts.fired ?? 0,
    suppressed: outcomeCounts.suppressed ?? 0,
    received: outcomeCounts.received ?? 0,
    reasons: topN(reasonCounts, 20),
    sources: topN(sourceCounts, 20),
    tripsScanned,
  };
}
