import { describe, expect, it } from 'vitest';
import type { LockCell, LockOp, LockOpResult } from '../lockOps';
import type { ProgressCell, ProgressOp, ProgressOpResult } from '../progressOps';
import { waypointSignatureKey } from '../trips';
import type { BoardingLockMeta, Waypoint } from '../types';
import { makeFakeTripDoNamespace } from './helpers/fakeTripDoNamespace';

/**
 * #3055 / #3300 옵션 D PR-4a — TripDO `/progress` 라우트(진행 셀). 스펙: tasks/plan-2026-11-03-trip-do-field-cas.md §4 PR-4a.
 * 노선은 10/31 storm 실측(용마산 -> 논현 7호선: 강남구청 -> 학동 -> 논현).
 */
const NOW = 1_793_408_140_000;
const CREATED_AT = NOW - 18 * 60_000;
const wp = (stationName: string, kind: Waypoint['kind'] = 'intermediate'): Waypoint =>
  ({ stationName, line: '7', kind }) as Waypoint;
const ROUTE = [wp('강남구청'), wp('학동'), wp('논현', 'destination')];
const key = waypointSignatureKey;
const LOCK = {
  trainCode: '7077',
  line: '7',
  subwayId: '1007',
  selectedDepartureTime: NOW,
  segmentStations: ['용마산', '강남구청', '학동', '논현'],
  expiresAt: NOW + 3_600_000,
} as BoardingLockMeta;

type Stub = { fetch(request: Request): Promise<Response> };

function stubFor(options?: Parameters<typeof makeFakeTripDoNamespace>[0], name = 'tok-p') {
  const fake = makeFakeTripDoNamespace(options);
  const stub = fake.ns.get(fake.ns.idFromName(name)) as unknown as Stub;
  return { ...fake, stub, name };
}

