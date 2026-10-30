/**
 * #3221 PR-4 — register body의 laClient(여정/탑승 LA 분리 capability) + boardingPushToStartToken 송신.
 * backend(#3238)가 수용하는 필드다. 토큰 회전은 hash에 들어가 즉시 재등록되어야 하고(드문 putTrip 1회),
 * 필드가 없는 기존 사용자(Android/구 build)는 body·hash가 바이트 동일해야 한다.
 */
import { registerActiveTrip, __resetAlarmBackendDedup } from '../alarmBackend';
import type { RegisterTripPayload } from '../alarmBackend';
import { makeDirectRoute } from '../../../../testUtils/routeFixtures';

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const ORIGINAL_FETCH = global.fetch;
const NOW = new Date('2026-10-28T06:27:00Z').getTime();

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

const PUSH_TO_START = { split: true as const, boardingStart: 'push-to-start' as const };

function bodyOfCall(index: number): Record<string, unknown> {
  return JSON.parse((global.fetch as jest.Mock).mock.calls[index][1].body);
}

describe('#3221 register payload — laClient / boardingPushToStartToken', () => {
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

  it('laClient + token이 body에 그대로 실린다', async () => {
    await registerActiveTrip({
      ...BASE_PAYLOAD,
      laClient: PUSH_TO_START,
      boardingPushToStartToken: 'p2s-token-1',
    });
    const body = bodyOfCall(0);
    expect(body.laClient).toEqual(PUSH_TO_START);
    expect(body.boardingPushToStartToken).toBe('p2s-token-1');
  });

  it('fg-only는 token 없이 laClient만 싣는다', async () => {
    await registerActiveTrip({ ...BASE_PAYLOAD, laClient: { split: true, boardingStart: 'fg-only' } });
    const body = bodyOfCall(0);
    expect(body.laClient).toEqual({ split: true, boardingStart: 'fg-only' });
    expect(Object.prototype.hasOwnProperty.call(body, 'boardingPushToStartToken')).toBe(false);
  });

  it('필드가 없으면 키 자체가 body에 없다 (Android/구 build 바이트 동일)', async () => {
    await registerActiveTrip(BASE_PAYLOAD);
    const body = bodyOfCall(0);
    expect(Object.prototype.hasOwnProperty.call(body, 'laClient')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body, 'boardingPushToStartToken')).toBe(false);
  });

  it('token 회전(값 변경)은 hash가 달라져 즉시 재등록된다', async () => {
    await registerActiveTrip({ ...BASE_PAYLOAD, laClient: PUSH_TO_START, boardingPushToStartToken: 't1' });
    const second = await registerActiveTrip({
      ...BASE_PAYLOAD,
      laClient: PUSH_TO_START,
      boardingPushToStartToken: 't2',
    });
    expect(second.skipped).toBeUndefined();
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(bodyOfCall(1).boardingPushToStartToken).toBe('t2');
  });

  it('token 최초 발급(없음 -> 있음)도 재등록된다', async () => {
    await registerActiveTrip({ ...BASE_PAYLOAD, laClient: PUSH_TO_START });
    await registerActiveTrip({ ...BASE_PAYLOAD, laClient: PUSH_TO_START, boardingPushToStartToken: 't1' });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('laClient.boardingStart 변경(예: LA 설정 OFF)도 재등록된다', async () => {
    await registerActiveTrip({ ...BASE_PAYLOAD, laClient: PUSH_TO_START, boardingPushToStartToken: 't1' });
    await registerActiveTrip({ ...BASE_PAYLOAD, laClient: { split: true, boardingStart: 'none' } });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('같은 값 재호출은 hash 동일 -> skipped (KV 쓰기 증가 없음)', async () => {
    const payload = { ...BASE_PAYLOAD, laClient: PUSH_TO_START, boardingPushToStartToken: 't1' };
    await registerActiveTrip(payload);
    const again = await registerActiveTrip({ ...payload });
    expect(again.skipped).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
