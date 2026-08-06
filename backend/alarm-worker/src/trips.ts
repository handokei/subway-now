import { getArchFlag } from './archFlag';
import {
  assertCronCacheTtl,
  assertKvCacheTtl,
  CRON_READ_CACHE_TTL_SEC as SHARED_CRON_TTL,
} from './kvConsistency';
import { listPending, pendingKey } from './pendingPushes';
import type { Trip } from './types';

/**
 * KV CRUD for active trips.
 *
 * Key format: trip:<token>
 * Listing은 prefix scan으로 enumerate한다.
 */

const TRIP_PREFIX = 'trip:';

/**
 * ADR-022 B4 — 새 route = 새 token 강제 (Phase 1-3, #2002 wire).
 *
 * 2026-06-17 ~ 2026-07-01 15일 회귀: `trip token e25e1158` 재사용으로 사용자가 새 route
 * 등록해도 old destination(용마산) silent push가 계속 발사되고 device는
 * `trip-token-mismatch`로 skip → backend/device state sync 완전 붕괴.
 *
 * Root cause: `POST /trips`가 incoming token(=APNs device token)을 그대로 KV key로 사용.
 * device 수명 동안 token이 안정하므로 route/destination이 바뀌어도 같은 KV entry에 덮어써짐.
 * `isSameSession`은 trainCode/createdAt 기준 → route/destination 차이가 있어도 같은 token 유지.
 *
 * #2002 — 임시 상수 `SIMPLE_ARCH_ENABLED` 제거. Phase 0 (#1988) 머지 후 real helper
 * `getArchFlag(kv)` 로 교체. flag 값은 KV `arch:simple-arrival-v1` 로 관리 (rollback = KV write).
 * Rollback: `POST /admin/arch-flag {value:'off'}` 로 즉시 되돌린다 (배포 없음).
 */

/**
 * cron read의 KV cacheTtl (#766/#770 → #1364 → #1381).
 *
 * #765 evidence: sync handler `putTrip` 직후 다음 cron(43~60s 후)의 `kv.get`이 옛 캐시를
 * 읽어 `boardingLock.expiresAt`이 갱신 전 값으로 노출 → `isBoardingLockActive` false-negative
 * → "lock missing or expired" 회귀.
 *
 * #1364 propagation 회피 의도: cron read를 origin 강제 조회하려 `cacheTtl=0`을 시도했으나
 * Cloudflare KV runtime은 `cacheTtl < 30` 요청을 거절한다 — 매 cron 사이클 `Invalid
 * cache_ttl of 0. Cache TTL must be at least 30.` throw로 `listTrips`가 첫 trip iterate
 * 시점에 abort되어 silent push 발사 0건 회귀(#1381 evidence).
 *
 * Resolution: 모든 KV read 경로(cron / read-after-write)는 KV 최소 제약(30s)을 준수한다.
 * #1423 — 과거 본 파일 주석이 "sync handler는 cacheTtl=0 허용"이라 명시해 `index.ts:1052`
 * `verifyBoardingLockPersisted`가 같은 함정에 재발 (`/boarding-lock/sync` 전체 400 fail).
 * 이제 `getTrip`은 caller가 `cacheTtl`을 명시할 때 `assertKvCacheTtl`로 floor 검증한다 —
 * caller 단계에서 명시 실패시켜 다음 callsite가 같은 회귀를 못 만들도록 차단.
 */
const CRON_READ_CACHE_TTL_SEC = SHARED_CRON_TTL;

export function tripKey(token: string): string {
  return `${TRIP_PREFIX}${token}`;
}

export async function putTrip(kv: KVNamespace, trip: Trip): Promise<void> {
  const ttlSec = Math.max(60, Math.floor((trip.expiresAt - Date.now()) / 1000));
  await kv.put(tripKey(trip.token), JSON.stringify(trip), { expirationTtl: ttlSec });
}

/**
 * getTrip은 caller가 cacheTtl을 지정해 stale read window를 명시 제어한다.
 *
 * 기본(미지정): 기본 KV cacheTtl(60s) 사용. read 경로 일반.
 * `cacheTtl: 30+`: read-after-write verification 경로 — sync handler가 putTrip 직후
 *   propagation 확인 시 사용. 30s window 안에 region propagation이 정렬되며, retry로 한 번 더
 *   확인 후 실패 시 503 반환.
 *
 * #1423 — `cacheTtl < 30`은 `assertKvCacheTtl`이 caller 단계에서 RangeError throw.
 * Cloudflare KV runtime이 throw하는 `Invalid cache_ttl` 사고(#1364/#1381)는 첫 iterate
 * 시점에서야 발생해 root cause가 가려지지만, 본 가드는 호출 자체를 막아 명시적으로 실패시킨다.
 */
