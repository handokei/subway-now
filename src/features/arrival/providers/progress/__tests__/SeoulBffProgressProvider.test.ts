import { SeoulBffProgressProvider } from '../SeoulBffProgressProvider';
import type { BffProgressResponse } from '../types';

describe('SeoulBffProgressProvider', () => {
  const BASE_URL = 'https://bff.example.com';
  const TRIP_TOKEN = 'trainCode-7301:line-2';
  const NOW_MS = 1_700_000_000_000;

  function mockFetchOk(data: BffProgressResponse) {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValueOnce(data),
    });
  }

  beforeEach(() => {
    global.fetch = jest.fn();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('정상 응답 시 BffProgressResponse를 그대로 반환한다', async () => {
    const provider = new SeoulBffProgressProvider(BASE_URL);
    const response: BffProgressResponse = {
      waypointIndex: 3,
      remainingHopsMs: 45_000,
      confidence: 'high',
      receivedAtMs: NOW_MS,
      ttlMs: 60_000,
    };
    mockFetchOk(response);

    const result = await provider.fetch(TRIP_TOKEN, NOW_MS);

    expect(result).toEqual(response);
    expect(global.fetch).toHaveBeenCalledWith(
      `${BASE_URL}/api/progress/${encodeURIComponent(TRIP_TOKEN)}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('응답이 만료되면 null을 반환한다 (nowMs - receivedAtMs > ttlMs)', async () => {
    const provider = new SeoulBffProgressProvider(BASE_URL);
    const expired: BffProgressResponse = {
      waypointIndex: 1,
      remainingHopsMs: 30_000,
      confidence: 'high',
      receivedAtMs: NOW_MS - 120_000,
      ttlMs: 60_000,
    };
    mockFetchOk(expired);

    const result = await provider.fetch(TRIP_TOKEN, NOW_MS);

    expect(result).toBeNull();
  });

  it('confidence가 low면 신선해도 null을 반환한다', async () => {
    const provider = new SeoulBffProgressProvider(BASE_URL);
    const lowConfidence: BffProgressResponse = {
      waypointIndex: 2,
      remainingHopsMs: 40_000,
      confidence: 'low',
      receivedAtMs: NOW_MS,
      ttlMs: 60_000,
    };
    mockFetchOk(lowConfidence);

    const result = await provider.fetch(TRIP_TOKEN, NOW_MS);

    expect(result).toBeNull();
  });

  it('네트워크 실패 시 null을 반환한다', async () => {
    const provider = new SeoulBffProgressProvider(BASE_URL);
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

    const result = await provider.fetch(TRIP_TOKEN, NOW_MS);

    expect(result).toBeNull();
  });

  it('non-2xx 응답 시 null을 반환한다', async () => {
    const provider = new SeoulBffProgressProvider(BASE_URL);
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 503 });

    const result = await provider.fetch(TRIP_TOKEN, NOW_MS);

    expect(result).toBeNull();
  });

  it('TTL 만료 전까지 캐시에서 응답해 fetch를 중복 호출하지 않는다', async () => {
    const provider = new SeoulBffProgressProvider(BASE_URL);
    const fresh: BffProgressResponse = {
      waypointIndex: 5,
      remainingHopsMs: 25_000,
      confidence: 'medium',
      receivedAtMs: NOW_MS,
      ttlMs: 60_000,
    };
    mockFetchOk(fresh);

    const first = await provider.fetch(TRIP_TOKEN, NOW_MS);
    const second = await provider.fetch(TRIP_TOKEN, NOW_MS + 10_000);

    expect(first).toEqual(fresh);
    expect(second).toEqual(fresh);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('캐시가 TTL을 넘기면 다시 fetch한다', async () => {
    const provider = new SeoulBffProgressProvider(BASE_URL);
    const first: BffProgressResponse = {
      waypointIndex: 1,
      remainingHopsMs: 50_000,
      confidence: 'high',
      receivedAtMs: NOW_MS,
      ttlMs: 60_000,
    };
    const second: BffProgressResponse = {
      waypointIndex: 2,
      remainingHopsMs: 30_000,
      confidence: 'high',
      receivedAtMs: NOW_MS + 70_000,
      ttlMs: 60_000,
    };
    mockFetchOk(first);
    mockFetchOk(second);

    const r1 = await provider.fetch(TRIP_TOKEN, NOW_MS);
    const r2 = await provider.fetch(TRIP_TOKEN, NOW_MS + 70_000);

    expect(r1).toEqual(first);
    expect(r2).toEqual(second);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('타임아웃 abort 시 null을 반환한다', async () => {
    const provider = new SeoulBffProgressProvider(BASE_URL, 100);
    (global.fetch as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new DOMException('Aborted', 'AbortError')), 6000);
        }),
    );

    const resultPromise = provider.fetch(TRIP_TOKEN, NOW_MS);
    jest.runAllTimers();
    const result = await resultPromise;

    expect(result).toBeNull();
  });

  describe('backend down 감지 + exponential backoff (#1172)', () => {
    function mockFetchFail() {
      (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));
    }

    it('연속 실패가 임계치 미만이면 매번 fetch를 시도한다', async () => {
      const provider = new SeoulBffProgressProvider(BASE_URL);
      mockFetchFail();
      mockFetchFail();

      await provider.fetch(TRIP_TOKEN, NOW_MS);
      await provider.fetch(TRIP_TOKEN, NOW_MS + 1_000);

      // 2회 실패는 아직 임계치(3) 미만 — 매 호출마다 fetch.
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('연속 실패가 임계치를 넘으면 backoff 동안 fetch를 건너뛴다', async () => {
      const provider = new SeoulBffProgressProvider(BASE_URL);
      mockFetchFail();
      mockFetchFail();
      mockFetchFail();

      await provider.fetch(TRIP_TOKEN, NOW_MS);
      await provider.fetch(TRIP_TOKEN, NOW_MS + 1_000);
      await provider.fetch(TRIP_TOKEN, NOW_MS + 2_000);
      expect(global.fetch).toHaveBeenCalledTimes(3);

      // 4번째 호출은 backoff 진입으로 fetch 생략, null 반환.
      const result = await provider.fetch(TRIP_TOKEN, NOW_MS + 3_000);
      expect(result).toBeNull();
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    it('backoff 만료 시점이 되면 다시 fetch를 시도한다', async () => {
      const provider = new SeoulBffProgressProvider(BASE_URL);
      // 임계치 도달.
      mockFetchFail();
      mockFetchFail();
      mockFetchFail();
      await provider.fetch(TRIP_TOKEN, NOW_MS);
      await provider.fetch(TRIP_TOKEN, NOW_MS);
      await provider.fetch(TRIP_TOKEN, NOW_MS);

      // 충분히 큰 시간이 지나면 backoff 만료 → 재시도.
      mockFetchFail();
      await provider.fetch(TRIP_TOKEN, NOW_MS + 10 * 60_000);
      expect(global.fetch).toHaveBeenCalledTimes(4);
    });

    it('backoff 만료 후 성공하면 down 모드가 해제된다 (즉시 재진입 fetch)', async () => {
      const provider = new SeoulBffProgressProvider(BASE_URL);
      mockFetchFail();
      mockFetchFail();
      mockFetchFail();
      await provider.fetch(TRIP_TOKEN, NOW_MS);
      await provider.fetch(TRIP_TOKEN, NOW_MS);
      await provider.fetch(TRIP_TOKEN, NOW_MS);

      const recovery: BffProgressResponse = {
        waypointIndex: 1,
        remainingHopsMs: 40_000,
        confidence: 'high',
        receivedAtMs: NOW_MS + 10 * 60_000,
        ttlMs: 60_000,
      };
      mockFetchOk(recovery);
      const recovered = await provider.fetch(TRIP_TOKEN, NOW_MS + 10 * 60_000);
      expect(recovered).toEqual(recovery);

      // 회복 후 캐시 만료 시점에 새로 fetch가 정상 동작 — backoff 미적용.
      const next: BffProgressResponse = {
        waypointIndex: 2,
        remainingHopsMs: 30_000,
        confidence: 'high',
        receivedAtMs: NOW_MS + 11 * 60_000 + 30_000,
        ttlMs: 60_000,
      };
      mockFetchOk(next);
      const after = await provider.fetch(TRIP_TOKEN, NOW_MS + 11 * 60_000 + 30_000);
      expect(after).toEqual(next);
      expect(global.fetch).toHaveBeenCalledTimes(5);
    });

    it('중간에 성공이 끼면 실패 카운터가 초기화된다', async () => {
      const provider = new SeoulBffProgressProvider(BASE_URL);
      mockFetchFail();
      mockFetchFail();
      await provider.fetch(TRIP_TOKEN, NOW_MS);
      await provider.fetch(TRIP_TOKEN, NOW_MS);

      const ok: BffProgressResponse = {
        waypointIndex: 0,
        remainingHopsMs: 50_000,
        confidence: 'high',
        receivedAtMs: NOW_MS + 1_000,
        ttlMs: 60_000,
      };
      mockFetchOk(ok);
      await provider.fetch(TRIP_TOKEN, NOW_MS + 1_000);

      // 캐시 만료 후 또 2회 실패해도 아직 임계치 미만(누적 리셋됨).
      mockFetchFail();
      mockFetchFail();
      await provider.fetch(TRIP_TOKEN, NOW_MS + 80_000);
      await provider.fetch(TRIP_TOKEN, NOW_MS + 90_000);

      // 모두 실제 fetch 호출 — backoff 미진입.
      expect(global.fetch).toHaveBeenCalledTimes(5);
    });

    it('confidence=low 응답은 backend 건강과 무관하므로 실패로 세지 않는다', async () => {
      const provider = new SeoulBffProgressProvider(BASE_URL);
      const low: BffProgressResponse = {
        waypointIndex: 0,
        remainingHopsMs: 40_000,
        confidence: 'low',
        receivedAtMs: NOW_MS,
        ttlMs: 60_000,
      };
      mockFetchOk(low);
      mockFetchOk(low);
      mockFetchOk(low);
      mockFetchOk(low);

      // 4회 모두 low (게이트는 null 반환) — backoff 미진입, 매번 캐시 만료 후 fetch.
      await provider.fetch(TRIP_TOKEN, NOW_MS);
      await provider.fetch(TRIP_TOKEN, NOW_MS + 70_000);
      await provider.fetch(TRIP_TOKEN, NOW_MS + 140_000);
      await provider.fetch(TRIP_TOKEN, NOW_MS + 210_000);

      expect(global.fetch).toHaveBeenCalledTimes(4);
    });

    it('backoff 지연은 BACKOFF_MAX_MS를 넘지 않는다', async () => {
      const provider = new SeoulBffProgressProvider(BASE_URL);
      // 매번 backoff 만료 직후 실패시켜 지수가 계속 증가하도록 유도.
      let now = NOW_MS;
      for (let i = 0; i < 20; i += 1) {
        mockFetchFail();
        await provider.fetch(TRIP_TOKEN, now);
        // 충분히 큰 점프로 다음 backoff 만료를 항상 넘기게 함.
        now += 10 * 60_000;
      }
      const fetchCallsAfterLoop = (global.fetch as jest.Mock).mock.calls.length;
      expect(fetchCallsAfterLoop).toBe(20);

      // 직전 실패 시점으로부터 BACKOFF_MAX_MS + 여유가 지나면 무조건 재시도 가능해야 함.
      mockFetchFail();
      await provider.fetch(TRIP_TOKEN, now + 60_001);
      expect((global.fetch as jest.Mock).mock.calls.length).toBe(21);
    });
  });

  it('특수 문자가 포함된 tripToken을 URL 인코딩한다', async () => {
    const provider = new SeoulBffProgressProvider(BASE_URL);
    const response: BffProgressResponse = {
      waypointIndex: 0,
      remainingHopsMs: 60_000,
      confidence: 'high',
      receivedAtMs: NOW_MS,
      ttlMs: 60_000,
    };
    mockFetchOk(response);

    await provider.fetch('lock/with spaces', NOW_MS);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent('lock/with spaces')),
      expect.any(Object),
    );
  });
});
