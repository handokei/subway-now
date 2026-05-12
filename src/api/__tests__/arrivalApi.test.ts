import { fetchArrivalInfo, MOCK_ARRIVALS, parseRecptnDt } from '../arrivalApi';

describe('fetchArrivalInfo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('API 키가 없으면 Mock 데이터를 반환한다', async () => {
    delete process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY;

    const result = await fetchArrivalInfo('강남');

    expect(result.up.length).toBeGreaterThan(0);
    expect(result.down.length).toBeGreaterThan(0);
    expect(result.up[0]).toHaveProperty('destination');
    expect(result.up[0]).toHaveProperty('arrivalMinutes');
    expect(result.up[0]).toHaveProperty('arrivalSeconds');
    expect(result.up[0]).toHaveProperty('statusMessage');
    expect(result.up[0]).toHaveProperty('trainCode');
    expect(result.isMock).toBe(true);
  });

  it('API 키가 있으면 fetch를 호출한다', async () => {
    process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY = 'test-key';

    const mockApiResponse = {
      realtimeArrivalList: [
        { trainLineNm: '소요산행', barvlDt: 120, btrainNo: 'T001', updnLine: '상행' },
        { trainLineNm: '인천행', barvlDt: 240, btrainNo: 'T002', updnLine: '하행' },
        { trainLineNm: '소요산행', barvlDt: 360, btrainNo: 'T003', updnLine: '상행' },
        { trainLineNm: '인천행', barvlDt: 480, btrainNo: 'T004', updnLine: '하행' },
      ],
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => mockApiResponse,
    } as Response);

    const result = await fetchArrivalInfo('강남');

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.up).toHaveLength(2);
    expect(result.down).toHaveLength(2);
    expect(result.up[0].arrivalMinutes).toBe(2); // 120초 → 2분
    expect(result.up[0].arrivalSeconds).toBe(120);
    expect(result.up[0].statusMessage).toBe('');
    expect(result.isMock).toBeUndefined();

    delete process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY;
  });

  it('API 응답이 실패하면 Mock 데이터를 반환한다', async () => {
    process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY = 'test-key';

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
    } as Response);

    const result = await fetchArrivalInfo('강남');

    expect(result.up.length).toBeGreaterThan(0);
    expect(result.down.length).toBeGreaterThan(0);
    expect(result.isMock).toBe(true);

    delete process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY;
  });

  it('fetch가 네트워크 오류를 발생시키면 Mock 데이터를 반환한다', async () => {
    process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY = 'test-key';

    global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));

    const result = await fetchArrivalInfo('강남');

    expect(result.up.length).toBeGreaterThan(0);
    expect(result.down.length).toBeGreaterThan(0);
    expect(result.isMock).toBe(true);

    delete process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY;
  });

  it('realtimeArrivalList가 없으면 Mock 데이터를 반환한다', async () => {
    process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY = 'test-key';

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);

    const result = await fetchArrivalInfo('강남');

    expect(result.up.length).toBeGreaterThan(0);
    expect(result.down.length).toBeGreaterThan(0);
    expect(result.isMock).toBe(true);

    delete process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY;
  });

  it('MOCK_ARRIVALS가 export 된다', () => {
    expect(MOCK_ARRIVALS).toBeDefined();
    expect(MOCK_ARRIVALS.up.length).toBeGreaterThan(0);
    expect(MOCK_ARRIVALS.down.length).toBeGreaterThan(0);
  });

  it('arrivalMinutes가 0초이면 0분을 반환한다', async () => {
    process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY = 'test-key';

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        realtimeArrivalList: [
          { trainLineNm: '소요산행', barvlDt: 0, btrainNo: 'T001', updnLine: '상행' },
        ],
      }),
    } as Response);

    const result = await fetchArrivalInfo('강남');
    expect(result.up[0].arrivalMinutes).toBe(0);
    expect(result.up[0].arrivalSeconds).toBe(0);

    delete process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY;
  });

  it('updnLine이 "내선"이면 상행으로 분류된다', async () => {
    process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY = 'test-key';

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        realtimeArrivalList: [
          { trainLineNm: '내선순환', barvlDt: 60, btrainNo: 'T001', updnLine: '내선' },
        ],
      }),
    } as Response);

    const result = await fetchArrivalInfo('시청');
    expect(result.up).toHaveLength(1);
    expect(result.up[0].destination).toBe('내선순환');

    delete process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY;
  });

  it('상행만 있고 하행이 없으면 실데이터로 반환한다', async () => {
    process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY = 'test-key';

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        realtimeArrivalList: [
          { trainLineNm: '소요산행', barvlDt: 120, btrainNo: 'T001', updnLine: '상행' },
        ],
      }),
    } as Response);

    const result = await fetchArrivalInfo('소요산');
    expect(result.up).toHaveLength(1);
    expect(result.down).toHaveLength(0);
    expect(result.isMock).toBeUndefined();

    delete process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY;
  });

  it('fetch가 5초 초과하면 Mock 데이터를 반환한다', async () => {
    process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY = 'test-key';
    jest.useFakeTimers();

    global.fetch = jest.fn().mockImplementation((_url: string, options?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    });

    const promise = fetchArrivalInfo('강남');
    jest.advanceTimersByTime(5000);
    const result = await promise;

    expect(result.isMock).toBe(true);

    jest.useRealTimers();
    delete process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY;
  });

  it('fetch에 AbortController signal을 전달한다', async () => {
    process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY = 'test-key';

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        realtimeArrivalList: [
          { trainLineNm: '소요산행', barvlDt: 120, btrainNo: 'T001', updnLine: '상행' },
        ],
      }),
    } as Response);

    await fetchArrivalInfo('강남');

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );

    delete process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY;
  });

  it('arvlMsg2를 statusMessage로 파싱한다', async () => {
    process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY = 'test-key';

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        realtimeArrivalList: [
          { trainLineNm: '소요산행', barvlDt: 90, btrainNo: 'T001', updnLine: '상행', arvlMsg2: '전역 출발' },
        ],
      }),
    } as Response);

    const result = await fetchArrivalInfo('강남');
    expect(result.up[0].statusMessage).toBe('전역 출발');
    expect(result.up[0].arrivalSeconds).toBe(90);
    expect(result.up[0].arrivalMinutes).toBe(1);

    delete process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY;
  });

  describe('recptnDt 시차 보정', () => {
    const mockArrivalAt = (
      barvlDt: number,
      recptnDt?: string,
      nowIso?: string,
    ) => {
      process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY = 'test-key';
      if (nowIso) jest.useFakeTimers().setSystemTime(new Date(nowIso));
      const item: Record<string, unknown> = {
        trainLineNm: '소요산행',
        barvlDt,
        btrainNo: 'T001',
        updnLine: '상행',
      };
      if (recptnDt !== undefined) item.recptnDt = recptnDt;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ realtimeArrivalList: [item] }),
      } as Response);
    };

    afterEach(() => {
      jest.useRealTimers();
      delete process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY;
    });

    it('recptnDt가 30초 전이면 barvlDt에서 30초가 차감된다', async () => {
      mockArrivalAt(120, '2026-05-12 12:00:00', '2026-05-12T03:00:30Z');
      const result = await fetchArrivalInfo('강남');
      expect(result.up[0].arrivalSeconds).toBe(90);
      expect(result.up[0].arrivalMinutes).toBe(1);
      expect(result.up[0].receivedAtMs).toBe(Date.parse('2026-05-12T03:00:00Z'));
    });

    it('recptnDt가 누락되면 보정 없이 raw barvlDt를 사용한다', async () => {
      mockArrivalAt(120);
      const result = await fetchArrivalInfo('강남');
      expect(result.up[0].arrivalSeconds).toBe(120);
      expect(result.up[0].receivedAtMs).toBe(0);
    });

    it('보정량이 barvlDt를 초과하면 0으로 클램프된다', async () => {
      // 90초 전(cap 이내) + barvlDt=60 → 음수 → 0
      mockArrivalAt(60, '2026-05-12 12:00:00', '2026-05-12T03:01:30Z');
      const result = await fetchArrivalInfo('강남');
      expect(result.up[0].arrivalSeconds).toBe(0);
      expect(result.up[0].arrivalMinutes).toBe(0);
    });

    it('recptnDt가 미래 시각(시계 어긋남)이면 보정 없이 raw 값을 사용한다', async () => {
      mockArrivalAt(120, '2026-05-12 12:00:10', '2026-05-12T03:00:00Z');
      const result = await fetchArrivalInfo('강남');
      expect(result.up[0].arrivalSeconds).toBe(120);
    });

    it('drift가 MAX_RECPTN_DRIFT_SEC(120s) 초과면 stale로 강등(보정 없음, receivedAtMs=0)', async () => {
      // 5분(300s) 전 — cap 초과
      mockArrivalAt(600, '2026-05-12 12:00:00', '2026-05-12T03:05:00Z');
      const result = await fetchArrivalInfo('강남');
      expect(result.up[0].arrivalSeconds).toBe(600);
      expect(result.up[0].receivedAtMs).toBe(0);
    });

    it('parseRecptnDt: 정상 KST 문자열을 epoch ms로 변환한다', () => {
      expect(parseRecptnDt('2026-05-12 12:00:00')).toBe(Date.parse('2026-05-12T03:00:00Z'));
    });

    it('parseRecptnDt: 비문자열·빈 문자열·잘못된 포맷은 0을 반환한다', () => {
      expect(parseRecptnDt(undefined)).toBe(0);
      expect(parseRecptnDt(null)).toBe(0);
      expect(parseRecptnDt(12345)).toBe(0);
      expect(parseRecptnDt('')).toBe(0);
      expect(parseRecptnDt('not-a-date')).toBe(0);
    });

    it('arvlCd: number / 숫자문자열 / 누락 / 비숫자 매핑', async () => {
      process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY = 'test-key';
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          realtimeArrivalList: [
            { trainLineNm: 'A', barvlDt: 60, btrainNo: 'T1', updnLine: '상행', arvlCd: 1 },
            { trainLineNm: 'B', barvlDt: 60, btrainNo: 'T2', updnLine: '상행', arvlCd: '0' },
            { trainLineNm: 'C', barvlDt: 60, btrainNo: 'T3', updnLine: '상행' },
            { trainLineNm: 'D', barvlDt: 60, btrainNo: 'T4', updnLine: '상행', arvlCd: 'abc' },
          ],
        }),
      } as Response);

      const result = await fetchArrivalInfo('강남', { maxPerDirection: 4 });
      expect(result.up.map((i) => i.arrivalCode)).toEqual([1, 0, -1, -1]);
    });

    it('realtimeArrivalList가 빈 배열이면 Mock으로 fallback', async () => {
      process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY = 'test-key';
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ realtimeArrivalList: [] }),
      } as Response);

      const result = await fetchArrivalInfo('강남');
      expect(result.isMock).toBe(true);
    });
  });

  it('trainLineNm, barvlDt, btrainNo가 undefined이면 기본값을 사용한다', async () => {
    process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY = 'test-key';

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        realtimeArrivalList: [
          { updnLine: '상행' }, // 모든 선택 필드 누락
        ],
      }),
    } as Response);

    const result = await fetchArrivalInfo('강남');
    expect(result.up[0].destination).toBe('');
    expect(result.up[0].arrivalMinutes).toBe(0);
    expect(result.up[0].arrivalSeconds).toBe(0);
    expect(result.up[0].statusMessage).toBe('');
    expect(result.up[0].trainCode).toBe('');

    delete process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY;
  });
});
