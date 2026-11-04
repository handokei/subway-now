/**
 * #3055 / #3300 옵션 D PR-4a — progressOps 순수 함수(진행 셀). 스펙: tasks/plan-2026-11-03-trip-do-field-cas.md §4 PR-4a/4b, §9.
 *
 * 입력 노선은 실측 트립의 역 순서다(통과시키려 조정 금지):
 *  - 10/31 용마산 -> 논현 7호선 (replay_20261031_reregister_storm): 강남구청 -> 학동 -> 논현. cron이 강남구청을 소비한 직후
 *    낡은 재등록이 head를 강남구청으로 되돌려 같은 역을 4번 소비했다(D1 prepare-alarm 1915/1921/1926/1929).
 *  - 11/02 뚝섬 -> 건대입구 환승 -> 용마산 (replay_20261102_lockless_jump_leg2): 어린이대공원 -> 군자 -> ...
 *
 * 순수 함수 단계라 DO/KV는 없다 — "낡은 시야"는 "이미 지나간 head 키를 든 op"로 표현한다.
 */
import { describe, expect, it } from 'vitest';
import { applyLockOp, emptyLockCell, type LockCell } from '../lockOps';
import {
  applyProgressCell,
  applyProgressOp,
  emptyProgressCell,
  progressHeadKey,
  type ProgressCell,
  type ProgressOp,
} from '../progressOps';
import { waypointSignatureKey } from '../trips';
import type { BoardingLockMeta, Trip, Waypoint } from '../types';

const NOW = 1_793_408_140_000; // D1 1912(09:55:40 KST) — 10/31 storm 재생 시작 시각
const CREATED_AT = NOW - 18 * 60_000;

const wp = (stationName: string, kind: Waypoint['kind'] = 'intermediate', line: Waypoint['line'] = '7'): Waypoint =>
  ({ stationName, line, kind }) as Waypoint;

/** 10/31 노선(재생 시작 시점 backend 진행분: 강남구청 학동 논현). */
const STORM_ROUTE = [wp('강남구청'), wp('학동'), wp('논현', 'destination')];
const key = (w: Waypoint): string => waypointSignatureKey(w);
const [GANGNAM_OFFICE, HAKDONG, NONHYEON] = STORM_ROUTE;

function seeded(waypoints: Waypoint[] = STORM_ROUTE, overrides: Partial<ProgressCell> = {}): ProgressCell {
  const empty = emptyProgressCell();
  return { ...empty, session: { createdAt: CREATED_AT }, waypoints, routeWaypoints: waypoints, seededEpoch: 1, ...overrides };
}

const run = (cell: ProgressCell, op: ProgressOp, lock: LockCell | null = null, now = NOW) => applyProgressOp(cell, lock, op, now);

describe('emptyProgressCell / progressHeadKey', () => {
  it('빈 셀은 waypoints가 없고 head 키도 없다', () => {
    const cell = emptyProgressCell();
    expect(cell.waypoints).toEqual([]);
    expect(progressHeadKey(cell)).toBeUndefined();
    expect(cell.seededEpoch).toBe(-1);
  });

  it('head 키는 waypointSignatureKey(waypoints[0])', () => {
    expect(progressHeadKey(seeded())).toBe(key(GANGNAM_OFFICE));
  });
});

