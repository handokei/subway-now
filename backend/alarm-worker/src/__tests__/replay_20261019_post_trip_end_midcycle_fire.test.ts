/**
 * #3005 acceptance — 트립이 종료된 뒤 같은 cycle의 mid-cycle(t+30) 발사가 그 트립으로 push를 보내지 않는다
 * (backend 시나리오 S4~S6 + 거부 케이스).
 *
 * ## 실측 (불변 fixture)
 * `fixtures/evidence_20261023_trip_self_delete_d1.json` = 운영 D1 `trip_events` 32행 (id 1015~1035 = 10-18,
 * 1081~1091 = 10-19). D1 보존 7일이라 이 사본이 원본이다. **행은 한 글자도 조정하지 않는다.**
 *
 *   1089  363672  metrics-window-truncated
 *   1090  363762  trip-end   {reason:'user-clear', endPath:'http-delete'}   <- 사용자가 15:46에 종료
 *   1091  376181  cron-fire-attempt 뚝섬 destination {outcome:'sent', midCycle:true, pushId:ca288827-...}
 *                 ^ 종료 13초 뒤, 종료된 트립으로 push가 나갔다 (이 PR이 막으려는 사건)
 *
 * 1091은 fix 전 코드가 **쓴 결과**이므로 fixture에서 시드하지 않는다 -- 테스트가 "쓰지 않음"을 assert한다.
 * cycle 시작 시각은 1091(376181) - MID_CYCLE_OFFSET_MS(30s) = 346181 로 역산했다 (1086 vanish-swap 346479가
 * 같은 cycle의 1차 pass 이벤트이므로 정합). 이 값은 추정이 아니라 `fire ts - 30s` 정의이며, 1차 pass의 정확한
 * 시작 시각은 D1에 없다.
 *
 * ## 설계
 * - `handler.scheduled`(index.ts)를 구동한다. `runScheduled`만 mock해 1차 pass의 스냅샷(`midCycleSnapshot`)을
 *   주입하고, `scheduleMidCyclePass` + **실제** `runMidCycleFireOnly` + 실제 APNs 발사 코드를 그대로 쓴다.
 *   `runMidCycleFireOnly`를 직접 호출하지 않는 이유: fix가 cycle 시작 시각을 인자로 넘기도록 시그니처를 바꿔도
 *   (이슈 PR-2: `ts >= cycleStartMs`) 이 시나리오는 그대로 유효해야 하기 때문이다.
 * - 관측은 **사용자 관점 결과**: Seoul/APNs를 가로채는 전역 `fetch`에서 APNs 호출 수 + D1 `cron-fire-attempt` 행.
 * - D1은 `TripEventsD1` -- trip_events를 보관하고 `token_hash` / `kind` / `ts` 필터 SELECT에 응답하는 in-memory
 *   fake. fix가 trip-end 행을 조회하는 쿼리를 쓰더라도 이 세 조건 범위 안이면 응답한다. 다른 형태가 필요하면 이 fake를
 *   확장한다 (fixture는 건드리지 않는다).
 * - token: D1 행의 `token_hash`(b00dd879)는 `hashTripToken(token)`이다. 같은 hash를 내는 합성 token을 FNV-1a
 *   전수 탐색으로 구해 (`TRIP_TOKEN`), fixture를 수정/매핑하지 않고 그대로 쓴다. 아래 테스트가 hash 일치를 assert한다.
 *   (token_hash가 10-18/10-19 두 날에 같은 것은 token이 기기 단위로 안정적이라는 뜻 -> 거부 케이스 R2의 근거.)
 *
 * 현재 코드에서 실패하는 시나리오는 `it.fails` -- fix PR이 `.fails`를 제거한다.
 */
import { generateKeyPair, exportPKCS8 } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashTripToken } from '../../../../src/shared/infra/monitoring/tripTokenHash';
import { resetApnsJwtCache } from '../apns';
import { ARRIVAL_CODE } from '../alarm';
import { MID_CYCLE_OFFSET_MS } from '../cronConstants';
import type { MidCycleTripSnapshot } from '../scheduled';
import { deleteTrip, putTrip } from '../trips';
import type { BoardingLockMeta, Env, Trip } from '../types';
import { InMemoryKV } from './inMemoryKv';
import evidence from './fixtures/evidence_20261023_trip_self_delete_d1.json';

interface EvidenceRow {
  id: number;
  token_hash: string;
  ts: number;
  kind: string;
  station: string | null;
  line: string | null;
  meta: string | null;
}

