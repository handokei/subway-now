/**
 * #3177 — fetch-quick-exit 노선 귀속 테스트.
 *
 * 결함: mapRow가 역명 첫 매칭(STATIONS.find(name))만 써서 환승역 데이터가 가장 앞 노선 id 한 곳에만
 * 저장됐다(도봉산 → 1호선 id 에 7호선 데이터). (역명 + lineNm) 으로 귀속해야 한다.
 */

'use strict';

process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY = 'test-key';

const STATIONS = require('../../src/data/stations.json');
const QUICK_EXIT = require('../../src/data/quickExit.json');
const SOURCE_STATIONS = require('../fixtures/quick-exit-source-stations.json');
const { mapRow, resolveStationId, LINE_NM_TO_LINE } = require('../fetch-quick-exit');

const byId = new Map(STATIONS.map((s) => [s.id, s]));

function row(lineNm, stnNm, extra = {}) {
  return {
    lineNm,
    stnNm,
    qckgffVhclDoorNo: '3-2',
    plfmCmgFac: '계단',
    upbdnbSe: '상행',
    drtnInfo: '어딘가방면',
    ...extra,
  };
}

describe('resolveStationId', () => {
  it.each([
    ['1호선', '도봉산', '1'],
    ['7호선', '도봉산', '7'],
    ['2호선', '사당', '2'],
    ['4호선', '사당', '4'],
  ])('%s %s → line %s id', (lineNm, name, line) => {
    const id = resolveStationId(lineNm, name);
    expect(byId.get(id)).toMatchObject({ name, line });
  });

  it('부역명 표기는 정규화로 매칭한다', () => {
    const stationWithSub = STATIONS.find((s) => /\(.+\)$/.test(s.name));
    const base = stationWithSub.name.replace(/\(.+\)$/, '').trim();
    expect(resolveStationId(`${stationWithSub.line}호선`, base)).toBe(stationWithSub.id);
  });

  it('alias 데이터(line|name → 정식명)로 매칭한다', () => {
    // platform-name-aliases.json: "7|뚝섬유원지" → "자양"
    const id = resolveStationId('7호선', '뚝섬유원지');
    expect(byId.get(id)).toMatchObject({ name: expect.stringMatching(/^자양/), line: '7' });
  });

  it('매칭 실패는 null (다른 노선 id로 폴백하지 않는다)', () => {
    expect(resolveStationId('8호선', '도봉산')).toBeNull(); // 도봉산은 1·7호선뿐
    expect(resolveStationId('5호선', '하남검단산')).toBeNull(); // stations.json 미등재
  });

  it('알 수 없는 lineNm은 null', () => {
    expect(resolveStationId('99호선', '도봉산')).toBeNull();
    expect(resolveStationId(undefined, '도봉산')).toBeNull();
  });
});

describe('mapRow', () => {
  it('같은 이름 다른 노선 행이 각자 노선 id로 간다', () => {
    const a = mapRow(row('1호선', '도봉산'));
    const b = mapRow(row('7호선', '도봉산'));
    expect(byId.get(a.stationId).line).toBe('1');
    expect(byId.get(b.stationId).line).toBe('7');
    expect(a.stationId).not.toBe(b.stationId);
  });

  it('사당 2/4호선 분리', () => {
    const lines = ['2호선', '4호선'].map((l) => byId.get(mapRow(row(l, '사당')).stationId).line);
    expect(lines).toEqual(['2', '4']);
  });

  it('매핑 실패(미등재 역)는 null', () => {
    expect(mapRow(row('5호선', '하남검단산'))).toBeNull();
  });

  it('필수 필드 누락·시설 분류 불가는 null', () => {
    expect(mapRow(row('1호선', '서울역', { qckgffVhclDoorNo: '' }))).toBeNull();
    expect(mapRow(row('1호선', '서울역', { plfmCmgFac: '기타' }))).toBeNull();
    expect(mapRow(row('1호선', ''))).toBeNull();
  });
});

describe('LINE_NM_TO_LINE', () => {
  it('값은 모두 stations.json에 존재하는 line', () => {
    const lines = new Set(STATIONS.map((s) => s.line));
    for (const line of Object.values(LINE_NM_TO_LINE)) expect(lines.has(line)).toBe(true);
  });
});

describe('quickExit.json 정합성', () => {
  it('모든 키가 stations.json id', () => {
    for (const id of Object.keys(QUICK_EXIT)) expect(byId.has(id)).toBe(true);
  });

  it('모든 키의 (노선, 역명)이 원천 응답의 lineNm|stnNm 기록에 존재한다 (타 노선 데이터 오귀속 차단)', () => {
    const source = new Set(SOURCE_STATIONS);
    const lineNmOf = Object.fromEntries(Object.entries(LINE_NM_TO_LINE).map(([nm, l]) => [l, nm]));
    const bad = [];
    for (const id of Object.keys(QUICK_EXIT)) {
      const { name, line } = byId.get(id);
      const lineNm = lineNmOf[line];
      const names = [name, name.replace(/\(.+\)$/, '').trim()];
      if (!lineNm || !names.some((n) => source.has(`${lineNm}|${n}`))) bad.push(id);
    }
    expect(bad).toEqual([]);
  });

  it('원천에 있는 환승역은 각 노선 id 모두에 데이터가 있다 (도봉산 1/7, 사당 2/4)', () => {
    for (const [name, lines] of [['도봉산', ['1', '7']], ['사당', ['2', '4']]]) {
      for (const line of lines) {
        const s = STATIONS.find((x) => x.name === name && x.line === line);
        expect(QUICK_EXIT[s.id]).toBeDefined();
      }
    }
  });
});
