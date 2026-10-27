/**
 * #3100 PR-3+4 golden — 기본 사용자(취침 알람 N역 전 설정 없음)의 register body / dedup hash는
 * 이 PR 전후로 바이트 동일해야 한다. 변경 전 구현에서 통과하는 값으로 고정한다.
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
};

function lastBody(): Record<string, unknown> {
  const calls = (global.fetch as jest.Mock).mock.calls;
  return JSON.parse(calls[calls.length - 1][1].body);
}

describe('#3100 golden — 기본 설정 register body / hash 바이트 동일', () => {
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

  it('취침 OFF 기본 body의 키 집합 (sleepAlarm 없음)', async () => {
    await registerActiveTrip(BASE_PAYLOAD);
    expect(Object.keys(lastBody()).sort()).toEqual(
      ['alarmAtEpochMs', 'apnsEnv', 'corrId', 'createdAt', 'destination', 'expiresAt', 'route', 'token', 'waypoints'].sort(),
    );
  });

  it('취침 ON 기본 body의 키 집합 = 취침 OFF 키 + sleepModeEnabled 하나', async () => {
    await registerActiveTrip({ ...BASE_PAYLOAD, sleepModeEnabled: true });
    const body = lastBody();
    expect(Object.keys(body).sort()).toEqual(
      [
        'alarmAtEpochMs',
        'apnsEnv',
        'corrId',
        'createdAt',
        'destination',
        'expiresAt',
        'route',
        'sleepModeEnabled',
        'token',
        'waypoints',
      ].sort(),
    );
    expect(body.sleepModeEnabled).toBe(true);
  });

  it('같은 기본 payload 재호출은 hash 동일 → 두 번째는 skipped', async () => {
    const first = await registerActiveTrip({ ...BASE_PAYLOAD, sleepModeEnabled: true });
    const second = await registerActiveTrip({ ...BASE_PAYLOAD, sleepModeEnabled: true });
    expect(first.skipped).toBeUndefined();
    expect(second.skipped).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
