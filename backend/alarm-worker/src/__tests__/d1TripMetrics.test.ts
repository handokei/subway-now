import { describe, expect, it, vi } from 'vitest';
import { recordTripMetrics } from '../d1TripMetrics';
import { makeTripFixture } from './helpers/testFixtures';

function makeMockDb(): D1Database {
  const run = vi.fn().mockResolvedValue({ success: true });
  const bind = vi.fn().mockReturnValue({ run });
  const prepare = vi.fn().mockReturnValue({ bind });
  return { prepare } as unknown as D1Database;
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
    const db2 = makeMockDb();
    const trip = makeTripFixture();
    await recordTripMetrics(db2, trip, 'destination-arrived', NOW);

    expect(db2.prepare).toHaveBeenCalledWith(
      expect.stringContaining('INSERT OR IGNORE INTO trip_metrics'),
    );
  });

  it('reason이 undefined (사용자 DELETE)일 때 user-delete로 적재된다', async () => {
    const trip = makeTripFixture();

    const run = vi.fn().mockResolvedValue({ success: true });
    let capturedArgs: unknown[] = [];
    const bind = vi.fn().mockImplementation((...args: unknown[]) => {
      capturedArgs = args;
      return { run };
    });
    const prepare = vi.fn().mockReturnValue({ bind });
    const db2 = { prepare } as unknown as D1Database;

    await recordTripMetrics(db2, trip, undefined, NOW);

    // end_reason이 'user-delete'로 전달됐는지 확인
    expect(capturedArgs).toContain('user-delete');
  });

  it('D1 write 실패 시 throw 없이 swallow한다', async () => {
    const run = vi.fn().mockRejectedValue(new Error('D1 write error'));
    const bind = vi.fn().mockReturnValue({ run });
    const prepare = vi.fn().mockReturnValue({ bind });
    const dbFail = { prepare } as unknown as D1Database;
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

    let capturedArgs: unknown[] = [];
    const run = vi.fn().mockResolvedValue({ success: true });
    const bind = vi.fn().mockImplementation((...args: unknown[]) => {
      capturedArgs = args;
      return { run };
    });
    const prepare = vi.fn().mockReturnValue({ bind });
    const db2 = { prepare } as unknown as D1Database;

    await recordTripMetrics(db2, trip, 'destination-arrived', NOW);

    const lineListArg = capturedArgs.find(
      (a) => typeof a === 'string' && a.startsWith('['),
    ) as string;
    const lines = JSON.parse(lineListArg);
    expect(lines).toEqual(expect.arrayContaining(['2', '3', '7']));
  });

  it('boardingLock 있고 boardingPromptState.fired=true이면 chain_complete=1', async () => {
    const run = vi.fn().mockResolvedValue({ success: true });
    let capturedArgs: unknown[] = [];
    const bind = vi.fn().mockImplementation((...args: unknown[]) => {
      capturedArgs = args;
      return { run };
    });
    const prepare = vi.fn().mockReturnValue({ bind });
    const db = { prepare } as unknown as D1Database;

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
    const chainComplete = capturedArgs[capturedArgs.length - 1];
    expect(chainComplete).toBe(1);
  });

  // #2268 — DELETE /trips/:token이 getTrip→cleanupTripWithLa 사이 원자 가드 없이 race하면
  // 동일 trip 종료가 recordTripMetrics를 두 번 호출한다(evidence: 2026-08-10, 동일
  // trip_token_hash 2행, 521ms차). migration 0004의 (trip_token_hash, started_at) UNIQUE index +
  // `INSERT OR IGNORE`가 실제 방어선 — 아래는 그 SQLite 제약을 in-memory로 재현해 recordTripMetrics가
  // 두 번째 race 호출에서 새 행을 만들지 않음을 검증한다.
  describe('race idempotency (#2268)', () => {
    /** migration 0004 UNIQUE index (trip_token_hash, started_at) + `INSERT OR IGNORE`를
     * in-memory로 재현하는 fake D1. 실제 SQLite 제약과 동일하게 중복 키는 조용히 무시한다. */
    function makeUniqueConstraintDb(): { db: D1Database; rows: () => unknown[][] } {
      const rows: unknown[][] = [];
      const seen = new Set<string>();
      const prepare = vi.fn().mockReturnValue({
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
    /** SELECT(fired_count 조회)와 INSERT(trip_metrics 적재)를 SQL 텍스트로 분기하는 mock D1. */
    function makeRoutingMockDb(options: {
      sentCount?: number;
      selectThrows?: boolean;
      onInsertBind?: (args: unknown[]) => void;
    }): D1Database {
      const { sentCount = 0, selectThrows = false, onInsertBind } = options;
      const prepare = vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('SELECT COUNT')) {
          return {
            bind: vi.fn().mockReturnValue({
              first: selectThrows
                ? vi.fn().mockRejectedValue(new Error('D1 select error'))
                : vi.fn().mockResolvedValue({ count: sentCount }),
            }),
          };
        }
        return {
          bind: vi.fn().mockImplementation((...args: unknown[]) => {
            onInsertBind?.(args);
            return { run: vi.fn().mockResolvedValue({ success: true }) };
          }),
        };
      });
      return { prepare } as unknown as D1Database;
    }

    it('D1 cron-fire-attempt sent 2건이면 fired_count=2로 적재된다', async () => {
      let capturedArgs: unknown[] = [];
      const db = makeRoutingMockDb({
        sentCount: 2,
        onInsertBind: (args) => {
          capturedArgs = args;
        },
      });
      const trip = makeTripFixture();

      await recordTripMetrics(db, trip, 'destination-arrived', NOW);

      // fired_count = 8번째 bind 인자 (positional index 7, 0-based) — INSERT 컬럼 순서 기준.
      expect(capturedArgs[7]).toBe(2);
    });

    it('D1에 sent 이벤트가 없으면 fired_count=0 이다', async () => {
      let capturedArgs: unknown[] = [];
      const db = makeRoutingMockDb({
        sentCount: 0,
        onInsertBind: (args) => {
          capturedArgs = args;
        },
      });
      const trip = makeTripFixture();

      await recordTripMetrics(db, trip, 'destination-arrived', NOW);

      expect(capturedArgs[7]).toBe(0);
    });

    it('fired_count 조회 실패는 swallow하고 0으로 안전 degrade한다(INSERT 흐름 차단 없음)', async () => {
      let capturedArgs: unknown[] = [];
      const db = makeRoutingMockDb({
        selectThrows: true,
        onInsertBind: (args) => {
          capturedArgs = args;
        },
      });
      const trip = makeTripFixture();

      await expect(
        recordTripMetrics(db, trip, 'destination-arrived', NOW),
      ).resolves.toBeUndefined();
      expect(capturedArgs[7]).toBe(0);
    });

    it('boardingPromptState/hopEndPromptState에 fireCount가 있어도(구 #2281 방식) 더 이상 fired_count에 반영되지 않는다', async () => {
      let capturedArgs: unknown[] = [];
      const db = makeRoutingMockDb({
        sentCount: 0,
        onInsertBind: (args) => {
          capturedArgs = args;
        },
      });
      const trip = makeTripFixture({
        boardingPromptState: { fired: true, lastFiredAt: NOW - 120_000, fireCount: 2 },
        hopEndPromptState: {
          '건대입구|7': { fired: true, lastFiredAt: NOW - 60_000, fireCount: 1 },
        },
      });

      await recordTripMetrics(db, trip, 'destination-arrived', NOW);

      expect(capturedArgs[7]).toBe(0);
    });
  });

  // #2628 — lock_attached는 "종료 시점 스냅샷"(boardingLock truthy 여부)이 아니라 "생애 중 한
  // 번이라도 부착됐는지"(trip.lockEverAttached, `trips.ts` putTrip이 stamp)를 본다. 도착 후 lock을
  // 해제하고 1초 뒤 trip이 삭제된 실 trip(2026-09-15 RCA)이 lock_attached=0으로 오기록되던 결함.
  describe('lock_attached 집계 — 생애 이력 (#2628)', () => {
    it('현재 boardingLock은 없지만 lockEverAttached=true이면 lock_attached=1로 적재된다', async () => {
      let capturedArgs: unknown[] = [];
      const run = vi.fn().mockResolvedValue({ success: true });
      const bind = vi.fn().mockImplementation((...args: unknown[]) => {
        capturedArgs = args;
        return { run };
      });
      const prepare = vi.fn().mockReturnValue({ bind });
      const db = { prepare } as unknown as D1Database;

      const trip = makeTripFixture({
        boardingLock: undefined,
        lockEverAttached: true,
      });

      await recordTripMetrics(db, trip, 'destination-arrived', NOW);

      // lock_attached = 12번째 bind 인자 (positional index 11, 0-based).
      expect(capturedArgs[11]).toBe(1);
    });

    it('lock을 한 번도 부착한 적 없으면 lock_attached=0 이다', async () => {
      let capturedArgs: unknown[] = [];
      const run = vi.fn().mockResolvedValue({ success: true });
      const bind = vi.fn().mockImplementation((...args: unknown[]) => {
        capturedArgs = args;
        return { run };
      });
      const prepare = vi.fn().mockReturnValue({ bind });
      const db = { prepare } as unknown as D1Database;

      const trip = makeTripFixture();

      await recordTripMetrics(db, trip, 'destination-arrived', NOW);

      expect(capturedArgs[11]).toBe(0);
    });

    it('lockEverAttached 미배선이어도 현재 boardingLock이 있으면 lock_attached=1 (방어적 OR)', async () => {
      let capturedArgs: unknown[] = [];
      const run = vi.fn().mockResolvedValue({ success: true });
      const bind = vi.fn().mockImplementation((...args: unknown[]) => {
        capturedArgs = args;
        return { run };
      });
      const prepare = vi.fn().mockReturnValue({ bind });
      const db = { prepare } as unknown as D1Database;

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

      expect(capturedArgs[11]).toBe(1);
    });
  });

  // #2628 — boarding_prompt_responded는 더 이상 하드코딩 0이 아니라 `POST
  // /trips/:token/boarding-confirm` 응답 시 stamp되는 `trip.boardingPromptResponded`를 집계한다.
  describe('boarding_prompt_responded 집계 (#2628)', () => {
    it('boardingPromptResponded=true인 trip은 boarding_prompt_responded=1로 적재된다', async () => {
      let capturedArgs: unknown[] = [];
      const run = vi.fn().mockResolvedValue({ success: true });
      const bind = vi.fn().mockImplementation((...args: unknown[]) => {
        capturedArgs = args;
        return { run };
      });
      const prepare = vi.fn().mockReturnValue({ bind });
      const db = { prepare } as unknown as D1Database;

      const trip = makeTripFixture({ boardingPromptResponded: true });

      await recordTripMetrics(db, trip, 'destination-arrived', NOW);

      // boarding_prompt_responded = 11번째 bind 인자 (positional index 10, 0-based).
      expect(capturedArgs[10]).toBe(1);
    });

    it('응답이 없으면(필드 부재) boarding_prompt_responded=0 이다', async () => {
      let capturedArgs: unknown[] = [];
      const run = vi.fn().mockResolvedValue({ success: true });
      const bind = vi.fn().mockImplementation((...args: unknown[]) => {
        capturedArgs = args;
        return { run };
      });
      const prepare = vi.fn().mockReturnValue({ bind });
      const db = { prepare } as unknown as D1Database;

      const trip = makeTripFixture();

      await recordTripMetrics(db, trip, 'destination-arrived', NOW);

      expect(capturedArgs[10]).toBe(0);
    });
  });

  // #2268 — device가 알고 있는 실제 종료 사유(예: lockless-trip-end)도 자유 문자열로 받아
  // end_reason에 그대로 적재한다. TripEndedReason(server-side auto-end 전용) 제약을 받지 않는다.
  it('device가 보고한 자유 문자열 reason도 end_reason에 그대로 적재된다', async () => {
    const trip = makeTripFixture();
    const run = vi.fn().mockResolvedValue({ success: true });
    let capturedArgs: unknown[] = [];
    const bind = vi.fn().mockImplementation((...args: unknown[]) => {
      capturedArgs = args;
      return { run };
    });
    const prepare = vi.fn().mockReturnValue({ bind });
    const db2 = { prepare } as unknown as D1Database;

    await recordTripMetrics(db2, trip, 'lockless-trip-end', NOW);

    expect(capturedArgs).toContain('lockless-trip-end');
  });

  // #2280 — origin_station null RCA: passedStations는 advance 이벤트(waypoint 통과)가 한 번도
  // 없던 trip(짧은 trip/조기 종료)에서 영구 undefined라 origin_station이 항상 null로 적재됐다
  // (evidence: 2026-08-11 3건 + 2026-08-10 trip 50, 모두 origin_station=null). device가 등록
  // 시점에 stamp한 `originStationName`(SSOT, trip 수명 동안 불변)을 1순위 소스로 채택해야 한다.
  describe('origin_station 적재 (#2280)', () => {
    /**
     * trip_metrics INSERT의 origin_station positional arg (bind 5번째, 0-based index 4).
     * #2628 — recordTripMetrics가 INSERT 전에 fired_count용 SELECT COUNT도 prepare/bind하므로
     * (`countSentFireAttempts`, 3-arg bind), SQL 텍스트로 분기해 INSERT(13-arg) bind만 관측한다.
     */
    function captureOriginStationArg(trip: Parameters<typeof makeTripFixture>[0]): Promise<unknown> {
      return new Promise((resolve) => {
        const prepare = vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('SELECT COUNT')) {
            return { bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue({ count: 0 }) }) };
          }
          return {
            bind: vi.fn().mockImplementation((...args: unknown[]) => {
              resolve(args[4]);
              return { run: vi.fn().mockResolvedValue({ success: true }) };
            }),
          };
        });
        const db = { prepare } as unknown as D1Database;
        void recordTripMetrics(db, makeTripFixture(trip), 'destination-arrived', NOW);
      });
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