describe('seedProgressFromKv', () => {
  const snapshot = { createdAt: CREATED_AT, waypoints: STORM_ROUTE, routeWaypoints: STORM_ROUTE, lastLaPushAt: NOW - 5_000 };

  it('빈 셀에는 KV 스냅샷으로 시드한다(waypoints/routeWaypoints/스탬프)', () => {
    const r = run(emptyProgressCell(), { type: 'seedProgressFromKv', source: 'overlay', snapshot, epoch: 1 });
    expect(r.outcome).toBe('applied');
    expect(r.cell).toMatchObject({ waypoints: STORM_ROUTE, routeWaypoints: STORM_ROUTE, lastLaPushAt: NOW - 5_000, seededEpoch: 1 });
    expect(r.cell.session.createdAt).toBe(CREATED_AT);
  });

  it('같은 세션·같은 epoch면 noop — 낡은 KV 스냅샷이 셀을 되돌리지 못한다', () => {
    const advanced = seeded([HAKDONG, NONHYEON]);
    const r = run(advanced, { type: 'seedProgressFromKv', source: 'overlay', snapshot, epoch: 1 });
    expect(r.outcome).toBe('noop');
    expect(r.cell.waypoints).toEqual([HAKDONG, NONHYEON]);
  });

  it('epoch가 바뀌면 재시드한다(off 기간 동안 KV에서만 일어난 변화 반영)', () => {
    const r = run(seeded([HAKDONG, NONHYEON]), { type: 'seedProgressFromKv', source: 'overlay', snapshot, epoch: 2 });
    expect(r.outcome).toBe('applied');
    expect(r.cell.waypoints).toEqual(STORM_ROUTE);
    expect(r.cell.seededEpoch).toBe(2);
  });
});

describe('registerProgress', () => {
  const incoming = { createdAt: CREATED_AT, waypoints: STORM_ROUTE, routeWaypoints: STORM_ROUTE };

  it('같은 세션 재등록은 셀 진행을 덮지 않는다 — 낡은 incoming waypoints(강남구청 head)가 되감지 못한다', () => {
    const advanced = seeded([HAKDONG, NONHYEON]);
    const r = run(advanced, { type: 'registerProgress', source: 'register', newSession: false, incoming });
    expect(r.cell.waypoints).toEqual([HAKDONG, NONHYEON]);
  });

  it('같은 세션: incoming promptDisplay가 있으면 채택, 없으면 셀 값 보존', () => {
    const base = seeded(STORM_ROUTE, { promptDisplay: { originStation: '용마산', line: '7' } as ProgressCell['promptDisplay'] });
    const kept = run(base, { type: 'registerProgress', source: 'register', newSession: false, incoming });
    expect(kept.cell.promptDisplay).toEqual({ originStation: '용마산', line: '7' });
    const replaced = run(base, {
      type: 'registerProgress',
      source: 'register',
      newSession: false,
      incoming: { ...incoming, promptDisplay: { originStation: '건대입구', line: '7' } as ProgressCell['promptDisplay'] },
    });
    expect(replaced.cell.promptDisplay).toEqual({ originStation: '건대입구', line: '7' });
  });

  it('새 세션은 incoming으로 전면 재초기화하고 스탬프·anchor를 지운다', () => {
    const dirty = seeded([HAKDONG, NONHYEON], {
      currentLegAnchor: { boardingStation: '건대입구', line: '7' },
      legBoardingEligibleAt: NOW,
      lastLaPushAt: NOW,
      lastTrackedArrivalEpoch: 1,
    });
    const r = run(dirty, {
      type: 'registerProgress',
      source: 'register',
      newSession: true,
      incoming: { ...incoming, createdAt: CREATED_AT + 60_000 },
    });
    expect(r.outcome).toBe('applied');
    expect(r.cell.waypoints).toEqual(STORM_ROUTE);
    expect(r.cell.session.createdAt).toBe(CREATED_AT + 60_000);
    expect(r.cell.currentLegAnchor).toBeUndefined();
    expect(r.cell.legBoardingEligibleAt).toBeUndefined();
    expect(r.cell.lastLaPushAt).toBeUndefined();
    expect(r.cell.lastTrackedArrivalEpoch).toBeUndefined();
  });
});

