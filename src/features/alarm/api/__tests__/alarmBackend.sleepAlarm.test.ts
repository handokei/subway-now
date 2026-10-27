/**
 * #3100 — 취침 알람 N역 전 설정의 register 송신 (backend `normalizeSleepAlarmConfig(obj.sleepAlarm)` 입력).
 * 재등록은 incoming이 이긴다 → 설정이 바뀌면 hash가 달라져 즉시 재등록되어야 한다.
 */
import { registerActiveTrip, __resetAlarmBackendDedup } from '../alarmBackend';
import type { RegisterTripPayload } from '../alarmBackend';
import { makeDirectRoute } from '../../../../testUtils/routeFixtures';

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const ORIGINAL_FETCH = global.fetch;
const NOW = new Date('2026-05-13T12:00:00Z').getTime();

const BASE_PAYLOAD: RegisterTripPayload = {
  token: 'token-hex',
  route: makeDirectRoute(5, '2'),
  destination: '0228',
  waypoints: [{ stationName: '강남', line: '2', kind: 'destination' }],
  alarmAtEpochMs: NOW + 60000,
  etaWithinPollingWindow: true,
  createdAt: NOW,
  expiresAt: NOW + 1000,
  apnsEnv: 'sandbox',
  sleepModeEnabled: true,
};

function bodyOfCall(index: number): Record<string, unknown> {
  return JSON.parse((global.fetch as jest.Mock).mock.calls[index][1].body);
}

describe('#3100 register payload — sleepAlarm', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    __resetAlarmBackendDedup();
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
    global.fetch = ORIGINAL_FETCH;
  });

  it('sleepAlarm이 있으면 body에 { mode, stops } 그대로 실린다', async () => {
    await registerActiveTrip({ ...BASE_PAYLOAD, sleepAlarm: { mode: 'selected', stops: [3, 1] } });
    expect(bodyOfCall(0).sleepAlarm).toEqual({ mode: 'selected', stops: [3, 1] });
  });

  it('sleepAlarm이 없으면 키 자체가 body에 없다 (기본 사용자 바이트 동일)', async () => {
    await registerActiveTrip(BASE_PAYLOAD);
    expect(Object.prototype.hasOwnProperty.call(bodyOfCall(0), 'sleepAlarm')).toBe(false);
  });

  it('기본 → 비기본 설정 변경은 hash가 달라져 즉시 재등록된다', async () => {
    await registerActiveTrip(BASE_PAYLOAD);
    const second = await registerActiveTrip({ ...BASE_PAYLOAD, sleepAlarm: { mode: 'every', stops: [3] } });
    expect(second.skipped).toBeUndefined();
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(bodyOfCall(1).sleepAlarm).toEqual({ mode: 'every', stops: [3] });
  });

  it('every 3 → selected {3,1} 변경도 재등록 (같은 stops 숫자여도 mode가 hash에 든다)', async () => {
    await registerActiveTrip({ ...BASE_PAYLOAD, sleepAlarm: { mode: 'every', stops: [3] } });
    await registerActiveTrip({ ...BASE_PAYLOAD, sleepAlarm: { mode: 'selected', stops: [3] } });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('같은 설정 재호출은 hash 동일 → skipped', async () => {
    await registerActiveTrip({ ...BASE_PAYLOAD, sleepAlarm: { mode: 'every', stops: [3] } });
    const again = await registerActiveTrip({ ...BASE_PAYLOAD, sleepAlarm: { mode: 'every', stops: [3] } });
    expect(again.skipped).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
