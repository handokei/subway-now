import { fetchAnchorDepartures } from '../anchorDepartures';

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe('fetchAnchorDepartures (#3155)', () => {
  it('GET /trips/:token/anchor-departures 200 → 앵커/노선/출발 열차 반환', async () => {
    const departed = [{ trainCode: '2011', departedAt: 1_792_445_788_000, currentStation: '건대입구' }];
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({ ok: true, station: '건대입구', line: '2', departed }),
    );
    const view = await fetchAnchorDepartures('tk', 'https://api.test.dev/', fetchImpl);
    expect(view).toEqual({ station: '건대입구', line: '2', departed });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.test.dev/trips/tk/anchor-departures');
    expect(init.method).toBe('GET');
  });

  it('앵커를 모르는 backend 응답({ ok, departed: [] })은 null — 섹션 없음', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ ok: true, departed: [] }));
    expect(await fetchAnchorDepartures('tk', 'https://api.test.dev', fetchImpl)).toBeNull();
  });

  it('필드 부재(구버전 backend 형태)/비정상 body는 null', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ ok: true }));
    expect(await fetchAnchorDepartures('tk', 'https://api.test.dev', fetchImpl)).toBeNull();
    const notObject = jest.fn().mockResolvedValue(jsonResponse('x'));
    expect(await fetchAnchorDepartures('tk', 'https://api.test.dev', notObject)).toBeNull();
  });

  it('형식이 틀린 행은 버리고 나머지만 반환', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({
        station: '건대입구',
        line: '2',
        departed: [
          { trainCode: '2011', departedAt: 1000, currentStation: '성수' },
          { trainCode: 2007, departedAt: 900, currentStation: null },
          { trainCode: '2005', departedAt: 'x', currentStation: null },
          { trainCode: '2003', departedAt: 800, currentStation: 5 },
          null,
        ],
      }),
    );
    const view = await fetchAnchorDepartures('tk', 'https://api.test.dev', fetchImpl);
    expect(view?.departed).toEqual([
      { trainCode: '2011', departedAt: 1000, currentStation: '성수' },
      { trainCode: '2003', departedAt: 800, currentStation: null },
    ]);
  });

  it('404/5xx는 throw 없이 null', async () => {
    expect(
      await fetchAnchorDepartures('tk', 'https://api.test.dev', jest.fn().mockResolvedValue(jsonResponse({}, 404))),
    ).toBeNull();
    expect(
      await fetchAnchorDepartures('tk', 'https://api.test.dev', jest.fn().mockResolvedValue(jsonResponse({}, 503))),
    ).toBeNull();
  });

  it('네트워크 오류/JSON 파싱 오류도 throw 없이 null', async () => {
    expect(
      await fetchAnchorDepartures('tk', 'https://api.test.dev', jest.fn().mockRejectedValue(new Error('net'))),
    ).toBeNull();
    const badJson = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => { throw new Error('bad'); } });
    expect(await fetchAnchorDepartures('tk', 'https://api.test.dev', badJson)).toBeNull();
  });
});