describe('advanceHead — head 키 선점(claim). 이미 지나간 역은 재소비되지 않는다', () => {
  it('head가 일치하면 count만큼 전진하고 LA·추적 기준값을 리셋한다', () => {
    const cell = seeded(STORM_ROUTE, { lastTrackedArrivalEpoch: 5, lastLaPushEpoch: 6, lastLaPushAt: NOW });
    const r = run(cell, { type: 'advanceHead', source: 'cron', expectedHeadKey: key(GANGNAM_OFFICE), count: 1 });
    expect(r.outcome).toBe('applied');
    expect(r.cell.waypoints).toEqual([HAKDONG, NONHYEON]);
    expect(r.cell.lastTrackedArrivalEpoch).toBeUndefined();
    expect(r.cell.lastLaPushEpoch).toBeUndefined();
    expect(r.cell.lastLaPushAt).toBeUndefined();
    expect(r.cell.rev).toBe(cell.rev + 1);
  });

  it('10/31 storm: 이미 소비한 강남구청 head 키로 다시 advance하면 noop(발사 금지 신호)이고 셀은 그대로다', () => {
    const afterFirst = run(seeded(), { type: 'advanceHead', source: 'cron', expectedHeadKey: key(GANGNAM_OFFICE), count: 1 }).cell;
    const results = Array.from({ length: 3 }, () =>
      run(afterFirst, { type: 'advanceHead', source: 'cron', expectedHeadKey: key(GANGNAM_OFFICE), count: 1 }),
    );
    expect(results.map((r) => r.outcome)).toEqual(['noop', 'noop', 'noop']);
    expect(results.every((r) => r.cell.waypoints.length === 2)).toBe(true);
  });

  it('호출자 시야가 셀보다 앞서면(헤드가 셀 안쪽에 있음) conflict — 셀을 건너뛰어 쓰지 않는다', () => {
    const r = run(seeded(), { type: 'advanceHead', source: 'cron', expectedHeadKey: key(HAKDONG), count: 1 });
    expect(r.outcome).toBe('conflict');
    expect(r.cell.waypoints).toEqual(STORM_ROUTE);
  });

  it('count가 남은 개수를 넘으면 전부 소진한다(destination 소비)', () => {
    const r = run(seeded([NONHYEON]), { type: 'advanceHead', source: 'cron', expectedHeadKey: key(NONHYEON), count: 3 });
    expect(r.outcome).toBe('applied');
    expect(r.cell.waypoints).toEqual([]);
  });

  it('releaseLock: 전진이 applied일 때만 lock 셀에 releaseAuto를 같은 op로 적용한다', () => {
    const lock: BoardingLockMeta = {
      trainCode: '7077',
      line: '7',
      subwayId: '1007',
      selectedDepartureTime: NOW,
      segmentStations: ['용마산', '강남구청', '학동', '논현'],
      expiresAt: NOW + 3_600_000,
    };
    const lockCell = applyLockOp(
      emptyLockCell(),
      { type: 'attachIfNone', source: 't', lock, authority: 'user', expectedRev: 0 },
      NOW,
    ).cell;
    const applied = run(
      seeded(),
      {
        type: 'advanceHead',
        source: 'cron',
        expectedHeadKey: key(GANGNAM_OFFICE),
        count: 1,
        releaseLock: { expectedRev: lockCell.rev, reason: 'transfer' },
      },
      lockCell,
    );
    expect(applied.outcome).toBe('applied');
    expect(applied.lock?.outcome).toBe('applied');
    expect(applied.lock?.cell.lock).toBeUndefined();

    const noop = run(
      applied.cell,
      {
        type: 'advanceHead',
        source: 'cron',
        expectedHeadKey: key(GANGNAM_OFFICE),
        count: 1,
        releaseLock: { expectedRev: lockCell.rev, reason: 'transfer' },
      },
      lockCell,
    );
    expect(noop.outcome).toBe('noop');
    expect(noop.lock).toBeUndefined();
  });

  it('releaseLock rev가 낡으면(그 사이 사용자 부착) 전진은 applied, lock은 conflict로 유지된다', () => {
    const lock: BoardingLockMeta = {
      trainCode: '7077',
      line: '7',
      subwayId: '1007',
      selectedDepartureTime: NOW,
      segmentStations: ['용마산', '강남구청'],
      expiresAt: NOW + 3_600_000,
    };
    const lockCell = applyLockOp(
      emptyLockCell(),
      { type: 'attachIfNone', source: 't', lock, authority: 'user', expectedRev: 0 },
      NOW,
    ).cell;
    const r = run(
      seeded(),
      {
        type: 'advanceHead',
        source: 'cron',
        expectedHeadKey: key(GANGNAM_OFFICE),
        count: 1,
        releaseLock: { expectedRev: lockCell.rev - 1, reason: 'transfer' },
      },
      lockCell,
    );
    expect(r.outcome).toBe('applied');
    expect(r.lock?.outcome).toBe('conflict');
    expect(r.lock?.cell.lock).toBeDefined();
  });
});

