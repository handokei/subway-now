import {
  registerActiveTrip,
  clearActiveTrip,
  sendPushAck,
  registerLiveActivityToken,
  clearLiveActivityToken,
  __resetAlarmBackendDedup,
} from '../alarmBackend';
import type { RegisterTripPayload } from '../alarmBackend';
import { makeDirectRoute } from '../../testUtils/routeFixtures';

jest.mock('../../utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const ORIGINAL_FETCH = global.fetch;
const NOW = new Date('2026-05-13T12:00:00Z').getTime();

const SAMPLE_PAYLOAD: RegisterTripPayload = {
  token: 'token-hex',
  route: makeDirectRoute(5, '2'),
  destination: '0228',
  waypoints: [{ stationName: '강남', line: '2', kind: 'destination' }],
  alarmAtEpochMs: NOW + 60000,
  createdAt: NOW,
  expiresAt: NOW + 1000,
  apnsEnv: 'sandbox',
};

describe('alarmBackend', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    delete process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
    global.fetch = jest.fn();
    __resetAlarmBackendDedup();
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = ORIGINAL_FETCH;
  });

  describe('registerActiveTrip', () => {
    it('URL 미설정 시 skipped=true 반환', async () => {
      const result = await registerActiveTrip(SAMPLE_PAYLOAD);
      expect(result).toEqual({ ok: false, skipped: true });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('URL 빈 문자열도 미설정으로 취급', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = '';
      const result = await registerActiveTrip(SAMPLE_PAYLOAD);
      expect(result.skipped).toBe(true);
    });

    it('정상 응답 시 ok=true, body에 트립 직렬화', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev/';
      (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 } as Response);

      const result = await registerActiveTrip(SAMPLE_PAYLOAD);
      expect(result).toEqual({ ok: true, status: 200 });
      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
      // trailing slash 제거 확인
      expect(url).toBe('https://api.test.dev/trips');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toMatchObject({
        token: 'token-hex',
        destination: '0228',
        alarmAtEpochMs: NOW + 60000,
        createdAt: NOW,
        expiresAt: NOW + 1000,
        apnsEnv: 'sandbox',
      });
    });

    it('createdAt/expiresAt 미지정 시 기본값(now, +2시간)', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
      (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 } as Response);

      const payload: RegisterTripPayload = {
        token: 't',
        route: makeDirectRoute(1, '2'),
        destination: '0228',
        waypoints: [{ stationName: '강남', line: '2', kind: 'destination' }],
        alarmAtEpochMs: NOW,
        apnsEnv: 'sandbox',
      };
      await registerActiveTrip(payload);
      const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      expect(body.createdAt).toBe(NOW);
      expect(body.expiresAt).toBe(NOW + 2 * 60 * 60 * 1000);
    });

    it('non-2xx 응답 시 ok=false + status', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
      (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 } as Response);
      const result = await registerActiveTrip(SAMPLE_PAYLOAD);
      expect(result).toEqual({ ok: false, status: 500 });
    });

    it('fetch throw 시 ok=false 반환(throw 안 함)', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
      (global.fetch as jest.Mock).mockRejectedValue(new Error('network'));
      const result = await registerActiveTrip(SAMPLE_PAYLOAD);
      expect(result).toEqual({ ok: false });
    });

    describe('dedup (#581)', () => {
      beforeEach(() => {
        process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
        (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 } as Response);
      });

      it('동일 페이로드 두 번 호출 시 두 번째는 fetch 안 함 + skipped=true', async () => {
        const first = await registerActiveTrip(SAMPLE_PAYLOAD);
        const second = await registerActiveTrip(SAMPLE_PAYLOAD);
        expect(first).toEqual({ ok: true, status: 200 });
        expect(second).toEqual({ ok: true, skipped: true });
        expect(global.fetch).toHaveBeenCalledTimes(1);
      });

      it('alarmAtEpochMs가 60초 버킷 내 jitter 면 dedup된다', async () => {
        await registerActiveTrip(SAMPLE_PAYLOAD);
        const jitter = await registerActiveTrip({
          ...SAMPLE_PAYLOAD,
          alarmAtEpochMs: SAMPLE_PAYLOAD.alarmAtEpochMs + 30_000,
        });
        expect(jitter.skipped).toBe(true);
        expect(global.fetch).toHaveBeenCalledTimes(1);
      });

      it('alarmAtEpochMs가 다른 버킷으로 넘어가면 재등록된다', async () => {
        await registerActiveTrip(SAMPLE_PAYLOAD);
        const next = await registerActiveTrip({
          ...SAMPLE_PAYLOAD,
          alarmAtEpochMs: SAMPLE_PAYLOAD.alarmAtEpochMs + 120_000,
        });
        expect(next).toEqual({ ok: true, status: 200 });
        expect(global.fetch).toHaveBeenCalledTimes(2);
      });

      it('destination 변경 시 재등록된다', async () => {
        await registerActiveTrip(SAMPLE_PAYLOAD);
        const next = await registerActiveTrip({ ...SAMPLE_PAYLOAD, destination: '0229' });
        expect(next.ok).toBe(true);
        expect(next.skipped).toBeUndefined();
        expect(global.fetch).toHaveBeenCalledTimes(2);
      });

      it('등록 실패(non-2xx)는 해시를 저장하지 않아 다음 호출에서 재시도된다', async () => {
        (global.fetch as jest.Mock)
          .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
          .mockResolvedValueOnce({ ok: true, status: 200 } as Response);
        const first = await registerActiveTrip(SAMPLE_PAYLOAD);
        const retry = await registerActiveTrip(SAMPLE_PAYLOAD);
        expect(first).toEqual({ ok: false, status: 500 });
        expect(retry).toEqual({ ok: true, status: 200 });
        expect(global.fetch).toHaveBeenCalledTimes(2);
      });

      it('clearActiveTrip 호출 후엔 같은 페이로드도 다시 등록된다', async () => {
        await registerActiveTrip(SAMPLE_PAYLOAD);
        await clearActiveTrip('token-hex');
        (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 } as Response);
        const reregister = await registerActiveTrip(SAMPLE_PAYLOAD);
        expect(reregister).toEqual({ ok: true, status: 200 });
      });

      it('boardingLock 송신: body에 포함 + key 변경 시 재등록 (#622)', async () => {
        const lock = {
          trainCode: '7246',
          line: '7',
          subwayId: '1007',
          selectedDepartureTime: NOW,
          segmentStations: ['면목', '용마산'],
          expiresAt: NOW + 600_000,
        };
        const first = await registerActiveTrip({ ...SAMPLE_PAYLOAD, boardingLock: lock });
        expect(first.ok).toBe(true);
        const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
        expect(body.boardingLock).toEqual(lock);

        // 동일 lock 재호출 → dedup
        const dup = await registerActiveTrip({ ...SAMPLE_PAYLOAD, boardingLock: lock });
        expect(dup).toEqual({ ok: true, skipped: true });

        // 다른 trainCode → 재등록
        const newLock = { ...lock, trainCode: '7301' };
        const reregister = await registerActiveTrip({ ...SAMPLE_PAYLOAD, boardingLock: newLock });
        expect(reregister).toEqual({ ok: true, status: 200 });
        expect(global.fetch).toHaveBeenCalledTimes(2);
      });

      it('boardingLock 없으면 body에 미포함', async () => {
        await registerActiveTrip(SAMPLE_PAYLOAD);
        const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
        expect(body.boardingLock).toBeUndefined();
      });

      it('URL 미설정 → 설정 사이클에서도 dedup이 stale state를 남기지 않는다', async () => {
        // URL 미설정으로 skip된 호출은 lastRegisteredHash를 건드리지 않아야 한다.
        delete process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
        const skipped = await registerActiveTrip(SAMPLE_PAYLOAD);
        expect(skipped.skipped).toBe(true);

        process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
        const real = await registerActiveTrip(SAMPLE_PAYLOAD);
        expect(real).toEqual({ ok: true, status: 200 });
        expect(global.fetch).toHaveBeenCalledTimes(1);
      });
    });

    it('타임아웃 시 AbortController가 abort를 호출한다', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
      let capturedSignal: AbortSignal | undefined;
      (global.fetch as jest.Mock).mockImplementation(async (_url, init) => {
        capturedSignal = init.signal;
        // 5초 후 timer가 abort()를 호출하도록 시각을 진행시킨다.
        jest.advanceTimersByTime(5000);
        return { ok: true, status: 200 } as Response;
      });
      await registerActiveTrip(SAMPLE_PAYLOAD);
      expect(capturedSignal?.aborted).toBe(true);
    });
  });

  describe('clearActiveTrip', () => {
    it('URL 미설정 시 skipped=true', async () => {
      const result = await clearActiveTrip('token-x');
      expect(result.skipped).toBe(true);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('token 비어 있으면 ok=false (호출 안 함)', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
      const result = await clearActiveTrip('');
      expect(result).toEqual({ ok: false });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('정상 응답 시 ok=true, URL에 token URL-encode', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
      (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 } as Response);
      const result = await clearActiveTrip('a/b');
      expect(result.ok).toBe(true);
      const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toBe('https://api.test.dev/trips/a%2Fb');
      expect(init.method).toBe('DELETE');
    });

    it('non-2xx 응답 시 ok=false + status', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
      (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 404 } as Response);
      const result = await clearActiveTrip('t');
      expect(result).toEqual({ ok: false, status: 404 });
    });

    it('fetch throw 시 ok=false (throw 안 함)', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
      (global.fetch as jest.Mock).mockRejectedValue(new Error('boom'));
      const result = await clearActiveTrip('t');
      expect(result).toEqual({ ok: false });
    });
  });

  describe('sendPushAck (#568 P2b)', () => {
    const ACK = {
      pushId: 'push-1',
      token: 'devicetoken-hex',
      outcome: 'fired' as const,
    };

    it('URL 미설정 시 skipped=true 반환, fetch 미호출', async () => {
      const result = await sendPushAck(ACK);
      expect(result.skipped).toBe(true);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('정상 응답 시 ok=true + POST /push/ack에 payload 그대로 전달', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
      (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 } as Response);
      const result = await sendPushAck({ ...ACK, outcome: 'skipped', reason: 'gate-out-of-range' });
      expect(result.ok).toBe(true);
      const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toBe('https://api.test.dev/push/ack');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({
        pushId: 'push-1',
        token: 'devicetoken-hex',
        outcome: 'skipped',
        reason: 'gate-out-of-range',
      });
    });

    it('non-2xx 응답 시 ok=false + status', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
      (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 400 } as Response);
      const result = await sendPushAck(ACK);
      expect(result).toEqual({ ok: false, status: 400 });
    });

    it('fetch throw 시 ok=false (throw 안 함)', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
      (global.fetch as jest.Mock).mockRejectedValue(new Error('boom'));
      const result = await sendPushAck(ACK);
      expect(result).toEqual({ ok: false });
    });

    it('trailing slash가 URL에 있어도 정상 처리', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev/';
      (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 } as Response);
      await sendPushAck(ACK);
      const [url] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toBe('https://api.test.dev/push/ack');
    });
  });

  describe('registerLiveActivityToken (#586 B)', () => {
    it('URL 미설정 시 skipped=true 반환', async () => {
      const result = await registerLiveActivityToken('trip-1', 'la-tok');
      expect(result).toEqual({ ok: false, skipped: true });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('정상 응답 시 POST /live-activity/register body 직렬화', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev/';
      (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 } as Response);
      const result = await registerLiveActivityToken('trip-1', 'la-tok');
      expect(result).toEqual({ ok: true, status: 200 });
      const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toBe('https://api.test.dev/live-activity/register');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({
        tripToken: 'trip-1',
        activityPushToken: 'la-tok',
      });
    });

    it('non-2xx 응답 시 ok=false + status', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
      (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 404 } as Response);
      const result = await registerLiveActivityToken('trip-1', 'la-tok');
      expect(result).toEqual({ ok: false, status: 404 });
    });

    it('fetch throw 시 ok=false', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
      (global.fetch as jest.Mock).mockRejectedValue(new Error('boom'));
      const result = await registerLiveActivityToken('trip-1', 'la-tok');
      expect(result).toEqual({ ok: false });
    });
  });

  describe('clearLiveActivityToken (#586 B)', () => {
    it('URL 미설정 시 skipped=true 반환', async () => {
      const result = await clearLiveActivityToken('trip-1');
      expect(result).toEqual({ ok: false, skipped: true });
    });

    it('빈 tripToken은 ok=false (no fetch)', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
      const result = await clearLiveActivityToken('');
      expect(result).toEqual({ ok: false });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('정상 응답 시 DELETE /live-activity/:tripToken (encoded)', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev/';
      (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 } as Response);
      const result = await clearLiveActivityToken('trip/with space');
      expect(result).toEqual({ ok: true, status: 200 });
      const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toBe('https://api.test.dev/live-activity/trip%2Fwith%20space');
      expect(init.method).toBe('DELETE');
    });

    it('non-2xx 응답 시 ok=false + status', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
      (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 } as Response);
      const result = await clearLiveActivityToken('trip-1');
      expect(result).toEqual({ ok: false, status: 500 });
    });

    it('fetch throw 시 ok=false', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
      (global.fetch as jest.Mock).mockRejectedValue(new Error('boom'));
      const result = await clearLiveActivityToken('trip-1');
      expect(result).toEqual({ ok: false });
    });
  });
});
