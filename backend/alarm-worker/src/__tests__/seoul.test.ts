import { describe, expect, it, vi } from 'vitest';
import { SeoulArrivalClient, parseRecptnDt, parseTerminusStationName } from '../seoul';
import { matchLine } from '../lineAlias';

function makeResponse(body: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? status : 500,
    headers: { 'content-type': 'application/json' },
  });
}

const FIXED_NOW = Date.parse('2025-01-15T10:30:00+09:00');

// #2355 — 실 Seoul API `realtimeStationArrival`은 subwayNm=null, subwayId만 유효값으로 보낸다
// (rca-2351로 확증). 기존 fixture가 subwayNm 텍스트를 손주입해 empty-pool 회귀를 마스킹했던
// 문제를 실 shape로 교정.
function makeItem(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    barvlDt: '120',
    recptnDt: '2025-01-15 10:30:00',
    updnLine: '상행',
    trainLineNm: '서울행',
    btrainNo: 'T-001',
    subwayNm: null,
    subwayId: '1001',
    ...overrides,
  };
}

describe('parseRecptnDt', () => {
  it('parses valid KST timestamp', () => {
    expect(parseRecptnDt('2025-01-15 10:30:00')).toBe(FIXED_NOW);
  });
  it('returns 0 for empty / invalid', () => {
    expect(parseRecptnDt('')).toBe(0);
    expect(parseRecptnDt(null)).toBe(0);
    expect(parseRecptnDt('not-a-date')).toBe(0);
  });
});

