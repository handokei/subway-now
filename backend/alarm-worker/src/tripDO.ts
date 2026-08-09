/**
 * TripDO — per-trip Durable Object scaffold (ADR-031 Phase 1, 이슈 #2264, Epic #2260).
 *
 * 배경
 * ====
 * ADR-031(https://.../ADR-031-scalable-fire-ssot-architecture.md)은 글로벌 cron
 * O(N) 스캔(`scheduled.ts:1207` `for trip of listTrips()`)을 per-trip DO + self-alarm
 * 이벤트 구동으로 재설계한다. Phase 1(본 파일)은 **scaffold만** — DO는 KV와 shadow
 * 병존하며 cron이 여전히 authoritative, fire 동작 delta 0.
 *
 * 스코프 (본 PR, Phase 1)
 * =======================
 * - `TripDO` 클래스: trip row + SSoT row를 DO storage(SQLite-backed, `new_sqlite_classes`
 *   migration)에 보관. **fire 로직 없음**(Phase 2 스코프) — state 보관/조회만.
 * - `POST /trips`(`index.ts`)가 flag on일 때만 dual-write(seed) — `tripDoFlag.ts` 게이트.
 * - shadow-compare divergence telemetry — DO 기존 state vs 신규 trip 불일치 로그.
 *
 * 설계 노트 — 왜 raw SQL(`ctx.storage.sql`)이 아닌 storage KV API(`ctx.storage.get/put`)인가
 * ==============================================================================
 * `new_sqlite_classes` migration은 DO의 **storage backend**를 SQLite로 지정한다. 이 backend
 * 위에서 `ctx.storage.get/put`(KV 스타일 API)과 `ctx.storage.sql.exec`(raw SQL) 둘 다 완전히
 * 유효하며 동일 backend를 공유한다(durable-objects 스킬 참조). 본 PR은 row 2개(trip/ssot)를
 * 통째로 저장하는 단순 유스케이스라 KV 스타일 API로 충분 — raw SQL 스키마는 Phase 1 스코프
 * 밖(정교한 쿼리/인덱스가 필요해지는 시점, 예: Phase 3 이후)으로 미룬다.
 *
 * `TripDoStorage` 포트로 `ctx.storage`를 추상화해 `TripDO` 클래스는 얇은 어댑터로 유지하고,
 * row read/write 로직은 순수 함수로 분리했다 — 기존 `tripPositionSsot.ts`(KV read/write
 * helper 분리 패턴)와 동형이며, `cloudflare:workers`/`cloudflare:test` 런타임 의존 없이
 * plain vitest로 단위 테스트 가능하다(repo 기존 `InMemoryKV` 테스트 컨벤션과 동형).
 *
 * `DurableObject`(from `cloudflare:workers`)를 extend하지 않고 전통적 `fetch()` 핸들러
 * 패턴(pre-RPC-helper style, 여전히 완전 유효)을 쓴 이유도 동일 — `cloudflare:workers`는
 * Workers 런타임(miniflare/vitest-pool-workers)에서만 resolve되는 가상 모듈이며, 본 repo는
 * 그 pool을 아직 구성하지 않았다(plain vitest node 환경). `DurableObject`/`DurableObjectState`
 * 등 타입은 `@cloudflare/workers-types`의 ambient global이라 import 없이 사용 가능.
 */

import type { Trip } from './types';
import type { TripPositionSSoT } from './tripPositionSsot';

/** DO storage row key — trip 본체. */
const TRIP_ROW_KEY = 'trip';
/** DO storage row key — trip row 마지막 write epoch ms. */
const TRIP_ROW_UPDATED_AT_KEY = 'tripUpdatedAt';
/** DO storage row key — SSoT 본체. */
const SSOT_ROW_KEY = 'ssot';
/** DO storage row key — SSoT row 마지막 write epoch ms. */
const SSOT_ROW_UPDATED_AT_KEY = 'ssotUpdatedAt';

/**
 * `DurableObjectState.storage`의 최소 부분집합 포트. 실제 프로덕션에서는
 * `ctx.storage`(SQLite-backed)가 이 인터페이스를 만족한다. 테스트는 Map 기반 fake로 대체.
 */
export interface TripDoStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

/** trip row read. 미존재 시 undefined (신규 DO 인스턴스). */
export async function getTripRow(storage: TripDoStorage): Promise<Trip | undefined> {
  return storage.get<Trip>(TRIP_ROW_KEY);
}

/** trip row write — persist-first(단일 컬럼 값이므로 put 자체가 atomic write). */
export async function seedTripRow(storage: TripDoStorage, trip: Trip): Promise<void> {
  await storage.put(TRIP_ROW_KEY, trip);
  await storage.put(TRIP_ROW_UPDATED_AT_KEY, Date.now());
}

/** SSoT row read. 미존재 시 undefined. */
export async function getSsotRow(
  storage: TripDoStorage,
): Promise<TripPositionSSoT | undefined> {
  return storage.get<TripPositionSSoT>(SSOT_ROW_KEY);
}

/** SSoT row write — persist-first. */
export async function seedSsotRow(
  storage: TripDoStorage,
  ssot: TripPositionSSoT,
): Promise<void> {
  await storage.put(SSOT_ROW_KEY, ssot);
  await storage.put(SSOT_ROW_UPDATED_AT_KEY, Date.now());
}

/**
 * TripDO — 1 trip = 1 DO 인스턴스(`env.TRIP_DO.idFromName(tripToken)`로 결정적 라우팅).
 *
 * `fetch()` 라우트:
 *  - `GET  /trip` → `{ trip: Trip | null }`
 *  - `POST /trip` → body `Trip` 그대로 seed, `204`
 *  - `GET  /ssot` → `{ ssot: TripPositionSSoT | null }`
 *  - `POST /ssot` → body `TripPositionSSoT` 그대로 seed, `204`
 *
 * **fire 없음** — Phase 2(#2260 후속 이슈) 스코프. 본 클래스는 state 보관/조회만 수행한다.
 */
export class TripDO implements DurableObject {
  private readonly storage: TripDoStorage;

  constructor(state: DurableObjectState) {
    this.storage = state.storage;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/trip') {
      const trip = await getTripRow(this.storage);
      return Response.json({ trip: trip ?? null });
    }

    if (request.method === 'POST' && url.pathname === '/trip') {
      const trip = (await request.json()) as Trip;
      await seedTripRow(this.storage, trip);
      return new Response(null, { status: 204 });
    }

    if (request.method === 'GET' && url.pathname === '/ssot') {
      const ssot = await getSsotRow(this.storage);
      return Response.json({ ssot: ssot ?? null });
    }

    if (request.method === 'POST' && url.pathname === '/ssot') {
      const ssot = (await request.json()) as TripPositionSSoT;
      await seedSsotRow(this.storage, ssot);
      return new Response(null, { status: 204 });
    }

    return new Response('not found', { status: 404 });
  }
}
