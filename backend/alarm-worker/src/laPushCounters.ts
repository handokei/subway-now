/**
 * LA push delivery counter accumulation (#1779).
 *
 * cron cycle 완료 시 laPushSent / laPushFailed를 1h bucket KV에 누적.
 * computeObservabilityMetrics가 24h bucket 합산으로 laPushDeliveryRatio를 산출한다.
 *
 * scheduled.ts, observabilityMetrics.ts 양쪽이 공유하는 독립 모듈.
 */

/** KV key prefix for per-hour LA push counters. */
export const LA_PUSH_COUNTER_KEY_PREFIX = 'la-push-counters:';

/** TTL 25h — covers 24h rolling scan. */
const LA_PUSH_COUNTER_TTL_SEC = 25 * 60 * 60;

/** 1h bucket key for LA push counters. */
export function laPushCounterKey(now: number): string {
  const bucket = Math.floor(now / (60 * 60 * 1000));
  return `${LA_PUSH_COUNTER_KEY_PREFIX}${bucket}`;
}

/**
 * cron cycle 완료 후 laPushSent / laPushFailed를 현재 1h bucket KV에 누적.
 * sent+failed=0이면 no-op (불필요한 KV write 차단).
 */
export async function accumulateLaPushCounters(
  tripsKv: KVNamespace,
  sent: number,
  failed: number,
  now: number,
): Promise<void> {
  if (sent + failed === 0) return;
  const key = laPushCounterKey(now);
  const raw = await tripsKv.get(key);
  let prevSent = 0;
  let prevFailed = 0;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { sent: number; failed: number };
      prevSent = parsed.sent;
      prevFailed = parsed.failed;
    } catch {
      // malformed — start fresh
    }
  }
  await tripsKv.put(
    key,
    JSON.stringify({ sent: prevSent + sent, failed: prevFailed + failed }),
    { expirationTtl: LA_PUSH_COUNTER_TTL_SEC },
  );
}

/**
 * 지난 24h의 bucket 합산으로 총 sent / failed를 산출.
 * 1h 단위 24 bucket을 KV.get으로 순차 조회 (KV cost: 최대 24 gets).
 */
export async function sumLaPushCounters(
  tripsKv: KVNamespace,
  now: number,
): Promise<{ sent: number; failed: number }> {
  const currentBucket = Math.floor(now / (60 * 60 * 1000));
  let totalSent = 0;
  let totalFailed = 0;
  for (let i = 0; i < 24; i++) {
    const bucket = currentBucket - i;
    const key = `${LA_PUSH_COUNTER_KEY_PREFIX}${bucket}`;
    const raw = await tripsKv.get(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as { sent: number; failed: number };
      totalSent += parsed.sent;
      totalFailed += parsed.failed;
    } catch {
      // malformed — skip
    }
  }
  return { sent: totalSent, failed: totalFailed };
}