async function getProgress(stub: Stub): Promise<ProgressCell | null> {
  const res = await stub.fetch(new Request('https://trip-do/progress'));
  return ((await res.json()) as { cell: ProgressCell | null }).cell;
}
async function postProgress(stub: Stub, op: ProgressOp, now = NOW): Promise<ProgressOpResult> {
  const res = await stub.fetch(
    new Request('https://trip-do/progress/op', { method: 'POST', body: JSON.stringify({ op, now }) }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as ProgressOpResult;
}
async function postLock(stub: Stub, op: LockOp, now = NOW): Promise<LockOpResult> {
  const res = await stub.fetch(
    new Request('https://trip-do/lock/op', { method: 'POST', body: JSON.stringify({ op, now }) }),
  );
  return (await res.json()) as LockOpResult;
}

const seed = (epoch = 1): ProgressOp => ({
  type: 'seedProgressFromKv',
  source: 'test',
  epoch,
  snapshot: { createdAt: CREATED_AT, waypoints: ROUTE, routeWaypoints: ROUTE },
});
const advance = (headKey: string, extra: Partial<Extract<ProgressOp, { type: 'advanceHead' }>> = {}): ProgressOp => ({
  type: 'advanceHead',
  source: 'test',
  expectedHeadKey: headKey,
  count: 1,
  ...extra,
});

describe('TripDO /progress', () => {
  it('GET /progress: 셀 미존재면 { cell: null }', async () => {
    const { stub } = stubFor();
    expect(await getProgress(stub)).toBeNull();
  });

  it('POST /progress/op 적용 결과가 GET /progress 와 GET /cells 로 보인다', async () => {
    const { stub } = stubFor();
    await postProgress(stub, seed());
    const advanced = await postProgress(stub, advance(key(ROUTE[0])));
    expect(advanced.outcome).toBe('applied');
    expect((await getProgress(stub))?.waypoints.map((w) => w.stationName)).toEqual(['학동', '논현']);
    const cells = (await (await stub.fetch(new Request('https://trip-do/cells'))).json()) as { progress: ProgressCell | null };
    expect(cells.progress?.waypoints).toHaveLength(2);
  });

  it('noop/conflict는 저장을 바꾸지 않는다(이미 소비된 head 재선점 = noop)', async () => {
    const { stub, storages, name } = stubFor();
    await postProgress(stub, seed());
    await postProgress(stub, advance(key(ROUTE[0])));
    const before = JSON.stringify(storages.get(name)!.map.get('progress'));
    expect((await postProgress(stub, advance(key(ROUTE[0])))).outcome).toBe('noop');
    expect((await postProgress(stub, advance(key(ROUTE[2])))).outcome).toBe('conflict');
    expect(JSON.stringify(storages.get(name)!.map.get('progress'))).toBe(before);
  });

  it('잘못된 body/op는 400 — 저장 불변', async () => {
    const { stub, storages, name } = stubFor();
    const bad = ['not json', JSON.stringify({}), JSON.stringify({ op: { type: 'nope', source: 'x' } })];
    for (const body of bad) {
      const res = await stub.fetch(new Request('https://trip-do/progress/op', { method: 'POST', body }));
      expect(res.status).toBe(400);
    }
    expect(storages.get(name)!.map.has('progress')).toBe(false);
  });

  it('progress 라우트는 lock/la 키와 독립이다', async () => {
    const { stub, storages, name } = stubFor();
    await postProgress(stub, seed());
    expect([...storages.get(name)!.map.keys()]).toEqual(['progress']);
  });

  describe('cross-cell — 같은 storage 쓰기로 원자 적용', () => {
    async function withLock(stub: Stub): Promise<LockCell> {
      const seeded = await postLock(stub, { type: 'seedFromKv', source: 't', epoch: 1, snapshot: { createdAt: CREATED_AT } });
      const attached = await postLock(stub, {
        type: 'attachIfNone',
        source: 't',
        authority: 'auto',
        expectedRev: seeded.cell.rev,
        lock: LOCK,
      });
      return attached.cell;
    }

    it('advanceHead.releaseLock: 전진과 lock 해제가 한 번에 영속된다', async () => {
      const { stub } = stubFor();
      const lockCell = await withLock(stub);
      await postProgress(stub, seed());
      const result = await postProgress(
        stub,
        advance(key(ROUTE[0]), { releaseLock: { expectedRev: lockCell.rev, reason: 'transfer' } }),
      );
      expect(result.outcome).toBe('applied');
      expect(result.lock?.outcome).toBe('applied');
      const lockAfter = (await (await stub.fetch(new Request('https://trip-do/lock'))).json()) as { cell: LockCell };
      expect(lockAfter.cell.lock).toBeUndefined();
    });

    it('이미 소비된 head면 lock도 해제하지 않는다(noop)', async () => {
      const { stub } = stubFor();
      const lockCell = await withLock(stub);
      await postProgress(stub, seed());
      await postProgress(stub, advance(key(ROUTE[0])));
      const result = await postProgress(
        stub,
        advance(key(ROUTE[0]), { releaseLock: { expectedRev: lockCell.rev, reason: 'transfer' } }),
      );
      expect(result.outcome).toBe('noop');
      const lockAfter = (await (await stub.fetch(new Request('https://trip-do/lock'))).json()) as { cell: LockCell };
      expect(lockAfter.cell.lock?.trainCode).toBe('7077');
    });
  });

  describe('동시성 — 클래스 내부 mutex', () => {
    it('같은 head 키 advance 4개 동시(10/31 storm 4회 재소비): 정확히 1개만 applied', async () => {
      // 요청 직렬화 OFF + storage gap ON: DO 런타임 보호 없이 mutex만으로 직렬화돼야 한다.
      const { stub } = stubFor({ serializeRequests: false, gap: true });
      await postProgress(stub, seed());
      const results = await Promise.all(Array.from({ length: 4 }, () => postProgress(stub, advance(key(ROUTE[0])))));
      expect(results.map((r) => r.outcome).sort()).toEqual(['applied', 'noop', 'noop', 'noop']);
      expect((await getProgress(stub))?.waypoints).toHaveLength(2);
    });
  });
});
