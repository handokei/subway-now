/**
 * #3300 옵션 D PR-1 — lockOps 순수 함수 (Part of #3055).
 *
 * 입력 시각·열차·노선은 실측이다(통과시키려 조정 금지):
 *  - 11/03: `tasks/evidence-2026-11-03-lock-loss-d1.json` (D1 trip_events, token_hash b00dd879)
 *      id 2046 ts 1793699219596 `lock-attached path=confirm trainCode=3334` 뚝섬/2 (18:46:59 KST)
 *      id 2047 같은 시각 `boarding-confirm-result lockState=leg1`
 *  - 10/19: `fixtures/replay_20261019_sleep_regression/events_168.json` (D1 trip_events)
 *      id 1153 `boarding-confirm-result lockState=leg2` (18:10:22 KST) — 건대입구/7, 후보 7266(id 1154)
 *      id 1156/1158/1160 같은 세션 `trip-register` 재등록 (재등록 payload의 lock 부재는 D1에 없는 **추정 입력**)
 *
 * 순수 함수 단계(동작 변화 0)라 DO/KV 연결은 없다 — 낡은 시야는 "낡은 rev를 든 op"로 표현한다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyLockCell,
  applyLockOp,
  emptyLockCell,
  lockLegKey,
  type LockCell,
  type LockOp,
} from '../lockOps';
import type { BoardingLockMeta, Trip } from '../types';

// ── 11/03 실측 (evidence id 2046)
const L3334_ATTACH_TS = 1793699219596;
const lock3334 = (): BoardingLockMeta => ({
  trainCode: '3334',
  line: '2',
  subwayId: '1002',
  selectedDepartureTime: L3334_ATTACH_TS,
  segmentStations: ['뚝섬', '성수'],
  expiresAt: L3334_ATTACH_TS + 30 * 60_000,
});

// ── 10/19 실측 (events_168.json id 1153 / 1156)
const FIXTURE_DIR = join(__dirname, 'fixtures', 'replay_20261019_sleep_regression');
interface D1Row {
  id: number;
  ts: number;
  kind: string;
  meta: string;
}
const rows168: D1Row[] = (JSON.parse(readFileSync(join(FIXTURE_DIR, 'events_168.json'), 'utf8')) as [{ results: D1Row[] }])[0]
  .results;
const rowById = (id: number): D1Row => rows168.find((r) => r.id === id) as D1Row;
const TRIP_168_STARTED_AT = 1792400281261; // id 1162 metrics-window-truncated.startedAt
const lock7266 = (): BoardingLockMeta => ({
  trainCode: '7266',
  line: '7',
  subwayId: '1007',
  selectedDepartureTime: rowById(1153).ts,
  segmentStations: ['건대입구', '용마산'],
  expiresAt: rowById(1153).ts + 30 * 60_000,
});

const userBoarded = (expectedRev: number, lock: BoardingLockMeta, releaseFirst = false): LockOp => ({
  type: 'userBoarded',
  source: 'confirm',
  expectedRev,
  releaseFirst,
  lock,
});
const run = (cell: LockCell, op: LockOp, now = 0) => applyLockOp(cell, op, now);

describe('lockOps — 실측 재현', () => {
  it('① 11/03: confirm이 부착한 3334를 낡은 시야(rev 0)의 sync op가 지우지 못한다', () => {
    // id 2046 — 18:46:59 confirm 부착.
    const attached = run(emptyLockCell(), userBoarded(0, lock3334()), L3334_ATTACH_TS);
    expect(attached.outcome).toBe('applied');
    expect(attached.cell.rev).toBe(1);

    // sync(18:47:01)는 60s 캐시 스냅샷(= lock 없음, rev 0)을 본다. 그 시야가 내는 op 전부 무해해야 한다.
    const staleRefresh = run(attached.cell, { type: 'refreshExpiry', source: 'sync', expectedRev: 0, until: L3334_ATTACH_TS + 99 });
    const staleAttach = run(attached.cell, {
      type: 'attachIfNone',
      source: 'sync',
      authority: 'auto',
      expectedRev: 0,
      lock: { ...lock3334(), trainCode: '9999' },
    });
    const staleRelease = run(attached.cell, { type: 'releaseAuto', source: 'cron', expectedRev: 0, reason: 'stale' });

    expect(staleRefresh.outcome).toBe('noop');
    expect(staleAttach.outcome).toBe('noop'); // 이유: lock이 이미 있다(덮지 않음)
    expect(staleRelease.outcome).toBe('conflict'); // 이유: rev 불일치
    for (const r of [staleRefresh, staleAttach, staleRelease]) {
      expect(r.cell.lock?.trainCode).toBe('3334');
      expect(r.cell).toBe(attached.cell); // 셀 불변
    }
  });

  it('② 10/19: userBoarded(18:10:22) 직후 같은 세션 registerSession{incomingLock:null}은 lock을 유지한다', () => {
    const boarded = run(emptyLockCell(), userBoarded(0, lock7266()), rowById(1153).ts);
    expect(boarded.cell.lock?.trainCode).toBe('7266');

    // id 1156 — 낡은 existing(lock 없음)을 읽은 재등록. 같은 세션이므로 셀의 최신 lock이 carry돼야 한다.
    const reg = run(
      boarded.cell,
      {
        type: 'registerSession',
        source: 'register',
        incomingLock: null,
        existing: { createdAt: TRIP_168_STARTED_AT, waypointLines: ['2', '7', '7', '7', '7'] },
        incomingCreatedAt: TRIP_168_STARTED_AT,
        routeReset: false,
      },
      rowById(1156).ts,
    );

    expect(reg.outcome).toBe('noop');
    expect(reg.cell.lock?.trainCode).toBe('7266');
    expect(reg.cell.session).toEqual(boarded.cell.session); // 새 세션이 아니다
  });

  it('③ cron이 tick 시작 rev로 releaseAuto — 그 사이 사용자 부착이 있으면 conflict, lock 유지', () => {
    const tickStartRev = 0;
    const userAttached = run(emptyLockCell(), userBoarded(0, lock3334()), L3334_ATTACH_TS).cell;
    const release = run(userAttached, { type: 'releaseAuto', source: 'cron-vanish', expectedRev: tickStartRev, reason: 'vanish' });
    expect(release.outcome).toBe('conflict');
    expect(release.cell.lock?.trainCode).toBe('3334');
  });

  it('④ userDisembarked는 같은 leg 안 swap 뒤에도 해제한다 (다른 leg면 conflict)', () => {
    const base = run(emptyLockCell(), userBoarded(0, lock3334()), 1).cell;
    const legKey = lockLegKey(base.lock as BoardingLockMeta);
    const swapped = run(base, {
      type: 'swapAuto',
      source: 'cron-vanish',
      expectedRev: base.rev,
      trainCode: '3338',
      expiresAt: 5,
      appendHistory: true,
    }).cell;
    expect(swapped.rev).toBe(base.rev + 1);
    expect(swapped.lock?.trainCode).toBe('3338');

    const wrongLeg = run(swapped, { type: 'userDisembarked', source: 'confirm', expectedLegKey: '건대입구|7' });
    expect(wrongLeg.outcome).toBe('conflict');
    expect(wrongLeg.cell.lock?.trainCode).toBe('3338');

    const released = run(swapped, { type: 'userDisembarked', source: 'confirm', expectedLegKey: legKey });
    expect(released.outcome).toBe('applied');
    expect(released.cell.lock).toBeUndefined();
    expect(released.cell.consecutiveEtaMissing).toBe(0);
    expect(released.cell.lockCodeHistory).toBeUndefined();
  });

  it('⑤ userBoarded rev 불일치 + 셀 lock 있음 → conflict-kept (기존 유지); lock 없으면 사용자 의향대로 부착', () => {
    const base = run(emptyLockCell(), userBoarded(0, lock3334()), 1).cell;
    const kept = run(base, userBoarded(0, { ...lock3334(), trainCode: '3338' }));
    expect(kept.outcome).toBe('conflict-kept');
    expect(kept.cell).toBe(base);

    const afterEnd = run(base, { type: 'endSession', source: 'cron' }).cell;
    const reattached = run(afterEnd, userBoarded(base.rev, lock7266()));
    expect(reattached.outcome).toBe('applied');
    expect(reattached.cell.lock?.trainCode).toBe('7266');
  });

  it('⑥ everAttached는 OR로만 커진다', () => {
    const attached = run(emptyLockCell(), userBoarded(0, lock3334()), 1).cell;
    expect(attached.everAttached).toBe(true);
    const released = run(attached, { type: 'releaseAuto', source: 'cron', expectedRev: attached.rev, reason: 'x' }).cell;
    expect(released.lock).toBeUndefined();
    expect(released.everAttached).toBe(true);
    const ended = run(released, { type: 'endSession', source: 'cron' }).cell;
    expect(ended.everAttached).toBe(true);
    const seeded = run(ended, {
      type: 'seedFromKv',
      source: 'seed',
      epoch: 1,
      snapshot: { createdAt: 10, everAttached: false },
    }).cell;
    expect(seeded.everAttached).toBe(true);
    expect(emptyLockCell().everAttached).toBe(false);
  });

  it('⑦ endSession 뒤 낡은 rev의 auto op는 거부된다', () => {
    const attached = run(emptyLockCell(), userBoarded(0, lock3334()), 1).cell;
    const ended = run(attached, { type: 'endSession', source: 'cleanup' });
    expect(ended.outcome).toBe('applied');
    expect(ended.cell.lock).toBeUndefined();
    expect(ended.cell.rev).toBeGreaterThan(attached.rev);
    expect(ended.cell.session.seq).toBe(attached.session.seq + 1);

    const staleOps: LockOp[] = [
      { type: 'attachIfNone', source: 'cron-leg1', authority: 'auto', expectedRev: attached.rev, lock: lock3334() },
      { type: 'releaseAuto', source: 'cron', expectedRev: attached.rev, reason: 'x' },
      { type: 'swapAuto', source: 'cron', expectedRev: attached.rev, trainCode: '1', expiresAt: 1, appendHistory: false },
      { type: 'setSegment', source: 'cron', expectedRev: attached.rev, segmentStations: ['a'] },
      { type: 'setEtaMissing', source: 'cron', expectedRev: attached.rev, value: 3 },
    ];
    for (const op of staleOps) {
      const r = run(ended.cell, op);
      expect(r.outcome).toBe('conflict');
      expect(r.cell.lock).toBeUndefined();
    }
  });
});

describe('lockOps — rev 규칙', () => {
  it('refreshExpiry / setSegment / setEtaMissing은 rev를 올리지 않고, 식별 변경만 +1', () => {
    const a = run(emptyLockCell(), { type: 'attachIfNone', source: 'cron-leg1', authority: 'auto', expectedRev: 0, lock: lock3334() });
    expect(a.cell.rev).toBe(1);
    const refreshed = run(a.cell, { type: 'refreshExpiry', source: 'sync', expectedRev: 1, until: a.cell.lock!.expiresAt + 1000 });
    expect(refreshed.outcome).toBe('applied');
    expect(refreshed.cell.rev).toBe(1);
    expect(refreshed.cell.lock?.expiresAt).toBe(a.cell.lock!.expiresAt + 1000);
    const seg = run(refreshed.cell, { type: 'setSegment', source: 'cron', expectedRev: 1, segmentStations: ['뚝섬', '성수', '건대입구'] });
    expect(seg.outcome).toBe('applied');
    expect(seg.cell.rev).toBe(1);
    expect(seg.cell.lock?.segmentStations).toEqual(['뚝섬', '성수', '건대입구']);
    const eta = run(seg.cell, { type: 'setEtaMissing', source: 'cron', expectedRev: 1, value: 4 });
    expect(eta.cell.rev).toBe(1);
    expect(eta.cell.consecutiveEtaMissing).toBe(4);
    const swapped = run(eta.cell, { type: 'swapAuto', source: 'cron', expectedRev: 1, trainCode: '3338', expiresAt: 1, appendHistory: true });
    expect(swapped.cell.rev).toBe(2);
    expect(swapped.cell.consecutiveEtaMissing).toBe(0);
    expect(swapped.cell.lockCodeHistory).toEqual(['3334']);
    expect(swapped.cell.lock?.expiresAt).toBe(a.cell.lock!.expiresAt + 1000); // max
    const rel = run(swapped.cell, { type: 'releaseAuto', source: 'cron', expectedRev: 2, reason: 'x' });
    expect(rel.cell.rev).toBe(3);
    expect(rel.cell.lockCodeHistory).toBeUndefined();
  });

  it('refreshExpiry: rev 불일치·lock 없음·만료가 줄어드는 경우는 noop', () => {
    const a = run(emptyLockCell(), userBoarded(0, lock3334())).cell;
    const until = a.lock!.expiresAt;
    expect(run(a, { type: 'refreshExpiry', source: 's', expectedRev: 0, until: until + 1 }).outcome).toBe('noop');
    expect(run(a, { type: 'refreshExpiry', source: 's', expectedRev: 1, until }).outcome).toBe('noop');
    expect(run(emptyLockCell(), { type: 'refreshExpiry', source: 's', expectedRev: 0, until: 1 }).outcome).toBe('noop');
  });

  it('lock이 없거나 값이 같을 때의 noop / rev 불일치 conflict', () => {
    const empty = emptyLockCell();
    expect(run(empty, { type: 'setSegment', source: 's', expectedRev: 0, segmentStations: [] }).outcome).toBe('noop');
    expect(run(empty, { type: 'setEtaMissing', source: 's', expectedRev: 0, value: 0 }).outcome).toBe('noop');
    expect(run(empty, { type: 'setEtaMissing', source: 's', expectedRev: 9, value: 1 }).outcome).toBe('conflict');
    expect(run(empty, { type: 'setSegment', source: 's', expectedRev: 9, segmentStations: [] }).outcome).toBe('conflict');
    expect(run(empty, { type: 'swapAuto', source: 's', expectedRev: 0, trainCode: '1', expiresAt: 1, appendHistory: false }).outcome).toBe('noop');
    expect(run(empty, { type: 'swapAuto', source: 's', expectedRev: 5, trainCode: '1', expiresAt: 1, appendHistory: false }).outcome).toBe('conflict');
    expect(run(empty, { type: 'releaseAuto', source: 's', expectedRev: 0, reason: 'x' }).outcome).toBe('noop');
    expect(run(empty, { type: 'userDisembarked', source: 's', expectedLegKey: 'a|2' }).outcome).toBe('noop');
  });

  it('swapAuto: renumberSuccessor를 싣고, appendHistory=false면 history를 그대로 둔다', () => {
    const a = run(emptyLockCell(), userBoarded(0, lock3334())).cell;
    const renumberSuccessor = { from: '3334', swappedTo: '3338', armedAt: 7 };
    const s1 = run(a, { type: 'swapAuto', source: 'c', expectedRev: 1, trainCode: '3338', expiresAt: 1, appendHistory: true, renumberSuccessor });
    expect(s1.cell.renumberSuccessor).toEqual(renumberSuccessor);
    const s2 = run(s1.cell, { type: 'swapAuto', source: 'c', expectedRev: 2, trainCode: '3340', expiresAt: 1, appendHistory: false });
    expect(s2.cell.lockCodeHistory).toEqual(['3334']);
    expect(s2.cell.renumberSuccessor).toBeUndefined();
  });

  it('attachIfNone: auto는 rev 불일치면 conflict, user(sync 수동 탭)는 lock만 없으면 부착', () => {
    const ended = run(run(emptyLockCell(), userBoarded(0, lock3334())).cell, { type: 'endSession', source: 'c' }).cell;
    const auto = run(ended, { type: 'attachIfNone', source: 'cron', authority: 'auto', expectedRev: 0, lock: lock7266() });
    expect(auto.outcome).toBe('conflict');
    const user = run(ended, { type: 'attachIfNone', source: 'sync', authority: 'user', expectedRev: 0, lock: lock7266() });
    expect(user.outcome).toBe('applied');
    expect(user.cell.lock?.trainCode).toBe('7266');
    expect(user.cell.rev).toBe(ended.rev + 1);
  });

  it('userBoarded: releaseFirst는 lock 없이도 해제만 수행, 아무것도 없으면 noop', () => {
    const a = run(emptyLockCell(), userBoarded(0, lock3334())).cell;
    const released = run(a, { type: 'userBoarded', source: 'confirm', expectedRev: 1, releaseFirst: true });
    expect(released.outcome).toBe('applied');
    expect(released.cell.lock).toBeUndefined();
    expect(run(emptyLockCell(), { type: 'userBoarded', source: 'confirm', expectedRev: 0, releaseFirst: true }).outcome).toBe('noop');
    expect(run(a, { type: 'userBoarded', source: 'confirm', expectedRev: 1, releaseFirst: false }).outcome).toBe('noop');
    const replaced = run(a, userBoarded(1, lock7266(), true));
    expect(replaced.cell.lock?.trainCode).toBe('7266');
  });
});

describe('lockOps — registerSession', () => {
  const reg = (over: Partial<Extract<LockOp, { type: 'registerSession' }>>): LockOp => ({
    type: 'registerSession',
    source: 'register',
    incomingLock: null,
    existing: { createdAt: 1000, waypointLines: ['2', '7'] },
    incomingCreatedAt: 1000,
    routeReset: false,
    ...over,
  });

  it('신규 trip / route reset / 다른 열차는 새 세션: seq+1, incoming 채택, 카운터 초기화', () => {
    const base = run(emptyLockCell(), userBoarded(0, lock3334())).cell;
    const fresh = run(emptyLockCell(), reg({ existing: null, incomingLock: lock3334(), incomingCreatedAt: 50 }));
    expect(fresh.cell.session).toEqual({ seq: 1, createdAt: 50 });
    expect(fresh.cell.lock?.trainCode).toBe('3334');
    expect(fresh.cell.rev).toBe(1);

    const reset = run(base, reg({ routeReset: true }));
    expect(reset.cell.lock).toBeUndefined();
    expect(reset.cell.session.seq).toBe(base.session.seq + 1);

    const otherTrain = run(base, reg({ incomingLock: { ...lock3334(), trainCode: '3338' } }));
    expect(otherTrain.cell.lock?.trainCode).toBe('3338');
    expect(otherTrain.cell.session.seq).toBe(base.session.seq + 1);
  });

  it('같은 세션: lock이 현재 waypoints와 불일치면 해제(rev+1), 일치하면 유지', () => {
    const base = run(emptyLockCell(), userBoarded(0, lock3334())).cell; // line '2'
    const inconsistent = run(base, reg({ existing: { createdAt: 1000, waypointLines: ['7'] } }));
    expect(inconsistent.outcome).toBe('applied');
    expect(inconsistent.cell.lock).toBeUndefined();
    expect(inconsistent.cell.rev).toBe(base.rev + 1);
    const consistent = run(base, reg({}));
    expect(consistent.outcome).toBe('noop');
  });

  it('같은 세션: 같은 열차 재송신은 rev 불변으로 값만 갱신, lock 없던 셀에 incoming(createdAt drift ≤5s)은 부착', () => {
    const base = run(emptyLockCell(), userBoarded(0, lock3334())).cell;
    const resend = run(base, reg({ incomingLock: { ...lock3334(), expiresAt: 99_999_999_999_999 } }));
    expect(resend.outcome).toBe('applied');
    expect(resend.cell.rev).toBe(base.rev);
    expect(resend.cell.lock?.expiresAt).toBe(99_999_999_999_999);

    const attach = run(emptyLockCell(), reg({ incomingLock: lock7266(), incomingCreatedAt: 1003 }));
    expect(attach.outcome).toBe('applied');
    expect(attach.cell.lock?.trainCode).toBe('7266');
    expect(attach.cell.rev).toBe(1);
    expect(attach.cell.session.seq).toBe(0);
  });

  it('같은 세션이고 양쪽 lock이 없으면 noop', () => {
    expect(run(emptyLockCell(), reg({})).outcome).toBe('noop');
  });
});

describe('lockOps — seedFromKv / applyLockCell', () => {
  it('seedFromKv: createdAt 또는 epoch가 다를 때만 KV 값으로 초기화', () => {
    const snapshot = {
      createdAt: 10,
      lock: lock3334(),
      everAttached: true,
      consecutiveEtaMissing: 2,
      lockCodeHistory: ['3330'],
      renumberSuccessor: { from: 'a', swappedTo: 'b', armedAt: 1 },
    };
    const seeded = run(emptyLockCell(), { type: 'seedFromKv', source: 'seed', snapshot, epoch: 1 }, 5);
    expect(seeded.outcome).toBe('applied');
    expect(seeded.cell).toMatchObject({
      session: { seq: 0, createdAt: 10 },
      rev: 1,
      everAttached: true,
      consecutiveEtaMissing: 2,
      lockCodeHistory: ['3330'],
      seededEpoch: 1,
      last: { op: 'seedFromKv', source: 'seed', at: 5 },
    });
    expect(run(seeded.cell, { type: 'seedFromKv', source: 'seed', snapshot, epoch: 1 }).outcome).toBe('noop');
    expect(run(seeded.cell, { type: 'seedFromKv', source: 'seed', snapshot, epoch: 2 }).outcome).toBe('applied');
    expect(run(seeded.cell, { type: 'seedFromKv', source: 'seed', snapshot: { createdAt: 11 }, epoch: 1 }).cell.consecutiveEtaMissing).toBe(0);
  });

  it('applyLockCell: 입력 trip을 변이하지 않고 lock 관련 필드를 반영, lockEverAttached는 OR', () => {
    const trip = { token: 't', boardingLock: undefined, lockEverAttached: undefined } as unknown as Trip;
    const cell = run(emptyLockCell(), userBoarded(0, lock3334())).cell;
    const next = applyLockCell(trip, cell);
    expect(next.boardingLock?.trainCode).toBe('3334');
    expect(next.lockEverAttached).toBe(true);
    expect(trip.boardingLock).toBeUndefined();

    const kvStamped = { ...trip, lockEverAttached: true } as Trip;
    expect(applyLockCell(kvStamped, emptyLockCell()).lockEverAttached).toBe(true);
    expect(applyLockCell(trip, emptyLockCell()).lockEverAttached).toBeUndefined();
    expect(applyLockCell(trip, emptyLockCell()).consecutiveEtaMissing).toBe(0);
  });
});

describe('lockOps — 만료 lock은 "lock 없음" (cron의 !isBoardingLockActive 의미, scheduled.ts:1965/1348)', () => {
  const expired = () => run(emptyLockCell(), userBoarded(0, lock3334()), L3334_ATTACH_TS).cell;
  const afterExpiry = () => expired().lock!.expiresAt + 1;

  it('만료 lock 셀 + cron attachIfNone(rev 일치) -> 덮어쓰기: 카운터·history 초기화, rev+1', () => {
    const base = { ...expired(), consecutiveEtaMissing: 3, lockCodeHistory: ['3330'] };
    const r = run(
      base,
      { type: 'attachIfNone', source: 'cron-leg2', authority: 'auto', expectedRev: base.rev, lock: lock7266() },
      afterExpiry(),
    );
    expect(r.outcome).toBe('applied');
    expect(r.cell.lock?.trainCode).toBe('7266');
    expect(r.cell.consecutiveEtaMissing).toBe(0);
    expect(r.cell.lockCodeHistory).toBeUndefined();
    expect(r.cell.rev).toBe(base.rev + 1);
  });

  it('만료 lock 셀 + userBoarded(rev 불일치) -> conflict-kept가 아니라 부착', () => {
    const base = expired();
    const r = run(base, userBoarded(base.rev - 1, lock7266()), afterExpiry());
    expect(r.outcome).toBe('applied');
    expect(r.cell.lock?.trainCode).toBe('7266');
  });

  it('활성 lock은 기존대로 attachIfNone noop / userBoarded conflict-kept', () => {
    const base = expired();
    const now = base.lock!.expiresAt - 1;
    expect(
      run(base, { type: 'attachIfNone', source: 'cron-leg2', authority: 'auto', expectedRev: base.rev, lock: lock7266() }, now)
        .outcome,
    ).toBe('noop');
    expect(run(base, userBoarded(base.rev - 1, lock7266()), now).outcome).toBe('conflict-kept');
  });
});
