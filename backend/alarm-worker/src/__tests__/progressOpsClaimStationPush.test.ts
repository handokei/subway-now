/**
 * #3055 PR-5 — `claimStationPush` op(진행 셀): 이 head의 매역 push를 역당 1회 선점한다.
 * 입력 노선은 10/31 storm 실측(강남구청 -> 학동 -> 논현, replay_20261031_reregister_storm).
 */
import { describe, expect, it } from 'vitest';
import { applyProgressOp, emptyProgressCell, type ProgressCell, type ProgressOp } from '../progressOps';
import { waypointSignatureKey } from '../trips';
import type { Waypoint } from '../types';

const NOW = 1_793_408_140_000;
const wp = (stationName: string, kind: Waypoint['kind'] = 'intermediate'): Waypoint => ({ stationName, line: '7', kind }) as Waypoint;
const ROUTE = [wp('강남구청'), wp('학동'), wp('논현', 'destination')];
const [HEAD, NEXT] = ROUTE;
const key = waypointSignatureKey;

const seeded = (waypoints: Waypoint[] = ROUTE): ProgressCell => ({
  ...emptyProgressCell(),
  session: { createdAt: NOW - 1000 },
  waypoints,
  routeWaypoints: waypoints,
  seededEpoch: 1,
});
const claim = (cell: ProgressCell, expectedHeadKey: string) =>
  applyProgressOp(cell, null, { type: 'claimStationPush', source: 'cron', expectedHeadKey } as ProgressOp, NOW);

describe('claimStationPush', () => {
  it('head가 맞고 아직 선점 전이면 applied — head·rev는 그대로(전진이 아니다)', () => {
    const cell = seeded();
    const r = claim(cell, key(HEAD));
    expect(r.outcome).toBe('applied');
    expect(r.cell.waypoints).toEqual(ROUTE);
    expect(r.cell.rev).toBe(cell.rev);
  });

  it('같은 head를 두 번째로 선점하면 noop (역당 1회)', () => {
    const first = claim(seeded(), key(HEAD));
    expect(claim(first.cell, key(HEAD)).outcome).toBe('noop');
  });

  it('이미 지나간 head(셀이 앞섬)는 noop, 셀보다 앞선 시야(index>0)는 conflict', () => {
    const advanced = seeded([NEXT, ROUTE[2]]);
    expect(claim(advanced, key(HEAD)).outcome).toBe('noop');
    expect(claim(seeded(), key(NEXT)).outcome).toBe('conflict');
  });

  it('선점 표식은 head가 바뀌면 무효 — 다음 역은 다시 선점할 수 있다', () => {
    const claimed = claim(seeded(), key(HEAD)).cell;
    const afterAdvance = applyProgressOp(claimed, null, { type: 'advanceHead', source: 'cron', expectedHeadKey: key(HEAD), count: 1 }, NOW).cell;
    expect(claim(afterAdvance, key(NEXT)).outcome).toBe('applied');
  });

  it('새 세션 register는 선점 표식을 지운다 (같은 head 서명이어도 새 세션은 선점 가능)', () => {
    const claimed = claim(seeded(), key(HEAD)).cell;
    const reset = applyProgressOp(
      claimed,
      null,
      { type: 'registerProgress', source: 'register', newSession: true, incoming: { createdAt: NOW, waypoints: ROUTE } },
      NOW,
    ).cell;
    expect(claim(reset, key(HEAD)).outcome).toBe('applied');
  });
});