export async function getTrip(
  kv: KVNamespace,
  token: string,
  options?: { cacheTtl?: number },
): Promise<Trip | null> {
  // #1423 — caller가 cacheTtl 명시했으면 floor 검증. undefined는 KV 기본(60s) 사용 → 통과.
  assertKvCacheTtl(options?.cacheTtl);
  const raw =
    options?.cacheTtl !== undefined
      ? await kv.get(tripKey(token), { cacheTtl: options.cacheTtl })
      : await kv.get(tripKey(token));
  if (!raw) return null;
  try {
    // 주의: stale lock auto-clear는 `listTrips` (cron) 경로에만 적용한다.
    // sync handler는 payload trainCode로 lock을 swap해 line mismatch를 해소하므로
    // 여기서 미리 제거하면 swap 기회가 사라진다.
    return JSON.parse(raw) as Trip;
  } catch {
    return null;
  }
}

export async function deleteTrip(kv: KVNamespace, token: string): Promise<void> {
  await kv.delete(tripKey(token));
}

export async function* listTrips(kv: KVNamespace): AsyncGenerator<Trip> {
  let cursor: string | undefined;
  do {
    const result = await kv.list({ prefix: TRIP_PREFIX, cursor });
    for (const key of result.keys) {
      // #766/#770/#1381 — cron read cacheTtl 30s. Cloudflare KV 최소 제약(<30 throw)을 지키면서
      // 동시에 putTrip 직후 첫 cron 사이클의 옛 캐시 window를 차단한다. region propagation
      // 정합성은 sync handler의 verifyBoardingLockPersisted가 read-after-write 검증으로 책임.
      // #1402 — 신규 callsite가 0/10 같은 값을 silently 쓰지 못하도록 caller 단계에서 guard.
      assertCronCacheTtl(CRON_READ_CACHE_TTL_SEC);
      const raw = await kv.get(key.name, { cacheTtl: CRON_READ_CACHE_TTL_SEC });
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as Trip;
        yield clearStaleBoardingLock(parsed);
      } catch {
        // 손상된 엔트리는 스킵 (TTL로 자동 정리됨)
      }
    }
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);
}

/**
 * #1364 Layer 4 — stale lock auto-clear.
 *
 * `boardingLock.line`이 현재 첫 waypoint의 line과 다르면 환승 시점에 끊긴 옛 leg의 lock이
 * KV에 남아 있는 상황 (trainCode swap이 누락됐거나 환승 직후 sync 실패). cron이 이 lock을
 * 활성으로 오인하면 잘못된 line의 trainCode를 추적하는 loop가 발생한다 (08:33-35 evidence,
 * `trainCode 7056 not found 3 cycle`).
 *
 * Read 시점에 line mismatch면 lock을 제거해 다음 cron 사이클에 lockless 경로(또는
 * boarding-prompt evaluation)로 복귀시킨다.
 */
export function clearStaleBoardingLock(trip: Trip): Trip {
  if (!trip.boardingLock) return trip;
  const head = trip.waypoints[0];
  if (!head) return trip;
  if (trip.boardingLock.line === head.line) return trip;
  return { ...trip, boardingLock: undefined };
}

/**
 * ADR-022 B4 — route/destination 시그니처.
 *
 * 두 trip이 "같은 route"인지 판정하는 content-based key. destination + waypoints sequence
 * (stationName + line + kind + occurrenceIdx)로 계산. `route` 필드 자체를 쓰지 않는 이유는
 * `POST /trips` 핸들러가 legacy `[destination]` waypoints를 Dijkstra로 재추론(#1604)하는
 * 경로에서 route 필드가 stale일 수 있기 때문. waypoints가 SSOT.
 */
export function computeRouteSignature(trip: Trip): string {
  const waypointSig = trip.waypoints
    .map(
      (w) =>
        `${w.stationName}|${w.line}|${w.kind}|${w.occurrenceIdx ?? 0}`,
    )
    .join('/');
  return `${trip.destination}::${waypointSig}`;
}

