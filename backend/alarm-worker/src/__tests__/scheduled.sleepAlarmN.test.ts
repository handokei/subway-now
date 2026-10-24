/**
 * #3100 PR-1 — 취침 알람 "N역 전부터" (cron 발사 경로). 상수 원본(MAX=3)에서 table 전체를 돌린다.
 * 같은 table의 MAX=4 변형은 `scheduled.sleepAlarmN.max4.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { evaluateSleepAlarmTrigger, sleepAlarmFireKey } from '../scheduled';
import { makeTrip, useApnsHarness, wp } from './helpers/sleepAlarmHarness';
import { registerSleepAlarmNTable } from './helpers/sleepAlarmNTable';

useApnsHarness();
registerSleepAlarmNTable();

describe('sleepAlarmFireKey — 칸별 dedup 키 (#3100)', () => {
  it('기본 칸(1역 전)은 인자 생략과 바이트 동일, 비기본 칸은 :s{N} 접미', () => {
    expect(sleepAlarmFireKey('tok', '건대입구', 1)).toBe(sleepAlarmFireKey('tok', '건대입구'));
    expect(sleepAlarmFireKey('tok', '건대입구', 1)).toBe('alarmFireKey:tok:건대입구');
    expect(sleepAlarmFireKey('tok', '건대입구', 2)).toBe('alarmFireKey:tok:건대입구:s2');
    expect(sleepAlarmFireKey('tok', '건대입구', 3)).toBe('alarmFireKey:tok:건대입구:s3');
  });
});

describe('evaluateSleepAlarmTrigger — crossing 인자 (#3100)', () => {
  const waypoint = wp('군자', 'intermediate');
  const target = wp('건대입구', 'transfer');
  const trip = makeTrip([waypoint, wp('어린이대공원', 'intermediate'), target], { sleepAlarm: { mode: 'every', stops: [3] } });

  it('crossing 생략 = 직전 역 1칸 전진 -> 기본 칸(1)만 걸린다 (현행 동작)', () => {
    const adjacent = makeTrip([waypoint, target], { sleepAlarm: { mode: 'every', stops: [3] } });
    expect(evaluateSleepAlarmTrigger(adjacent, waypoint, target)).toEqual({ fire: true, target, remaining: 1 });
  });

  it('crossing 지정 시 실제 남은 수로 발사', () => {
    expect(evaluateSleepAlarmTrigger(trip, waypoint, target, { fromRemaining: 3, toRemaining: 2 })).toEqual({
      fire: true,
      target,
      remaining: 2,
    });
  });

  it('칸에 걸리지 않으면 not-preceding', () => {
    const only1 = makeTrip([waypoint, target], { sleepAlarm: undefined });
    expect(evaluateSleepAlarmTrigger(only1, waypoint, target, { fromRemaining: 3, toRemaining: 2 })).toEqual({
      fire: false,
      reason: 'not-preceding',
    });
  });

  it('취침 OFF면 설정이 있어도 not-sleep', () => {
    const off = makeTrip([waypoint, target], { sleepModeEnabled: false, sleepAlarm: { mode: 'every', stops: [3] } });
    expect(evaluateSleepAlarmTrigger(off, waypoint, target, { fromRemaining: 3, toRemaining: 2 })).toEqual({
      fire: false,
      reason: 'not-sleep',
    });
  });
});
