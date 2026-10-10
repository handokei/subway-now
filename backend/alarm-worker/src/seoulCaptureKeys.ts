/**
 * GET /admin/seoul-capture/keys (#2592, Epic #2239 P1 후속) 스캔 로직.
 *
 * `fixtureFromTrip`(#2586/PR#2588)이 aws CLI + R2 S3 토큰 없이 R2 seoul-capture 목록을
 * 얻을 수 있도록, worker 자신의 TELEMETRY_R2 바인딩으로 key만 조회한다(객체 본문은
 * 절대 반환하지 않음 — 다운로드는 wrangler r2 object get --remote 그대로 유지).
 *
 * index.ts 라우트는 이 모듈에 위임만 한다 (alarmLogStats.ts 선례 — 스캔 로직은 별도
 * 모듈로 분리해 단위테스트).
 */
import { SEOUL_CAPTURE_KEY_PREFIX, parseSeoulCaptureKey, utcDateKey } from './seoulCapture';

/** R2Bucket.list() 1회 호출당 최대 개수 — Cloudflare R2 list() 자체 상한(1000)과 동일. */
export const R2_LIST_PAGE_LIMIT = 1000;

/** 매칭 key 안전 상한 — 응답 payload/스캔 비용 보호. */
export const SEOUL_CAPTURE_KEYS_MAX_RESULTS = 5000;

/**
 * from~to 걸치는 UTC 날짜 수 상한. 날짜 1개당 최소 list() 1 subrequest(페이지네이션 시
 * 그 이상)를 소비한다 — Cloudflare Workers free tier subrequest 한도(요청당 50)를 고려해
 * bounded concurrency(5)로 병렬 호출해도 안전 여유가 남도록 45로 설정 (#2073 quota 사고
 * 클래스 재발 방지 — 키 개수 가드(SEOUL_CAPTURE_KEYS_MAX_RESULTS)만으로는 sparse한
 * 광범위 요청(예: from=0)을 걸러내지 못한다).
 */
export const SEOUL_CAPTURE_MAX_DATE_RANGE_DAYS = 45;

/** 날짜 prefix 병렬 스캔 동시 실행 수. */
export const SEOUL_CAPTURE_LIST_CONCURRENCY = 5;

export type SeoulCaptureKeysRangeError = 'invalid_range' | 'range_too_wide';

/**
 * epoch ms 쿼리 파라미터 파싱. `Number('')`가 0을 반환하는 함정을 막기 위해 raw 문자열이
 * `/^\d+$/`(순수 숫자, 공백/부호/소수점 없음)를 만족할 때만 숫자로 인정한다.
 */
function parseEpochMsParam(raw: string | undefined): number | 'invalid' | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) return 'invalid';
  const n = Number(raw);
  return Number.isFinite(n) ? n : 'invalid';
}

/** from~to(둘 다 epoch ms, inclusive)가 걸치는 UTC 날짜 key 목록 — 하루 단위 prefix 분할용. */
function enumerateUtcDateKeys(fromMs: number, toMs: number): string[] {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const startDay = Math.floor(fromMs / MS_PER_DAY) * MS_PER_DAY;
  const endDay = Math.floor(toMs / MS_PER_DAY) * MS_PER_DAY;
  const dateKeys: string[] = [];
  for (let day = startDay; day <= endDay; day += MS_PER_DAY) {
    dateKeys.push(utcDateKey(day));
  }
  return dateKeys;
}

/**
 * 쿼리 파라미터 `from`/`to`를 검증한다.
 *
 * - 비숫자(빈 문자열 포함)/공백/음수/소수 등 `/^\d+$/` 불일치 또는 from>to → `invalid_range`
 * - from/to가 모두 주어졌고 걸치는 UTC 날짜 수가 상한(45일) 초과 → `range_too_wide`
 *   (매칭 key 5000개 가드와 별개 — subrequest 폭발 자체를 사전 차단)
 */
export function parseSeoulCaptureRangeQuery(
  fromRaw: string | undefined,
  toRaw: string | undefined,
): { from?: number; to?: number } | { error: SeoulCaptureKeysRangeError } {
  const from = parseEpochMsParam(fromRaw);
  const to = parseEpochMsParam(toRaw);
  if (from === 'invalid' || to === 'invalid') return { error: 'invalid_range' };
  if (from !== undefined && to !== undefined) {
    if (from > to) return { error: 'invalid_range' };
    if (enumerateUtcDateKeys(from, to).length > SEOUL_CAPTURE_MAX_DATE_RANGE_DAYS) {
      return { error: 'range_too_wide' };
    }
  }
  return { from, to };
}

/**
 * `seoul-capture/` prefix(들)를 bounded concurrency(5)로 순회하며 [from, to] 범위의
 * cycleStartMs를 가진 key만 반환한다. from/to 둘 다 주어지면 걸치는 UTC 날짜별
 * prefix(`seoul-capture/{YYYY-MM-DD}/`)로 나눠 전체 스캔을 회피하고, 하나라도 없으면
 * `seoul-capture/` 전체를 스캔한다. 매칭 key가 상한(5000)을 넘으면 즉시 중단하고
 * `range_too_wide`.
 */
export async function listSeoulCaptureKeys(
  r2: R2Bucket,
  from: number | undefined,
  to: number | undefined,
): Promise<{ keys: string[] } | { error: 'range_too_wide' }> {
  const prefixes =
    from !== undefined && to !== undefined
      ? enumerateUtcDateKeys(from, to).map((dateKey) => `${SEOUL_CAPTURE_KEY_PREFIX}${dateKey}/`)
      : [SEOUL_CAPTURE_KEY_PREFIX];

  const matched: string[] = [];
  let tooWide = false;

  const scanPrefix = async (prefix: string): Promise<void> => {
    let cursor: string | undefined;
    do {
      const result = await r2.list({ prefix, cursor, limit: R2_LIST_PAGE_LIMIT });
      for (const obj of result.objects) {
        const cycleStartMs = parseSeoulCaptureKey(obj.key);
        if (cycleStartMs === null) continue;
        if (from !== undefined && cycleStartMs < from) continue;
        if (to !== undefined && cycleStartMs > to) continue;
        matched.push(obj.key);
        if (matched.length > SEOUL_CAPTURE_KEYS_MAX_RESULTS) {
          tooWide = true;
          return;
        }
      }
      cursor = result.truncated ? result.cursor : undefined;
    } while (cursor && !tooWide);
  };

  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < prefixes.length && !tooWide) {
      const prefix = prefixes[nextIndex];
      nextIndex += 1;
      await scanPrefix(prefix);
    }
  };
  const workerCount = Math.min(SEOUL_CAPTURE_LIST_CONCURRENCY, prefixes.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (tooWide) return { error: 'range_too_wide' };
  return { keys: matched };
}
