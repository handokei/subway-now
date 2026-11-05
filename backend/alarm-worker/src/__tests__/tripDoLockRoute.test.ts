import { describe, expect, it } from 'vitest';
import type { LockCell, LockOp, LockOpResult } from '../lockOps';
import type { BoardingLockMeta } from '../types';
import { makeFakeTripDoNamespace } from './helpers/fakeTripDoNamespace';

/**
 * #3300 옵션 D PR-2 — TripDO `/lock` 라우트.
 * 스펙: tasks/plan-2026-11-03-trip-do-field-cas.md §1(a), §4 PR-2.
 */

const NOW = 1_800_000_000_000;
const LOCK = {
  trainCode: '3334',
  line: '2',
  segmentStations: ['성수', '건대입구'],
  expiresAt: NOW + 3_600_000,
} as unknown as BoardingLockMeta;

type Stub = { fetch(request: Request): Promise<Response> };

function stubFor(options?: Parameters<typeof makeFakeTripDoNamespace>[0], name = 'tok-1') {
  const fake = makeFakeTripDoNamespace(options);
  const stub = fake.ns.get(fake.ns.idFromName(name)) as unknown as Stub;
  return { ...fake, stub };
}

async function getCell(stub: Stub): Promise<LockCell | null> {
  const res = await stub.fetch(new Request('https://trip-do/lock'));
  return ((await res.json()) as { cell: LockCell | null }).cell;
}

