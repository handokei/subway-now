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
      expect.stringContaining('INSERT INTO trip_metrics'),
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
});
