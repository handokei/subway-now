/**
 * scrape-wiki-platform.js (#1092 follow-up PoC) — 인포박스 파서 + 분류 + 통합 동작 검증.
 * 네트워크는 mock fetch로 격리한다.
 */

const os = require('node:os');
const path = require('node:path');

const {
  extractPlatformFields,
  classifyLayout,
  aggregateLayout,
  fetchWikitext,
  resolveStation,
  pickStations,
  run,
} = require('../scrape-wiki-platform');

const TMP_OUT = path.join(os.tmpdir(), 'subway-now-wiki-platform-test.json');

// 테스트 헬퍼: MediaWiki parse API 응답 mock 생성 (중복 제거)
const wikiResponse = (wikitext) => ({
  ok: true,
  json: async () => ({ parse: { wikitext: { '*': wikitext } } }),
});
const notFoundResponse = () => ({ ok: false, json: async () => ({}) });
const mockFetchOnce = (wikitext) => jest.fn().mockResolvedValue(wikiResponse(wikitext));

// resolveStation 결과 shape 헬퍼 (필드 9줄 중복 제거)
const stationResult = (overrides) => ({
  stationName: '',
  line: '',
  wikiTitle: null,
  rawField: null,
  layout: 'unknown',
  confidence: 'low',
  ...overrides,
});

// run() deps 헬퍼 (kwargs 중복 제거)
const runDeps = (overrides = {}) => ({
  fetch: jest.fn(),
  sleep: jest.fn(),
  writeFile: jest.fn(),
  log: jest.fn(),
  stations: [],
  ...overrides,
});

describe('extractPlatformFields', () => {
  it('returns [] for empty / null input', () => {
    expect(extractPlatformFields('')).toEqual([]);
    expect(extractPlatformFields(null)).toEqual([]);
    expect(extractPlatformFields(undefined)).toEqual([]);
    expect(extractPlatformFields(123)).toEqual([]);
  });

  it('extracts single 승강장 field', () => {
    const wt = '|역명 = 잠실\n|승강장 = 2면 2선([[상대식 승강장|상대식]])\n|코드 = 0216';
    expect(extractPlatformFields(wt)).toEqual(['2면 2선([[상대식 승강장|상대식]])']);
  });

  it('extracts multiple 승강장 fields from multi-infobox page', () => {
    const wt = '|승강장 = 2면 2선([[상대식]])\n... 다른 본문 ...\n|승강장 = 1면 2선([[섬식]])';
    expect(extractPlatformFields(wt)).toEqual(['2면 2선([[상대식]])', '1면 2선([[섬식]])']);
  });

  it('ignores fields without value', () => {
    const wt = '|승강장 =   \n|승강장 = 1면 2선';
    expect(extractPlatformFields(wt)).toEqual(['1면 2선']);
  });
});

describe('classifyLayout', () => {
  it('returns unknown for empty', () => {
    expect(classifyLayout('')).toEqual({ layout: 'unknown', confidence: 'low' });
    expect(classifyLayout(null)).toEqual({ layout: 'unknown', confidence: 'low' });
  });

  it('detects 섬식 with high confidence', () => {
    expect(classifyLayout('1면 2선 ([[섬식 승강장|섬식]])')).toEqual({ layout: 'island', confidence: 'high' });
  });

  it('detects 상대식 with high confidence', () => {
    expect(classifyLayout('2면 2선([[상대식 승강장|상대식]])')).toEqual({ layout: 'side', confidence: 'high' });
  });

  it('detects mixed when both 섬식 and 상대식 present', () => {
    expect(classifyLayout('상행 섬식 / 하행 상대식')).toEqual({ layout: 'mixed', confidence: 'high' });
  });

  it('heuristic: 1면 2선 → island (medium)', () => {
    expect(classifyLayout('1면 2선')).toEqual({ layout: 'island', confidence: 'medium' });
  });

  it('heuristic: 2면 2선 → side (medium)', () => {
    expect(classifyLayout('2면 2선')).toEqual({ layout: 'side', confidence: 'medium' });
  });

  it('heuristic: 2면 4선 → mixed (low)', () => {
    expect(classifyLayout('2면 4선 혼합')).toEqual({ layout: 'mixed', confidence: 'low' });
  });

  it('returns unknown for free text without 면선 pattern', () => {
    expect(classifyLayout('지상역')).toEqual({ layout: 'unknown', confidence: 'low' });
  });
});

describe('aggregateLayout', () => {
  it('returns unknown when no fields', () => {
    expect(aggregateLayout([])).toEqual({ layout: 'unknown', confidence: 'low', rawField: null });
  });

  it('returns single classification when all fields agree', () => {
    const r = aggregateLayout(['1면 2선 섬식', '1면 2선 섬식']);
    expect(r.layout).toBe('island');
    expect(r.confidence).toBe('high');
    expect(r.rawField).toBe('1면 2선 섬식 || 1면 2선 섬식');
  });

  it('collapses to single layout if all non-unknown agree', () => {
    const r = aggregateLayout(['1면 2선 섬식', '지상역']);
    expect(r.layout).toBe('island');
    expect(r.confidence).toBe('medium');
  });

  it('returns mixed when non-unknown layouts differ', () => {
    const r = aggregateLayout(['2면 2선 상대식', '1면 2선 섬식']);
    expect(r.layout).toBe('mixed');
    expect(r.confidence).toBe('medium');
  });
});