const runScheduledMock = vi.fn();
vi.mock('../scheduled', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../scheduled')>();
  return { ...actual, runScheduled: (...args: unknown[]) => runScheduledMock(...args) };
});

const { handler } = await import('../index');

// ---------------------------------------------------------------------------------------------
// fixture access (verbatim)
// ---------------------------------------------------------------------------------------------
const ALL_ROWS: readonly EvidenceRow[] = (evidence as Array<{ results: EvidenceRow[] }>)[0].results;
const rowById = (id: number): EvidenceRow => {
  const row = ALL_ROWS.find((r) => r.id === id);
  if (!row) throw new Error(`evidence row ${id} missing`);
  return row;
};
const rowsBetween = (from: number, to: number): EvidenceRow[] =>
  ALL_ROWS.filter((r) => r.id >= from && r.id <= to);

const EVIDENCE_TOKEN_HASH = 'b00dd879';
/** hashTripToken(TRIP_TOKEN) === 'b00dd879' (FNV-1a 전수 탐색으로 구한 합성 token). */
const TRIP_TOKEN = 'trip-b00dd879-brnn0e2';

const TRIP_END_ROW = rowById(1090); // user-clear http-delete, ts 1792392363762
const FIRE_ROW_1091 = rowById(1091); // fix 전 코드가 쓴 결과 (시드하지 않는다)
const CYCLE_START_MS = FIRE_ROW_1091.ts - MID_CYCLE_OFFSET_MS; // 1792392346181
const EPISODE_ROWS_BEFORE_END = rowsBetween(1081, 1089); // 같은 token_hash의 10-19 이벤트 (trip-end 이전)
const PREVIOUS_TRIP_END_ROW = rowById(1020); // 10-18 첫 트립의 trip-end (같은 token_hash, ts 1792317193378)

// ---------------------------------------------------------------------------------------------
// D1 fake: trip_events 보관 + token_hash/kind/ts SELECT
// ---------------------------------------------------------------------------------------------
class TripEventsD1 {
  rows: EvidenceRow[] = [];
  private nextId = 100_000;

  seed(rows: readonly EvidenceRow[]): void {
    this.rows.push(...rows.map((r) => ({ ...r })));
  }

  prepare = (sql: string) => {
    const make = (args: unknown[]) => ({
      run: async () => {
        if (/^\s*INSERT INTO trip_events/i.test(sql)) {
          const [token_hash, ts, kind, station, line, meta] = args as [
            string,
            number,
            string,
            string | null,
            string | null,
            string | null,
          ];
          this.rows.push({ id: this.nextId++, token_hash, ts, kind, station, line, meta });
        }
        return { success: true };
      },
      first: async () => this.select(sql, args)[0] ?? null,
      all: async () => ({ results: this.select(sql, args), success: true }),
    });
    return { ...make([]), bind: (...args: unknown[]) => make(args) };
  };

  private select(sql: string, args: unknown[]): unknown[] {
    if (!/SELECT[\s\S]+FROM\s+trip_events/i.test(sql)) return [];
    let rows = this.rows;
    const strings = args.filter((a): a is string => typeof a === 'string');
    const numbers = args.filter((a): a is number => typeof a === 'number');
    if (/token_hash/i.test(sql)) rows = rows.filter((r) => strings.includes(r.token_hash));
    const kinds = new Set(
      [...strings, ...(sql.match(/'([a-z][a-z0-9-]+)'/g) ?? []).map((m) => m.slice(1, -1))].filter(
        (s) => ALL_ROWS.some((r) => r.kind === s) || s === 'trip-end',
      ),
    );
    if (/\bkind\b/i.test(sql) && kinds.size > 0) rows = rows.filter((r) => kinds.has(r.kind));
    if (/\bts\s*>=/i.test(sql) && numbers.length > 0) rows = rows.filter((r) => r.ts >= numbers[0]);
    else if (/\bts\s*>/i.test(sql) && numbers.length > 0) rows = rows.filter((r) => r.ts > numbers[0]);
    if (/COUNT\s*\(/i.test(sql)) return [{ count: rows.length, 'COUNT(*)': rows.length, n: rows.length }];
    return rows;
  }
}

// ---------------------------------------------------------------------------------------------
// env / trip / fetch
// ---------------------------------------------------------------------------------------------
const APNS_HOST = 'api.push.apple.com';
const APNS_HOST_SANDBOX = 'api.sandbox.push.apple.com';
const SEOUL_HOST = 'seoul.api.test';
let apnsPrivateKeyPem: string;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair('ES256');
  apnsPrivateKeyPem = await exportPKCS8(privateKey);
});

