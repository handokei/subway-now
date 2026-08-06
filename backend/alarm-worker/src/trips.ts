import { getArchFlag } from './archFlag';
import { recordTripMetrics } from './d1TripMetrics';
import {
  assertCronCacheTtl,
  assertKvCacheTtl,
  CRON_READ_CACHE_TTL_SEC as SHARED_CRON_TTL,
} from './kvConsistency';
import { listPending, pendingKey } from './pendingPushes';
import { writeTripEndedStatus } from './tripStatus';
import type { Trip, TripEndedReason } from './types';

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

/** #2174 — 64-hex APNs device token 포맷 검증. */
const DEVICE_TOKEN_HEX64_RE = /^[0-9a-f]{64}$/i;

/**
 * #2174 (P1-A) — push 발사용 실 APNs deviceToken을 단일 지점에서 해석한다.
 *
 * 로테이션(`rotateTripTokenForNewRoute`)이 `trip.token`을 `crypto.randomUUID()`로 교체해도
 * `trip.deviceToken`은 등록 시점의 실 토큰을 그대로 보존하므로(index.ts `validateTrip`이
 * `incoming.deviceToken`을 rotation 이전에 고정), 정상 경로는 항상 `trip.deviceToken`을 반환한다.
 *
 * 하위호환(#2174 스펙 4): 본 필드 도입 이전 KV에 남은 legacy trip 레코드는 `deviceToken`이
 * 없을 수 있다 — `trip.token`이 유효한 64-hex 포맷(로테이션 전 실토큰)일 때만 그 값으로
 * fallback한다. `trip.token`이 UUID(로테이션된 신원, deviceToken 부재)면 애초에 P0 guard로
 * 로테이션이 막혀 있던 구간의 산물이라 존재해서는 안 되는 조합 — 그런 경우도 fallback으로
 * `trip.token`을 반환해 기존(로테이션 재활성 이전) 동작과 동일하게 유지한다(마이그레이션
 * 배치 금지, 새 회귀 없음 — 이미 무효했던 push가 계속 무효할 뿐).
 */
export function resolveTripDeviceToken(trip: Trip): string {
  if (
    typeof trip.deviceToken === 'string' &&
    DEVICE_TOKEN_HEX64_RE.test(trip.deviceToken)
  ) {
    return trip.deviceToken;
  }
  return trip.token;
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

/**
 * #2175 — deviceToken → 현재 trip.token 역인덱스.
 *
 * ADR-022 B4 로테이션이 `trip.token`을 `crypto.randomUUID()`로 교체하면, `POST /trips`가
 * `getTrip(incoming.token)`(incoming.token은 항상 실 deviceToken — 클라는 응답의 rotated UUID를
 * 채택하지 않는다, #2174 코멘트)로 직전 로테이션의 UUID trip을 찾지 못해 매번 새 trip이 생성되고
 * old UUID trip은 orphan으로 남는다. 이 역인덱스가 "실 deviceToken이 가리키는 현재 trip.token"을
 * 별도 KV entry(`device-trips:<deviceToken>`)로 추적해, 직접 키 조회가 실패해도 로테이션된 trip을
 * 재발견할 수 있게 한다.
 *
 * Key: `device-trips:<deviceToken>` (raw deviceToken을 그대로 키 접미사로 사용 — `trip:<token>`이
 * 이미 raw token을 KV 키로 사용하는 기존 정책과 동일. `hashTripToken`(FNV-1a 32bit)은 Sentry/D1
 * PII 마스킹 목적의 비가역 축약이라 KV lookup key로 쓰면 충돌 시 다른 device의 trip을 잘못
 * 반환할 위험이 있어 부적합 — exact match가 필요한 이 경로는 raw 값을 쓴다).
 * Value: 최신 trip.token (plain string, JSON 아님 — 단일 스칼라라 파싱 오버헤드 불필요).
 *
 * TTL은 가리키는 trip의 `expiresAt`과 정렬 — trip이 자연 만료되면 역인덱스도 함께 사라진다.
 */
const DEVICE_TRIP_INDEX_PREFIX = 'device-trips:';

export function deviceTripIndexKey(deviceToken: string): string {
  return `${DEVICE_TRIP_INDEX_PREFIX}${deviceToken}`;
}

export async function putDeviceTripIndex(
  kv: KVNamespace,
  deviceToken: string,
  tripToken: string,
  expiresAt: number,
): Promise<void> {
  const ttlSec = Math.max(60, Math.floor((expiresAt - Date.now()) / 1000));
  await kv.put(deviceTripIndexKey(deviceToken), tripToken, { expirationTtl: ttlSec });
}

export async function getDeviceTripIndex(
  kv: KVNamespace,
  deviceToken: string,
): Promise<string | null> {
  return kv.get(deviceTripIndexKey(deviceToken));
}

export async function deleteDeviceTripIndex(kv: KVNamespace, deviceToken: string): Promise<void> {
  await kv.delete(deviceTripIndexKey(deviceToken));
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
  /** #2174 — F2 old-trip 관측 기록용 D1 binding. 미지정/undefined는 `recordTripMetrics` 내부 no-op. */
  db?: D1Database;
  /** #2174 — old-trip sentinel/D1 기록 시각(epoch ms). 미지정 시 `Date.now()`. */
  now?: number;
}

/**
 * #2174 (P1-A) — token rotation 재활성 guard.
 *
 * #2173 P0 hotfix가 `deviceToken` 필드 분리 전까지 rotation을 전면 차단했다 — 로테이션이
 * `trip.token`(APNs 발사 주소 겸용)을 UUID로 교체하면 이후 모든 push가 400 BadDeviceToken으로
 * 즉사했기 때문(Epic #2172 물증). 이제 `Trip.deviceToken`이 로테이션과 무관하게 실 토큰을
 * 보존하므로(모든 push 발사 사이트가 `resolveTripDeviceToken(trip)` 사용) rotation을 안전하게
 * 재활성한다.
 *
 * `arch:simple-arrival-v1` 플래그가 여전히 최종 on/off 스위치 — 이 상수는 그 앞단의 이중 guard였고
 * 이제 flag 판정에 그대로 위임한다(false = guard 해제).
 */
const TOKEN_ROTATION_DISABLED = false;

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
  // 같은 route (destination + waypoints 시그니처 일치): existing token으로 merge.
  //
  // #2175 — 과거엔 여기서 `incoming.token`을 그대로 반환했다. `existing`이 항상 직접 키 조회
  // (`getTrip(incoming.token)`)로만 발견되던 시절엔 `existing.token === incoming.token`이 항상
  // 성립해 무해했지만, `POST /trips` 핸들러가 이제 deviceToken 역인덱스로 `existing`을 재발견할
  // 수 있어(직접 키 조회 miss 시 fallback) 이 경우 `existing.token`(예: 이전 로테이션 UUID)이
  // `incoming.token`(원본 실 deviceToken)과 달라진다. `incoming.token`을 반환하면 실 deviceToken
  // 키로 새 trip이 또 생성돼 이미 존재하는 UUID trip과 함께 유령 2개가 남는다 — `existing.token`을
  // 반환해 항상 같은 KV 레코드로 merge되도록 고정한다.
  const existingSig = computeRouteSignature(existing);
  const incomingSig = computeRouteSignature(incoming);
  if (existingSig === incomingSig) {
    return { token: existing.token, rotated: false };
  }
  // 다른 route: 새 token 발급 + old 정리.
  const generateToken = deps?.generateToken ?? (() => crypto.randomUUID());
  const newToken = generateToken();
  const rotatedAt = deps?.now ?? Date.now();
  // #2174 F2 — old trip 삭제가 관측 blind hole이었다(raw KV delete, D1/sentinel 미기록 →
  // 사후 RCA 완전 비가시, 2026-08-06 진단 지연 직접 원인). cleanupTripWithLa(liveActivity.ts)를
  // 재사용하지 않는다 — 그 helper는 사용자향 trip-ended alert push를 함께 발사하는데, mid-trip
  // route 변경(F1: 환승 waypoint trim/목적지 변경 재-POST)마다 로테이션이 발동하므로 매번 종료
  // alert가 뜨면 사용자 경험 회귀다. 여기서는 push-unrecoverable/user-delete와 구분되는 관측
  // 전용 사유 'rotated'로 D1 기록 + tripStatus sentinel만 남긴다(alert push 없음).
  await cleanupSupersededTrip(kv, existing, 'rotated', rotatedAt, deps?.db);
  return { token: newToken, rotated: true };
}

