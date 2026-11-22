/**
 * #3177 PR-1 — 공식 데이터셋 밖 노선의 하차문 방향: 위키백과 + 나무위키 교차검증 규칙.
 *
 * 사용자 결정(2026-11-22, 옵션 1): 두 위키가 일치할 때만 값을 채운다.
 *   - 위키백과 개별 역 문서의 승강장 형식 + 나무위키 역 목록 `승강장` 열 글리프(│■│=섬식, ■││■=상대식)
 *   - 둘 다 같은 단순형(섬식/상대식), 선로 정확히 2개, 구간 주행방향(좌/우측통행) 근거가 있어야 도출
 *   - 우측통행: 상대식=right / 섬식=left. 좌측통행은 반전. 그 외 전부 null.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  build,
  GRADE_WIKI_CROSSCHECKED,
  classifyNamuGlyph,
  resolveWikiCrosscheckSide,
  findSectionRunningSide,
} = require('../build-platform-exit-side');

describe('classifyNamuGlyph (나무위키 승강장 열 글리프)', () => {
  it('│■│ = 섬식 2선', () => {
    expect(classifyNamuGlyph('│■│')).toEqual({ format: '섬식', tracks: 2 });
  });

  it('■││■ = 상대식 2선', () => {
    expect(classifyNamuGlyph('■││■')).toEqual({ format: '상대식', tracks: 2 });
  });

  it.each([
    ['│■││■│', 4], // 쌍섬식(급행 구간)
    ['■││││■', 4], // 상대식 + 통과선 2선
    ['││■││', 4], // 섬식 + 통과선 2선
    ['│■│■│\n│■│■│', 6], // 다층 복합
  ])('2선이 아닌 구조 %p는 format null, tracks=%i', (glyph, tracks) => {
    expect(classifyNamuGlyph(glyph)).toEqual({ format: null, tracks });
  });

  it.each([null, undefined, ''])('글리프 없음 %p', (glyph) => {
    expect(classifyNamuGlyph(glyph)).toEqual({ format: null, tracks: null });
  });
});

describe('resolveWikiCrosscheckSide (두 위키 일치 규칙)', () => {
  const agree = {
    wikipedia: { format: '상대식', tracks: 2 },
    namuGlyph: '■││■',
    runningSide: 'right',
  };

  it('두 소스가 같은 상대식 2선 + 우측통행 → right', () => {
    expect(resolveWikiCrosscheckSide(agree)).toEqual({ side: 'right', reason: 'derived' });
  });

  it('두 소스가 같은 섬식 2선 + 우측통행 → left', () => {
    expect(
      resolveWikiCrosscheckSide({
        wikipedia: { format: '섬식', tracks: 2 },
        namuGlyph: '│■│',
        runningSide: 'right',
      }),
    ).toEqual({ side: 'left', reason: 'derived' });
  });

  it('좌측통행 구간은 반전된다 (상대식→left, 섬식→right)', () => {
    expect(resolveWikiCrosscheckSide({ ...agree, runningSide: 'left' })).toEqual({
      side: 'left',
      reason: 'derived',
    });
    expect(
      resolveWikiCrosscheckSide({
        wikipedia: { format: '섬식', tracks: 2 },
        namuGlyph: '│■│',
        runningSide: 'left',
      }),
    ).toEqual({ side: 'right', reason: 'derived' });
  });

  it('두 소스가 불일치하면 null (format-disagree)', () => {
    expect(resolveWikiCrosscheckSide({ ...agree, namuGlyph: '│■│' })).toEqual({
      side: null,
      reason: 'format-disagree',
    });
  });

  it.each([
    ['위키백과 4선', { wikipedia: { format: '상대식', tracks: 4 } }],
    ['위키백과 3선(혼합식)', { wikipedia: { format: null, tracks: 3 } }],
    ['나무위키 4선', { namuGlyph: '■││││■' }],
  ])('3선 이상/2선 아님: %s → not-two-tracks', (_label, override) => {
    expect(resolveWikiCrosscheckSide({ ...agree, ...override })).toEqual({
      side: null,
      reason: 'not-two-tracks',
    });
  });

  it('위키백과 형식이 단순형이 아니면(복합·두단식) null (not-plain)', () => {
    expect(
      resolveWikiCrosscheckSide({ ...agree, wikipedia: { format: '복합식', tracks: 2 } }),
    ).toEqual({ side: null, reason: 'not-plain' });
  });

  it('한쪽 소스가 없으면 null (missing-source)', () => {
    expect(resolveWikiCrosscheckSide({ ...agree, wikipedia: null })).toEqual({
      side: null,
      reason: 'missing-source',
    });
    expect(resolveWikiCrosscheckSide({ ...agree, namuGlyph: null })).toEqual({
      side: null,
      reason: 'missing-source',
    });
  });

  it('구간 주행방향 근거가 없으면 null (running-side-unknown) — 두 위키가 일치해도', () => {
    expect(resolveWikiCrosscheckSide({ ...agree, runningSide: null })).toEqual({
      side: null,
      reason: 'running-side-unknown',
    });
  });
});

describe('findSectionRunningSide (구간 단위 주행방향)', () => {
  const sections = [
    { id: 'a-all', line: 'a', stationIds: 'all', side: 'right', evidence: [] },
    { id: 'b-part', line: 'b', stationIds: ['b-001', 'b-002'], side: 'left', evidence: [] },
    { id: 'c-pending', line: 'c', side: 'left', evidence: [] },
    { id: 'd-null', line: 'd', stationIds: 'all', side: null, evidence: [] },
  ];

  it('stationIds=all은 노선 전 역에 적용', () => {
    expect(findSectionRunningSide(sections, 'a', 'a-099')).toBe('right');
  });

  it('stationIds 배열은 열거된 역에만 적용', () => {
    expect(findSectionRunningSide(sections, 'b', 'b-001')).toBe('left');
    expect(findSectionRunningSide(sections, 'b', 'b-003')).toBeNull();
  });

  it('stationIds 미지정(역 매핑 보류) 구간은 어떤 역에도 적용되지 않는다', () => {
    expect(findSectionRunningSide(sections, 'c', 'c-001')).toBeNull();
  });

  it('side=null 구간 / 구간 없는 노선은 null', () => {
    expect(findSectionRunningSide(sections, 'd', 'd-001')).toBeNull();
    expect(findSectionRunningSide(sections, 'zzz', 'zzz-001')).toBeNull();
  });
});

describe('section-running-side.json 계약 (구간별 주행방향 + 인용)', () => {
  const { sections } = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../fixtures/section-running-side.json'), 'utf8'),
  );
  const byId = Object.fromEntries(sections.map((s) => [s.id, s]));

  it('side가 있는 구간은 인용(url + quote + retrievedAt)을 갖는다', () => {
    for (const section of sections.filter((s) => s.side != null)) {
      expect(['left', 'right']).toContain(section.side);
      expect(section.evidence.length).toBeGreaterThan(0);
      for (const { url, quote, retrievedAt } of section.evidence) {
        expect(url).toMatch(/^https:\/\//);
        expect(quote.length).toBeGreaterThan(0);
        expect(retrievedAt).toBe('2026-11-22');
      }
    }
  });

  it.each([
    ['9', 'right'],
    ['sinbundang', 'left'],
    ['airport', 'left'],
    ['gyeongui', 'left'],
    ['bundang', 'left'],
    ['1-korail', 'left'],
    ['4-korail', 'left'],
    ['3-ilsan', 'right'],
    ['7-bucheon-incheon', 'right'],
  ])('구간 %s = %s', (id, side) => {
    expect(byId[id].side).toBe(side);
  });
});

describe('wiki-platform-formats/9.json (9호선 원자료 — null 역도 전부 기록)', () => {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../fixtures/wiki-platform-formats/9.json'), 'utf8'),
  );
  const stations = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../src/data/stations.json'), 'utf8'),
  ).filter((s) => s.line === '9');

  it('9호선 38역 전부 raw 값이 기록돼 있다', () => {
    expect(stations).toHaveLength(38);
    for (const { id } of stations) {
      const entry = fixture.stations[id];
      expect(entry).toBeDefined();
      expect(entry.wikipedia.url).toMatch(/^https:\/\/ko\.wikipedia\.org\/wiki\//);
      expect(entry.wikipedia.quote.length).toBeGreaterThan(0);
      expect(entry.namuwiki.url).toMatch(/^https:\/\/namu\.wiki\//);
      expect(typeof entry.namuwiki.glyph).toBe('string');
    }
  });
});

describe('build → 9호선 wiki-crosschecked 출력', () => {
  let result;
  let writeSpy;
  let logSpy;

  beforeAll(() => {
    writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    result = build();
  });

  afterAll(() => {
    writeSpy.mockRestore();
    logSpy.mockRestore();
  });

  const entryOf = (id) => result.output[id];

  it.each([
    ['9-001', 'left'], // 개화: 섬식 │■│
    ['9-003', 'right'], // 공항시장: 상대식 ■││■
    ['9-013', 'left'], // 당산: 섬식
    ['9-023', 'right'], // 고속터미널: 상대식
    ['9-033', 'left'], // 석촌: 섬식
    ['9-037', 'left'], // 둔촌오륜: 섬식
  ])('%s → %s (grade wiki-crosschecked)', (id, side) => {
    expect(entryOf(id)).toEqual({ side, grade: GRADE_WIKI_CROSSCHECKED });
  });

  it.each([
    '9-002', // 김포공항: 다층 복합
    '9-005', // 마곡나루: 쌍섬식 4선
    '9-007', // 가양: 급행 4선
    '9-012', // 선유도: 상대식 + 통과선 4선
    '9-016', // 샛강
    '9-025', // 신논현: 혼합식 3선
    '9-034', // 송파나루: 1면 4선
    '9-038', // 중앙보훈병원: 2면 3선
  ])('%s → 키 없음 (null)', (id) => {
    expect(entryOf(id)).toBeUndefined();
  });

  it('9호선 채움 26 / null 12', () => {
    const nine = Object.keys(result.output).filter((id) => id.startsWith('9-'));
    expect(nine).toHaveLength(26);
    expect(result.wikiStats['9']).toEqual({ left: 8, right: 18, unknown: 12 });
  });

  it('공식 데이터셋(1~8호선) 결과는 그대로 official-derived', () => {
    expect(entryOf('2-012')).toEqual({ side: 'right', grade: 'official-derived' });
  });
});
