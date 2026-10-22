/**
 * #2452 — cron `listTrips()` list-quota 게이트 (PR #2450 write-throttle의 짝).
 *
 * 배경: `runScheduled`가 매 cron tick(1분 = 1,440회/일) `listTrips(env.TRIPS)`(`kv.list()`)를
 * 무조건 호출한다. Cloudflare Free plan에서 LIST는 read/write와 별도 quota 버킷(상한
 * 1,000/일)이라 하루 중 tick ~1000(대략 16:40 UTC)부터 자정까지 `kv.list()`가 실패 → cron이
 * trip을 못 찾아 advance/SSoT/fire가 그 시간대 전체 전멸한다. #2073 idle-gate
 * (`cronIdleGate.ts`)는 pending/retry `kv.list()`만 게이팅하고 이 main `listTrips`는
 * 게이팅하지 않는다 — 이 모듈이 그 잔여 취약점을 막는다.
 *
 * 해법: "활성 trip이 하나라도 있는가"를 값싼 KV GET 마커(read quota 100k/일, 사실상 무제한)로
 * 먼저 판정하고, 마커가 없을 때만 `listTrips` 호출 자체를 skip한다.
 *   - 마커는 `POST /trips` REGISTER 성공 시(`index.ts`, putTrip 직후) 1회 stamp된다.
 *     `POST /position`에서는 절대 stamp하지 않는다 — PR #2450의 write throttle을 되돌리지
 *     않기 위함.
 *   - TTL은 고정 상수 없이 trip 자신의 `expiresAt` 기준으로 계산한다(putTrip과 동일 방식) —
 *     실제 trip 수명과 항상 정렬된다.
 *   - cron이 마커를 발견해 `listTrips`를 실행한 tick마다, 실제 결과로 마커를 조정한다:
 *     trips가 비었으면(stale marker) 즉시 delete해 다음 idle tick부터 skip이 재개되게 하고,
 *     trips가 있으면 남은 trip 중 최대 `expiresAt`이 마커가 담은 만료보다 **커졌을 때만**
 *     (#3167) 재stamp한다.
 *
 * #3167 — 마커 값은 만료 epoch(ms, `String(maxExpiresAt)`)다. 과거엔 값이 항상 '1'이라 만료
 * 연장을 따라가려고 활성 tick마다 무조건 재기록했다(~1 write/분). 값에 만료를 실어 두면 cron이
 * 이미 매 tick 읽는 값만으로 "재기록 필요 여부"를 판정할 수 있다.
 *
 * 안전 논거(마커가 trip보다 먼저 죽는 틈이 없다): trip 만료는 `extendTripExpiryOnActivity` /
 * `extendTripExpiryViaPosition`이 **잔여 30분 미만일 때만** now+2h로 연장한다. 마커 TTL은
 * 직전 max `expiresAt`에 정렬돼 있으므로, 연장 시점엔 마커가 아직 최소 ~30분 살아있다. cron은
 * 1분 주기라 그 안에 연장된 trip을 보고(마커가 살아있어 listTrips가 실행됨) 새 만료로 재기록한다.
 * 어떤 연장 경로도 마커를 건드리지 않아도 공백이 생기지 않는 이유다.
 * 낡은 읽기(cacheTtl ≤ ~30s)는 저장 만료를 실제보다 이르게/없게만 보일 수 있고(마커는 만료 외에
 * 줄어들지 않는다) 그 결과는 불필요한 재기록일 뿐 필요한 재기록의 누락이 아니다.
 * legacy 값 '1'/파싱 불가 값은 "만료 미상"으로 취급해 첫 tick에 업그레이드한다.
 *
 * 보수 정책(#2073 `readPushActivityRecent`와 동일) — 마커 GET이 실패(KV 장애)하면
 * "활성 trip이 있을 수 있음"으로 간주해 `listTrips`를 강행한다. 실 라이더의 fire를 놓치는
 * 것은 불허 — 가끔의 낭비 list 호출은 감수한다.
 */

import { assertCronCacheTtl, CRON_READ_CACHE_TTL_SEC } from './kvConsistency';
import type { Trip } from './types';

export const ACTIVE_TRIPS_MARKER_KEY = 'cron:has-active-trips';

/** 유효한 만료 epoch(ms)의 하한 — legacy 값 '1' 등 epoch가 아닌 값을 "만료 미상"으로 가른다. */
const MIN_VALID_EXPIRES_AT_MS = 1e11;

function parseMarkerExpiresAt(raw: string | null): number | null {
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= MIN_VALID_EXPIRES_AT_MS ? parsed : null;
}