/**
 * #2175 — 다른(superseded) trip의 관측 기록 + KV 정리 단일 지점.
 *
 * `rotateTripTokenForNewRoute`의 route-변경 cleanup과, `POST /trips` 핸들러가 deviceToken 역인덱스로
 * 발견한 orphan trip(같은 deviceToken의 다른 active trip, `superseded-by-reregister`)이 공유한다.
 * D1 기록(`recordTripMetrics`) → tripStatus sentinel(`writeTripEndedStatus`, best-effort) →
 * `trip:<token>` delete → `pending:*` 잔재 cleanup 순서로 동작한다. alert push는 발사하지 않는다
 * (관측 전용 — `cleanupTripWithLa`와 달리 사용자향 UX 신호 없음, 두 호출자 모두 device 관점에서는
 * "정상 재등록"이지 사용자에게 알릴 종료가 아니다).
 */
export async function cleanupSupersededTrip(
  kv: KVNamespace,
  orphan: Trip,
  reason: TripEndedReason,
  now: number,
  db?: D1Database,
): Promise<void> {
  await recordTripMetrics(db, orphan, reason, now);
  try {
    await writeTripEndedStatus(kv, orphan.token, reason, now);
  } catch {
    // best-effort — sentinel 기록 실패가 cleanup 자체를 막지 않는다.
  }
  await deleteTrip(kv, orphan.token);
  await cleanupPendingPushesForToken(kv, orphan.token);
}

/**
 * #2175 — cron 안전망. register-time deviceToken 역인덱스 merge/cleanup이 실패하거나(KV
 * eventual consistency, 예상 못한 race) 실행 전이라 같은 deviceToken의 active trip이 KV에 2개
 * 이상 동시 존재하는 경우, cron이 둘 다에 push를 발사(#2184 `resolveTripDeviceToken`가 orphan도
 * 실 deviceToken으로 발사)하는 회귀를 막는다. deviceToken 없는(legacy) trip은 그룹핑 대상에서
 * 제외하고 그대로 통과시킨다 — 하위호환.
 *
 * 정책: 같은 deviceToken 그룹에서 `createdAt`이 가장 최신인 trip만 유지, 나머지는 이번 cron
 * tick 처리에서 제외한다(스캔 skip — cron 자체가 KV를 수정하지는 않는다, register-time 경로가
 * 최종 정리를 담당).
 */
export function dedupeTripsByDeviceToken(trips: readonly Trip[]): Trip[] {
  const latestByDevice = new Map<string, Trip>();
  for (const trip of trips) {
    if (trip.deviceToken === undefined) continue;
    const current = latestByDevice.get(trip.deviceToken);
    if (!current || trip.createdAt > current.createdAt) {
      latestByDevice.set(trip.deviceToken, trip);
    }
  }
  return trips.filter((trip) => {
    if (trip.deviceToken === undefined) return true;
    return latestByDevice.get(trip.deviceToken) === trip;
  });
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