describe('SeoulArrivalClient', () => {
  it('fetches and parses arrivals', async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse({ realtimeArrivalList: [makeItem(), makeItem({ updnLine: '하행' })] }),
    );
    const client = new SeoulArrivalClient({
      apiKey: 'KEY',
      host: 'example.com',
      now: () => FIXED_NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const arrivals = await client.fetchArrivals('서울역');
    expect(arrivals).toHaveLength(2);
    expect(arrivals[0].isUp).toBe(true);
    expect(arrivals[1].isUp).toBe(false);
    expect(arrivals[0].arrivalSeconds).toBe(120);
  });

  it('#2355 — subwayNm=null(실 API shape)이어도 subwayId로 line 복원 → matchLine 통과', async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse({
        realtimeArrivalList: [makeItem({ subwayNm: null, subwayId: '1007' })],
      }),
    );
    const client = new SeoulArrivalClient({
      apiKey: 'KEY',
      host: 'example.com',
      now: () => FIXED_NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const arrivals = await client.fetchArrivals('건대입구');
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0].subwayNm).toBe('7호선');
    expect(arrivals[0].subwayId).toBe('1007');
    // 회귀 재현: 수정 전에는 subwayNm=''로 남아 matchLine이 전량 false.
    expect(matchLine(arrivals[0].subwayNm, '7')).toBe(true);
  });

  it('#2355 — subwayNm이 실값으로 오면 그대로 유지(subwayId 파생 우회 X)', async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse({
        realtimeArrivalList: [makeItem({ subwayNm: '지하철1호선', subwayId: '1001' })],
      }),
    );
    const client = new SeoulArrivalClient({
      apiKey: 'KEY',
      host: 'example.com',
      now: () => FIXED_NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const arrivals = await client.fetchArrivals('서울역');
    expect(arrivals[0].subwayNm).toBe('지하철1호선');
  });

  it('arvlCd 파싱 — number / numeric string / 누락 (#409)', async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse({
        realtimeArrivalList: [
          makeItem({ arvlCd: 0 }),
          makeItem({ arvlCd: '1' }),
          makeItem({ arvlCd: 'invalid' }),
          makeItem(), // arvlCd 누락
        ],
      }),
    );
    const client = new SeoulArrivalClient({
      apiKey: 'KEY',
      host: 'example.com',
      now: () => FIXED_NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const arrivals = await client.fetchArrivals('서울역');
    expect(arrivals[0].arvlCd).toBe(0);
    expect(arrivals[1].arvlCd).toBe(1);
    expect(arrivals[2].arvlCd).toBeNull();
    expect(arrivals[3].arvlCd).toBeNull();
  });

  it('caches within TTL', async () => {
    const fetchImpl = vi.fn(async () => makeResponse({ realtimeArrivalList: [makeItem()] }));
    let now = FIXED_NOW;
    const client = new SeoulArrivalClient({
      apiKey: 'KEY',
      host: 'example.com',
      now: () => now,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.fetchArrivals('서울역');
    await client.fetchArrivals('서울역');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // 16s 후엔 캐시 만료
    now += 16_000;
    await client.fetchArrivals('서울역');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns empty array on http error and short-caches', async () => {
    const fetchImpl = vi.fn(async () => makeResponse({}, false, 500));
    const client = new SeoulArrivalClient({
      apiKey: 'KEY',
      host: 'example.com',
      now: () => FIXED_NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const arrivals = await client.fetchArrivals('서울역');
    expect(arrivals).toEqual([]);
    // 두 번째 호출은 캐시 hit
    await client.fetchArrivals('서울역');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('handles malformed item gracefully', async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse({ realtimeArrivalList: [null, 'not-an-object', makeItem()] }),
    );
    const client = new SeoulArrivalClient({
      apiKey: 'KEY',
      host: 'example.com',
      now: () => FIXED_NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const arrivals = await client.fetchArrivals('서울역');
    expect(arrivals).toHaveLength(1);
  });

  describe('#2328 — btrainSttus(급행) + trainLineNm(행선지) 파싱', () => {
    it('parses btrainSttus into trainType', async () => {
      const fetchImpl = vi.fn(async () =>
        makeResponse({
          realtimeArrivalList: [
            makeItem({ btrainSttus: '급행' }),
            makeItem({ btrainSttus: 'ITX' }),
            makeItem({ btrainSttus: '특급' }),
            makeItem({ btrainSttus: undefined }),
          ],
        }),
      );
      const client = new SeoulArrivalClient({
        apiKey: 'KEY',
        host: 'example.com',
        now: () => FIXED_NOW,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const arrivals = await client.fetchArrivals('서울역');
      expect(arrivals[0].trainType).toBe('express');
      expect(arrivals[1].trainType).toBe('itx');
      expect(arrivals[2].trainType).toBe('rapid');
      expect(arrivals[3].trainType).toBe('normal');
    });

    it('parses trainLineNm into terminus station name', async () => {
      const fetchImpl = vi.fn(async () =>
        makeResponse({
          realtimeArrivalList: [
            makeItem({ trainLineNm: '성수행' }),
            makeItem({ trainLineNm: '내선순환' }),
            makeItem({ trainLineNm: '외선순환' }),
            makeItem({ trainLineNm: '장암방면' }),
          ],
        }),
      );
      const client = new SeoulArrivalClient({
        apiKey: 'KEY',
        host: 'example.com',
        now: () => FIXED_NOW,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const arrivals = await client.fetchArrivals('서울역');
      expect(arrivals[0].terminus).toBe('성수');
      expect(arrivals[1].terminus).toBeNull();
      expect(arrivals[2].terminus).toBeNull();
      expect(arrivals[3].terminus).toBe('장암');
    });
  });

  describe('parseTerminusStationName', () => {
    it('strips 행 suffix', () => {
      expect(parseTerminusStationName('성수행')).toBe('성수');
    });
    it('strips 방면 suffix', () => {
      expect(parseTerminusStationName('장암방면')).toBe('장암');
    });
    it('returns null for loop-line direction tokens', () => {
      expect(parseTerminusStationName('내선순환')).toBeNull();
      expect(parseTerminusStationName('외선순환')).toBeNull();
    });
    it('returns null for unrecognized formats', () => {
      expect(parseTerminusStationName('')).toBeNull();
      expect(parseTerminusStationName('알수없음')).toBeNull();
      expect(parseTerminusStationName('행')).toBeNull();
      expect(parseTerminusStationName('방면')).toBeNull();
    });
  });

  it('applies recptnDt drift correction and demotes stale data', async () => {
    const staleItem = makeItem({
      barvlDt: '120',
      // 200초 전 데이터 → drift > 120s → stale 처리, drift 보정 없음
      recptnDt: '2025-01-15 10:26:40',
    });
    const fetchImpl = vi.fn(async () => makeResponse({ realtimeArrivalList: [staleItem] }));
    const client = new SeoulArrivalClient({
      apiKey: 'KEY',
      host: 'example.com',
      now: () => FIXED_NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const arrivals = await client.fetchArrivals('서울역');
    expect(arrivals[0].arrivalSeconds).toBe(120);
  });

  describe('fetchPositions (#585)', () => {
    // #2746 — realtimePosition의 updnLine은 realtimeStationArrival(한글 '상행'/'하행')과 달리
    // 숫자 문자열('0'/'1')이다. R2 실캡처(seoul-capture/2026-09-17) trainCode 8387/2389/7355등
    // 교차 대조로 확정: '0'=상행/내선, '1'=하행/외선.
    function makePositionItem(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
      return {
        trainNo: '7246',
        statnNm: '중곡',
        trainSttus: 1,
        updnLine: '0',
        lastRecptnDt: '2025-01-15 10:30:00',
        ...overrides,
      };
    }

    it('parses position list for known line', async () => {
      const fetchImpl = vi.fn(async () =>
        makeResponse({ realtimePositionList: [makePositionItem(), makePositionItem({ trainNo: '7248', updnLine: '1' })] }),
      );
      const client = new SeoulArrivalClient({
        apiKey: 'KEY',
        host: 'example.com',
        now: () => FIXED_NOW,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const positions = await client.fetchPositions('7');
      expect(positions).toHaveLength(2);
      expect(positions[0].trainCode).toBe('7246');
      expect(positions[0].stationName).toBe('중곡');
      expect(positions[0].trainSttus).toBe(1);
      expect(positions[0].isUp).toBe(true);
      expect(positions[1].isUp).toBe(false);
      expect(positions[0].recptnMs).toBe(FIXED_NOW);
    });

    it('#2746 — updnLine="0"(숫자, 상행/내선)을 isUp:true로 판정한다 (한글 매칭이 아니라 숫자 코드 매칭이어야 통과)', async () => {
      const fetchImpl = vi.fn(async () =>
        makeResponse({ realtimePositionList: [makePositionItem({ trainNo: '7246', updnLine: '0' })] }),
      );
      const client = new SeoulArrivalClient({
        apiKey: 'KEY',
        host: 'example.com',
        now: () => FIXED_NOW,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const positions = await client.fetchPositions('7');
      expect(positions[0].isUp).toBe(true);
    });

    it('#2746 — updnLine="1"(숫자, 하행/외선)을 isUp:false로 판정한다', async () => {
      const fetchImpl = vi.fn(async () =>
        makeResponse({ realtimePositionList: [makePositionItem({ trainNo: '7248', updnLine: '1' })] }),
      );
      const client = new SeoulArrivalClient({
        apiKey: 'KEY',
        host: 'example.com',
        now: () => FIXED_NOW,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const positions = await client.fetchPositions('7');
      expect(positions[0].isUp).toBe(false);
    });

    it('#2746 — R2 실캡처 대조: 같은 trainCode(8387)가 arrival(한글 "외선")과 position(숫자 "1") 양쪽에서 같은 방향(하행)으로 해석된다', async () => {
      // seoul-capture/2026-09-17/1789642190359.json 실측: trainCode 8387 → arrival.updnLine="외선", position.updnLine="1"
      const fetchArrivalImpl = vi.fn(async () =>
        makeResponse({ realtimeArrivalList: [makeItem({ updnLine: '외선', btrainNo: '8387' })] }),
      );
      const arrivalClient = new SeoulArrivalClient({
        apiKey: 'KEY',
        host: 'example.com',
        now: () => FIXED_NOW,
        fetchImpl: fetchArrivalImpl as unknown as typeof fetch,
      });
      const arrivals = await arrivalClient.fetchArrivals('건대입구');
      expect(arrivals[0].isUp).toBe(false);

      const fetchPositionImpl = vi.fn(async () =>
        makeResponse({ realtimePositionList: [makePositionItem({ trainNo: '8387', updnLine: '1' })] }),
      );
      const positionClient = new SeoulArrivalClient({
        apiKey: 'KEY',
        host: 'example.com',
        now: () => FIXED_NOW,
        fetchImpl: fetchPositionImpl as unknown as typeof fetch,
      });
      const positions = await positionClient.fetchPositions('2');
      expect(positions[0].isUp).toBe(false);
      // 두 엔드포인트가 같은 trainCode를 같은 방향으로 해석해야 한다
      expect(positions[0].isUp).toBe(arrivals[0].isUp);
    });

    it('#2746 — 알 수 없는 updnLine 값은 방향 판정에서 제외되고(null 반환) 카운터로 관측된다 (조용히 false로 떨어뜨리지 않는다)', async () => {
      const fetchImpl = vi.fn(async () =>
        makeResponse({
          realtimePositionList: [
            makePositionItem({ trainNo: '7246', updnLine: '0' }),
            makePositionItem({ trainNo: '9999', updnLine: '상행' }), // 옛 한글 오염 값 — 숫자 파서 기준 미지
            makePositionItem({ trainNo: '8888', updnLine: '' }),
          ],
        }),
      );
      const client = new SeoulArrivalClient({
        apiKey: 'KEY',
        host: 'example.com',
        now: () => FIXED_NOW,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const positions = await client.fetchPositions('7');
      // 미지 값 항목(9999, 8888)은 방향 판정 대상에서 제외 — 결과 목록에 없어야 한다
      expect(positions).toHaveLength(1);
      expect(positions[0].trainCode).toBe('7246');
      expect(client.stats.positionUnknownDirectionCount).toBe(2);
    });

    it('returns empty array for unmapped line (no API call)', async () => {
      const fetchImpl = vi.fn();
      const client = new SeoulArrivalClient({
        apiKey: 'KEY',
        host: 'example.com',
        now: () => FIXED_NOW,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const positions = await client.fetchPositions('unknown-line');
      expect(positions).toEqual([]);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('caches positions within TTL', async () => {
      const fetchImpl = vi.fn(async () => makeResponse({ realtimePositionList: [makePositionItem()] }));
      let now = FIXED_NOW;
      const client = new SeoulArrivalClient({
        apiKey: 'KEY',
        host: 'example.com',
        now: () => now,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      await client.fetchPositions('7');
      await client.fetchPositions('7');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      now += 16_000;
      await client.fetchPositions('7');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('returns empty + short-caches on http error', async () => {
      const fetchImpl = vi.fn(async () => makeResponse({}, false, 500));
      const client = new SeoulArrivalClient({
        apiKey: 'KEY',
        host: 'example.com',
        now: () => FIXED_NOW,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(await client.fetchPositions('7')).toEqual([]);
      await client.fetchPositions('7');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('#2328 — parses directAt(급행) + statnTnm(행선지) into trainType/terminus', async () => {
      const fetchImpl = vi.fn(async () =>
        makeResponse({
          realtimePositionList: [
            makePositionItem({ trainNo: '7246', directAt: '1', statnTnm: '장암' }),
            makePositionItem({ trainNo: '7248', directAt: '7', statnTnm: '' }),
            makePositionItem({ trainNo: '7250', directAt: '0' }),
          ],
        }),
      );
      const client = new SeoulArrivalClient({
        apiKey: 'KEY',
        host: 'example.com',
        now: () => FIXED_NOW,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const positions = await client.fetchPositions('7');
      expect(positions[0].trainType).toBe('express');
      expect(positions[0].terminus).toBe('장암');
      expect(positions[1].trainType).toBe('rapid');
      expect(positions[1].terminus).toBeNull();
      expect(positions[2].trainType).toBe('normal');
      expect(positions[2].terminus).toBeNull();
    });

    it('skips malformed items (null, no trainNo, non-object)', async () => {
      const fetchImpl = vi.fn(async () =>
        makeResponse({
          realtimePositionList: [
            null,
            'string-item',
            { statnNm: '중곡' }, // missing trainNo
            { trainNo: 123 }, // wrong type
            makePositionItem(),
          ],
        }),
      );
      const client = new SeoulArrivalClient({
        apiKey: 'KEY',
        host: 'example.com',
        now: () => FIXED_NOW,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const positions = await client.fetchPositions('7');
      expect(positions).toHaveLength(1);
    });

    it('handles missing realtimePositionList field', async () => {
      const fetchImpl = vi.fn(async () => makeResponse({}));
      const client = new SeoulArrivalClient({
        apiKey: 'KEY',
        host: 'example.com',
        now: () => FIXED_NOW,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(await client.fetchPositions('7')).toEqual([]);
    });

    it('defaults trainSttus / stationName when missing', async () => {
      // #2746 — updnLine 누락은 "미지 값"으로 취급돼 항목 자체가 제외되므로(방향 판정 오염 방지),
      // 이 케이스에선 유효한 updnLine('0')을 명시해 stationName/trainSttus/recptnMs 기본값만 검증한다.
      const fetchImpl = vi.fn(async () =>
        makeResponse({ realtimePositionList: [{ trainNo: '7246', updnLine: '0' }] }),
      );
      const client = new SeoulArrivalClient({
        apiKey: 'KEY',
        host: 'example.com',
        now: () => FIXED_NOW,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const positions = await client.fetchPositions('7');
      expect(positions[0].stationName).toBe('');
      expect(positions[0].trainSttus).toBeNull();
      expect(positions[0].recptnMs).toBe(0);
    });

    it('#2746 — updnLine 누락 항목은 제외되고 카운터가 증가한다', async () => {
      const fetchImpl = vi.fn(async () =>
        makeResponse({ realtimePositionList: [{ trainNo: '7246' }] }),
      );
      const client = new SeoulArrivalClient({
        apiKey: 'KEY',
        host: 'example.com',
        now: () => FIXED_NOW,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const positions = await client.fetchPositions('7');
      expect(positions).toHaveLength(0);
      expect(client.stats.positionUnknownDirectionCount).toBe(1);
    });
  });

  it('tracks call count', async () => {
    const fetchImpl = vi.fn(async () => makeResponse({ realtimeArrivalList: [] }));
    const client = new SeoulArrivalClient({
      apiKey: 'KEY',
      host: 'example.com',
      now: () => FIXED_NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.fetchArrivals('A');
    await client.fetchArrivals('B');
    expect(client.stats.callCount).toBe(2);
    expect(client.stats.cacheSize).toBe(2);
  });

  describe('httpErrorCount (#1663 Seoul outage detection)', () => {
    it('starts at 0 for successful fetches', async () => {
      const fetchImpl = vi.fn(async () => makeResponse({ realtimeArrivalList: [] }));
      const client = new SeoulArrivalClient({
        apiKey: 'KEY',
        host: 'example.com',
        now: () => FIXED_NOW,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      await client.fetchArrivals('서울역');
      expect(client.stats.httpErrorCount).toBe(0);
    });

    it('increments on fetchArrivals HTTP error', async () => {
      const fetchImpl = vi.fn(async () => makeResponse({}, false, 500));
      const client = new SeoulArrivalClient({
        apiKey: 'KEY',
        host: 'example.com',
        now: () => FIXED_NOW,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      await client.fetchArrivals('서울역');
      expect(client.stats.httpErrorCount).toBe(1);
    });

    it('increments on fetchPositions HTTP error', async () => {
      const fetchImpl = vi.fn(async () => makeResponse({}, false, 503));
      const client = new SeoulArrivalClient({
        apiKey: 'KEY',
        host: 'example.com',
        now: () => FIXED_NOW,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      await client.fetchPositions('7');
      expect(client.stats.httpErrorCount).toBe(1);
    });

    it('accumulates across multiple failed calls', async () => {
      const fetchImpl = vi.fn(async () => makeResponse({}, false, 500));
      const client = new SeoulArrivalClient({
        apiKey: 'KEY',
        host: 'example.com',
        now: () => FIXED_NOW,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      await client.fetchArrivals('서울역');
      // second call hits cache (short error cache), no new HTTP error
      await client.fetchArrivals('서울역');
      await client.fetchArrivals('다른역'); // different station — new HTTP call
      expect(client.stats.httpErrorCount).toBe(2);
    });

    it('does not count cached error responses as new HTTP errors', async () => {
      let callCount = 0;
      const fetchImpl = vi.fn(async () => {
        callCount += 1;
        return makeResponse({}, false, 500);
      });
      const client = new SeoulArrivalClient({
        apiKey: 'KEY',
        host: 'example.com',
        now: () => FIXED_NOW,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      await client.fetchArrivals('서울역');
      await client.fetchArrivals('서울역'); // cached — no HTTP call
      expect(callCount).toBe(1);
      expect(client.stats.httpErrorCount).toBe(1);
    });
  });
});
