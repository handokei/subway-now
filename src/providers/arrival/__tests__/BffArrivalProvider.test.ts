import { BffArrivalProvider } from '../BffArrivalProvider';
import { MOCK_ARRIVALS } from '../../../api/arrivalApi';
import type { StationArrival } from '../../../api/arrivalApi';
import type { ArrivalOptions } from '../../types';

describe('BffArrivalProvider', () => {
  const BASE_URL = 'https://bff.example.com';
  let provider: BffArrivalProvider;

  const VALID_DATA: StationArrival = {
    up: [{ destination: '서울역', arrivalMinutes: 3, trainCode: 'UP-001' }],
    down: [{ destination: '인천역', arrivalMinutes: 5, trainCode: 'DN-001' }],
  };

  function mockFetchOk(data: StationArrival) {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: jest.fn().mockResolvedValueOnce(data),
    });
  }

  async function callGetArrival(station = '강남', options?: ArrivalOptions) {
    const resultPromise = provider.getArrival(station, options);
    jest.runAllTimersAsync();
    return resultPromise;
  }

  beforeEach(() => {
    provider = new BffArrivalProvider(BASE_URL);
    global.fetch = jest.fn();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('정상 응답 시 도착 데이터를 반환한다', async () => {
    mockFetchOk(VALID_DATA);
    const result = await callGetArrival();
    expect(result).toEqual(VALID_DATA);
  });

  it('기본 옵션으로 올바른 URL을 호출한다', async () => {
    mockFetchOk(VALID_DATA);
    await callGetArrival();

    expect(global.fetch).toHaveBeenCalledWith(
      `${BASE_URL}/api/arrival/${encodeURIComponent('강남')}?maxPerDirection=2`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('커스텀 maxPerDirection 옵션을 URL에 반영한다', async () => {
    mockFetchOk(VALID_DATA);
    await callGetArrival('홍대입구', { maxPerDirection: 5 });

    expect(global.fetch).toHaveBeenCalledWith(
      `${BASE_URL}/api/arrival/${encodeURIComponent('홍대입구')}?maxPerDirection=5`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('응답이 ok가 아니면 MOCK_ARRIVALS를 반환한다', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 500 });
    const result = await callGetArrival();
    expect(result).toBe(MOCK_ARRIVALS);
  });

  it('up/down 모두 빈 배열이면 MOCK_ARRIVALS를 반환한다', async () => {
    mockFetchOk({ up: [], down: [] });
    const result = await callGetArrival();
    expect(result).toBe(MOCK_ARRIVALS);
  });

  it.each([
    { label: 'up만 있을 때', data: { up: VALID_DATA.up, down: [] } },
    { label: 'down만 있을 때', data: { up: [], down: VALID_DATA.down } },
  ])('한 방향($label)에만 데이터가 있으면 그대로 반환한다', async ({ data }) => {
    mockFetchOk(data);
    const result = await callGetArrival();
    expect(result).toEqual(data);
  });

  it('fetch 에러 시 MOCK_ARRIVALS를 반환한다', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));
    const result = await callGetArrival();
    expect(result).toBe(MOCK_ARRIVALS);
  });

  it('타임아웃 abort 시 MOCK_ARRIVALS를 반환한다', async () => {
    (global.fetch as jest.Mock).mockImplementationOnce(
      () => new Promise((_, reject) => {
        setTimeout(() => reject(new DOMException('Aborted', 'AbortError')), 6000);
      }),
    );

    const resultPromise = provider.getArrival('강남', { timeoutMs: 100 });
    jest.runAllTimers();
    const result = await resultPromise;

    expect(result).toBe(MOCK_ARRIVALS);
  });

  it('특수 문자가 포함된 역명을 URL 인코딩한다', async () => {
    mockFetchOk(VALID_DATA);
    await callGetArrival('서울 역');

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent('서울 역')),
      expect.any(Object),
    );
  });
});
