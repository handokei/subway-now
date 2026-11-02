/**
 * #2510 재오픈 (2026-11-02) — 모드 × 역 alert 종류 → {발사 여부, sound, interruption-level} 정책 표.
 * 문구가 아니라 실제 APNs 요청(aps.sound / interruption-level / apns-collapse-id)으로 검증한다.
 * 일반(비취침) 모드의 alarm.wav는 어떤 행에도 없어야 한다.
 */
import { describe, expect, it } from 'vitest';
import {
  STATION_ALERT_POLICY,
  resolveStationAlert,
  sendStationAlert,
  stationAlertKind,
  tripMode,
  type ArrivalContent,
  type OneStopContent,
  type StationAlertKind,
} from '../alertSoundPolicy';
import { captureFetch, getApnsConfig, useApnsHarness } from './helpers/sleepAlarmHarness';

useApnsHarness();

const SLEEP = { sleepModeEnabled: true };
const NORMAL = { sleepModeEnabled: undefined };
const NORMAL_FALSE = { sleepModeEnabled: false };
const ALL_KINDS: StationAlertKind[] = ['one-stop', 'arrival-transfer', 'arrival-destination', 'arrival-intermediate'];

describe('tripMode / stationAlertKind', () => {
  it('sleepModeEnabled===true만 sleep, undefined/false는 normal', () => {
    expect(tripMode(SLEEP)).toBe('sleep');
    expect(tripMode(NORMAL)).toBe('normal');
    expect(tripMode(NORMAL_FALSE)).toBe('normal');
  });

  it('waypoint kind × 시점 → 정책 kind (모든 조합)', () => {
    expect(stationAlertKind('transfer', 'one-stop')).toBe('one-stop');
    expect(stationAlertKind('destination', 'one-stop')).toBe('one-stop');
    expect(stationAlertKind('transfer', 'arrival')).toBe('arrival-transfer');
    expect(stationAlertKind('destination', 'arrival')).toBe('arrival-destination');
    expect(stationAlertKind('intermediate', 'arrival')).toBe('arrival-intermediate');
  });
});

describe('정책 표 값 (D1 기본 S = 무음 배너 + active)', () => {
  it('취침: 1역 전·환승·하차 도착 = alarm.wav + time-sensitive, 매역 = 발사 안 함', () => {
    const alarm = { fires: true, sound: 'alarm.wav', interruptionLevel: 'time-sensitive' };
    expect(STATION_ALERT_POLICY.sleep['one-stop']).toEqual(alarm);
    expect(STATION_ALERT_POLICY.sleep['arrival-transfer']).toEqual(alarm);
    expect(STATION_ALERT_POLICY.sleep['arrival-destination']).toEqual(alarm);
    expect(STATION_ALERT_POLICY.sleep['arrival-intermediate']).toEqual({ fires: false });
  });

  it('일반: 1역 전 = 발사 안 함, 환승·하차·매역 도착 = sound null + active (alarm.wav 0)', () => {
    expect(STATION_ALERT_POLICY.normal['one-stop']).toEqual({ fires: false });
    for (const kind of ['arrival-transfer', 'arrival-destination', 'arrival-intermediate'] as const) {
      expect(STATION_ALERT_POLICY.normal[kind]).toEqual({ fires: true, sound: null, interruptionLevel: 'active' });
    }
  });

  it('일반 행 어디에도 alarm.wav / time-sensitive 가 없다', () => {
    for (const kind of ALL_KINDS) {
      const row = resolveStationAlert(NORMAL, kind);
      if (!row.fires) continue;
      expect(row.sound).not.toBe('alarm.wav');
      expect(row.interruptionLevel).not.toBe('time-sensitive');
    }
  });

  it('resolveStationAlert는 모드 행을 그대로 돌려준다', () => {
    expect(resolveStationAlert(SLEEP, 'one-stop')).toBe(STATION_ALERT_POLICY.sleep['one-stop']);
    expect(resolveStationAlert(NORMAL, 'one-stop')).toBe(STATION_ALERT_POLICY.normal['one-stop']);
  });
});

describe('sendStationAlert — 실제 APNs 요청', () => {
  const base = () => {
    const { calls, fetchImpl } = captureFetch();
    return {
      calls,
      options: {
        deviceToken: 'ab'.repeat(32),
        pushId: 'p1',
        tripToken: 'trip-1',
        collapseId: 'cid-1',
        config: getApnsConfig(),
        host: 'api.push.apple.com',
        fetchImpl,
        now: 1_700_000_000_000,
      },
    };
  };
  const oneStop = { title: 't', body: 'b' } as OneStopContent;
  const arrival = { title: 't', body: 'b' } as ArrivalContent;

  it('취침 1역 전 → aps.sound alarm.wav + interruption-level time-sensitive + collapse-id', async () => {
    const { calls, options } = base();
    const result = await sendStationAlert(SLEEP, 'one-stop', oneStop, options);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const aps = calls[0].body.aps as Record<string, unknown>;
    expect(aps.sound).toBe('alarm.wav');
    expect(aps['interruption-level']).toBe('time-sensitive');
    expect(calls[0].pushType).toBe('alert');
    expect(calls[0].collapseId).toBe('cid-1');
  });

  it('일반 환승 도착 → aps.sound 키 부재 + active', async () => {
    const { calls, options } = base();
    await sendStationAlert(NORMAL, 'arrival-transfer', arrival, options);
    const aps = calls[0].body.aps as Record<string, unknown>;
    expect('sound' in aps).toBe(false);
    expect(aps['interruption-level']).toBe('active');
  });

  it('정책 off 행은 APNs 요청을 만들지 않고 throw (호출부 게이트 누락 = 프로그래밍 오류)', async () => {
    const { calls, options } = base();
    await expect(sendStationAlert(NORMAL, 'one-stop', oneStop, options)).rejects.toThrow(/policy-off/);
    await expect(sendStationAlert(SLEEP, 'arrival-intermediate', arrival, options)).rejects.toThrow(/policy-off/);
    expect(calls).toEqual([]);
  });
});
