import { describe, expect, it } from 'vitest';
import { applyLaCell, applyLaOp, emptyLaCell, type LaCell, type LaOp, type LaOpResult } from '../laCellOps';
import type { Trip } from '../types';
import { makeFakeTripDoNamespace } from './helpers/fakeTripDoNamespace';

/**
 * #3300 PR-3a (plan §10) — LA 셀 op + TripDO `/la`·`/cells` 라우트.
 * 11/04: la-token-register(17:24:56, evidence id 2168) -> 낡은 캐시 재등록(id 2172) -> 토큰 소실.
 */
const NOW = 1_800_000_000_000;

const run = (cell: LaCell, op: LaOp, now = NOW): LaOpResult => applyLaOp(cell, op, now);
const seeded = (): LaCell =>
  run(emptyLaCell(), { type: 'seedLaFromKv', source: 't', epoch: 1, snapshot: { createdAt: 1000 } }).cell;

describe('laCellOps', () => {
  it('registerLaToken: 토큰 저장 + state=live, 같은 값 재등록은 noop', () => {
    const first = run(seeded(), { type: 'registerLaToken', source: 't', token: 'A' });
    expect(first.outcome).toBe('applied');
    expect(first.cell).toMatchObject({ activityPushToken: 'A', activityState: 'live' });
    expect(run(first.cell, { type: 'registerLaToken', source: 't', token: 'A' }).outcome).toBe('noop');
  });

  it('registerLaToken: 다른 토큰은 교체(rotation)', () => {
    const a = run(seeded(), { type: 'registerLaToken', source: 't', token: 'A' }).cell;
    const b = run(a, { type: 'registerLaToken', source: 't', token: 'B' });
    expect(b.outcome).toBe('applied');
    expect(b.cell.activityPushToken).toBe('B');
  });

  it('clearLaToken: 토큰을 비우고 state=ended, 이미 비어 ended면 noop', () => {
    const a = run(seeded(), { type: 'registerLaToken', source: 't', token: 'A' }).cell;
    const cleared = run(a, { type: 'clearLaToken', source: 't', reason: 'device-end' });
    expect(cleared.outcome).toBe('applied');
    expect(cleared.cell).toMatchObject({ activityPushToken: undefined, activityState: 'ended' });
    expect(run(cleared.cell, { type: 'clearLaToken', source: 't', reason: 'again' }).outcome).toBe('noop');
  });

  it('clearLaToken{expectedToken}: 그 사이 새 토큰이 등록됐으면 지우지 않는다(cron token-invalid 보호)', () => {
    const b = run(
      run(seeded(), { type: 'registerLaToken', source: 't', token: 'A' }).cell,
      { type: 'registerLaToken', source: 't', token: 'B' },
    ).cell;
    const stale = run(b, { type: 'clearLaToken', source: 'cron', reason: 'token-invalid', expectedToken: 'A' });
    expect(stale.outcome).toBe('noop');
    expect(stale.cell.activityPushToken).toBe('B');
    expect(run(b, { type: 'clearLaToken', source: 'cron', reason: 'token-invalid', expectedToken: 'B' }).outcome).toBe(
      'applied',
    );
  });

  it('setLaState: 같은 값은 noop, 다르면 적용', () => {
    const a = run(seeded(), { type: 'registerLaToken', source: 't', token: 'A' }).cell;
    expect(run(a, { type: 'setLaState', source: 't', state: 'live' }).outcome).toBe('noop');
    expect(run(a, { type: 'setLaState', source: 't', state: 'ended' }).cell.activityState).toBe('ended');
  });

  it('seedLaFromKv: 같은 세션·epoch면 noop, epoch가 바뀌면 KV 값으로 재시드', () => {
    const base = seeded();
    const op = (epoch: number, token?: string): LaOp => ({
      type: 'seedLaFromKv',
      source: 't',
      epoch,
      snapshot: { createdAt: 1000, activityPushToken: token, activityState: token ? 'live' : undefined },
    });
    expect(run(base, op(1, 'X')).outcome).toBe('noop');
    const reseeded = run(base, op(2, 'X'));
    expect(reseeded.outcome).toBe('applied');
    expect(reseeded.cell).toMatchObject({ activityPushToken: 'X', seededEpoch: 2 });
  });

  it('applyLaCell은 입력 trip을 바꾸지 않고 LA 필드만 반영한다', () => {
    const trip = { token: 't', activityPushToken: 'old' } as Trip;
    const next = applyLaCell(trip, { ...seeded(), activityPushToken: 'new', activityState: 'live' });
    expect(next).toMatchObject({ activityPushToken: 'new', activityState: 'live' });
    expect(trip.activityPushToken).toBe('old');
  });
});

describe('TripDO /la · /cells 라우트', () => {
  const stubOf = () => {
    const fake = makeFakeTripDoNamespace();
    return fake.ns.get(fake.ns.idFromName('tok')) as unknown as { fetch(r: Request): Promise<Response> };
  };
  const postLa = (stub: ReturnType<typeof stubOf>, body: string) =>
    stub.fetch(new Request('https://trip-do/la/op', { method: 'POST', body }));

  it('applied만 영속하고 /la·/cells로 읽힌다', async () => {
    const stub = stubOf();
    expect(await (await stub.fetch(new Request('https://trip-do/la'))).json()).toEqual({ cell: null });
    expect(await (await stub.fetch(new Request('https://trip-do/cells'))).json()).toEqual({ lock: null, la: null });
    const res = await postLa(stub, JSON.stringify({ op: { type: 'registerLaToken', source: 't', token: 'A' }, now: NOW }));
    expect(((await res.json()) as LaOpResult).outcome).toBe('applied');
    const noop = await postLa(stub, JSON.stringify({ op: { type: 'registerLaToken', source: 't', token: 'A' }, now: NOW }));
    expect(((await noop.json()) as LaOpResult).outcome).toBe('noop');
    const cells = (await (await stub.fetch(new Request('https://trip-do/cells'))).json()) as { la: LaCell };
    expect(cells.la.activityPushToken).toBe('A');
    expect(cells.la.rev).toBe(1);
  });

  it('잘못된 json / op는 400', async () => {
    const stub = stubOf();
    expect((await postLa(stub, '{')).status).toBe(400);
    expect((await postLa(stub, JSON.stringify({ now: NOW }))).status).toBe(400);
    expect((await postLa(stub, JSON.stringify({ op: { type: 'nope', source: 't' }, now: NOW }))).status).toBe(400);
  });
});
