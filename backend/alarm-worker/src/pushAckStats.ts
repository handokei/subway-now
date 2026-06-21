/**
 * Push ack stats (S4 #1537 / #1614 Phase D).
 *
 * 배경
 * ====
 * `pendingPushes.ts:152` receivedKey + `stampReceived`로 push 도달 이벤트가 KV에 stamp되어
 * 있다. RCA endpoint(`/admin/push-ack-stats`)가 이를 scan해 1시간 윈도우 분포를 산출.
 *
 * 측정 신호
 * =========
 * - `pending:` prefix: silent push가 발사된 entries (60s TTL)
 * - `received:` prefix: device가 ack한 entries (1h TTL)
 *
 * 도달률 = receivedCount / sentCount(=fallback pending or 발사 카운터 별도 metric)
 *
 * 본 모듈은 raw count만 산출 — 비율/대시보드는 운영자 측 후처리. 단순화 위해 1h 윈도우 고정
 * (TTL과 일치). 윈도우 짧게 하려면 client filter — 본 endpoint는 raw enumerate만 제공.
 *
 * KV cost
 * =======
 * `kv.list` 호출 + 각 key get. 활성 trip 시 평소 ~수십 entry. limit param으로 cap (default 100).
 */

import { CRON_READ_CACHE_TTL_SEC, assertCronCacheTtl } from './kvConsistency';

const RECEIVED_PREFIX = 'received:';
const PENDING_PREFIX = 'pending:';

/** 단일 received ack entry (json-decoded). */
interface ReceivedEntry {
  pushId: string;
  receivedAt: number;
  stationName: string;
  phase: string;
}

/**
 * `/admin/push-ack-stats` 응답 shape.
 *
 * - `windowStart` / `windowEnd`: 측정 윈도우 (epoch ms)
 * - `pending`: 현재 발사 중(60s TTL) 미ack push 카운트
 * - `received`: 본 윈도우 내 ack 카운트
 * - `receivedByPhase`: phase 별 ack 분포 (imminent/etc)
 * - `receivedByStation`: station 별 ack 분포 (top 10)
 *
 * 비율(도달률) 계산은 client에서 — 본 endpoint는 raw count만 제공.
 */
export interface PushAckStatsResponse {
  windowStart: number;
  windowEnd: number;
  pending: number;
  received: number;
  receivedByPhase: Record<string, number>;
  receivedByStation: Record<string, number>;
}

/**
 * KV `received:` + `pending:` prefix scan으로 분포 산출.
 *
 * @param kv TRIPS KV namespace
 * @param now 현재 epoch ms (윈도우 계산)
 * @param limit 최대 enumerate entry 수 (KV cost 보호, default 500)
 */
export async function computePushAckStats(
  kv: KVNamespace,
  now: number,
  limit = 500,
): Promise<PushAckStatsResponse> {
  const windowStart = now - 60 * 60 * 1000; // 1h
  const windowEnd = now;

  // received: prefix enumerate + JSON parse + phase/station bucket.
  const receivedByPhase: Record<string, number> = {};
  const receivedByStation: Record<string, number> = {};
  let receivedCount = 0;
  let pendingCount = 0;

  assertCronCacheTtl(CRON_READ_CACHE_TTL_SEC);
  let receivedCursor: string | undefined;
  let enumerated = 0;
  do {
    const result = await kv.list({
      prefix: RECEIVED_PREFIX,
      cursor: receivedCursor,
      limit: Math.min(limit - enumerated, 1000),
    });
    for (const key of result.keys) {
      if (enumerated >= limit) break;
      const raw = await kv.get(key.name, { cacheTtl: CRON_READ_CACHE_TTL_SEC });
      enumerated += 1;
      if (!raw) continue;
      let entry: ReceivedEntry;
      try {
        entry = JSON.parse(raw) as ReceivedEntry;
      } catch {
        continue;
      }
      if (entry.receivedAt < windowStart || entry.receivedAt > windowEnd) continue;
      receivedCount += 1;
      receivedByPhase[entry.phase] = (receivedByPhase[entry.phase] ?? 0) + 1;
      receivedByStation[entry.stationName] = (receivedByStation[entry.stationName] ?? 0) + 1;
    }
    receivedCursor = result.list_complete || enumerated >= limit ? undefined : result.cursor;
  } while (receivedCursor);

  // pending: prefix scan — count only (TTL 60s, 살아있는 발사 in-flight).
  let pendingCursor: string | undefined;
  let pendingEnumerated = 0;
  do {
    const result = await kv.list({
      prefix: PENDING_PREFIX,
      cursor: pendingCursor,
      limit: Math.min(limit - pendingEnumerated, 1000),
    });
    pendingCount += result.keys.length;
    pendingEnumerated += result.keys.length;
    pendingCursor =
      result.list_complete || pendingEnumerated >= limit ? undefined : result.cursor;
  } while (pendingCursor);

  return {
    windowStart,
    windowEnd,
    pending: pendingCount,
    received: receivedCount,
    receivedByPhase,
    receivedByStation: topN(receivedByStation, 10),
  };
}

/** 큰 dict에서 top-N 만 추출 (KV station 분포가 100+ 가능 — response size 보호). */
function topN(dict: Record<string, number>, n: number): Record<string, number> {
  const sorted = Object.entries(dict)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
  return Object.fromEntries(sorted);
}
