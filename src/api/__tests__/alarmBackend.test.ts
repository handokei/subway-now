import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  registerActiveTrip,
  clearActiveTrip,
  sendPushAck,
  registerLiveActivityToken,
  clearLiveActivityToken,
  reportBoardingPromptOutcome,
  __resetAlarmBackendDedup,
} from '../alarmBackend';
import type { RegisterTripPayload } from '../alarmBackend';
import { makeDirectRoute } from '../../testUtils/routeFixtures';
import { ACTIVE_BOARDING_LINE_KEY } from '../../shared/constants/storageKeys';

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

      // #816 C — lockless station-passed 토글
      it('locklessStationPassed=true 송신 + 토글 변경 시 재등록', async () => {
        const first = await registerActiveTrip({
          ...SAMPLE_PAYLOAD,
          locklessStationPassed: true,
        });
        expect(first.ok).toBe(true);
        const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
        expect(body.locklessStationPassed).toBe(true);

        // 토글 OFF로 재호출 → hash 달라져서 재등록 (dedup 미적용)
        const off = await registerActiveTrip({
          ...SAMPLE_PAYLOAD,
          locklessStationPassed: false,
        });
        expect(off).toEqual({ ok: true, status: 200 });
        expect(global.fetch).toHaveBeenCalledTimes(2);
        const offBody = JSON.parse((global.fetch as jest.Mock).mock.calls[1][1].body);
        expect(offBody.locklessStationPassed).toBeUndefined();
      });

      it('locklessStationPassed=false/미설정이면 body에 미포함', async () => {
        await registerActiveTrip({ ...SAMPLE_PAYLOAD, locklessStationPassed: false });
        const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
        expect(body.locklessStationPassed).toBeUndefined();
      });

      it('#701 in-flight dedup: 동일 페이로드 동시 호출 시 fetch는 1번만 발사된다', async () => {
        let resolveFetch: ((v: Response) => void) | null = null;
        (global.fetch as jest.Mock).mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              resolveFetch = resolve;
            }),
        );

        // 같은 ms에 3개 발사 (await 없이 Promise만 받기) — Cloudflare 로그 시나리오 재현.
        const p1 = registerActiveTrip(SAMPLE_PAYLOAD);
        const p2 = registerActiveTrip(SAMPLE_PAYLOAD);
        const p3 = registerActiveTrip(SAMPLE_PAYLOAD);

        // 첫 fetch 미해결 상태에서도 모두 동일 Promise를 공유해야 함.
        expect(global.fetch).toHaveBeenCalledTimes(1);

        resolveFetch!({ ok: true, status: 200 } as Response);
        const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

        expect(r1).toEqual({ ok: true, status: 200 });
        expect(r2).toEqual({ ok: true, status: 200 });
        expect(r3).toEqual({ ok: true, status: 200 });
        expect(global.fetch).toHaveBeenCalledTimes(1);
      });

      it('#701 in-flight 완료 후 lastRegisteredHash가 정상 set되어 후속 호출은 skipped', async () => {
        await registerActiveTrip(SAMPLE_PAYLOAD);
        const followup = await registerActiveTrip(SAMPLE_PAYLOAD);
        expect(followup).toEqual({ ok: true, skipped: true });
        expect(global.fetch).toHaveBeenCalledTimes(1);
      });

      it('#701 다른 sessionKey 동시 호출은 병렬로 진행된다', async () => {
        (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 } as Response);
        const p1 = registerActiveTrip(SAMPLE_PAYLOAD);
        const p2 = registerActiveTrip({ ...SAMPLE_PAYLOAD, destination: '0229' });
        const [r1, r2] = await Promise.all([p1, p2]);
        expect(r1.ok).toBe(true);
        expect(r2.ok).toBe(true);
        expect(global.fetch).toHaveBeenCalledTimes(2);
      });

      it('#701 in-flight 실패 시 후속 호출은 재시도 가능 (in-flight Map 정리)', async () => {
        (global.fetch as jest.Mock)
          .mockRejectedValueOnce(new Error('network'))
          .mockResolvedValueOnce({ ok: true, status: 200 } as Response);
        const first = await registerActiveTrip(SAMPLE_PAYLOAD);
        expect(first).toEqual({ ok: false });
        const retry = await registerActiveTrip(SAMPLE_PAYLOAD);
        expect(retry).toEqual({ ok: true, status: 200 });
        expect(global.fetch).toHaveBeenCalledTimes(2);
      });

      it('#701 clearActiveTrip 호출 시 in-flight Map까지 비워진다', async () => {
        let resolveFetch: ((v: Response) => void) | null = null;
        (global.fetch as jest.Mock).mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              resolveFetch = resolve;
            }),
        );
        const p1 = registerActiveTrip(SAMPLE_PAYLOAD);
        // clear 도중에도 in-flight Map은 비워져야 한다.
        (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, status: 200 } as Response);
        await clearActiveTrip('token-hex');
        // pending register는 stale로 남지만 새 register 호출은 새 Promise를 만들어야 함.
        (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, status: 200 } as Response);
        const p2 = registerActiveTrip(SAMPLE_PAYLOAD);
        expect(p1).not.toBe(p2);
        // resolve 원래 fetch
        resolveFetch!({ ok: true, status: 200 } as Response);
        await Promise.all([p1, p2]);
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

  describe('reportBoardingPromptOutcome (#827)', () => {
    it('URL 미설정 시 skipped=true 반환', async () => {
      const result = await reportBoardingPromptOutcome('tok', 'boarded');
      expect(result).toEqual({ ok: false, skipped: true });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('빈 token이면 ok=false (fetch 미호출)', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
      const result = await reportBoardingPromptOutcome('', 'boarded');
      expect(result).toEqual({ ok: false });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('POST /metrics/boarding-prompt에 token/outcome 직렬화', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev/';
      (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 } as Response);
      const result = await reportBoardingPromptOutcome('tok-1', 'dismissed');
      expect(result).toEqual({ ok: true, status: 200 });
      const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toBe('https://api.test.dev/metrics/boarding-prompt');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ token: 'tok-1', outcome: 'dismissed' });
    });

    it('non-2xx 응답 시 ok=false + status', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
      (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 } as Response);
      const result = await reportBoardingPromptOutcome('tok-1', 'boarded');
      expect(result).toEqual({ ok: false, status: 500 });
    });

    it('fetch throw 시 ok=false (throw 안 함)', async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
      (global.fetch as jest.Mock).mockRejectedValue(new Error('boom'));
      const result = await reportBoardingPromptOutcome('tok-1', 'boarded');
      expect(result).toEqual({ ok: false });
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

  describe('promptGeoContext / promptDisplay (#819)', () => {
    const PROMPT_PAYLOAD: RegisterTripPayload = {
      ...SAMPLE_PAYLOAD,
      promptGeoContext: {
        origin: { lat: 37.5, lng: 127 },
        nextStation: { lat: 37.51, lng: 127.01 },
        direction: 'up',
      },
      promptDisplay: { originStation: '강남', line: '2' },
    };

    beforeEach(() => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
      (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 } as Response);
    });

    it('promptGeoContext + promptDisplay body에 포함', async () => {
      await registerActiveTrip(PROMPT_PAYLOAD);
      const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      expect(body.promptGeoContext).toEqual({
        origin: { lat: 37.5, lng: 127 },
        nextStation: { lat: 37.51, lng: 127.01 },
        direction: 'up',
      });
      expect(body.promptDisplay).toEqual({ originStation: '강남', line: '2' });
    });

    it('promptDisplay만 다르면 dedup 깨고 재등록', async () => {
      await registerActiveTrip(PROMPT_PAYLOAD);
      const changed = await registerActiveTrip({
        ...PROMPT_PAYLOAD,
        promptDisplay: { originStation: '강남', line: '신분당' },
      });
      expect(changed.ok).toBe(true);
      expect(changed.skipped).toBeUndefined();
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('promptGeoContext 좌표 jitter는 dedup 유지 (hash에 미포함)', async () => {
      await registerActiveTrip(PROMPT_PAYLOAD);
      const jitter = await registerActiveTrip({
        ...PROMPT_PAYLOAD,
        promptGeoContext: {
          origin: { lat: 37.5001, lng: 127.0001 },
          nextStation: { lat: 37.5101, lng: 127.0101 },
          direction: 'up',
        },
      });
      expect(jitter.skipped).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('#828 — ACTIVE_BOARDING_LINE_KEY mirror', () => {
    beforeEach(async () => {
      process.env.EXPO_PUBLIC_ALARM_BACKEND_URL = 'https://api.test.dev';
      (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 } as Response);
      await AsyncStorage.removeItem(ACTIVE_BOARDING_LINE_KEY);
    });

    it('register 시 promptDisplay.line이 AsyncStorage에 mirror', async () => {
      await registerActiveTrip({
        ...SAMPLE_PAYLOAD,
        promptDisplay: { originStation: '강남', line: '2' },
      });
      expect(await AsyncStorage.getItem(ACTIVE_BOARDING_LINE_KEY)).toBe('2');
    });

    it('register 시 promptDisplay 부재면 mirror 제거', async () => {
      await AsyncStorage.setItem(ACTIVE_BOARDING_LINE_KEY, 'stale');
      await registerActiveTrip(SAMPLE_PAYLOAD);
      expect(await AsyncStorage.getItem(ACTIVE_BOARDING_LINE_KEY)).toBeNull();
    });

    it('clearActiveTrip 호출 시 mirror 제거', async () => {
      await AsyncStorage.setItem(ACTIVE_BOARDING_LINE_KEY, '2');
      await clearActiveTrip('token-hex');
      expect(await AsyncStorage.getItem(ACTIVE_BOARDING_LINE_KEY)).toBeNull();
    });

    it('AsyncStorage throw → register는 계속 진행 (graceful)', async () => {
      const originalSetItem = AsyncStorage.setItem;
      (AsyncStorage.setItem as jest.Mock) = jest.fn().mockRejectedValue(new Error('storage down'));
      const result = await registerActiveTrip({
        ...SAMPLE_PAYLOAD,
        promptDisplay: { originStation: '강남', line: '2' },
      });
      expect(result.ok).toBe(true);
      AsyncStorage.setItem = originalSetItem;
    });
  });
});