function makeEnv(kv: InMemoryKV, db: TripEventsD1): Env {
  return {
    TRIPS: kv as unknown as KVNamespace,
    DB: db as unknown as D1Database,
    APNS_HOST,
    APNS_HOST_SANDBOX,
    SEOUL_API_HOST: SEOUL_HOST,
    SEOUL_API_KEY: 'k',
    APNS_KEY_ID: 'K',
    APNS_TEAM_ID: 'T',
    APNS_PRIVATE_KEY: apnsPrivateKeyPem,
    APNS_BUNDLE_ID: 'com.example.app',
  };
}

const LOCK: BoardingLockMeta = {
  trainCode: '2214',
  line: '2',
  subwayId: '1002',
  selectedDepartureTime: 0,
  segmentStations: ['건대입구', '성수', '뚝섬'],
  expiresAt: Number.MAX_SAFE_INTEGER,
};

function makeTrip(createdAt: number): Trip {
  return {
    token: TRIP_TOKEN,
    deviceToken: 'a'.repeat(64),
    route: { type: 'direct', line: '2', stops: 2 },
    destination: '2-210',
    waypoints: [{ stationName: '뚝섬', line: '2', kind: 'destination' }],
    expiresAt: Number.MAX_SAFE_INTEGER,
    createdAt,
    alarmAtEpochMs: createdAt,
    boardingLock: LOCK,
  };
}

function snapshotOf(trip: Trip): MidCycleTripSnapshot[] {
  return [{ trip, waypoint: trip.waypoints[0], lock: LOCK }];
}

interface FetchLog {
  apns: string[];
}

