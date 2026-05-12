import { fetchTrainPositions, parsePositionRecvTime, MOCK_POSITIONS } from '../positionApi';

describe('fetchTrainPositions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY;
    jest.useRealTimers();
  });

  it('API 키가 없으면 mock 반환 (요청 line 보존)', async () => {
    const result = await fetchTrainPositions('2');
    expect(result.isMock).toBe(true);
    expect(result.line).toBe('2');
    expect(result.trains).toEqual([]);
  });

  const mockApi = (items: unknown[]) => {
    process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY = 'test-key';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ realtimePositionList: items }),
    } as Response);
  };

  it('정상 응답을 TrainPosition[]로 매핑', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-12T03:00:30Z'));
    mockApi([
      {
        statnId: '1002000201',
        statnNm: '강남',
        trainNo: 'T100',
        trainSttus: '1',
        updnLine: '0',
        statnTid: '1002000202',
        statnTnm: '역삼',
        directAt: '1', // 급행
        lstcarAt: '0',
        lastRecptnDt: '2026-05-12',
        recptnDt: '12:00:00',
      },
    ]);

    const result = await fetchTrainPositions('2');
    expect(result.trains).toHaveLength(1);
    const t = result.trains[0];
    expect(t.statnId).toBe('1002000201');
    expect(t.trainStatus).toBe(1);
    expect(t.updnLine).toBe(0);
    expect(t.terminalStationName).toBe('역삼');
    expect(t.trainType).toBe('express');
    expect(t.isLastTrain).toBe(false);
    expect(t.receivedAtMs).toBe(Date.parse('2026-05-12T03:00:00Z'));
  });

  it('lstcarAt: "1" 또는 1 → isLastTrain true', async () => {
    mockApi([
      { statnId: '1', statnNm: 'A', trainNo: 'T1', trainSttus: 1, updnLine: 0, lstcarAt: '1' },
      { statnId: '2', statnNm: 'B', trainNo: 'T2', trainSttus: 1, updnLine: 0, lstcarAt: 1 },
      { statnId: '3', statnNm: 'C', trainNo: 'T3', trainSttus: 1, updnLine: 0 },
    ]);

    const result = await fetchTrainPositions('2');
    expect(result.trains.map((t) => t.isLastTrain)).toEqual([true, true, false]);
  });

  it('directAt: 1=express, 7=rapid, 0/누락=normal', async () => {
    mockApi([
      { statnId: '1', statnNm: 'A', trainNo: 'T', trainSttus: 1, updnLine: 0, directAt: 1 },
      { statnId: '2', statnNm: 'B', trainNo: 'T', trainSttus: 1, updnLine: 0, directAt: 7 },
      { statnId: '3', statnNm: 'C', trainNo: 'T', trainSttus: 1, updnLine: 0, directAt: 0 },
      { statnId: '4', statnNm: 'D', trainNo: 'T', trainSttus: 1, updnLine: 0 },
    ]);

    const result = await fetchTrainPositions('2');
    expect(result.trains.map((t) => t.trainType)).toEqual(['express', 'rapid', 'normal', 'normal']);
  });

  it('drift > 120s면 receivedAtMs=0(stale 강등)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-12T03:05:00Z'));
    mockApi([
      {
        statnId: '1',
        statnNm: 'A',
        trainNo: 'T',
        trainSttus: 1,
        updnLine: 0,
        lastRecptnDt: '2026-05-12',
        recptnDt: '12:00:00',
      },
    ]);
    const result = await fetchTrainPositions('2');
    expect(result.trains[0].receivedAtMs).toBe(0);
  });

  it('빈 리스트 → mock fallback', async () => {
    mockApi([]);
    const result = await fetchTrainPositions('2');
    expect(result.isMock).toBe(true);
  });

  it('HTTP 실패 → mock fallback (line 보존)', async () => {
    process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY = 'test-key';
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 } as Response);
    const result = await fetchTrainPositions('5');
    expect(result.isMock).toBe(true);
    expect(result.line).toBe('5');
  });

  it('네트워크 에러 → mock fallback', async () => {
    process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY = 'test-key';
    global.fetch = jest.fn().mockRejectedValue(new Error('net'));
    const result = await fetchTrainPositions('2');
    expect(result.isMock).toBe(true);
  });

  it('timeout 5s 초과 → mock fallback', async () => {
    process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY = 'test-key';
    jest.useFakeTimers();
    global.fetch = jest.fn().mockImplementation((_url, opts?: RequestInit) => {
      return new Promise((_res, rej) => {
        opts?.signal?.addEventListener('abort', () =>
          rej(new DOMException('aborted', 'AbortError')),
        );
      });
    });
    const promise = fetchTrainPositions('2');
    jest.advanceTimersByTime(5000);
    const result = await promise;
    expect(result.isMock).toBe(true);
  });

  it('trainSttus / updnLine 비숫자 → -1', async () => {
    mockApi([
      { statnId: '1', statnNm: 'A', trainNo: 'T', trainSttus: 'abc', updnLine: 'xyz' },
    ]);
    const result = await fetchTrainPositions('2');
    expect(result.trains[0].trainStatus).toBe(-1);
    expect(result.trains[0].updnLine).toBe(-1);
  });

  it('MOCK_POSITIONS export', () => {
    expect(MOCK_POSITIONS.isMock).toBe(true);
    expect(MOCK_POSITIONS.trains).toEqual([]);
  });

  it('realtimePositionList 누락 → 빈 배열 → mock fallback', async () => {
    process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY = 'test-key';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as Response);
    const result = await fetchTrainPositions('2');
    expect(result.isMock).toBe(true);
  });

  it('trainSttus / updnLine이 number 타입으로 와도 그대로 매핑', async () => {
    mockApi([{ statnId: '1', statnNm: 'A', trainNo: 'T', trainSttus: 2, updnLine: 1 }]);
    const result = await fetchTrainPositions('2');
    expect(result.trains[0].trainStatus).toBe(2);
    expect(result.trains[0].updnLine).toBe(1);
  });

  it('statnId / statnNm / trainNo 누락 시 빈 문자열로 fallback', async () => {
    mockApi([{ trainSttus: 1, updnLine: 0 }]);
    const result = await fetchTrainPositions('2');
    expect(result.trains[0].statnId).toBe('');
    expect(result.trains[0].statnNm).toBe('');
    expect(result.trains[0].trainNo).toBe('');
  });

  it('trainSttus / updnLine이 객체(undefined 외 비스칼라)면 -1', async () => {
    mockApi([
      { statnId: '1', statnNm: 'A', trainNo: 'T', trainSttus: { x: 1 }, updnLine: [] },
    ]);
    const result = await fetchTrainPositions('2');
    expect(result.trains[0].trainStatus).toBe(-1);
    expect(result.trains[0].updnLine).toBe(-1);
  });
});

describe('parsePositionRecvTime', () => {
  it('풀 포맷 recptnDt만 와도 파싱', () => {
    expect(parsePositionRecvTime('', '2026-05-12 12:00:00')).toBe(
      Date.parse('2026-05-12T03:00:00Z'),
    );
  });

  it('lastRecptnDt(날짜) + recptnDt(시각) 조합', () => {
    expect(parsePositionRecvTime('2026-05-12', '12:00:00')).toBe(
      Date.parse('2026-05-12T03:00:00Z'),
    );
  });

  it('비문자열/빈 문자열은 0', () => {
    expect(parsePositionRecvTime(undefined, undefined)).toBe(0);
    expect(parsePositionRecvTime('2026-05-12', '')).toBe(0);
    expect(parsePositionRecvTime(null, null)).toBe(0);
  });

  it('잘못된 포맷은 0', () => {
    expect(parsePositionRecvTime('', 'not-a-date')).toBe(0);
  });
});