/**
 * ADR-022 B4 — 새 route = 새 token 강제 결정.
 *
 * `POST /trips`가 호출하는 진입점. incoming trip과 existing trip의 route/destination
 * 시그니처를 비교해 다르면 새 token 발급 + old token cleanup, 같으면 incoming token 유지.
 *
 * Flag OFF (default, KV `arch:simple-arrival-v1` !== 'on'): 기존 동작 유지 — incoming.token
 * 그대로 반환, KV cleanup 없음. Phase 1-3 인프라만 병존.
 *
 * Flag ON (Phase 2+, KV `arch:simple-arrival-v1` === 'on'): existing 있고 route sig 다르면
 *   1. `crypto.randomUUID()`로 새 token 생성
 *   2. `trip:<oldToken>` KV delete
 *   3. `pending:*` 중 `entry.token === oldToken` 인 entry 모두 delete
 *   4. 새 token 반환 (`rotated: true`)
 *
 * existing 없음 또는 같은 route: incoming.token 그대로 반환 (`rotated: false`).
 *
 * Testability: `deps.simpleArchEnabled` / `deps.generateToken` DI로 flag 강제 + token 결정성
 * 확보. 기본은 real helper `getArchFlag(kv)` + `crypto.randomUUID`. 테스트가 옵션 명시.
 * #2002 — 임시 상수 대신 real helper wire. KV 미바인딩 / 미설정 견해는 `getArchFlag` 가
 * default `'off'` 로 fallback → 기존 동작 유지.
 */
export interface TokenRotationResult {
  token: string;
  rotated: boolean;
}

export interface TokenRotationDeps {
  /** flag override — 미지정 시 `getArchFlag(kv) === 'on'` 조회. */
  simpleArchEnabled?: boolean;
  /** 새 token 발급 함수 — 미지정 시 `crypto.randomUUID`. */
  generateToken?: () => string;
  /**
   * #2173 — `TOKEN_ROTATION_DISABLED` guard override. 미지정 시 production 상수(`true`)를
   * 그대로 사용한다. rotation 로직 자체(existing/route sig 비교, cleanup)는 삭제하지 않고
   * 보존해야 하므로, 그 경로를 테스트가 커버할 수 있도록 기존 `simpleArchEnabled`/`generateToken`
   * 과 동일한 DI 패턴으로 노출한다. 실제 호출부(`POST /trips`)는 이 값을 지정하지 않는다.
   */
  rotationDisabled?: boolean;
}

/**
 * #2173 P0 hotfix — token rotation 전면 비활성 guard.
 *
 * `rotateTripTokenForNewRoute`가 route sig 변경 시 `crypto.randomUUID()`로 trip.token을
 * 교체 → 이후 모든 push가 UUID를 APNs deviceToken으로 사용해 400 BadDeviceToken →
 * 첫 due push에서 push-unrecoverable 즉사 (Epic #2172 물증).
 *
 * `arch:simple-arrival-v1` 플래그를 OFF로 끄는 방식은 금지 — 오토락 봉인 등 다른 게이트까지
 * 함께 풀린다. 그래서 rotation 경로만 독립적으로 단락하는 전용 상수 guard를 둔다.
 * KV/env 신규 플래그는 추가하지 않는다 (파생 복잡도 방지) — 배포 시점 코드 상수로만 제어.
 *
 * 로테이션 로직 자체는 삭제하지 않는다 — #P1-A에서 구조 수리 후 이 상수를 false로 되돌려 재활성.
 */
const TOKEN_ROTATION_DISABLED = true;

