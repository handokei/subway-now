import { describe, expect, it, vi } from 'vitest';
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
    vi.unstubAllGlobals();
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
    vi.unstubAllGlobals();
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
    vi.unstubAllGlobals();
  });

  it('apiKey가 빈 문자열이면 마스킹 없이 URL을 그대로 저장한다', async () => {
    const baseFetch = vi.fn().mockResolvedValue(makeResponse('{}'));
    vi.stubGlobal('fetch', baseFetch);
    const recorder = createSeoulCaptureRecorder('', () => 1000);

    await recorder.fetchImpl('http://example.com/api/subway//json/realtimeStationArrival/0/10/역');

    expect(recorder.entries[0].url).toBe(
      'http://example.com/api/subway//json/realtimeStationArrival/0/10/역',
    );
    vi.unstubAllGlobals();
  });

  it('미매칭 URL(kind 분류 불가)은 캡처 skip하고 위임만 한다', async () => {
    const baseFetch = vi.fn().mockResolvedValue(makeResponse('{}'));
    vi.stubGlobal('fetch', baseFetch);
    const recorder = createSeoulCaptureRecorder(API_KEY, () => 1000);

    const response = await recorder.fetchImpl('http://example.com/unrelated/path');

    expect(recorder.entries).toHaveLength(0);
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    vi.unstubAllGlobals();
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
    vi.unstubAllGlobals();
  });

  it('entries 200개 상한 — 초과 요청은 캡처하지 않고 위임만', async () => {
    const baseFetch = vi.fn().mockResolvedValue(makeResponse('{}'));
    vi.stubGlobal('fetch', baseFetch);
    const recorder = createSeoulCaptureRecorder(API_KEY, () => 1000);

    for (let i = 0; i < 201; i++) {
      await recorder.fetchImpl(
        `http://example.com/api/subway/${API_KEY}/json/realtimeStationArrival/0/10/역${i}`,
      );
    }

    expect(recorder.entries).toHaveLength(200);
    expect(baseFetch).toHaveBeenCalledTimes(201);
    vi.unstubAllGlobals();
  });

  it('body 합계 4MB 초과 시 이후 entry는 body를 비우고 truncated:true', async () => {
    const bigBody = 'x'.repeat(3 * 1024 * 1024);
    const baseFetch = vi.fn().mockResolvedValue(makeResponse(bigBody));
    vi.stubGlobal('fetch', baseFetch);
    const recorder = createSeoulCaptureRecorder(API_KEY, () => 1000);

    await recorder.fetchImpl(`http://example.com/api/subway/${API_KEY}/json/realtimeStationArrival/0/10/역1`);
    await recorder.fetchImpl(`http://example.com/api/subway/${API_KEY}/json/realtimeStationArrival/0/10/역2`);

    expect(recorder.entries[0].truncated).toBeUndefined();
    expect(recorder.entries[1]).toMatchObject({ body: '', truncated: true });
    vi.unstubAllGlobals();
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
    vi.unstubAllGlobals();
  });

  it('now 인자 미지정 시 Date.now() fallback', async () => {
    const baseFetch = vi.fn().mockResolvedValue(makeResponse('{}'));
    vi.stubGlobal('fetch', baseFetch);
    const recorder = createSeoulCaptureRecorder(API_KEY);

    await recorder.fetchImpl(`http://example.com/api/subway/${API_KEY}/json/realtimeStationArrival/0/10/역`);

    expect(typeof recorder.entries[0].tMs).toBe('number');
    vi.unstubAllGlobals();
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
      polled: 3,
      entries: [
        { tMs: 1, kind: 'arrival', target: '교대', url: 'u', status: 200, body: '{}' },
      ],
    };

    await flushSeoulCapture(r2, cycle);

    expect(put).toHaveBeenCalledTimes(1);
    const [key, body] = put.mock.calls[0];
    expect(key).toBe(buildSeoulCaptureKey(cycle.cycleStartMs));
    expect(key).toBe(`seoul-capture/2026-09-13/${cycle.cycleStartMs}.json`);
    expect(JSON.parse(body as string)).toEqual(cycle);
  });
});