function stubFetch(): FetchLog {
  const log: FetchLog = { apns: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(SEOUL_HOST)) {
        return new Response(
          JSON.stringify({
            realtimeArrivalList: [
              {
                barvlDt: '0',
                recptnDt: '',
                updnLine: '내선',
                trainLineNm: '성수행',
                btrainNo: LOCK.trainCode,
                subwayNm: '2호선',
                arvlCd: String(ARRIVAL_CODE.ENTERING),
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes(APNS_HOST) || url.includes(APNS_HOST_SANDBOX)) {
        log.apns.push(url);
        return new Response('', { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }),
  );
  return log;
}

function makeCtx(): { ctx: ExecutionContext; pending: Promise<unknown>[] } {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, pending };
}

interface Cycle {
  kv: InMemoryKV;
  db: TripEventsD1;
  fetchLog: FetchLog;
  env: Env;
  /** handler.scheduled 호출 (1차 pass는 snapshot만 반환) -> mid pass가 t+30에 예약된다. */
  start(snapshot: MidCycleTripSnapshot[]): Promise<void>;
  /** 가짜 시계를 `offsetMs`(cycle 시작 기준)까지 전진. */
  advanceTo(offsetMs: number): Promise<void>;
  /** 예약된 mid pass(및 같은 cycle의 waitUntil)가 끝날 때까지 기다린다. */
  settle(): Promise<void>;
  /** D1에 기록된 cron-fire-attempt 중 outcome='sent'. */
  sentFireRows(): EvidenceRow[];
}

function makeCycle(cycleStartMs: number): Cycle {
  const kv = new InMemoryKV(() => Date.now());
  const db = new TripEventsD1();
  const fetchLog = stubFetch();
  const env = makeEnv(kv, db);
  const { ctx, pending } = makeCtx();
  let elapsed = 0;
  vi.setSystemTime(cycleStartMs);
  return {
    kv,
    db,
    fetchLog,
    env,
    async start(snapshot) {
      runScheduledMock.mockResolvedValue({
        scanned: 1,
        polled: 1,
        midCycleSnapshot: snapshot,
        pendingActivityPossible: false,
      });
      await handler.scheduled(
        { scheduledTime: cycleStartMs, cron: '* * * * *', noRetry: () => {} } as ScheduledController,
        env,
        ctx,
      );
    },
    async advanceTo(offsetMs) {
      await vi.advanceTimersByTimeAsync(offsetMs - elapsed);
      elapsed = offsetMs;
    },
    async settle() {
      await vi.advanceTimersByTimeAsync(0);
      await Promise.all(pending);
    },
    sentFireRows() {
      return db.rows.filter(
        (r) =>
          r.kind === 'cron-fire-attempt' &&
          r.token_hash === EVIDENCE_TOKEN_HASH &&
          (JSON.parse(r.meta ?? '{}') as { outcome?: string }).outcome === 'sent',
      );
    },
  };
}

beforeEach(() => {
  resetApnsJwtCache();
  runScheduledMock.mockReset();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------------------------
// fixture sanity (이 파일의 전제가 깨지면 시나리오 결과를 신뢰할 수 없다)
// ---------------------------------------------------------------------------------------------
describe('#3005 fixture sanity — 실측 D1 사본', () => {
  it('32행, 10-18(1015~1035) + 10-19(1081~1091), 전부 같은 token_hash', () => {
    expect(ALL_ROWS).toHaveLength(32);
    expect(new Set(ALL_ROWS.map((r) => r.token_hash))).toEqual(new Set([EVIDENCE_TOKEN_HASH]));
    expect(rowsBetween(1015, 1035)).toHaveLength(21);
    expect(rowsBetween(1081, 1091)).toHaveLength(11);
  });

  it('핵심 3행이 실측 그대로다 (trip-end 1090 -> 13초 뒤 mid-cycle 발사 1091)', () => {
    expect(TRIP_END_ROW).toMatchObject({ kind: 'trip-end', ts: 1792392363762, station: '2-010' });
    expect(JSON.parse(TRIP_END_ROW.meta ?? '{}')).toEqual({ reason: 'user-clear', endPath: 'http-delete' });
    expect(FIRE_ROW_1091).toMatchObject({ kind: 'cron-fire-attempt', ts: 1792392376181, station: '뚝섬' });
    expect(JSON.parse(FIRE_ROW_1091.meta ?? '{}')).toMatchObject({ outcome: 'sent', midCycle: true });
    expect(FIRE_ROW_1091.ts - TRIP_END_ROW.ts).toBe(12_419);
  });

  it('합성 TRIP_TOKEN의 hashTripToken이 fixture token_hash와 같다', () => {
    expect(hashTripToken(TRIP_TOKEN)).toBe(EVIDENCE_TOKEN_HASH);
  });
});

// ---------------------------------------------------------------------------------------------
// 거부 케이스 (발사는 그대로 나가야 한다) -- 현재도 통과
// ---------------------------------------------------------------------------------------------
describe('#3005 거부 케이스 — 정상 트립의 mid-cycle 발사는 막히지 않는다', () => {
  it('R1: 정상 진행 중 트립 (KV에 존재, trip-end 행 없음) -> APNs 1회 + cron-fire-attempt sent 1행', async () => {
    const cycle = makeCycle(CYCLE_START_MS);
    const trip = makeTrip(CYCLE_START_MS - 60_000);
    await putTrip(cycle.kv as unknown as KVNamespace, trip);
    cycle.db.seed(EPISODE_ROWS_BEFORE_END);

    await cycle.start(snapshotOf(trip));
    await cycle.advanceTo(MID_CYCLE_OFFSET_MS + 1_000);
    await cycle.settle();

    expect(cycle.fetchLog.apns).toHaveLength(1);
    expect(cycle.sentFireRows()).toHaveLength(1);
  });

  it('R2: 같은 token_hash의 직전 트립이 정상 종료된 뒤 새로 등록된 트립의 첫 발사는 막히지 않는다 (token은 기기 단위로 재사용됨)', async () => {
    // 10-18 첫 트립은 1020(trip-end, ts 1792317193378)으로 끝났고, 같은 token_hash의 새 트립이 그 뒤에 등록됐다
    // (evidence 1021: trip-register existedAtRequestStart:false). trip-end 행이 존재한다는 이유만으로 막으면 안 된다.
    const cycle = makeCycle(CYCLE_START_MS);
    expect(PREVIOUS_TRIP_END_ROW.ts).toBeLessThan(CYCLE_START_MS);
    const trip = makeTrip(PREVIOUS_TRIP_END_ROW.ts + 16_000_000); // 1021의 trip-register 이후 등록
    await putTrip(cycle.kv as unknown as KVNamespace, trip);
    cycle.db.seed([PREVIOUS_TRIP_END_ROW, ...EPISODE_ROWS_BEFORE_END]);

    await cycle.start(snapshotOf(trip));
    await cycle.advanceTo(MID_CYCLE_OFFSET_MS + 1_000);
    await cycle.settle();

    expect(cycle.fetchLog.apns).toHaveLength(1);
    expect(cycle.sentFireRows()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// S4~S6
// ---------------------------------------------------------------------------------------------
describe('#3005 S4~S6 — 종료된 트립으로 mid-cycle push가 나가지 않는다', () => {
  // #3005 acceptance — fix PR이 .fails를 제거한다
  it.fails(
    'S4 [10-19 실측]: 1차 pass 뒤 t+17.6s에 사용자가 종료(trip-end 1090) -> t+30 mid pass가 그 트립으로 발사 0',
    async () => {
      const cycle = makeCycle(CYCLE_START_MS);
      const trip = makeTrip(CYCLE_START_MS - 60_000);
      await putTrip(cycle.kv as unknown as KVNamespace, trip);
      cycle.db.seed(EPISODE_ROWS_BEFORE_END);

      await cycle.start(snapshotOf(trip)); // 1차 pass 시점엔 트립이 살아 있었고 스냅샷에 담겼다
      await cycle.advanceTo(TRIP_END_ROW.ts - CYCLE_START_MS); // 15:46 사용자 종료 (DELETE /trips)
      await deleteTrip(cycle.kv as unknown as KVNamespace, TRIP_TOKEN);
      cycle.db.seed([TRIP_END_ROW]);

      await cycle.advanceTo(MID_CYCLE_OFFSET_MS + 1_000); // t+30 mid pass
      await cycle.settle();

      // 사용자 관점: 종료한 트립의 기기로 알림이 오지 않는다.
      expect(cycle.fetchLog.apns).toHaveLength(0);
      // 실패 사유 분리: D1에도 1091 같은 'sent' 행이 남지 않는다.
      expect(cycle.sentFireRows()).toHaveLength(0);
    },
  );

  // #3005 acceptance — fix PR이 .fails를 제거한다
  it.fails(
    'S5: cycle 시작 전에 이미 종료(trip-end 1090 ts < cycleStart)됐으나 KV list/get 캐시로 스냅샷에 남은 같은 트립 -> 발사 0',
    async () => {
      // trip-end(363762)가 이 cycle 시작(+54s) 전이므로 `ts >= cycleStartMs` 비교로는 걸리지 않는다 (이슈 반증 3).
      const cycleStartLater = TRIP_END_ROW.ts + 54_000;
      const cycle = makeCycle(cycleStartLater);
      const trip = makeTrip(TRIP_END_ROW.ts - 3_600_000);
      // KV에는 이미 없다 (deleteTrip 완료). 스냅샷만 stale list/get 캐시(cacheTtl 30)에서 온 것으로 주입.
      cycle.db.seed([...EPISODE_ROWS_BEFORE_END, TRIP_END_ROW]);
      expect(await cycle.kv.get(`trip:${TRIP_TOKEN}`)).toBeNull();

      await cycle.start(snapshotOf(trip));
      await cycle.advanceTo(MID_CYCLE_OFFSET_MS + 1_000);
      await cycle.settle();

      expect(cycle.fetchLog.apns).toHaveLength(0);
      expect(cycle.sentFireRows()).toHaveLength(0);
    },
  );

  // #3005 acceptance — fix PR이 .fails를 제거한다
  it.fails(
    'S6: 종료 처리 중 -- deleteTrip은 끝났고 trip-end 행은 아직 안 써진 약 2초 창에 mid pass -> 발사 0',
    async () => {
      // liveActivity.ts: deleteTrip 완료(:558) -> trip-end 행 기록(:624) 사이 약 2.17s (이슈 반증 3).
      // 이 창에는 트립도 행도 없다. 행(1090)은 시드하지 않는다.
      const cycle = makeCycle(CYCLE_START_MS);
      const trip = makeTrip(CYCLE_START_MS - 60_000);
      await putTrip(cycle.kv as unknown as KVNamespace, trip);
      cycle.db.seed(EPISODE_ROWS_BEFORE_END);

      await cycle.start(snapshotOf(trip));
      await cycle.advanceTo(MID_CYCLE_OFFSET_MS - 1_000); // t+29s: 종료 요청 도착
      await deleteTrip(cycle.kv as unknown as KVNamespace, TRIP_TOKEN);
      expect(cycle.db.rows.some((r) => r.kind === 'trip-end' && r.ts >= CYCLE_START_MS)).toBe(false);

      await cycle.advanceTo(MID_CYCLE_OFFSET_MS + 1_000); // t+31s: mid pass (trip-end 행은 t+31.2s에야 써진다)
      await cycle.settle();

      expect(cycle.fetchLog.apns).toHaveLength(0);
      expect(cycle.sentFireRows()).toHaveLength(0);
    },
  );
});
