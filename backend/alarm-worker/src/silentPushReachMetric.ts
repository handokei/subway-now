/**
 * Silent push reach metric — corrId(pushId) join (#1958, #1503 잔여 2/3).
 *
 * 배경
 * ====
 * 기존 `pushAckStats.ts` / `observabilityMetrics.ts`의 `silentPushDeliveryRatio`는
 * `received / (received + pending)` 비율이다. `pending` KV TTL은 120s — push가 발사된 직후
 * 60~120s 안에 ack를 받지 못한 entry는 자연 expire돼 분모에서 사라진다. 결과적으로 "발사했지만
 * 도달 못 한" 케이스가 silent하게 누락된다.
 *
 * 본 모듈은 그 갭을 메우기 위해 **별도의 `sent:<pushId>` KV stamp(5min TTL)** 를 적재한다.
 *   - sent stamp는 silent push 발사 직후 1건 적재 (corrId=pushId)
 *   - received stamp는 device가 `/push/ack` outcome='received'로 echo 시 적재 (`pendingPushes.ts:stampReceived`)
 *   - 5min 윈도우 안에서 sent count 와 received count 를 corrId(pushId)로 1:1 join하여
 *     실제 도달률(`received / sent`) 산출
 *
 * 윈도우 5분
 * ==========
 * - 짧으면(60s): KV TTL 정합성은 좋지만 burst가 적은 trip에서 표본 0이 자주 발생
 * - 길면(1h): pending TTL 120s가 잡지 못하는 진짜 미도달을 sent stamp가 살리지만, paradigm
 *   회복 시간 측정에는 너무 길어 acuity 감소
 * - **5min**: paradigm Phase 1+2(#1745) 회복 시간 측정 + burst가 있는 trip 1건의 도달률
 *   baseline 확보에 적당. 사용자 trip 평균 35분 안에서 7건의 5min window 측정 가능.
 *
 * `silentPushDeliveryRatio` vs `silentPushReachRatio`
 * ====================================================
 * 두 metric 은 의도가 다르므로 동시에 유지한다.
 *  - `silentPushDeliveryRatio` (기존, 1h): 운영 안정성. 1h window 안에서 "최근 도달 분포".
 *  - `silentPushReachRatio` (신규, 5min): paradigm 측정. 5min window의 corrId-join 도달률.
 *
 * KV cost
 * =======
 * - sent stamp 1건 = 1 put (sendSilentPush가 호출되는 trip 1건당 ~수십 회). 5min TTL.
 * - list scan은 cron(`computeSilentPushReachRatio`)이 1h마다 1회 호출. limit cap 보호.
 *
 * 회귀 차단
 * =========
 * - sent stamp 적재 실패는 silent push 본 발사 흐름을 막지 않는다 (graceful no-op).
 * - KV namespace 미바인딩(`kv === undefined`) graceful no-op — 개발 환경 호환.
 */

import { CRON_READ_CACHE_TTL_SEC, assertCronCacheTtl } from './kvConsistency';

/** `sent:<pushId>` KV stamp prefix. */
const SENT_PREFIX = 'sent:';

/** `received:<pushId>` stamp prefix — `pendingPushes.ts` 의 RECEIVED_PREFIX 와 동일. */
const RECEIVED_PREFIX = 'received:';

/**
 * sent stamp TTL — 5min. 본 metric 윈도우와 동일.
 * received stamp(`pendingPushes.ts:RECEIVED_TTL_SEC = 60 * 60`) 보다 짧다 — 5분 안에 ack 가
 * 도착하지 않으면 미도달로 간주.
 */
export const SENT_TTL_SEC = 5 * 60;

/** 5분 윈도우 — receivedAt - sentAt 비교 기준. ms 단위. */
export const SILENT_PUSH_REACH_WINDOW_MS = 5 * 60 * 1000;

/** KV list 호출 1회당 최대 enumerate entry 수 (cost 보호). */
export const DEFAULT_LIST_LIMIT = 500;

/** sent stamp 1건의 추적 정보. */
export interface SentStamp {
  pushId: string;
  sentAt: number;
}

/**
 * 5min 윈도우 corrId-join 결과.
 *  - `sent`: 5min 윈도우 안에서 발사된 push 수 (sent stamp 기준)
 *  - `received`: 5min 윈도우 안에서 device가 ack한 push 수 (received stamp + sentAt 윈도우 안)
 *  - `joined`: corrId 기준 sent 와 received 둘 다 있는 push 수
 *  - `ratio`: received / sent (sent=0 → 0). division-by-zero 방어.
 *  - `windowStart` / `windowEnd`: 측정 윈도우 (epoch ms)
 */
export interface SilentPushReachRatio {
  sent: number;
  received: number;
  joined: number;
  ratio: number;
  windowStart: number;
  windowEnd: number;
}

export function sentKey(pushId: string): string {
  return `${SENT_PREFIX}${pushId}`;
}

function receivedKeyFor(pushId: string): string {
  return `${RECEIVED_PREFIX}${pushId}`;
}

