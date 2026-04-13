import { fetchArrivalInfo, MOCK_ARRIVALS } from '../arrivalApi';

describe('fetchArrivalInfo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('API 키가 없으면 Mock 데이터를 반환한다', async () => {
    delete process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY;

    const result = await fetchArrivalInfo('강남');

    expect(result.up.length).toBeGreaterThan(0);
    expect(result.down.length).toBeGreaterThan(0);
    expect(result.up[0]).toHaveProperty('destination');
    expect(result.up[0]).toHaveProperty('arrivalMinutes');
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
    expect(result.up[0].trainCode).toBe('');

    delete process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY;
  });
});
