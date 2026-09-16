/**
 * #2054 — cron jitter sample aggregate + scheduled heartbeat KV helpers.
 *
 * 배경: Cloudflare Workers Logs 가 매 cron cycle 5 개 로그를 무조건 발화 → 12h 3600+ 이벤트,
 * 2000 cap 6h 소진. `scheduled: cron jitter` raw log 를 제거하고, 정상 jitter 값은 KV 에
 * append 해뒀다가 시간당 1회 heartbeat 시 P50/P99 산출 + reset.
 *
 * 책임:
 *  - `appendJitterSample` : 정상(≤ spike 임계) jitter 값 KV 배열 append.
 *    KV 미바인딩 / read fail / write fail 시 모두 graceful (log skip 은 관찰 손실이지 서비스 영향 X).
 *  - `readJitterSamples`  : heartbeat 시 배열 read (없으면 empty).
 *  - `resetJitterSamples` : heartbeat log 발화 직후 배열 clear.
 *  - `computeJitterPercentiles` : 순수 P50/P99 산출 (empty → null).
 *
 *  Heartbeat gate:
 *  - `shouldEmitHeartbeat(kv, now)` : last-heartbeat KV timestamp 와 비교. 미존재 / >= interval 이면 true.
 *  - `stampHeartbeat(kv, now)`       : timestamp write + TTL 7200s (2h) 로 자연 정리.
 */

const JITTER_SAMPLES_KEY = 'scheduled:jitter-samples';
const LAST_HEARTBEAT_KEY = 'scheduled:last-heartbeat';

/**
 * jitter sample append 시 상한. cron 60s × 1h = 60 sample 이 정상.
 * KV value 크기 방어용 상한 — spike 폭주로 samples 무한 증가 시 write 폭탄 방지.
 */
export const JITTER_SAMPLES_MAX_LEN = 240;

/**
 * spike 임계 (ms). 이 값 초과 시 heartbeat 대기 없이 즉시 `scheduled: cron jitter spike` log.
 * 45s = Cloudflare scheduler 정상 부하 최대치 이상 (P99 정상 < 10s, spike 는 dashboard 육안 관측용).
 */
export const JITTER_SPIKE_THRESHOLD_MS = 45_000;

/**
 * heartbeat 간격 (ms). idle 시 이 간격마다 1회 `scheduled heartbeat` log 발화.
 * 1h = 이슈 요구사항. cron 60s cycle 60 회당 1 회 heartbeat.
 */
export const HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000;

/**
 * heartbeat KV TTL (초). interval 의 2 배 = 7200s. 만료돼도 다음 cycle 이 자연 재stamp.
 */
export const HEARTBEAT_KV_TTL_SEC = 7200;

/**
 * jitter samples KV TTL (초). heartbeat 발화되지 않아도 자연 정리되도록 24h.
 */
export const JITTER_SAMPLES_KV_TTL_SEC = 24 * 60 * 60;

/**
 * #2073 — jitter sample write 스로틀 주기(tick 수). appendJitterSample이 매 정상 tick 실행돼
 * write 1,440/일(한도 1,000, 144%)을 유발했다(2026-07-29 quota audit). 10 tick당 1회로
 * 샘플링해도 P50/P99 관측(halt 감지)에는 충분한 정밀도 — 순수 관측용 지표라 정밀도 저하가
 * 사용자 가치에 영향 없음.
 */
export const JITTER_SAMPLE_EVERY_N_TICKS = 10;

/**
 * 절대 tick index(now / tickIntervalMs) 기준 결정적 샘플링 gate. KV 상태 없이 `now`만으로
 * 계산해 마지막 write 성공 여부와 무관하게 항상 같은 tick에서 true를 반환한다(재시작/장애
 * 후에도 sampling 주기가 흔들리지 않음).
 */
export function shouldSampleJitterTick(now: number, tickIntervalMs: number): boolean {
  return Math.floor(now / tickIntervalMs) % JITTER_SAMPLE_EVERY_N_TICKS === 0;
}

/** 정상 jitter sample 을 KV 배열에 append. graceful (KV 없음/실패 무시). */
export async function appendJitterSample(
  kv: KVNamespace | undefined,
  jitterMs: number,
): Promise<void> {
  if (!kv) return;
  try {
    const samples = await readJitterSamples(kv);
    samples.push(jitterMs);
    // 상한 초과 시 oldest drop — write 크기 방어.
    if (samples.length > JITTER_SAMPLES_MAX_LEN) {
      samples.splice(0, samples.length - JITTER_SAMPLES_MAX_LEN);
    }
    await kv.put(JITTER_SAMPLES_KEY, JSON.stringify(samples), {
      expirationTtl: JITTER_SAMPLES_KV_TTL_SEC,
    });
  } catch {
    // KV I/O 실패는 관찰 손실 — 서비스 영향 X, silent skip.
  }
}

/** 저장된 jitter samples 배열 read. 없거나 손상 시 empty. */
export async function readJitterSamples(kv: KVNamespace | undefined): Promise<number[]> {
  if (!kv) return [];
  try {
    const raw = await kv.get(JITTER_SAMPLES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  } catch {
    return [];
  }
}

/** heartbeat 발화 직후 samples clear. */
export async function resetJitterSamples(kv: KVNamespace | undefined): Promise<void> {
  if (!kv) return;
  try {
    await kv.delete(JITTER_SAMPLES_KEY);
  } catch {
    // silent
  }
}

/**
 * P50 / P99 산출. 입력 배열은 mutate 하지 않는다 (호출자 재사용 가능).
 * empty → null.
 *
 * 단순 nearest-rank percentile — sort 후 index = ceil(p * n) - 1.
 * n = 1 시 두 값 모두 유일 element.
 */
export function computeJitterPercentiles(
  samples: readonly number[],
): { p50: number; p99: number } | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: pickPercentile(sorted, 0.5),
    p99: pickPercentile(sorted, 0.99),
  };
}

function pickPercentile(sortedAsc: readonly number[], p: number): number {
  const idx = Math.max(0, Math.ceil(p * sortedAsc.length) - 1);
  return sortedAsc[Math.min(idx, sortedAsc.length - 1)];
}

/**
 * heartbeat 발화 gate. last-heartbeat KV timestamp 기준:
 *  - KV 미바인딩 → false (heartbeat log skip. idle idle log 폭발 방지).
 *  - stamp 미존재 → true (첫 emission).
 *  - `now - lastAt >= HEARTBEAT_INTERVAL_MS` → true.
 *
 * 손상 JSON / KV read 실패 → false (안전 방향). read 는 cacheTtl 미지정 (KV 기본 60s).
 */
export async function shouldEmitHeartbeat(
  kv: KVNamespace | undefined,
  now: number,
): Promise<boolean> {
  if (!kv) return false;
  try {
    const raw = await kv.get(LAST_HEARTBEAT_KEY);
    if (!raw) return true;
    const lastAt = Number.parseInt(raw, 10);
    if (!Number.isFinite(lastAt)) return true;
    return now - lastAt >= HEARTBEAT_INTERVAL_MS;
  } catch {
    return false;
  }
}

/** heartbeat 발화 직후 last-heartbeat timestamp stamp. TTL 2h. */
export async function stampHeartbeat(
  kv: KVNamespace | undefined,
  now: number,
): Promise<void> {
  if (!kv) return;
  try {
    await kv.put(LAST_HEARTBEAT_KEY, String(now), {
      expirationTtl: HEARTBEAT_KV_TTL_SEC,
    });
  } catch {
    // silent
  }
}
