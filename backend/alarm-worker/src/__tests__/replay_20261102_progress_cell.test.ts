/**
 * #3055 / #3300 옵션 D PR-4b — 11/02 lockless 점프 + leg-2 lock(7320) replay를 **진행 셀 권위**로 재생한다(cron 맞춤 off).
 *
 * 사고·입력은 `replay_20261102_lockless_jump_leg2.test.ts` 헤더 그대로(불변 실측: R2 18 cycle + D1 1956~2021).
 * 이 파일은 `reconcileTripWithProgress`를 항상 null로 대체해 progress KV 맞춤을 끄고, 단계 flag만 바꿔 같은 단언을 건다:
 *  - 어린이대공원·군자가 lock 7320 트립에서 사라지지 않는다(lock 전 재등록이 군자를 건너뛰지 않고, lock 부착 때 reanchor가 복원).
 *  - progress@1은 진행 위치를 DO가 갖는다 -> progress KV(`progress:<token>`)는 더 이상 쓰이지 않는다(퇴역). lock@1은 계속 쓴다(롤백 경로).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { latestTrip } from './helpers/progressAuthorityReplay';
import { firedStationOccurrences } from './helpers/pushAssertions';
import { useApnsHarness } from './helpers/sleepAlarmHarness';
import {
  alertTicks,
  FIRST_TICK_WITH_ARRIVAL,
  kst,
  LEG2_SEGMENT,
  replayLeg2,
  tickIndexOf,
  TOKEN,
  type Leg2,
} from './helpers/jumpReplay20261102';

vi.mock('../progress', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../progress')>()),
  reconcileTripWithProgress: () => null,
}));

useApnsHarness();
afterEach(() => vi.unstubAllGlobals());

describe.each(['lock@1', 'progress@1'] as const)('#3055 PR-4b 11/02 leg-2 — 맞춤 off · %s', (cells) => {
  it('전제: 탑승 탭이 열차 7320을 해소해 lock을 붙인다', async () => {
    const r = await replayLeg2({ registers: true, cells });
    expect(r.taps.map((t) => t.response.resolvedTrainCode)).toEqual(['7320', '7320']);
    expect(latestTrip(r.kv, TOKEN)?.boardingLock?.trainCode).toBe('7320');
  });

  it('lock 전 구간: 재등록(19:50:18)이 군자를 건너뛰지 않는다 — head는 군자 그대로 lock 부착 tick까지 유지', async () => {
    const r = await replayLeg2({ registers: true, cells });
    const lockTick = tickIndexOf(r, '19:54:4');
    expect(r.headsAfterTick.slice(0, lockTick + 1)).toEqual(Array(lockTick + 1).fill('군자(능동)'));
  });

  it.each(Object.entries(FIRST_TICK_WITH_ARRIVAL))('%s 매역 alert push는 열차 도착을 처음 볼 수 있는 tick 이하에서 정확히 1건', async (station, tickPrefix) => {
    const r = await replayLeg2({ registers: true, cells });
    const limit = tickIndexOf(r, tickPrefix);
    const ticks = alertTicks(r, station);
    expect({ count: ticks.length, withinLimit: ticks.every((t) => t <= kst(r.result.cycles[limit].simNowMs)) }).toEqual({ count: 1, withinLimit: true });
  });

  it('lock 7320의 segmentStations·waypoints에 어린이대공원·군자가 복원된다 (D1 lock-reanchor 정확히 1행)', async () => {
    const r = await replayLeg2({ registers: true, cells });
    const reanchors = r.events.filter((e) => e.kind === 'lock-reanchor');
    expect(reanchors).toHaveLength(1);
    expect(reanchors[0].meta).toMatchObject({ trainCode: '7320' });
    expect(latestTrip(r.kv, TOKEN)?.boardingLock?.segmentStations ?? []).toEqual(LEG2_SEGMENT);
  });

  it('재등록 주입 있음/없음 두 실행의 lock 이후 매역 alert 시퀀스가 같다', async () => {
    const withRegisters = await replayLeg2({ registers: true, cells });
    const control = await replayLeg2({ registers: false, cells });
    const sequence = (r: Leg2) => r.result.cycles.flatMap((c) => firedStationOccurrences(c.pushes).map((name) => `${kst(c.simNowMs)} ${name}`));
    expect(sequence(withRegisters)).toEqual(sequence(control));
  });
});

describe('#3055 PR-4b 11/02 leg-2 — progress KV 퇴역', () => {
  it('progress@1: 어느 tick에서도 progress KV가 쓰이지 않는다 (진행 위치 권위 = DO 셀)', async () => {
    const r = await replayLeg2({ registers: true, cells: 'progress@1' });
    expect(r.progressAfterTick.every((p) => p === null)).toBe(true);
  });

  it('lock@1(롤백 경로): lock 부착 뒤 progress KV가 계속 mirror된다', async () => {
    const r = await replayLeg2({ registers: true, cells: 'lock@1' });
    expect(r.progressAfterTick.some((p) => p !== null)).toBe(true);
  });
});
