import { describe, expect, it, vi } from 'vitest';
import { recordTripMetrics } from '../d1TripMetrics';
import { makeTripFixture } from './helpers/testFixtures';

/**
 * SELECT(fired_count 조회, `countSentFireAttempts`)와 INSERT(trip_metrics 적재)를 SQL 텍스트로
 * 분기하는 공용 mock D1.
 *
 * #2628 (리뷰 P2-6) — 이전에는 이 라우팅이 "fired_count 집계" describe 하나에만 있었고 다른
 * describe들은 bind→run만 있는 평평한 mock(`makeMockDb`류)을 썼다. `countSentFireAttempts`가
 * INSERT 전에 `.bind(...).first()`를 호출하는데, 그 평평한 mock에는 `.first`가 없어
 * `TypeError: ... .first is not a function`가 나고 내부 try/catch가 swallow해 fired_count=0으로
 * "우연히" 통과하고 있었다 — SELECT 경로가 실제로 의도대로 동작하는지는 그 테스트들에서 전혀
 * 검증되지 않았던 셈이다. 모든 테스트가 이 헬퍼를 통해 SELECT 경로를 명시적으로(TypeError에
 * 기대지 않고) 거치도록 모듈 스코프로 올린다.
 */
function makeRoutingMockDb(
  options: {
    sentCount?: number;
    // #2783 — suppressed_count 집계(outcome='skipped-reason') 전용 mock count. sentCount와
    // 별도 SQL 텍스트(outcome 리터럴)로 라우팅된다.
    skippedCount?: number;
    selectThrows?: boolean;
    insertThrows?: boolean;
    onInsertBind?: (args: unknown[]) => void;
  } = {},
): D1Database {
  const {
    sentCount = 0,
    skippedCount = 0,
    selectThrows = false,
    insertThrows = false,
    onInsertBind,
  } = options;
  const prepare = vi.fn().mockImplementation((sql: string) => {
    if (sql.includes('SELECT COUNT')) {
      const count = sql.includes("outcome') = 'skipped-reason'") ? skippedCount : sentCount;
      return {
        bind: vi.fn().mockReturnValue({
          first: selectThrows
            ? vi.fn().mockRejectedValue(new Error('D1 select error'))
            : vi.fn().mockResolvedValue({ count }),
        }),
      };
    }
    return {
      bind: vi.fn().mockImplementation((...args: unknown[]) => {
        onInsertBind?.(args);
        return {
          run: insertThrows
            ? vi.fn().mockRejectedValue(new Error('D1 write error'))
            : vi.fn().mockResolvedValue({ success: true }),
        };
      }),
    };
  });
  return { prepare } as unknown as D1Database;
}

/** INSERT bind 인자를 캡처하는 편의 wrapper — 대부분의 단일-assert 테스트가 이 형태를 쓴다. */
function makeRoutingMockDbCapturing(
  options: Omit<Parameters<typeof makeRoutingMockDb>[0], 'onInsertBind'> = {},
): { db: D1Database; insertArgs: () => unknown[] } {
  let insertArgs: unknown[] = [];
  const db = makeRoutingMockDb({
    ...options,
    onInsertBind: (args) => {
      insertArgs = args;
    },
  });
  return { db, insertArgs: () => insertArgs };
}

