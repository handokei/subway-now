import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSeoulCaptureRecorder,
  flushSeoulCapture,
  buildSeoulCaptureKey,
  type SeoulCaptureCycle,
} from '../seoulCapture';

const API_KEY = 'secret-key-123';

function makeResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createSeoulCaptureRecorder', () => {
  it('arrival URL을 kind=arrival + target(역명, decodeURIComponent)로 파싱', async () => {
    const baseFetch = vi.fn().mockResolvedValue(makeResponse('{"ok":true}'));
    vi.stubGlobal('fetch', baseFetch);
    const recorder = createSeoulCaptureRecorder(API_KEY, () => 1000);

    await recorder.fetchImpl(
      `http://example.com/api/subway/${API_KEY}/json/realtimeStationArrival/0/10/%EA%B5%90%EB%8C%80`,
    );

    expect(recorder.entries).toHaveLength(1);
    expect(recorder.entries[0]).toMatchObject({
      tMs: 1000,
      kind: 'arrival',
      target: '교대',
      status: 200,
      body: '{"ok":true}',
    });
  });

  it('position URL을 kind=position + target(호선명)로 파싱', async () => {
    const baseFetch = vi.fn().mockResolvedValue(makeResponse('{"list":[]}'));
    vi.stubGlobal('fetch', baseFetch);
    const recorder = createSeoulCaptureRecorder(API_KEY, () => 2000);

    await recorder.fetchImpl(
      `http://example.com/api/subway/${API_KEY}/json/realtimePosition/0/100/2%ED%98%B8%EC%84%A0`,
    );

    expect(recorder.entries).toHaveLength(1);
    expect(recorder.entries[0]).toMatchObject({ kind: 'position', target: '2호선', status: 200 });
  });

  it('URL에서 apiKey를 *** 로 마스킹해 저장한다 — 원문 SEOUL_API_KEY 부재', async () => {
    const baseFetch = vi.fn().mockResolvedValue(makeResponse('{}'));
    vi.stubGlobal('fetch', baseFetch);
    const recorder = createSeoulCaptureRecorder(API_KEY, () => 1000);

    await recorder.fetchImpl(
      `http://example.com/api/subway/${API_KEY}/json/realtimeStationArrival/0/10/역`,
    );

    expect(recorder.entries[0].url).not.toContain(API_KEY);
    expect(recorder.entries[0].url).toContain('***');
  });

  it('apiKey가 빈 문자열이면 마스킹 없이 URL을 그대로 저장한다', async () => {
    const baseFetch = vi.fn().mockResolvedValue(makeResponse('{}'));
    vi.stubGlobal('fetch', baseFetch);
    const recorder = createSeoulCaptureRecorder('', () => 1000);

    await recorder.fetchImpl('http://example.com/api/subway//json/realtimeStationArrival/0/10/역');

    expect(recorder.entries[0].url).toBe(
      'http://example.com/api/subway//json/realtimeStationArrival/0/10/역',
    );
  });

  it('미매칭 URL(kind 분류 불가)은 캡처 skip하고 위임만 한다', async () => {
    const baseFetch = vi.fn().mockResolvedValue(makeResponse('{}'));
    vi.stubGlobal('fetch', baseFetch);
    const recorder = createSeoulCaptureRecorder(API_KEY, () => 1000);

    const response = await recorder.fetchImpl('http://example.com/unrelated/path');

    expect(recorder.entries).toHaveLength(0);
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
  });

  it('fetch throw 시 status=0/body=빈 문자열로 entry를 남기고 원래 예외를 재throw', async () => {
    const err = new Error('network down');
    const baseFetch = vi.fn().mockRejectedValue(err);
    vi.stubGlobal('fetch', baseFetch);
    const recorder = createSeoulCaptureRecorder(API_KEY, () => 1000);

    await expect(
      recorder.fetchImpl(`http://example.com/api/subway/${API_KEY}/json/realtimeStationArrival/0/10/역`),
    ).rejects.toThrow('network down');

    expect(recorder.entries).toHaveLength(1);
    expect(recorder.entries[0]).toMatchObject({ status: 0, body: '' });
  });

  it('entries 200개 상한 — 초과 요청은 캡처하지 않고 droppedEntries를 증가시킨다', async () => {
    const baseFetch = vi.fn().mockResolvedValue(makeResponse('{}'));
    vi.stubGlobal('fetch', baseFetch);
    const recorder = createSeoulCaptureRecorder(API_KEY, () => 1000);

    for (let i = 0; i < 203; i++) {
      await recorder.fetchImpl(
        `http://example.com/api/subway/${API_KEY}/json/realtimeStationArrival/0/10/역${i}`,
      );
    }

    expect(recorder.entries).toHaveLength(200);
    expect(recorder.droppedEntries).toBe(3);
    expect(baseFetch).toHaveBeenCalledTimes(203);
  });

  it('entries 상한 초과 상태에서 fetch가 throw해도 droppedEntries를 증가시킨다', async () => {
    const baseFetch = vi.fn().mockResolvedValue(makeResponse('{}'));
    vi.stubGlobal('fetch', baseFetch);
    const recorder = createSeoulCaptureRecorder(API_KEY, () => 1000);

    for (let i = 0; i < 200; i++) {
      await recorder.fetchImpl(
        `http://example.com/api/subway/${API_KEY}/json/realtimeStationArrival/0/10/역${i}`,
      );
    }
    baseFetch.mockRejectedValueOnce(new Error('network down'));

    await expect(
      recorder.fetchImpl(`http://example.com/api/subway/${API_KEY}/json/realtimeStationArrival/0/10/역over`),
    ).rejects.toThrow('network down');

    expect(recorder.entries).toHaveLength(200);
    expect(recorder.droppedEntries).toBe(1);
  });

  it('body 바이트(UTF-8) 합계 4MB 초과 시 이후 entry는 body를 비우고 truncated:true + droppedEntries 증가', async () => {
    const bigBody = 'x'.repeat(3 * 1024 * 1024);
    const baseFetch = vi.fn().mockResolvedValue(makeResponse(bigBody));
    vi.stubGlobal('fetch', baseFetch);
    const recorder = createSeoulCaptureRecorder(API_KEY, () => 1000);

    await recorder.fetchImpl(`http://example.com/api/subway/${API_KEY}/json/realtimeStationArrival/0/10/역1`);
    await recorder.fetchImpl(`http://example.com/api/subway/${API_KEY}/json/realtimeStationArrival/0/10/역2`);

    expect(recorder.entries[0].truncated).toBeUndefined();
    expect(recorder.entries[1]).toMatchObject({ body: '', truncated: true });
    expect(recorder.droppedEntries).toBe(1);
    expect(recorder.totalBodyBytes).toBe(3 * 1024 * 1024);
  });

  it('byte 예산이 이미 소진된 뒤의 entry는 clone/text 디코드 없이 곧장 truncated entry를 남긴다', async () => {
    const bigBody = 'x'.repeat(4 * 1024 * 1024);
    const cloneSpy = vi.fn();
    const bigResponse = {
      status: 200,
      clone: () => {
        cloneSpy();
        return { text: () => Promise.resolve(bigBody) };
      },
    } as unknown as Response;
    const thirdResponse = {
      status: 200,
      clone: () => {
        cloneSpy();
        return { text: () => Promise.resolve('should-not-be-read') };
      },
    } as unknown as Response;
    const baseFetch = vi.fn().mockResolvedValueOnce(bigResponse).mockResolvedValueOnce(thirdResponse);
    vi.stubGlobal('fetch', baseFetch);
    const recorder = createSeoulCaptureRecorder(API_KEY, () => 1000);

    // 1번째 호출: 4MB 정확히 소진 (totalBodyBytes === MAX_TOTAL_BODY_BYTES).
    await recorder.fetchImpl(`http://example.com/api/subway/${API_KEY}/json/realtimeStationArrival/0/10/역1`);
    expect(cloneSpy).toHaveBeenCalledTimes(1);

    // 2번째 호출: 예산이 이미 꽉 찬 상태 — clone/text를 아예 호출하지 않아야 한다(효율성 리뷰).
    await recorder.fetchImpl(`http://example.com/api/subway/${API_KEY}/json/realtimeStationArrival/0/10/역2`);

    expect(cloneSpy).toHaveBeenCalledTimes(1);
    expect(recorder.entries[1]).toMatchObject({ body: '', truncated: true });
    expect(recorder.droppedEntries).toBe(1);
  });

  it('multi-byte(한글) body는 UTF-16 length가 아닌 UTF-8 byte length로 예산을 소진시킨다', async () => {
    // 한글 1글자 = UTF-16 code unit 1개지만 UTF-8로는 3바이트. code-unit 기준이면 예산을
    // 훨씬 늦게 소진되므로, byte 기준 판정과 구분되는 회귀 테스트.
    const koreanChar = '가'; // UTF-8 3 bytes, UTF-16 1 code unit
    const body = koreanChar.repeat(1024 * 1024); // code-unit length 1,048,576 / byte length 3,145,728
    const baseFetch = vi.fn().mockResolvedValue(makeResponse(body));
    vi.stubGlobal('fetch', baseFetch);
    const recorder = createSeoulCaptureRecorder(API_KEY, () => 1000);

    await recorder.fetchImpl(`http://example.com/api/subway/${API_KEY}/json/realtimeStationArrival/0/10/역`);

    expect(recorder.totalBodyBytes).toBe(body.length * 3);
    expect(recorder.entries[0].body.length).toBe(body.length);
  });

  it('response.text() throw 시 body=빈 문자열로 entry를 남기고(캡처 실패가 cron을 죽이지 않음)', async () => {
    const fakeResponse = {
      status: 200,
      clone: () => ({ text: () => Promise.reject(new Error('body read failed')) }),
    } as unknown as Response;
    const baseFetch = vi.fn().mockResolvedValue(fakeResponse);
    vi.stubGlobal('fetch', baseFetch);
    const recorder = createSeoulCaptureRecorder(API_KEY, () => 1000);

    const result = await recorder.fetchImpl(
      `http://example.com/api/subway/${API_KEY}/json/realtimeStationArrival/0/10/역`,
    );

    expect(result).toBe(fakeResponse);
    expect(recorder.entries[0]).toMatchObject({ status: 200, body: '' });
  });

  it('now 인자 미지정 시 Date.now() fallback', async () => {
    const baseFetch = vi.fn().mockResolvedValue(makeResponse('{}'));
    vi.stubGlobal('fetch', baseFetch);
    const recorder = createSeoulCaptureRecorder(API_KEY);

    await recorder.fetchImpl(`http://example.com/api/subway/${API_KEY}/json/realtimeStationArrival/0/10/역`);

    expect(typeof recorder.entries[0].tMs).toBe('number');
  });
});

describe('flushSeoulCapture', () => {
  it('key = seoul-capture/{YYYY-MM-DD}/{cycleStartMs}.json (UTC) 로 JSON put', async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const r2 = { put } as unknown as R2Bucket;
    const cycle: SeoulCaptureCycle = {
      schemaVersion: 1,
      cycleStartMs: Date.UTC(2026, 8, 13, 3, 0, 0),
      scanned: 2,
      seoulCalls: 3,
      entries: [{ tMs: 1, kind: 'arrival', target: '교대', url: 'u', status: 200, body: '{}' }],
    };

    await flushSeoulCapture(r2, cycle);

    expect(put).toHaveBeenCalledTimes(1);
    const [key, body] = put.mock.calls[0];
    expect(key).toBe(buildSeoulCaptureKey(cycle.cycleStartMs));
    expect(key).toBe(`seoul-capture/2026-09-13/${cycle.cycleStartMs}.json`);
    expect(JSON.parse(body as string)).toEqual(cycle);
  });
});
