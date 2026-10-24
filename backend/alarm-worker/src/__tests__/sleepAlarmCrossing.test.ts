/**
 * #3100 — `crossingForConsumed` / `readSleepAlarmStops` 순수 함수 table.
 * 남은 정거장 수는 "타깃이 속한 leg 안에서만" 센다 — 앞 leg의 환승역(non-intermediate)에서 끊는다.
 */
import { describe, expect, it } from 'vitest';
import { crossingForConsumed, readSleepAlarmStops } from '../sleepAlarmCrossing';
import type { Trip, Waypoint } from '../types';

const i = (name: string): Waypoint => ({ stationName: name, line: '7', kind: 'intermediate' });
const transfer = (name: string): Waypoint => ({ stationName: name, line: '7', kind: 'transfer' });
const dest = (name: string): Waypoint => ({ stationName: name, line: '2', kind: 'destination' });

describe('crossingForConsumed — 단일 leg [a, b, c, T]', () => {
  const W = [i('a'), i('b'), i('c'), dest('T')];

  it.each([
    // appliedCount, to, from
    [1, 3, 4], // cron 1칸 전진(q=0): 정확히 to == from-1
    [2, 2, 4], // 2역 점프: 3역 전을 걸쳐 지남
    [3, 1, 4], // 3역 점프: 3,2,1을 걸침
  ])('appliedCount %i -> to %i, from %i, 타깃 T', (appliedCount, toRemaining, fromRemaining) => {
    expect(crossingForConsumed(W, appliedCount)).toEqual({
      target: W[3],
      crossing: { fromRemaining, toRemaining },
    });
  });

  it('마지막 소비가 타깃 자신(appliedCount=4)이면 이미 도착한 쌍 — 없음', () => {
    expect(crossingForConsumed(W, 4)).toBeUndefined();
  });

  it('appliedCount=0이면 waypoints 접근 없이 없음', () => {
    expect(crossingForConsumed(W, 0)).toBeUndefined();
    expect(crossingForConsumed([], 0)).toBeUndefined();
  });

  it('소비 개수가 waypoints보다 많으면 없음', () => {
    expect(crossingForConsumed(W, 9)).toBeUndefined();
  });

  it('타깃이 없는(전부 intermediate) 목록은 없음', () => {
    expect(crossingForConsumed([i('a'), i('b')], 1)).toBeUndefined();
  });
});

describe('crossingForConsumed — requestedCount: 요청한 소비 구간 안의 타깃은 이미 도착한 쌍', () => {
  const W = [i('a'), i('b'), i('c'), dest('T')];

  it('applied 1 / requested 4(타깃 포함) -> 타깃 인덱스 3 < 4 -> 없음', () => {
    expect(crossingForConsumed(W, 1, 4)).toBeUndefined();
  });

  it('applied 2 / requested 4 -> 없음 (중단 경로: 타깃 소비가 중단됐어도 도착으로 본다)', () => {
    expect(crossingForConsumed(W, 2, 4)).toBeUndefined();
  });

  it('applied 3 / requested 3(타깃은 요청 밖) -> 정상', () => {
    expect(crossingForConsumed(W, 3, 3)).toEqual({ target: W[3], crossing: { fromRemaining: 4, toRemaining: 1 } });
  });

  it('requested 생략 = applied (기존 sync 규칙: 타깃이 소비 구간 밖일 때만)', () => {
    expect(crossingForConsumed(W, 3)).toEqual(crossingForConsumed(W, 3, 3));
  });
});

describe('crossingForConsumed — 환승 포함 [a, T1(환승), b, c, T2(하차)]', () => {
  const W = [i('a'), transfer('T1'), i('b'), i('c'), dest('T2')];

  it('첫 leg: appliedCount 1 -> T1까지 1', () => {
    expect(crossingForConsumed(W, 1)).toEqual({ target: W[1], crossing: { fromRemaining: 2, toRemaining: 1 } });
  });

  it('환승역 자신이 마지막 소비(appliedCount 2)면 없음', () => {
    expect(crossingForConsumed(W, 2)).toBeUndefined();
  });

  it('둘째 leg: 환승역 뒤부터 센다 — appliedCount 3(q=b) -> T2까지 2, from은 환승역에서 끊김(3)', () => {
    expect(crossingForConsumed(W, 3)).toEqual({ target: W[4], crossing: { fromRemaining: 3, toRemaining: 2 } });
  });

  it('둘째 leg 마지막 직전(appliedCount 4) -> 1', () => {
    expect(crossingForConsumed(W, 4)).toEqual({ target: W[4], crossing: { fromRemaining: 2, toRemaining: 1 } });
  });
});

describe('readSleepAlarmStops — 설정은 취침 ON일 때만', () => {
  const base = (over: Partial<Trip>): Trip => ({ token: 't', waypoints: [], ...over }) as unknown as Trip;

  it('설정 없음 -> [MIN]', () => {
    expect(readSleepAlarmStops(base({ sleepModeEnabled: true }))).toEqual([1]);
  });

  it('취침 ON + 매 역 3 -> [3,2,1]', () => {
    expect(readSleepAlarmStops(base({ sleepModeEnabled: true, sleepAlarm: { mode: 'every', stops: [3] } }))).toEqual([3, 2, 1]);
  });

  it('취침 ON + 선택 {3,1} -> [3,1]', () => {
    expect(readSleepAlarmStops(base({ sleepModeEnabled: true, sleepAlarm: { mode: 'selected', stops: [3, 1] } }))).toEqual([3, 1]);
  });

  it.each([false, undefined])('취침 %s + 설정 있음 -> 설정 무시 [MIN]', (sleepModeEnabled) => {
    expect(readSleepAlarmStops(base({ sleepModeEnabled, sleepAlarm: { mode: 'every', stops: [3] } }))).toEqual([1]);
  });
});
