import { BffArrivalProvider } from '../BffArrivalProvider';
import type { StationArrival } from '../../../api/arrivalApi';
import type { ArrivalOptions } from '../../types';

describe('BffArrivalProvider', () => {
  const BASE_URL = 'https://bff.example.com';
  let provider: BffArrivalProvider;

  const VALID_DATA: StationArrival = {
    up: [{ destination: '서울역', arrivalMinutes: 3, arrivalSeconds: 180, statusMessage: '', trainCode: 'UP-001', receivedAtMs: 0, arrivalCode: -1, isLastTrain: false, trainType: 'normal' }],
    down: [{ destination: '인천역', arrivalMinutes: 5, arrivalSeconds: 300, statusMessage: '', trainCode: 'DN-001', receivedAtMs: 0, arrivalCode: -1, isLastTrain: false, trainType: 'normal' }],
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
    // schedule fallback이 closed 시간대에 빈 배열을 반환하지 않도록 KST 15:00 weekday 고정.
    jest.setSystemTime(new Date('2026-05-18T06:00:00Z'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('정상 응답 시 도착 데이터를 source=realtime과 함께 반환한다', async () => {
    mockFetchOk(VALID_DATA);
    const result = await callGetArrival();
    expect(result).toEqual({ ...VALID_DATA, source: 'realtime' });
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

  it('응답이 ok가 아니면 schedule fallback으로 전환한다', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 500 });
    const result = await callGetArrival();
    expect(result.source).toBe('schedule');
    expect(result.isMock).toBe(true);
  });

  it('up/down 모두 빈 배열이면 schedule fallback으로 전환한다', async () => {
    mockFetchOk({ up: [], down: [] });
    const result = await callGetArrival();
    expect(result.source).toBe('schedule');
  });

  it('lineHint를 schedule fallback에 전달한다', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 503 });
    const result = await callGetArrival('서울역', { lineHint: '4' });
    expect(result.source).toBe('schedule');
    // 4호선 평일 offPeak headway 360s → wall-clock anchor 기반이라 (0, 360] 범위
    expect(result.up[0].arrivalSeconds).toBeGreaterThan(0);
    expect(result.up[0].arrivalSeconds).toBeLessThanOrEqual(360);
  });

  it.each([
    { label: 'up만 있을 때', data: { up: VALID_DATA.up, down: [] } },
    { label: 'down만 있을 때', data: { up: [], down: VALID_DATA.down } },
  ])('한 방향($label)에만 데이터가 있으면 source=realtime으로 표시', async ({ data }) => {
    mockFetchOk(data);
    const result = await callGetArrival();
    expect(result.up).toEqual(data.up);
    expect(result.down).toEqual(data.down);
    expect(result.source).toBe('realtime');
  });

  it('fetch 에러 시 schedule fallback으로 전환한다', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));
    const result = await callGetArrival();
    expect(result.source).toBe('schedule');
  });

  it('타임아웃 abort 시 schedule fallback으로 전환한다', async () => {
    (global.fetch as jest.Mock).mockImplementationOnce(
      () => new Promise((_, reject) => {
        setTimeout(() => reject(new DOMException('Aborted', 'AbortError')), 6000);
      }),
    );

    const resultPromise = provider.getArrival('강남', { timeoutMs: 100 });
    jest.runAllTimers();
    const result = await resultPromise;

    expect(result.source).toBe('schedule');
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