describe('recordTripMetrics (#1835)', () => {
  const NOW = 1_700_000_000_000;

  it('db가 undefined일 때 no-op (graceful)', async () => {
    const trip = makeTripFixture();
    await expect(
      recordTripMetrics(undefined, trip, 'destination-arrived', NOW),
    ).resolves.toBeUndefined();
  });

  it('db가 있을 때 trip_metrics INSERT를 실행한다', async () => {
    const { db } = makeRoutingMockDbCapturing();
    const trip = makeTripFixture();
    await recordTripMetrics(db, trip, 'destination-arrived', NOW);

    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('INSERT OR IGNORE INTO trip_metrics'),
    );
  });

  it('reason이 undefined (사용자 DELETE)일 때 user-delete로 적재된다', async () => {
    const trip = makeTripFixture();
    const { db, insertArgs } = makeRoutingMockDbCapturing();

    await recordTripMetrics(db, trip, undefined, NOW);

    // end_reason이 'user-delete'로 전달됐는지 확인
    expect(insertArgs()).toContain('user-delete');
  });

  it('D1 write 실패 시 throw 없이 swallow한다', async () => {
    const dbFail = makeRoutingMockDb({ insertThrows: true });
    const trip = makeTripFixture();

    await expect(
      recordTripMetrics(dbFail, trip, 'expired', NOW),
    ).resolves.toBeUndefined();
  });

  it('multi-transfer route의 line_list를 JSON으로 직렬화한다', async () => {
    const trip = makeTripFixture({
      route: {
        type: 'multi-transfer',
        transfers: [
          { fromLine: '2', toLine: '3', stopsToTransfer: 3, transferName: '교대' },
          { fromLine: '3', toLine: '7', stopsToTransfer: 2, transferName: '고속터미널' },
        ],
        stopsAfterLastTransfer: 4,
      },
    });
    const { db, insertArgs } = makeRoutingMockDbCapturing();

    await recordTripMetrics(db, trip, 'destination-arrived', NOW);

    const lineListArg = insertArgs().find(
      (a) => typeof a === 'string' && a.startsWith('['),
    ) as string;
    const lines = JSON.parse(lineListArg);
    expect(lines).toEqual(expect.arrayContaining(['2', '3', '7']));
  });

  it('boardingLock 있고 boardingPromptState.fired=true이면 chain_complete=1', async () => {
    const { db, insertArgs } = makeRoutingMockDbCapturing();

    const trip = makeTripFixture({
      boardingLock: {
        trainCode: '7246',
        line: '7',
        subwayId: '1007',
        selectedDepartureTime: NOW,
        segmentStations: ['상봉', '중화'],
        expiresAt: NOW + 3600_000,
      },
      boardingPromptState: { fired: true, lastFiredAt: NOW - 60_000 },
    });

    await recordTripMetrics(db, trip, 'destination-arrived', NOW);

    // chain_complete = 마지막 positional argument (index 12, 0-based)
    const args = insertArgs();
    expect(args[args.length - 1]).toBe(1);
  });

  // #2268 — DELETE /trips/:token이 getTrip→cleanupTripWithLa 사이 원자 가드 없이 race하면
  // 동일 trip 종료가 recordTripMetrics를 두 번 호출할 수 있다(evidence: 2026-08-10, 동일
  // trip_token_hash 2행, 521ms차). migration 0004의 (trip_token_hash, started_at) UNIQUE index +
  // `INSERT OR IGNORE`가 실제 방어선 — 아래는 그 SQLite 제약을 in-memory로 재현해 recordTripMetrics가
  // 두 번째 race 호출에서 새 행을 만들지 않음을 검증한다.
  describe('race idempotency (#2268)', () => {
    /**
     * migration 0004 UNIQUE index (trip_token_hash, started_at) + `INSERT OR IGNORE`를
     * in-memory로 재현하는 fake D1. 실제 SQLite 제약과 동일하게 중복 키는 조용히 무시한다.
     * #2628 (리뷰 P2-6) — SELECT COUNT(fired_count 조회)도 SQL 텍스트로 명시 분기해(count=0)
     * INSERT 경로의 dedup Set과 섞이지 않음을 명확히 한다(이전에는 `.first`가 없어 우연히
     * throw→catch로 회피되고 있었을 뿐, dedup 키가 같은 값(tokenHash, startedAt)을 쓰기 때문에
     * 만약 SELECT가 `.run()`까지 갔다면 rows 카운트를 오염시켰을 것).
     */
    function makeUniqueConstraintDb(): { db: D1Database; rows: () => unknown[][] } {
      const rows: unknown[][] = [];
      const seen = new Set<string>();
      const prepare = vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('SELECT COUNT')) {
          return { bind: () => ({ first: async () => ({ count: 0 }) }) };
        }
        return {
          bind: (...args: unknown[]) => ({
            run: async () => {
              const [tokenHash, startedAt] = args;
              const key = `${tokenHash}:${startedAt}`;
              if (seen.has(key)) return { success: true }; // OR IGNORE — no-op on duplicate
              seen.add(key);
              rows.push(args);
              return { success: true };
            },
          }),
        };
      });
      return { db: { prepare } as unknown as D1Database, rows: () => rows };
    }

    it('동일 trip 종료가 race로 recordTripMetrics를 두 번 호출해도 1행만 기록된다', async () => {
      const { db, rows } = makeUniqueConstraintDb();
      const trip = makeTripFixture();

      // 두 DELETE 요청이 거의 동시에 같은 trip을 cleanup → recordTripMetrics가 race로 2회 호출.
      await Promise.all([
        recordTripMetrics(db, trip, 'user-delete', NOW),
        recordTripMetrics(db, trip, 'user-delete', NOW + 521), // evidence의 521ms 간격 재현
      ]);

      expect(rows()).toHaveLength(1);
    });

    it('같은 token이 나중에 새 trip으로 재등록되면(started_at 다름) 별도 행으로 기록된다', async () => {
      const { db, rows } = makeUniqueConstraintDb();
      const trip1 = makeTripFixture({ createdAt: NOW });
      const trip2 = makeTripFixture({ createdAt: NOW + 3_600_000 });

      await recordTripMetrics(db, trip1, 'destination-arrived', NOW + 60_000);
      await recordTripMetrics(db, trip2, 'destination-arrived', NOW + 3_660_000);

      expect(rows()).toHaveLength(2);
    });
  });

  // #2628 — fired_count는 이제 trip 객체 카운터(#2281, boardingPromptState/hopEndPromptState
  // fireCount 합산)가 아니라 D1 trip_events(kind='cron-fire-attempt', outcome='sent')를 직접
  // COUNT한다. #2281 방식은 매역 station-passed alert 발사를 전혀 집계하지 못했다(RCA: 실 trip
  // 2건 sent에도 0으로 기록) — 이번 fix의 root 수리 대상.
  describe('fired_count 집계 — D1 trip_events 소스 (#2628)', () => {
    it('D1 cron-fire-attempt sent 2건이면 fired_count=2로 적재된다', async () => {
      const { db, insertArgs } = makeRoutingMockDbCapturing({ sentCount: 2 });
      const trip = makeTripFixture();

      await recordTripMetrics(db, trip, 'destination-arrived', NOW);

      // fired_count = 8번째 bind 인자 (positional index 7, 0-based) — INSERT 컬럼 순서 기준.
      expect(insertArgs()[7]).toBe(2);
    });

    it('D1에 sent 이벤트가 없으면 fired_count=0 이다', async () => {
      const { db, insertArgs } = makeRoutingMockDbCapturing({ sentCount: 0 });
      const trip = makeTripFixture();

      await recordTripMetrics(db, trip, 'destination-arrived', NOW);

      expect(insertArgs()[7]).toBe(0);
    });

    it('fired_count 조회 실패는 swallow하고 0으로 안전 degrade한다(INSERT 흐름 차단 없음)', async () => {
      const { db, insertArgs } = makeRoutingMockDbCapturing({ selectThrows: true });
      const trip = makeTripFixture();

      await expect(
        recordTripMetrics(db, trip, 'destination-arrived', NOW),
      ).resolves.toBeUndefined();
      expect(insertArgs()[7]).toBe(0);
    });

    it('boardingPromptState/hopEndPromptState에 fireCount가 있어도(구 #2281 방식) 더 이상 fired_count에 반영되지 않는다', async () => {
      const { db, insertArgs } = makeRoutingMockDbCapturing({ sentCount: 0 });
      const trip = makeTripFixture({
        boardingPromptState: { fired: true, lastFiredAt: NOW - 120_000, fireCount: 2 },
        hopEndPromptState: {
          '건대입구|7': { fired: true, lastFiredAt: NOW - 60_000, fireCount: 1 },
        },
      });

      await recordTripMetrics(db, trip, 'destination-arrived', NOW);

      expect(insertArgs()[7]).toBe(0);
    });
  });

  // #2783 (red② — TDD) — suppressed_count는 그동안 하드코딩 0("동상")이었다. countSentFireAttempts
  // 와 동일 패턴(D1 trip_events, kind='cron-fire-attempt')으로 outcome='skipped-reason' 건수를
  // 직접 COUNT해야 한다. 아래 두 테스트는 리팩터 전(hardcoded 0) 코드에서 반드시 실패한다 —
  // "값이 0이 아니기만 하면 통과"가 아니라 "그 값이 skipped-reason 건수와 정확히 일치"를 assert.
  describe('suppressed_count 집계 — D1 trip_events 소스 (#2783)', () => {
    it('D1 cron-fire-attempt skipped-reason 3건이면 suppressed_count=3으로 적재된다', async () => {
      const { db, insertArgs } = makeRoutingMockDbCapturing({ sentCount: 1, skippedCount: 3 });
      const trip = makeTripFixture();

      await recordTripMetrics(db, trip, 'destination-arrived', NOW);

      // suppressed_count = 9번째 bind 인자 (positional index 8, 0-based) — INSERT 컬럼 순서 기준.
      expect(insertArgs()[8]).toBe(3);
    });

    it('D1에 skipped-reason 이벤트가 없으면 suppressed_count=0 이다', async () => {
      const { db, insertArgs } = makeRoutingMockDbCapturing({ sentCount: 5, skippedCount: 0 });
      const trip = makeTripFixture();

      await recordTripMetrics(db, trip, 'destination-arrived', NOW);

      expect(insertArgs()[8]).toBe(0);
    });

    it('suppressed_count 조회 실패는 swallow하고 0으로 안전 degrade한다(INSERT 흐름 차단 없음)', async () => {
      const { db, insertArgs } = makeRoutingMockDbCapturing({ selectThrows: true });
      const trip = makeTripFixture();

      await expect(
        recordTripMetrics(db, trip, 'destination-arrived', NOW),
      ).resolves.toBeUndefined();
      expect(insertArgs()[8]).toBe(0);
    });

    it('fired_count(sent)와 suppressed_count(skipped-reason)는 서로 다른 count로 독립 집계된다', async () => {
      const { db, insertArgs } = makeRoutingMockDbCapturing({ sentCount: 4, skippedCount: 2 });
      const trip = makeTripFixture();

      await recordTripMetrics(db, trip, 'destination-arrived', NOW);

      expect(insertArgs()[7]).toBe(4); // fired_count
      expect(insertArgs()[8]).toBe(2); // suppressed_count
    });
  });

  // #2628 — lock_attached는 "종료 시점 스냅샷"(boardingLock truthy 여부)이 아니라 "생애 중 한
  // 번이라도 부착됐는지"(trip.lockEverAttached, `trips.ts` putTrip이 stamp)를 본다. 도착 후 lock을
  // 해제하고 1초 뒤 trip이 삭제된 실 trip(2026-09-15 RCA)이 lock_attached=0으로 오기록되던 결함.
  describe('lock_attached 집계 — 생애 이력 (#2628)', () => {
    it('현재 boardingLock은 없지만 lockEverAttached=true이면 lock_attached=1로 적재된다', async () => {
      const { db, insertArgs } = makeRoutingMockDbCapturing();

      const trip = makeTripFixture({
        boardingLock: undefined,
        lockEverAttached: true,
      });

      await recordTripMetrics(db, trip, 'destination-arrived', NOW);

      // lock_attached = 12번째 bind 인자 (positional index 11, 0-based).
      expect(insertArgs()[11]).toBe(1);
    });

    it('lock을 한 번도 부착한 적 없으면 lock_attached=0 이다', async () => {
      const { db, insertArgs } = makeRoutingMockDbCapturing();
      const trip = makeTripFixture();

      await recordTripMetrics(db, trip, 'destination-arrived', NOW);

      expect(insertArgs()[11]).toBe(0);
    });

    // #2628 (리뷰 P2-5) — lockEverAttached가 아직 stamp되지 않은 채 현재 boardingLock만 truthy인
    // 케이스(이 PR 배포 시점에 이미 KV에 존재하던 진행 중 trip의 전환기 상태)를 구제하는 방어적
    // OR. putTrip 단일 choke point 도입 후에도 살아있는 코드 — d1TripMetrics.ts 해당 주석 참고.
    it('lockEverAttached 미배선이어도 현재 boardingLock이 있으면 lock_attached=1 (배포 전환기 방어적 OR)', async () => {
      const { db, insertArgs } = makeRoutingMockDbCapturing();

      const trip = makeTripFixture({
        boardingLock: {
          trainCode: '7246',
          line: '7',
          subwayId: '1007',
          selectedDepartureTime: NOW,
          segmentStations: ['상봉', '중화'],
          expiresAt: NOW + 3600_000,
        },
      });

      await recordTripMetrics(db, trip, 'destination-arrived', NOW);

      expect(insertArgs()[11]).toBe(1);
    });
  });

  // #2628 — boarding_prompt_responded는 더 이상 하드코딩 0이 아니라 `POST
  // /trips/:token/boarding-confirm` / `POST /boarding-prompt/dismiss` 응답 시 stamp되는
  // `trip.boardingPromptResponded`를 집계한다.
  describe('boarding_prompt_responded 집계 (#2628)', () => {
    it('boardingPromptResponded=true인 trip은 boarding_prompt_responded=1로 적재된다', async () => {
      const { db, insertArgs } = makeRoutingMockDbCapturing();
      const trip = makeTripFixture({ boardingPromptResponded: true });

      await recordTripMetrics(db, trip, 'destination-arrived', NOW);

      // boarding_prompt_responded = 11번째 bind 인자 (positional index 10, 0-based).
      expect(insertArgs()[10]).toBe(1);
    });

    it('응답이 없으면(필드 부재) boarding_prompt_responded=0 이다', async () => {
      const { db, insertArgs } = makeRoutingMockDbCapturing();
      const trip = makeTripFixture();

      await recordTripMetrics(db, trip, 'destination-arrived', NOW);

      expect(insertArgs()[10]).toBe(0);
    });
  });

  // #2268 — device가 알고 있는 실제 종료 사유(예: lockless-trip-end)도 자유 문자열로 받아
  // end_reason에 그대로 적재한다. TripEndedReason(server-side auto-end 전용) 제약을 받지 않는다.
  it('device가 보고한 자유 문자열 reason도 end_reason에 그대로 적재된다', async () => {
    const trip = makeTripFixture();
    const { db, insertArgs } = makeRoutingMockDbCapturing();

    await recordTripMetrics(db, trip, 'lockless-trip-end', NOW);

    expect(insertArgs()).toContain('lockless-trip-end');
  });

  // #2280 — origin_station null RCA: passedStations는 advance 이벤트(waypoint 통과)가 한 번도
  // 없던 trip(짧은 trip/조기 종료)에서 영구 undefined라 origin_station이 항상 null로 적재됐다
  // (evidence: 2026-08-11 3건 + 2026-08-10 trip 50, 모두 origin_station=null). device가 등록
  // 시점에 stamp한 `originStationName`(SSOT, trip 수명 동안 불변)을 1순위 소스로 채택해야 한다.
  describe('origin_station 적재 (#2280)', () => {
    /** trip_metrics INSERT의 origin_station positional arg (bind 5번째, 0-based index 4). */
    async function captureOriginStationArg(
      trip: Parameters<typeof makeTripFixture>[0],
    ): Promise<unknown> {
      const { db, insertArgs } = makeRoutingMockDbCapturing();
      await recordTripMetrics(db, makeTripFixture(trip), 'destination-arrived', NOW);
      return insertArgs()[4];
    }

    it('RED였던 회귀 재현: passedStations 없음(advance 이벤트 0회) + originStationName도 없으면 null', async () => {
      const arg = await captureOriginStationArg({});
      expect(arg).toBeNull();
    });

    it('originStationName이 있으면 passedStations 유무와 무관하게 1순위 채택', async () => {
      const arg = await captureOriginStationArg({
        originStationName: '건대입구',
        passedStations: ['어린이대공원'],
      });
      expect(arg).toBe('건대입구');
    });

    it('originStationName이 없고 passedStations만 있으면 기존 fallback(첫 원소) 유지', async () => {
      const arg = await captureOriginStationArg({ passedStations: ['어린이대공원', '건대입구'] });
      expect(arg).toBe('어린이대공원');
    });
  });
});