async function postOp(stub: Stub, op: LockOp, now = NOW): Promise<LockOpResult> {
  const res = await stub.fetch(
    new Request('https://trip-do/lock/op', { method: 'POST', body: JSON.stringify({ op, now }) }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as LockOpResult;
}

const seed = (epoch = 1, createdAt = 1000): LockOp => ({
  type: 'seedFromKv',
  source: 'test',
  epoch,
  snapshot: { createdAt },
});
const attachAuto = (expectedRev: number, lock = LOCK): LockOp => ({
  type: 'attachIfNone',
  source: 'test',
  authority: 'auto',
  expectedRev,
  lock,
});

describe('TripDO /lock', () => {
  it('GET /lock: 셀 미존재면 { cell: null }', async () => {
    const { stub } = stubFor();
    expect(await getCell(stub)).toBeNull();
  });

  it('POST /lock/op 적용 결과가 GET /lock 으로 보인다', async () => {
    const { stub } = stubFor();
    const seeded = await postOp(stub, seed());
    expect(seeded.outcome).toBe('applied');
    const attached = await postOp(stub, attachAuto(seeded.cell.rev));
    expect(attached.outcome).toBe('applied');
    const cell = await getCell(stub);
    expect(cell?.lock?.trainCode).toBe('3334');
    expect(cell?.rev).toBe(2);
  });

  it('conflict는 저장을 바꾸지 않는다', async () => {
    const { stub, storages } = stubFor();
    await postOp(stub, seed());
    const before = JSON.stringify(storages.get('tok-1')!.map.get('lock'));
    const conflict = await postOp(stub, attachAuto(99));
    expect(conflict.outcome).toBe('conflict');
    expect(JSON.stringify(storages.get('tok-1')!.map.get('lock'))).toBe(before);
  });

  it('now 생략 시 DO 시계를 쓴다', async () => {
    const { stub } = stubFor();
    const res = await stub.fetch(
      new Request('https://trip-do/lock/op', { method: 'POST', body: JSON.stringify({ op: seed() }) }),
    );
    const body = (await res.json()) as LockOpResult;
    expect(Math.abs(body.cell.last.at - Date.now())).toBeLessThan(5_000);
  });

  it('잘못된 body/op는 400 — 저장 불변', async () => {
    const { stub, storages } = stubFor();
    const bad = ['not json', JSON.stringify({}), JSON.stringify({ op: { type: 'nope', source: 'x' } })];
    for (const body of bad) {
      const res = await stub.fetch(new Request('https://trip-do/lock/op', { method: 'POST', body }));
      expect(res.status).toBe(400);
    }
    expect(storages.get('tok-1')!.map.has('lock')).toBe(false);
  });

  it('lock 라우트는 기존 /trip 키와 독립', async () => {
    const { stub } = stubFor();
    await postOp(stub, seed());
    const res = await stub.fetch(new Request('https://trip-do/trip'));
    expect(await res.json()).toEqual({ trip: null });
  });

  describe('동시성 — 클래스 내부 mutex', () => {
    it('동시 attach 2개(같은 expectedRev)는 직렬화: 하나만 applied, 하나는 noop(이미 lock)', async () => {
      // 요청 직렬화 OFF + storage gap ON: DO 런타임 보호 없이 mutex만으로 직렬화돼야 한다.
      const { stub } = stubFor({ serializeRequests: false, gap: true });
      const seeded = await postOp(stub, seed());
      const lockB = { ...LOCK, trainCode: '9999' } as unknown as BoardingLockMeta;
      const [a, b] = await Promise.all([
        postOp(stub, attachAuto(seeded.cell.rev, LOCK)),
        postOp(stub, attachAuto(seeded.cell.rev, lockB)),
      ]);
      expect([a.outcome, b.outcome].sort()).toEqual(['applied', 'noop']);
      const cell = await getCell(stub);
      expect(cell?.rev).toBe(seeded.cell.rev + 1);
      expect(cell?.lock?.trainCode).toBe('3334');
    });

    it('동시 서로 다른 op 2개는 둘 다 반영되고 rev는 2회 증가', async () => {
      const { stub } = stubFor({ serializeRequests: false, gap: true });
      const s = await postOp(stub, seed());
      const attached = await postOp(stub, attachAuto(s.cell.rev));
      const [swap, release] = await Promise.all([
        postOp(stub, {
          type: 'swapAuto',
          source: 't',
          expectedRev: attached.cell.rev,
          trainCode: '4444',
          expiresAt: NOW + 7_200_000,
          appendHistory: true,
        }),
        postOp(stub, { type: 'userDisembarked', source: 't', expectedLegKey: '성수|2' }),
      ]);
      expect(swap.outcome).toBe('applied');
      expect(release.outcome).toBe('applied');
      const cell = await getCell(stub);
      expect(cell?.rev).toBe(attached.cell.rev + 2);
      expect(cell?.lock).toBeUndefined();
    });

    it('핸들러 예외가 mutex를 막지 않는다 (다음 요청 정상)', async () => {
      const { stub, storages } = stubFor();
      const storage = storages.get('tok-1')!;
      const originalGet = storage.get.bind(storage);
      let fail = true;
      storage.get = (async (key: string) => {
        if (fail) {
          fail = false;
          throw new Error('storage down');
        }
        return originalGet(key);
      }) as typeof storage.get;
      await expect(stub.fetch(new Request('https://trip-do/lock'))).rejects.toThrow('storage down');
      expect((await postOp(stub, seed())).outcome).toBe('applied');
    });
  });

  describe('seed 규칙', () => {
    it('같은 createdAt + 같은 epoch 재seed는 noop (DO 셀 보존)', async () => {
      const { stub } = stubFor();
      const s = await postOp(stub, seed(1, 1000));
      await postOp(stub, attachAuto(s.cell.rev));
      const again = await postOp(stub, seed(1, 1000));
      expect(again.outcome).toBe('noop');
      expect((await getCell(stub))?.lock?.trainCode).toBe('3334');
    });

    it('createdAt 불일치면 재seed (KV 값으로 초기화)', async () => {
      const { stub } = stubFor();
      const s = await postOp(stub, seed(1, 1000));
      await postOp(stub, attachAuto(s.cell.rev));
      const again = await postOp(stub, seed(1, 2000));
      expect(again.outcome).toBe('applied');
      expect((await getCell(stub))?.lock).toBeUndefined();
    });

    it('epoch 불일치면 재seed', async () => {
      const { stub } = stubFor();
      const s = await postOp(stub, seed(1, 1000));
      await postOp(stub, attachAuto(s.cell.rev));
      const again = await postOp(stub, seed(2, 1000));
      expect(again.outcome).toBe('applied');
      expect((await getCell(stub))?.seededEpoch).toBe(2);
    });
  });

  it('endSession 후 낡은 rev의 auto op는 DO 경유에서도 거부', async () => {
    const { stub } = stubFor();
    const s = await postOp(stub, seed());
    const attached = await postOp(stub, attachAuto(s.cell.rev));
    await postOp(stub, { type: 'endSession', source: 't' });
    const stale = await postOp(stub, attachAuto(attached.cell.rev));
    expect(stale.outcome).toBe('conflict');
    expect((await getCell(stub))?.lock).toBeUndefined();
  });
});