describe('userTapAdvance — 앞으로만 이동', () => {
  const anchor = { boardingStation: '건대입구', line: '7' };

  it('toHeadKey가 셀 안쪽(index>0)이면 그 head로 전진하고 anchor를 stamp한다(도보 게이트 즉시 통과)', () => {
    const cell = seeded(STORM_ROUTE, { legResolveStreak: { trainCode: '7077', count: 2 } });
    const r = run(cell, { type: 'userTapAdvance', source: 'confirm', toHeadKey: key(HAKDONG), anchor });
    expect(r.outcome).toBe('applied');
    expect(r.cell.waypoints).toEqual([HAKDONG, NONHYEON]);
    expect(r.cell.currentLegAnchor).toEqual(anchor);
    expect(r.cell.legBoardingEligibleAt).toBe(NOW);
    expect(r.cell.legResolveStreak).toBeUndefined();
  });

  it('낡은 base(탭 시야가 되감긴 head)로는 되감지 않는다 — 셀이 이미 앞이면 noop', () => {
    const ahead = seeded([NONHYEON]);
    const r = run(ahead, { type: 'userTapAdvance', source: 'confirm', toHeadKey: key(HAKDONG), anchor });
    expect(r.outcome).toBe('noop');
    expect(r.cell.waypoints).toEqual([NONHYEON]);
  });

  it('같은 head(index 0)이고 이미 같은 anchor면 noop, anchor가 없으면 stamp만 한다', () => {
    const stamped = seeded(STORM_ROUTE, { currentLegAnchor: anchor, legBoardingEligibleAt: NOW - 1 });
    expect(run(stamped, { type: 'userTapAdvance', source: 'confirm', toHeadKey: key(GANGNAM_OFFICE), anchor }).outcome).toBe('noop');
    const fresh = run(seeded(), { type: 'userTapAdvance', source: 'confirm', toHeadKey: key(GANGNAM_OFFICE), anchor });
    expect(fresh.outcome).toBe('applied');
    expect(fresh.cell.waypoints).toEqual(STORM_ROUTE);
    expect(fresh.cell.currentLegAnchor).toEqual(anchor);
  });
});

describe('setLegAnchor', () => {
  const anchor = { boardingStation: '건대입구', line: '7' };
  it('anchor·도보 게이트를 stamp하고 leg 상태(prompt/streak/promptDisplay)를 함께 리셋한다', () => {
    const cell = seeded(STORM_ROUTE, {
      legBoardingPromptState: { firedAt: 1 } as unknown as ProgressCell['legBoardingPromptState'],
      legResolveStreak: { trainCode: '7077', count: 1 },
      promptDisplay: { originStation: '성수', line: '2' } as ProgressCell['promptDisplay'],
    });
    const r = run(cell, { type: 'setLegAnchor', source: 'cron', anchor, eligibleAt: NOW + 60_000 });
    expect(r.outcome).toBe('applied');
    expect(r.cell).toMatchObject({ currentLegAnchor: anchor, legBoardingEligibleAt: NOW + 60_000 });
    expect(r.cell.legBoardingPromptState).toBeUndefined();
    expect(r.cell.legResolveStreak).toBeUndefined();
    expect(r.cell.promptDisplay).toBeUndefined();
  });
  it('값이 같으면 noop', () => {
    const cell = seeded(STORM_ROUTE, { currentLegAnchor: anchor, legBoardingEligibleAt: NOW + 60_000 });
    expect(run(cell, { type: 'setLegAnchor', source: 'cron', anchor, eligibleAt: NOW + 60_000 }).outcome).toBe('noop');
  });
});

