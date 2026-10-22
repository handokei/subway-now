/**
 * #3168 — D1 vs KV 지연 실측 프로브 (관측 전용, 동작 변경 0, KV write 0).
 *
 * 목적: lock trip의 position/accel/device-contact 시계열을 KV → D1로 옮길지 판단하기 위해
 * **프로덕션 colo**(cron의 colo / Seoul 사용자 HTTP를 받는 colo)에서 D1 read·write와 KV get의
 * 실제 지연을 잰다. `wrangler dev --remote`(colo LAX) 측정은 colo가 달라 근거로 부족했다.
 *
 * 제약
 * - KV put/delete 0. 무료 플랜 KV write 쿼터(1,000/day)가 소진된 상태에서 쿼터를 더 쓰지 않는다.
 *   그래서 "시간당 1회"는 KV 마커가 아니라 **UTC 분==0 tick**으로 상태 없이 정하고, HTTP 일 cap은
 *   D1 COUNT로 센다.
 * - 프로브는 항상 응답/cron 이후(`waitUntil`)에 돌고, 어떤 실패도 흡수한다.
 * - 행 수: cron ≤24/day + http ≤`PROBE_HTTP_DAILY_CAP`/day = 일 124행 이하.
 *
 * 제거: `D1_KV_PROBE_ENABLED=false`로 즉시 비활성. 약 3일 데이터 수집 후 이 파일·배선·
 * `0008_latency_probe.sql` 소비처를 걷어낸다(테이블은 데이터 조회용으로 남겨도 무방).
 *
 * 측정 해석 주의: Workers 런타임의 시계는 I/O 경계에서만 전진한다. 모든 구간이 await된 I/O라
 * ms 단위로 유효하다. KV get은 키가 없어도(null) 조회 지연을 잰다.
 */

/** 마스터 스위치. false면 cron/HTTP 프로브 모두 no-op. */
export const D1_KV_PROBE_ENABLED = true;

/** POST /position 샘플링 비율(1/20). */
export const PROBE_HTTP_SAMPLE_RATE = 0.05;

/** HTTP 프로브 UTC 일 상한. */
export const PROBE_HTTP_DAILY_CAP = 100;

/** cron 프로브가 도는 UTC 분(매시 정각 tick). */
const PROBE_CRON_MINUTE_UTC = 0;

/** KV get 대상 — 이미 존재하는 키(스케줄러 heartbeat stamp). cacheTtl을 주지 않아 cold에 가깝다. */
const PROBE_KV_KEY = 'scheduled:last-heartbeat';

/** cron(scheduled event)에는 request.cf가 없어 colo를 trace 엔드포인트에서 시간당 1회 읽는다. */
const CF_TRACE_URL = 'https://www.cloudflare.com/cdn-cgi/trace';

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;
const UNKNOWN_COLO = 'unknown';

export type ProbeSource = 'cron' | 'http';

export interface ProbeEnv {
  DB?: D1Database;
  TRIPS: KVNamespace;
}

export function isCronProbeTick(scheduledTime: number): boolean {
  return new Date(scheduledTime).getUTCMinutes() === PROBE_CRON_MINUTE_UTC;
}

/** 경과 ms. */
async function timed(op: () => Promise<unknown>): Promise<number> {
  const start = Date.now();
  await op();
  return Date.now() - start;
}

/**
 * D1 read(PK 인덱스 1행) → KV get(옵션 없음) → 행 INSERT(쓰기 지연 측정) → 같은 행에
 * `d1_write_ms` UPDATE. 어떤 단계가 throw해도 흡수한다.
 */
export async function recordLatencyProbe(
  env: ProbeEnv,
  source: ProbeSource,
  colo: string,
): Promise<void> {
  const { DB: db, TRIPS: kv } = env;
  if (!db) return;
  try {
    const d1ReadMs = await timed(() =>
      db.prepare('SELECT id FROM latency_probe ORDER BY id DESC LIMIT 1').first(),
    );
    const kvGetMs = await timed(() => kv.get(PROBE_KV_KEY));
    const ts = Date.now();
    let lastRowId: number | undefined;
    const d1WriteMs = await timed(async () => {
      const result = await db
        .prepare(
          'INSERT INTO latency_probe (ts, source, colo, d1_read_ms, kv_get_ms) VALUES (?, ?, ?, ?, ?)',
        )
        .bind(ts, source, colo, d1ReadMs, kvGetMs)
        .run();
      lastRowId = result.meta?.last_row_id;
    });
    if (lastRowId === undefined) return;
    await db
      .prepare('UPDATE latency_probe SET d1_write_ms = ? WHERE id = ?')
      .bind(d1WriteMs, lastRowId)
      .run();
  } catch {
    // 관측 전용 — 프로브 실패는 서비스에 영향 0.
  }
}

/**
 * POST /position 샘플 프로브. `random`(0~1)이 샘플링 비율 미만이고 오늘(UTC) http 행이 cap 미만일
 * 때만 적재한다. 미당첨이면 D1/KV 접근이 전혀 없다.
 */
export async function runHttpProbe(
  env: ProbeEnv,
  colo: string,
  now: number,
  random: number,
  enabled: boolean = D1_KV_PROBE_ENABLED,
): Promise<void> {
  const { DB: db } = env;
  if (!enabled || !db || random >= PROBE_HTTP_SAMPLE_RATE) return;
  try {
    const dayStart = Math.floor(now / MS_PER_DAY) * MS_PER_DAY;
    const row = await db
      .prepare("SELECT COUNT(*) AS n FROM latency_probe WHERE source = 'http' AND ts >= ?")
      .bind(dayStart)
      .first<{ n: number }>();
    if ((row?.n ?? 0) >= PROBE_HTTP_DAILY_CAP) return;
  } catch {
    return;
  }
  await recordLatencyProbe(env, 'http', colo);
}

/** cdn-cgi/trace의 `colo=XXX`. 실패/부재 시 'unknown'. */
export async function fetchCronColo(fetchImpl: typeof fetch = fetch): Promise<string> {
  try {
    const res = await fetchImpl(CF_TRACE_URL);
    const match = /^colo=(\w+)$/m.exec(await res.text());
    return match?.[1] ?? UNKNOWN_COLO;
  } catch {
    return UNKNOWN_COLO;
  }
}

/** scheduled()에서 호출. 정시 tick에만 `waitUntil`로 프로브를 스케줄한다. */
export function scheduleCronProbe(
  env: ProbeEnv,
  ctx: ExecutionContext,
  scheduledTime: number,
  enabled: boolean = D1_KV_PROBE_ENABLED,
): void {
  if (!enabled || !isCronProbeTick(scheduledTime)) return;
  ctx.waitUntil(
    (async () => {
      const colo = await fetchCronColo();
      await recordLatencyProbe(env, 'cron', colo);
    })(),
  );
}