export interface ActiveTripsMarkerState {
  /** `listTrips`를 실행해야 하는가(마커 존재 또는 읽기 실패). */
  readonly mayHaveActiveTrips: boolean;
  /** 마커가 담은 만료 epoch(ms). 부재/legacy/파싱 불가/읽기 실패면 null(= 재기록 필요). */
  readonly storedExpiresAt: number | null;
}

/** KV `expirationTtl` 최소 제약(60s) 준수 — `putTrip`(trips.ts)과 동일 계산. */
const MIN_MARKER_TTL_SEC = 60;

function ttlSecFromExpiresAt(expiresAt: number, now: number): number {
  return Math.max(MIN_MARKER_TTL_SEC, Math.floor((expiresAt - now) / 1000));
}

/**
 * `POST /trips` REGISTER 성공(생성/업데이트 공통 putTrip 직후) 시 1회 stamp.
 *
 * 이 write가 유실되면(예: KV 장애) cron이 이 trip을 listTrips로 영영 발견 못 할 위험이 있다
 * — cron 쪽 `refreshActiveTripsMarker`는 마커가 이미 있을 때만 동작하므로 자가치유 지점이
 * 아니다. 그래서 이 함수는 다른 마커 write(예: `refreshActiveTripsMarker`, `cronIdleGate`)와
 * 달리 실패를 삼키지 않고 그대로 throw한다 — 호출부(`index.ts`)가 register 응답을 막지 않는
 * 선에서 로깅하도록 위임한다.
 */
export async function markTripRegistered(
  kv: KVNamespace,
  expiresAt: number,
  now: number,
): Promise<void> {
  // #3167 — 이미 더 늦은 만료가 기록돼 있으면 단축하지 않는다. 읽기가 낡거나 실패해도 항상
  // write는 수행한다(조건부 skip 금지): 낡은 읽기를 근거로 write를 건너뛰면 cron이 삭제한 직후의
  // 신규 등록이 마커 없이 남을 수 있다.
  let existing: number | null = null;
  try {
    existing = parseMarkerExpiresAt(await kv.get(ACTIVE_TRIPS_MARKER_KEY));
  } catch {
    existing = null;
  }
  const effective = Math.max(expiresAt, existing ?? 0);
  await kv.put(ACTIVE_TRIPS_MARKER_KEY, String(effective), {
    expirationTtl: ttlSecFromExpiresAt(effective, now),
  });
}

/**
 * cron이 `listTrips` 실행 *후* 실 결과로 마커를 조정한다. 마커가 없어 `listTrips` 자체를
 * skip한 tick에는 호출하지 않는다(불필요한 delete write를 피함 — 호출부 책임).
 */
export async function refreshActiveTripsMarker(
  kv: KVNamespace,
  trips: readonly Trip[],
  now: number,
  storedExpiresAt: number | null,
): Promise<void> {
  if (trips.length === 0) {
    try {
      await kv.delete(ACTIVE_TRIPS_MARKER_KEY);
    } catch {
      // silent — TTL 자연만료가 백업.
    }
    return;
  }
  const maxExpiresAt = trips.reduce((max, trip) => Math.max(max, trip.expiresAt), 0);
  // #3167 — 만료가 늘지 않았으면 재기록 불필요(저장 만료가 미상이면 항상 재기록).
  if (storedExpiresAt !== null && maxExpiresAt <= storedExpiresAt) return;
  try {
    await kv.put(ACTIVE_TRIPS_MARKER_KEY, String(maxExpiresAt), {
      expirationTtl: ttlSecFromExpiresAt(maxExpiresAt, now),
    });
  } catch {
    // silent.
  }
}

/**
 * marker 상태(= `listTrips`를 실행해야 하는가 + 마커가 담은 만료).
 * KV 미바인딩 → 비활성(binding 자체가 없으면 마커 개념이 무의미). read 실패 → 활성으로 간주
 * (보수적 — `listTrips` 강행, 위 모듈 헤더 정책 참조). 비-null 값은 legacy '1' 포함 모두 활성.
 */
export async function readActiveTripsMarker(
  kv: KVNamespace | undefined,
): Promise<ActiveTripsMarkerState> {
  if (!kv) return { mayHaveActiveTrips: false, storedExpiresAt: null };
  try {
    assertCronCacheTtl(CRON_READ_CACHE_TTL_SEC);
    const raw = await kv.get(ACTIVE_TRIPS_MARKER_KEY, { cacheTtl: CRON_READ_CACHE_TTL_SEC });
    return { mayHaveActiveTrips: raw !== null, storedExpiresAt: parseMarkerExpiresAt(raw) };
  } catch {
    return { mayHaveActiveTrips: true, storedExpiresAt: null };
  }
}