describe('reanchor — lock 셀 segment와 한 번에', () => {
  const lock: BoardingLockMeta = {
    trainCode: '7320',
    line: '7',
    subwayId: '1007',
    selectedDepartureTime: NOW,
    segmentStations: ['건대입구', '군자'],
    expiresAt: NOW + 3_600_000,
  };
  const attach = (): LockCell =>
    applyLockOp(emptyLockCell(), { type: 'attachIfNone', source: 't', lock, authority: 'user', expectedRev: 0 }, NOW).cell;
  const AFTER_LOCKLESS = [wp('군자'), wp('중곡'), wp('용마산', 'destination')];
  const FULL = [wp('어린이대공원(세종대)'), ...AFTER_LOCKLESS];

  it('head·lock rev가 맞으면 waypoints와 segment를 함께 바꾼다', () => {
    const lockCell = attach();
    const r = run(
      seeded(AFTER_LOCKLESS, { routeWaypoints: FULL }),
      {
        type: 'reanchor',
        source: 'cron-reanchor',
        expectedHeadKey: key(AFTER_LOCKLESS[0]),
        waypoints: FULL,
        expectedLockRev: lockCell.rev,
        segmentStations: ['건대입구', '어린이대공원(세종대)', '군자'],
      },
      lockCell,
    );
    expect(r.outcome).toBe('applied');
    expect(r.cell.waypoints).toEqual(FULL);
    expect(r.lock?.cell.lock?.segmentStations).toEqual(['건대입구', '어린이대공원(세종대)', '군자']);
  });

  it('lock rev가 어긋나면 전체를 적용하지 않는다(waypoints만 되감지 않는다)', () => {
    const lockCell = attach();
    const r = run(
      seeded(AFTER_LOCKLESS, { routeWaypoints: FULL }),
      {
        type: 'reanchor',
        source: 'cron-reanchor',
        expectedHeadKey: key(AFTER_LOCKLESS[0]),
        waypoints: FULL,
        expectedLockRev: lockCell.rev + 5,
        segmentStations: ['건대입구', '군자'],
      },
      lockCell,
    );
    expect(r.outcome).toBe('conflict');
    expect(r.cell.waypoints).toEqual(AFTER_LOCKLESS);
    expect(r.lock).toBeUndefined();
  });

  it('head가 이미 바뀌었으면(그 사이 전진) conflict', () => {
    const lockCell = attach();
    const r = run(
      seeded([AFTER_LOCKLESS[1], AFTER_LOCKLESS[2]], { routeWaypoints: FULL }),
      {
        type: 'reanchor',
        source: 'cron-reanchor',
        expectedHeadKey: key(AFTER_LOCKLESS[0]),
        waypoints: FULL,
        expectedLockRev: lockCell.rev,
        segmentStations: ['건대입구', '군자'],
      },
      lockCell,
    );
    expect(r.outcome).toBe('conflict');
  });
});

describe('attachWithFastForward — sync 수동 목록 탭 승격(lock 부착 + 건너뛴 구간 전진)', () => {
  const lock: BoardingLockMeta = {
    trainCode: '7077',
    line: '7',
    subwayId: '1007',
    selectedDepartureTime: NOW,
    segmentStations: ['용마산', '강남구청', '학동', '논현'],
    expiresAt: NOW + 3_600_000,
  };

  it('lock 부착이 applied일 때만 head를 skip만큼 전진하고 기준값을 리셋한다', () => {
    const r = run(
      seeded(STORM_ROUTE, { lastLaPushAt: NOW }),
      { type: 'attachWithFastForward', source: 'sync-promote', lock, expectedLockRev: 0, expectedHeadKey: key(GANGNAM_OFFICE), skip: 1 },
      emptyLockCell(),
    );
    expect(r.outcome).toBe('applied');
    expect(r.lock?.outcome).toBe('applied');
    expect(r.cell.waypoints).toEqual([HAKDONG, NONHYEON]);
    expect(r.cell.lastLaPushAt).toBeUndefined();
  });

  it('셀에 이미 활성 lock이 있으면(noop) 전진도 하지 않는다 — 그 lock이 이긴다', () => {
    const existing = applyLockOp(
      emptyLockCell(),
      { type: 'attachIfNone', source: 't', lock: { ...lock, trainCode: '7000' }, authority: 'user', expectedRev: 0 },
      NOW,
    ).cell;
    const r = run(
      seeded(),
      { type: 'attachWithFastForward', source: 'sync-promote', lock, expectedLockRev: existing.rev, expectedHeadKey: key(GANGNAM_OFFICE), skip: 1 },
      existing,
      NOW,
    );
    expect(r.outcome).toBe('noop');
    expect(r.lock?.outcome).toBe('noop');
    expect(r.cell.waypoints).toEqual(STORM_ROUTE);
  });
});