describe('fetchWikitext', () => {
  it('returns wikitext on 200', async () => {
    const fakeFetch = mockFetchOnce('|승강장 = 1면 2선');
    const wt = await fetchWikitext('잠실역', fakeFetch);
    expect(wt).toBe('|승강장 = 1면 2선');
    expect(fakeFetch).toHaveBeenCalledWith(
      expect.stringContaining('action=parse'),
      expect.objectContaining({ headers: expect.objectContaining({ 'User-Agent': expect.any(String) }) }),
    );
  });

  it('returns null on non-ok response', async () => {
    const fakeFetch = jest.fn().mockResolvedValue(notFoundResponse());
    expect(await fetchWikitext('없는역', fakeFetch)).toBeNull();
  });

  it('returns null when parse field missing', async () => {
    const fakeFetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ error: 'missingtitle' }) });
    expect(await fetchWikitext('없는역', fakeFetch)).toBeNull();
  });
});

describe('resolveStation', () => {
  it('uses first matching candidate', async () => {
    const fakeFetch = mockFetchOnce('|승강장 = 2면 2선([[상대식]])');
    const r = await resolveStation({ name: '잠실', line: '2' }, fakeFetch);
    expect(r).toEqual(stationResult({
      stationName: '잠실',
      line: '2',
      wikiTitle: '잠실역',
      rawField: '2면 2선([[상대식]])',
      layout: 'side',
      confidence: 'high',
    }));
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it('falls through to next candidate when first has no 승강장 field (disambiguation)', async () => {
    const fakeFetch = jest.fn()
      .mockResolvedValueOnce(wikiResponse('동음이의 페이지'))
      .mockResolvedValueOnce(wikiResponse('|승강장 = 1면 2선 섬식'));
    const r = await resolveStation({ name: '시청', line: '2' }, fakeFetch);
    expect(r.wikiTitle).toBe('시청역 (서울)');
    expect(r.layout).toBe('island');
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });

  it('skips candidate when fetchWikitext returns null', async () => {
    const fakeFetch = jest.fn()
      .mockResolvedValueOnce(notFoundResponse())
      .mockResolvedValueOnce(wikiResponse('|승강장 = 1면 2선'))
      .mockResolvedValueOnce(notFoundResponse());
    const r = await resolveStation({ name: '강남', line: '2' }, fakeFetch);
    expect(r.wikiTitle).toBe('강남역 (서울)');
    expect(r.layout).toBe('island');
  });

  it('returns unknown when all candidates fail', async () => {
    const fakeFetch = jest.fn().mockResolvedValue(notFoundResponse());
    const r = await resolveStation({ name: '없음', line: '99' }, fakeFetch);
    expect(r).toEqual(stationResult({ stationName: '없음', line: '99' }));
  });
});

describe('pickStations', () => {
  const stations = [
    { name: 'A', line: '1' },
    { name: 'B', line: '1' },
    { name: 'A', line: '2' }, // 같은 이름이지만 다른 노선 (환승역)
    { name: 'C', line: '2' },
    { name: 'D', line: '3' },
  ];

  it('returns [] when no option', () => {
    expect(pickStations(stations, {})).toEqual([]);
  });

  it('filters by --only and de-dupes names', () => {
    const r = pickStations(stations, { only: ['A', 'C'] });
    expect(r).toEqual([
      { name: 'A', line: '1' },
      { name: 'C', line: '2' },
    ]);
  });

  it('--only ignores names not in the list', () => {
    expect(pickStations(stations, { only: ['Z'] })).toEqual([]);
  });

  it('--sample picks across lines round-robin, dedupes', () => {
    const r = pickStations(stations, { sample: 3 });
    expect(r).toHaveLength(3);
    const names = r.map((s) => s.name);
    // Round 0: line 1 → A, line 2 → A (dup, skip), line 3 → D
    // Round 1: line 1 → B
    expect(names).toEqual(['A', 'D', 'B']);
  });

  it('--sample exits round loop after exhausting unique stations', () => {
    // sample=99 but only 4 unique names → stop at 4
    const r = pickStations(stations, { sample: 99 });
    const names = r.map((s) => s.name);
    expect(names).toEqual(['A', 'D', 'B', 'C']);
  });
});

describe('run (integration with deps injection)', () => {
  it('warns and returns empty when no targets', async () => {
    const log = jest.fn();
    const r = await run([], runDeps({ log, stations: [{ name: 'A', line: '1' }] }));
    expect(r.results).toEqual([]);
    expect(r.path).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('No target stations'));
  });

  it('scrapes --only stations and writes output', async () => {
    const fakeFetch = mockFetchOnce('|승강장 = 1면 2선 ([[섬식]])');
    const sleepFn = jest.fn().mockResolvedValue(undefined);
    const writeFile = jest.fn();
    const r = await run(['--only', 'A,B'], runDeps({
      fetch: fakeFetch,
      sleep: sleepFn,
      writeFile,
      stations: [
        { name: 'A', line: '1' },
        { name: 'B', line: '2' },
      ],
      outFile: TMP_OUT,
    }));
    expect(r.results).toHaveLength(2);
    expect(r.results[0].layout).toBe('island');
    expect(r.path).toBe(TMP_OUT);
    expect(writeFile).toHaveBeenCalledWith(TMP_OUT, expect.stringContaining('"license": "CC BY-SA 4.0"'));
    // sleep called once between 2 items (not after last)
    expect(sleepFn).toHaveBeenCalledTimes(1);
  });

  it('handles --sample argument', async () => {
    const fakeFetch = mockFetchOnce('|승강장 = 2면 2선 상대식');
    const r = await run(['--sample', '1'], runDeps({
      fetch: fakeFetch,
      stations: [{ name: 'X', line: '1' }],
      outFile: TMP_OUT,
    }));
    expect(r.results).toHaveLength(1);
    expect(r.results[0].layout).toBe('side');
  });
});