/**
 * silent push 발사 직후 호출 — sent stamp 1건 적재.
 *
 * 실패는 silent — KV throw / namespace 미바인딩 둘 다 graceful. push 본 발사 흐름과 격리.
 * `putPending` 직후 호출하므로 두 stamp 가 byte-level 정합.
 *
 * @param kv PENDING_PUSHES KV namespace (`pendingPushes.ts:putPending` 와 동일 namespace)
 * @param entry sent stamp 본문 (pushId + sentAt)
 */
export async function stampSent(
  kv: KVNamespace | undefined,
  entry: SentStamp,
): Promise<void> {
  if (!kv) return;
  try {
    await kv.put(sentKey(entry.pushId), JSON.stringify(entry), {
      expirationTtl: SENT_TTL_SEC,
    });
  } catch {
    // silent — 측정 인프라가 본 발사를 차단해서는 안 된다.
  }
}

/** received stamp 1건의 partial shape — pendingPushes.ts `stampReceived` 와 호환. */
interface ReceivedStampShape {
  pushId: string;
  receivedAt: number;
}

/**
 * `received:<pushId>` raw JSON parse — corrId 와 receivedAt 만 필요.
 * pendingPushes.ts 가 추가 메타(stationName/phase/latencyMs/...)도 stamp 하지만 본 모듈은
 * 쓰지 않으므로 partial type 으로 narrow.
 */
function parseReceivedStamp(raw: string): ReceivedStampShape | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ReceivedStampShape>;
    if (typeof parsed.pushId !== 'string' || parsed.pushId.length === 0) return null;
    if (typeof parsed.receivedAt !== 'number' || !Number.isFinite(parsed.receivedAt)) return null;
    return { pushId: parsed.pushId, receivedAt: parsed.receivedAt };
  } catch {
    return null;
  }
}

/** sent stamp raw JSON parse + 검증. */
function parseSentStamp(raw: string): SentStamp | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SentStamp>;
    if (typeof parsed.pushId !== 'string' || parsed.pushId.length === 0) return null;
    if (typeof parsed.sentAt !== 'number' || !Number.isFinite(parsed.sentAt)) return null;
    return { pushId: parsed.pushId, sentAt: parsed.sentAt };
  } catch {
    return null;
  }
}

/** prefix scan helper — cursor + cacheTtl 정합 (pushAckStats.ts 패턴). */
async function listPrefixKeys(
  kv: KVNamespace,
  prefix: string,
  limit: number,
): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  let enumerated = 0;
  do {
    const result = await kv.list({
      prefix,
      cursor,
      limit: Math.min(limit - enumerated, 1000),
    });
    for (const key of result.keys) {
      if (enumerated >= limit) break;
      keys.push(key.name);
      enumerated += 1;
    }
    cursor = result.list_complete || enumerated >= limit ? undefined : result.cursor;
  } while (cursor);
  return keys;
}

/**
 * `sent:` + `received:` prefix scan으로 5min 윈도우 corrId-join 산출.
 *
 * sent stamp 가 부재한 received(legacy device / 누락)는 분자에서만 counted X — sent 가 SSoT.
 * received stamp 가 부재한 sent 는 미도달로 간주.
 *
 * @param kv PENDING_PUSHES KV namespace
 * @param now 현재 epoch ms
 * @param limit 각 prefix scan 한 회당 최대 entry 수 (default DEFAULT_LIST_LIMIT)
 */
export async function computeSilentPushReachRatio(
  kv: KVNamespace,
  now: number,
  limit: number = DEFAULT_LIST_LIMIT,
): Promise<SilentPushReachRatio> {
  const windowStart = now - SILENT_PUSH_REACH_WINDOW_MS;
  const windowEnd = now;

  // sent stamp scan — pushId → sentAt
  assertCronCacheTtl(CRON_READ_CACHE_TTL_SEC);
  const sentKeys = await listPrefixKeys(kv, SENT_PREFIX, limit);
  const sentByPushId = new Map<string, number>();
  for (const key of sentKeys) {
    const raw = await kv.get(key, { cacheTtl: CRON_READ_CACHE_TTL_SEC });
    if (!raw) continue;
    const stamp = parseSentStamp(raw);
    if (!stamp) continue;
    if (stamp.sentAt < windowStart || stamp.sentAt > windowEnd) continue;
    sentByPushId.set(stamp.pushId, stamp.sentAt);
  }

  // received stamp scan — pushId → receivedAt (sentAt 윈도우 포함 여부 분리)
  const receivedKeys = await listPrefixKeys(kv, RECEIVED_PREFIX, limit);
  let receivedCount = 0;
  let joined = 0;
  for (const key of receivedKeys) {
    const raw = await kv.get(key, { cacheTtl: CRON_READ_CACHE_TTL_SEC });
    if (!raw) continue;
    const stamp = parseReceivedStamp(raw);
    if (!stamp) continue;
    const sentAt = sentByPushId.get(stamp.pushId);
    // sent stamp 가 있고 5min 윈도우 안 → received as joined.
    if (sentAt !== undefined && sentAt >= windowStart && sentAt <= windowEnd) {
      receivedCount += 1;
      joined += 1;
    }
  }

  const sent = sentByPushId.size;
  const ratio = sent === 0 ? 0 : receivedCount / sent;
  return {
    sent,
    received: receivedCount,
    joined,
    ratio,
    windowStart,
    windowEnd,
  };
}