describe('stampProgress — 허용 필드만, head 스코프 스탬프는 head가 그대로일 때만', () => {
  it('head 스코프 필드(lastLaPush*, lastTrackedArrivalEpoch)는 expectedHeadKey가 일치할 때만 적용', () => {
    const ok = run(seeded(), {
      type: 'stampProgress',
      source: 'cron',
      expectedHeadKey: key(GANGNAM_OFFICE),
      set: { lastLaPushEpoch: 10, lastLaPushAt: NOW, lastTrackedArrivalEpoch: 11 },
    });
    expect(ok.outcome).toBe('applied');
    expect(ok.cell).toMatchObject({ lastLaPushEpoch: 10, lastLaPushAt: NOW, lastTrackedArrivalEpoch: 11 });

    const stale = run(seeded([HAKDONG, NONHYEON]), {
      type: 'stampProgress',
      source: 'cron',
      expectedHeadKey: key(GANGNAM_OFFICE),
      set: { lastLaPushEpoch: 10 },
    });
    expect(stale.outcome).toBe('noop');
    expect(stale.cell.lastLaPushEpoch).toBeUndefined();
  });

  it('leg 스코프 필드(legResolveStreak 등)는 head와 무관하게 적용되고 clear로 지운다', () => {
    const set = run(seeded(), { type: 'stampProgress', source: 'cron', set: { legResolveStreak: { trainCode: '7077', count: 1 } } });
    expect(set.cell.legResolveStreak).toEqual({ trainCode: '7077', count: 1 });
    const cleared = run(set.cell, { type: 'stampProgress', source: 'cron', clear: ['legResolveStreak'] });
    expect(cleared.outcome).toBe('applied');
    expect(cleared.cell.legResolveStreak).toBeUndefined();
  });

  it('transferObservedAt은 더 오래된 관측으로 덮지 않는다(forward-only)', () => {
    const newer = { stationName: '건대입구', line: '2', atMs: NOW };
    const older = { ...newer, atMs: NOW - 60_000 };
    const first = run(seeded(), { type: 'stampProgress', source: 'sync', set: { transferObservedAt: newer } });
    expect(first.cell.transferObservedAt).toEqual(newer);
    const second = run(first.cell, { type: 'stampProgress', source: 'sync', set: { transferObservedAt: older } });
    expect(second.outcome).toBe('noop');
    expect(second.cell.transferObservedAt).toEqual(newer);
  });

  it('변화가 없으면 noop(rev 불변)', () => {
    const cell = seeded(STORM_ROUTE, { lastLaPushAt: NOW });
    const r = run(cell, { type: 'stampProgress', source: 'cron', expectedHeadKey: key(GANGNAM_OFFICE), set: { lastLaPushAt: NOW } });
    expect(r.outcome).toBe('noop');
    expect(r.cell.rev).toBe(cell.rev);
  });
});

describe('applyProgressCell — 메모리 trip에 셀 반영', () => {
  it('waypoints·routeWaypoints·leg 상태·스탬프를 셀 값으로 덮고 입력 trip은 불변', () => {
    const trip = {
      token: 't',
      waypoints: STORM_ROUTE,
      lastLaPushAt: 1,
      currentLegAnchor: { boardingStation: 'x', line: '2' },
    } as unknown as Trip;
    const cell = seeded([HAKDONG, NONHYEON], { lastLaPushAt: undefined, currentLegAnchor: undefined });
    const next = applyProgressCell(trip, cell);
    expect(next.waypoints).toEqual([HAKDONG, NONHYEON]);
    expect(next.lastLaPushAt).toBeUndefined();
    expect(next.currentLegAnchor).toBeUndefined();
    expect(trip.waypoints).toEqual(STORM_ROUTE);
  });
});
