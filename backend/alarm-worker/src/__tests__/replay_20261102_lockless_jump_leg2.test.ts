/**
 * #2308 PR-2 — 2026-11-02 19:44~20:02 트립(토큰 해시 b00dd879, 뚝섬 -> 건대입구 환승 -> 용마산, leg-2 lock 7320) whole-trip replay.
 *
 * 사고(두 겹): leg-2 lock(19:54:57)이 붙기 전에
 *   ⓐ lockless cron이 어린이대공원을 소비해 head를 군자로 당겼고(D1 1984 prepare-alarm `no-lock`, 19:49:45),
 *   ⓑ 같은 세션 재등록(19:50:18)이 lockless progress를 hopIndex로 적용해 군자를 건너뛰었다(D1 1985 head 군자 -> 1987 head 중곡,
 *      그 사이 cron·sync 행 없음. device waypoints에는 hopIndex가 없어 backend `validateTrip`이 배열 위치로 다시 매기기 때문).
 *   그래서 lock 7320의 segmentStations·waypoints에 어린이대공원·군자가 없었고, 열차 7320이 두 역에 도착했는데(R2:
 *   19:55:53 어대 / 19:57:54 군자) 매역 알림이 0건이었다(D1 1996~2020 사이 cron-fire-attempt 0행). ADR-042 결정 1 위반.
 *
 * 입력은 불변 실측 — `fixtures/replay_20261102_lockless_jump_leg2/`:
 *   - caps/*.json : R2 seoul-capture 18 cycle (19:44:45~20:01:45, R2 원문과 byte 동일).
 *   - events.json : D1 trip_events 1956~2021 원문. 재등록(trip-register)·동기화(sync-received)·탑승 탭(boarding-confirm-result)을
 *     원래 시각 순서대로 주입한다(createDeviceReplayer). 통과시키려 조정 금지.
 * 재생 시작 상태는 D1 1982(19:49:28)의 backend 진행분(head 어린이대공원)이다. leg-1(2호선 lock 3368)·환승(건대입구) 구간은
 * 이 사고의 기전 밖이라 재생하지 않는다.
 *
 * 합성 입력(정직 표기): R2에는 device motion이 없다. lockless 소비(D1 1984)가 일어났다는 사실이 motion 게이트 통과(walking/automotive)를
 * 증명하므로, 환승 도보 중(19:46:40~19:49:40) walking, 승강장 대기 중(19:50:10~19:55:10) stationary 시리즈를 합성했다.
 * (stationary 구간은 실제로 19:50~19:54:57 사이 lockless 소비가 D1에 0건이라는 사실과 일치한다.)
 *
 * assert는 실제로 나간 APNs 요청(종류·tick·횟수) 기준이다.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { latestTrip } from './helpers/progressAuthorityReplay';
import { firedStationOccurrences } from './helpers/pushAssertions';
import { useApnsHarness } from './helpers/sleepAlarmHarness';
import {
  alertTicks,
  FIRST_TICK_WITH_ARRIVAL,
  type Leg2,
  HEAD_AFTER_LOCKLESS,
  kst,
  LEG2_SEGMENT,
  replayLeg2,
  tickIndexOf,
  TOKEN,
} from './helpers/jumpReplay20261102';

useApnsHarness();
afterEach(() => vi.unstubAllGlobals());

describe('#2308 11/02 lockless 점프 + lock 전 전진이 lock 트립 역을 지움 — leg-2 lock 7320', () => {
  it.each([
    ['재등록 주입(D1 실측 15회)', true],
    ['재등록 없음(대조)', false],
  ])('%s: 탑승 탭이 열차 7320을 해소해 lock을 붙인다 (사슬 전제)', async (_label, registers) => {
    const r = await replayLeg2({ registers });
    expect(r.taps.map((t) => t.response.resolvedTrainCode)).toEqual(['7320', '7320']);
    expect(latestTrip(r.kv, TOKEN)?.boardingLock?.trainCode).toBe('7320');
  });

  it('lock 전 구간: 재등록(19:50:18)이 군자를 건너뛰지 않는다 — head는 군자 그대로 lock 부착 tick까지 유지', async () => {
    const r = await replayLeg2({ registers: true });
    const lockTick = tickIndexOf(r, '19:54:4');
    expect(r.headsAfterTick.slice(0, lockTick + 1)).toEqual(Array(lockTick + 1).fill('군자(능동)'));
  });

  it.each(Object.entries(FIRST_TICK_WITH_ARRIVAL))(
    '%s 매역 alert push는 열차 도착을 처음 볼 수 있는 tick 이하에서 정확히 1건',
    async (station, tickPrefix) => {
      const r = await replayLeg2({ registers: true });
      const limit = tickIndexOf(r, tickPrefix);
      const ticks = alertTicks(r, station);
      expect({ count: ticks.length, withinLimit: ticks.every((t) => t <= kst(r.result.cycles[limit].simNowMs)) }).toEqual({
        count: 1,
        withinLimit: true,
      });
    },
  );

  it('lock 7320의 segmentStations·waypoints에 탑승역 다음 역(어린이대공원·군자)이 복원된다 (D1 lock-reanchor 정확히 1행)', async () => {
    const r = await replayLeg2({ registers: true });
    const reanchors = r.events.filter((e) => e.kind === 'lock-reanchor');
    expect(reanchors).toHaveLength(1);
    expect(reanchors[0].meta).toMatchObject({ trainCode: '7320' });
    const segment = latestTrip(r.kv, TOKEN)?.boardingLock?.segmentStations ?? [];
    expect(segment).toEqual(LEG2_SEGMENT);
  });

  it('재등록 주입 있음/없음 두 실행의 lock 이후 매역 alert 시퀀스가 같다 (재등록이 발사를 바꾸지 못한다)', async () => {
    const withRegisters = await replayLeg2({ registers: true });
    const control = await replayLeg2({ registers: false });
    const sequence = (r: Leg2) => r.result.cycles.flatMap((c) => firedStationOccurrences(c.pushes).map((name) => `${kst(c.simNowMs)} ${name}`));
    expect(sequence(withRegisters)).toEqual(sequence(control));
  });

  it('lockless progress는 더 이상 쓰이지 않는다 (mirrorLocklessProgress 제거): lockless 전진 직후 progress 키가 없다', async () => {
    const r = await replayLeg2({ registers: false });
    expect(r.headsAfterTick[0]).toBe(HEAD_AFTER_LOCKLESS); // 전제: lockless 전진이 실제로 일어났다
    expect(r.progressAfterTick[0]).toBeNull();
  });

  it('전제: lockless cron은 lock 전에 어린이대공원을 실제로 소비한다 (이 PR이 막는 것은 소비 자체가 아니라 lock 트립으로의 누수)', async () => {
    const r = await replayLeg2({ registers: false });
    expect(r.headsAfterTick[0]).toBe(HEAD_AFTER_LOCKLESS);
  });
});