export async function rotateTripTokenForNewRoute(
  kv: KVNamespace,
  incoming: Trip,
  existing: Trip | null,
  deps?: TokenRotationDeps,
): Promise<TokenRotationResult> {
  // #2173 — rotation 전면 guard. flag 상태와 무관하게 항상 incoming token 유지.
  if (deps?.rotationDisabled ?? TOKEN_ROTATION_DISABLED) {
    return { token: incoming.token, rotated: false };
  }
  // #2002 — real helper wire. deps.simpleArchEnabled DI 명시가 우선; 미지정 시 KV 조회.
  // `getArchFlag` 는 KV 미바인딩/미설정/오타 모두 default `'off'` 로 fallback (dormant).
  // 명시적 괄호: `??` 가 `===` 보다 tighter 로 파싱되므로 DI boolean 값 우선 사용을 보장한다.
  const flagEnabled =
    deps?.simpleArchEnabled ?? ((await getArchFlag(kv)) === 'on');
  // Flag OFF: 기존 동작 유지. incoming token 그대로.
  if (!flagEnabled) {
    return { token: incoming.token, rotated: false };
  }
  // existing 없음 (신규 trip): incoming token 그대로 등록.
  if (existing === null) {
    return { token: incoming.token, rotated: false };
  }
  // 같은 route (destination + waypoints 시그니처 일치): incoming token 유지 → same-session merge.
  const existingSig = computeRouteSignature(existing);
  const incomingSig = computeRouteSignature(incoming);
  if (existingSig === incomingSig) {
    return { token: incoming.token, rotated: false };
  }
  // 다른 route: 새 token 발급 + old 정리.
  const generateToken = deps?.generateToken ?? (() => crypto.randomUUID());
  const newToken = generateToken();
  const oldToken = existing.token;
  await deleteTrip(kv, oldToken);
  await cleanupPendingPushesForToken(kv, oldToken);
  return { token: newToken, rotated: true };
}

/**
 * ADR-022 B4 — old token 소유의 pending push entry cleanup.
 *
 * `listPending`으로 enumerate → `entry.token === oldToken` 인 것만 delete. token mismatch
 * entry는 다른 device 소유이므로 건드리지 않는다. 손상된 entry는 listPending이 자동 skip.
 */
export async function cleanupPendingPushesForToken(
  kv: KVNamespace,
  oldToken: string,
): Promise<number> {
  let removed = 0;
  for await (const entry of listPending(kv)) {
    if (entry.token !== oldToken) continue;
    await kv.delete(pendingKey(entry.pushId));
    removed += 1;
  }
  return removed;
}

/**
 * #2129 — per-token in-flight 직렬화.
 *
 * `POST /trips`가 device의 같은 token으로 거의 동시에 2건 도착하면(2026-08-04 실탑승 evidence:
 * 20:06:21 `msejyvj91`/`msejyvmt2` 2개 register), 각 요청이 독립적으로
 * `getTrip → rotateTripTokenForNewRoute → putTrip` TOCTOU window를 통과하며 interleave할 수
 * 있다: 요청 A가 `existing=null`로 읽어(rotated=false) 원본 token으로 진행하는 도중, 요청 B가
 * A의 이미 landed된 write를 `existing`으로 읽고 route sig 차이로 새 UUID를 발급 +
 * `trip:<oldToken>` delete까지 완료 → 그 뒤에 A의 원래 `putTrip`이 착지해 오히려 A가 방금 지워진
 * 키를 되살린다. 결과: 유령 trip 2개(원본 token + rotated UUID) 모두 KV에 생존.
 *
 * 같은 isolate 안에서 같은 token의 register 처리를 순차 큐로 직렬화해 두 번째 요청이 첫 번째
 * 요청의 read-rotate-write 사이클이 완전히 끝난 뒤에야 자신의 `getTrip`을 수행하도록 보장한다.
 * `previous.then(fn, fn)` — 직전 요청이 성공/실패 무관하게 정착(settle)한 뒤 `fn`이 실행되며,
 * 호출자는 자신의 `fn` 결과/에러를 그대로 받는다(큐 자체의 실패가 전파되지 않음).
 *
 * 한계: Cloudflare Workers는 요청을 여러 isolate로 분산할 수 있어 cross-isolate 완전 보장은
 * 아니다 — 같은 device의 거의 동시 POST는 대개 같은 isolate/colo로 라우팅되므로 실질적 방어선.
 * 완전한 분산 lock(Durable Object 등)은 #2129 금지사항(rotation 자체 재작성 금지) 범위 밖이며
 * 별도 이슈 후보. 메모리 누적 방지를 위해 자신이 마지막 queued entry였으면 Map에서 제거한다.
 */
const registerLocks = new Map<string, Promise<void>>();

export function withTripRegisterLock<T>(
  token: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = registerLocks.get(token) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  registerLocks.set(token, settled);
  void settled.finally(() => {
    if (registerLocks.get(token) === settled) {
      registerLocks.delete(token);
    }
  });
  return run;
}

/** 테스트용 — register lock Map 상태 초기화. production 호출자 없음. */
export function __resetTripRegisterLocksForTest(): void {
  registerLocks.clear();
}
