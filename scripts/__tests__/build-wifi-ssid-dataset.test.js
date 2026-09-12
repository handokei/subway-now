/**
 * #1451 — build-wifi-ssid-dataset 헬퍼 + 실제 데이터 회귀 점검.
 * 부수효과 main()은 io deps 주입으로 검증.
 */
const fs = require('node:fs');
const path = require('node:path');
const {
  SUBWAY_ID_TO_LINE,
  stripBom,
  parseCsvLine,
  lineFromSubwayId,
  parseCsv,
  buildBssidMap,
  buildStationIndex,
  validateAgainstStations,
  buildOutput,
  summarize,
  main,
} = require('../build-wifi-ssid-dataset');

const BOM = '﻿';

describe('SUBWAY_ID_TO_LINE', () => {
  it('1~9호선 + 공항/경의/분당/신분당 13종 매핑', () => {
    expect(SUBWAY_ID_TO_LINE[1001]).toBe('1');
    expect(SUBWAY_ID_TO_LINE[1009]).toBe('9');
    expect(SUBWAY_ID_TO_LINE[1063]).toBe('gyeongui');
    expect(SUBWAY_ID_TO_LINE[1065]).toBe('airport');
    expect(SUBWAY_ID_TO_LINE[1075]).toBe('bundang');
    expect(SUBWAY_ID_TO_LINE[1077]).toBe('sinbundang');
  });

  it('Object.freeze 봉인', () => {
    expect(Object.isFrozen(SUBWAY_ID_TO_LINE)).toBe(true);
  });
});

describe('stripBom', () => {
  it.each([
    [`${BOM}hello`, 'hello'],
    [`a${BOM}b${BOM}c`, 'abc'],
    ['no-bom', 'no-bom'],
    ['', ''],
  ])('"%s" → "%s"', (input, expected) => {
    expect(stripBom(input)).toBe(expected);
  });

  it.each([[null], [undefined], [42], [{}]])('비문자열 → 빈 문자열 (%p)', (input) => {
    expect(stripBom(input)).toBe('');
  });
});

describe('parseCsvLine', () => {
  it('BOM이 매 cell에 prepend된 row를 정상 split', () => {
    const line = `${BOM}aa:bb,${BOM}T wifi zone,${BOM}1009000922,${BOM}신반포,${BOM}1009,${BOM}-67`;
    expect(parseCsvLine(line)).toEqual(['aa:bb', 'T wifi zone', '1009000922', '신반포', '1009', '-67']);
  });

  it('일반 row(BOM 없음)도 처리', () => {
    expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });
});

describe('lineFromSubwayId', () => {
  it.each([
    ['1001', '1'],
    ['1009', '9'],
    ['1065', 'airport'],
    [1075, 'bundang'],
  ])('"%s" → "%s"', (input, expected) => {
    expect(lineFromSubwayId(input)).toBe(expected);
  });

  it.each([['9999', null], ['', null], ['abc', null], [null, null], [undefined, null]])(
    '미등록/비숫자 → null (%p)',
    (input, expected) => {
      expect(lineFromSubwayId(input)).toBe(expected);
    },
  );
});

describe('parseCsv (#1481 slim header)', () => {
  // Slim CSV header — `SSID_MAC주소` / `지하철역명` / `지하철호선ID` 3 컬럼만.
  const SLIM_HEADER = 'SSID_MAC주소,지하철역명,지하철호선ID';
  const SLIM_ROW = (bssid, name, line) => `${BOM}${bssid},${BOM}${name},${BOM}${line}`;

  // 원본 CSV header — slim 전 6 컬럼 형식 (후방 호환).
  const RAW_HEADER = 'SSID_MAC주소,SSID등록통신사,지하철역ID,지하철역명,지하철호선ID,WIFI신호세기';
  const RAW_ROW = (bssid, ssid, code, name, line, rssi) =>
    `${BOM}${bssid},${BOM}${ssid},${BOM}${code},${BOM}${name},${BOM}${line},${BOM}${rssi}`;

  it('slim header (3 col) — bssid/stationName/line만 보존', () => {
    const text = `${BOM}${SLIM_HEADER}\r\n${SLIM_ROW('aa:bb:cc:dd:ee:ff', '강남', '1002')}\r\n`;
    const rows = parseCsv(text);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      bssid: 'aa:bb:cc:dd:ee:ff',
      ssid: '', // slim 본은 SSID 컬럼 미포함 → 빈 문자열.
      stationName: '강남',
      line: '2',
    });
  });

  it('원본 header (6 col) — ssid 컬럼도 row.ssid로 보존 (후방 호환)', () => {
    const text = `${BOM}${RAW_HEADER}\r\n${RAW_ROW('aa:bb:cc:dd:ee:ff', 'T wifi zone', '1', '강남', '1002', '-60')}\r\n`;
    const rows = parseCsv(text);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      bssid: 'aa:bb:cc:dd:ee:ff',
      ssid: 'T wifi zone',
      stationName: '강남',
      line: '2',
    });
  });

  it('header 누락 시 빈 결과', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('only,header,wrong')).toEqual([]);
  });

  it('빈 줄/짧은 row는 skip', () => {
    const text = `${SLIM_HEADER}\r\n\r\n${BOM}a,b\r\n${SLIM_ROW('a1', 'd', '1009')}`;
    expect(parseCsv(text)).toHaveLength(1);
  });

  it('필수 필드(bssid/stationName) 비어 있으면 skip', () => {
    const text = `${SLIM_HEADER}\r\n${SLIM_ROW('', 'd', '1001')}\r\n${SLIM_ROW('a', '', '1001')}`;
    expect(parseCsv(text)).toHaveLength(0);
  });

  it('미등록 호선 코드(9999 등) row는 line=null로 보존', () => {
    const text = `${SLIM_HEADER}\r\n${SLIM_ROW('aa', '강남', '9999')}`;
    const rows = parseCsv(text);
    expect(rows).toHaveLength(1);
    expect(rows[0].line).toBeNull();
  });

  it('bssid는 lower-case 정규화', () => {
    const text = `${SLIM_HEADER}\r\n${SLIM_ROW('AA:BB:CC:DD:EE:FF', '강남', '1001')}`;
    expect(parseCsv(text)[0].bssid).toBe('aa:bb:cc:dd:ee:ff');
  });
});

describe('buildBssidMap', () => {
  it('row들을 BSSID → meta 맵으로 변환 (ssid 필드 미보존, #1481)', () => {
    const rows = [
      { bssid: 'aa', ssid: 'T', stationName: '강남', line: '2' },
      { bssid: 'bb', ssid: 'ollehWiFi', stationName: '왕십리', line: '5' },
    ];
    const { entries, bssidCollisions } = buildBssidMap(rows);
    expect(entries.aa).toEqual({ stationName: '강남', line: '2' });
    expect(entries.bb).toEqual({ stationName: '왕십리', line: '5' });
    expect(bssidCollisions).toBe(0);
  });

  it('line=null row는 제외', () => {
    const rows = [{ bssid: 'aa', ssid: 'T', stationName: '강남', line: null }];
    expect(buildBssidMap(rows).entries).toEqual({});
  });

  it('BSSID 충돌은 첫 row 보존 + 카운트', () => {
    const rows = [
      { bssid: 'aa', ssid: 'T', stationName: '강남', line: '2' },
      { bssid: 'aa', ssid: 'OTHER', stationName: '왕십리', line: '5' },
    ];
    const { entries, bssidCollisions } = buildBssidMap(rows);
    expect(entries.aa.stationName).toBe('강남');
    expect(bssidCollisions).toBe(1);
  });
});

describe('buildStationIndex', () => {
  it('(stationName, line) 단위로 distinct BSSID 집계 (ssids 미보존, #1481)', () => {
    const rows = [
      { bssid: 'aa', ssid: 'T', stationName: '강남', line: '2' },
      { bssid: 'bb', ssid: 'T', stationName: '강남', line: '2' },
      { bssid: 'cc', ssid: 'ollehWiFi', stationName: '강남', line: '2' },
      { bssid: 'dd', ssid: 'T', stationName: '강남', line: '7' }, // 다른 호선(타 platform)
    ];
    const idx = buildStationIndex(rows);
    expect(idx).toHaveLength(2);
    const line2 = idx.find((e) => e.line === '2');
    expect(line2.bssidCount).toBe(3);
    expect(line2.ssids).toBeUndefined();
  });

  it('line=null row 제외', () => {
    expect(buildStationIndex([{ bssid: 'aa', ssid: 'T', stationName: '강남', line: null }])).toEqual([]);
  });

  it('결정적 정렬 — stationName 우선, line 보조', () => {
    const rows = [
      { bssid: 'a', ssid: 'X', stationName: '잠실', line: '2' },
      { bssid: 'b', ssid: 'X', stationName: '강남', line: '7' },
      { bssid: 'c', ssid: 'X', stationName: '강남', line: '2' },
    ];
    const idx = buildStationIndex(rows);
    expect(idx.map((e) => `${e.stationName}|${e.line}`)).toEqual(['강남|2', '강남|7', '잠실|2']);
  });
});

describe('validateAgainstStations', () => {
  const stations = [
    { name: '강남', line: '2' },
    { name: '강변(동서울터미널)', line: '2' }, // 괄호 suffix
  ];

  it('정확히 일치하면 missing 없음', () => {
    expect(validateAgainstStations([{ stationName: '강남', line: '2' }], stations)).toEqual([]);
  });

  it('normalizeStationName으로 괄호 suffix 흡수 (강변 ↔ 강변(동서울터미널))', () => {
    expect(validateAgainstStations([{ stationName: '강변', line: '2' }], stations)).toEqual([]);
  });

  it('stations.json에 없으면 missing key 반환', () => {
    expect(
      validateAgainstStations([{ stationName: '없는역', line: '9' }], stations),
    ).toEqual(['없는역|9']);
  });
});

describe('summarize', () => {
  it('통계 객체 + missing sample 10건 자르기 (원본 CSV ssid 있을 시)', () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      bssid: `mac-${i}`,
      ssid: 'T wifi zone', // 원본 CSV — row.ssid 보존.
      stationName: '강남',
      line: '2',
    }));
    rows.push({ bssid: 'x', ssid: 'unknown', stationName: '강남', line: null });
    const idx = buildStationIndex(rows);
    const bmap = buildBssidMap(rows);
    const missing = Array.from({ length: 15 }, (_, i) => `miss-${i}`);
    const s = summarize(rows, idx, bmap, missing);
    expect(s.rowsParsed).toBe(4);
    expect(s.rowsWithKnownLine).toBe(3);
    expect(s.rowsWithUnknownLine).toBe(1);
    expect(s.bssidEntries).toBe(3);
    expect(s.stationLinePairs).toBe(1);
    expect(s.linesCovered).toEqual(['2']);
    expect(s.carrierCounts['T wifi zone']).toBe(3);
    expect(s.missingSample).toHaveLength(10);
    expect(s.stationsMissingInStationsJson).toBe(15);
  });

  it('slim CSV (row.ssid=빈 문자열) — carrierCounts 비어 있음 (#1481)', () => {
    const rows = [{ bssid: 'aa', ssid: '', stationName: '강남', line: '2' }];
    const idx = buildStationIndex(rows);
    const bmap = buildBssidMap(rows);
    const s = summarize(rows, idx, bmap, []);
    expect(s.carrierCounts).toEqual({});
  });
});

describe('buildOutput', () => {
  const NOW = '2026-06-18T00:00:00.000Z';
  const rows = [
    { bssid: 'aa:bb:cc:dd:ee:ff', ssid: 'T wifi zone', stationName: '강남', line: '2' },
    { bssid: '11:22:33:44:55:66', ssid: 'ollehWiFi', stationName: '강남', line: '7' },
  ];

  it('bssidOutput + stationIndexOutput + stats 반환', () => {
    const stations = [
      { name: '강남', line: '2' },
      { name: '강남', line: '7' },
    ];
    const out = buildOutput({ rows, stations, generatedAt: NOW });
    expect(out.bssidOutput._meta.generatedAt).toBe(NOW);
    expect(out.bssidOutput._meta.bssidEntries).toBe(2);
    expect(out.bssidOutput.entries['aa:bb:cc:dd:ee:ff'].line).toBe('2');
    expect(out.stationIndexOutput._meta.linesCovered).toEqual(['2', '7']);
    expect(out.stationIndexOutput.entries).toHaveLength(2);
    expect(out.stats.bssidEntries).toBe(2);
  });
});

describe('main (io 주입)', () => {
  it('readCsv/readJson 받아 writeJson 2회 호출 + 로그 (slim header, #1481)', () => {
    const csv = `${BOM}SSID_MAC주소,지하철역명,지하철호선ID\r\n${BOM}aa:bb:cc:dd:ee:ff,${BOM}강남,${BOM}1002\r\n`;
    const stations = [{ name: '강남', line: '2' }];
    const writes = [];
    const logs = [];
    const stats = main({
      readCsv: () => csv,
      readJson: () => stations,
      writeJson: (file, value) => writes.push({ file, value }),
      log: (...args) => logs.push(args.join(' ')),
      now: () => '2026-06-18T00:00:00.000Z',
    });
    expect(writes).toHaveLength(2);
    expect(writes[0].file).toMatch(/subwayWifiBssidMap\.json$/);
    expect(writes[1].file).toMatch(/subwayWifiStationIndex\.json$/);
    expect(stats.bssidEntries).toBe(1);
    expect(logs.length).toBeGreaterThanOrEqual(3);
  });
});

describe('실제 데이터 무결성 (회귀)', () => {
  const bssidMap = require('../../src/data/subwayWifiBssidMap.json');
  const stationIndex = require('../../src/data/subwayWifiStationIndex.json');
  const stations = require('../../src/data/stations.json');

  it('bssidMap _meta + entries 형식', () => {
    expect(bssidMap._meta.generatedAt).toEqual(expect.any(String));
    expect(bssidMap._meta.bssidEntries).toBe(Object.keys(bssidMap.entries).length);
    expect(bssidMap._meta.bssidEntries).toBeGreaterThan(15000);
  });

  it('stationIndex entries는 377 station-line pair 이상', () => {
    expect(stationIndex.entries.length).toBeGreaterThanOrEqual(370);
  });

  it('linesCovered에 1~9호선 + bundang/airport/sinbundang 포함', () => {
    const lines = new Set(stationIndex._meta.linesCovered);
    for (const l of ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'airport', 'bundang', 'sinbundang']) {
      expect(lines.has(l)).toBe(true);
    }
  });

  it('사용자 trip 핵심 역(성수/뚝섬/한양대/왕십리/마장/용마산/중곡) 모두 매핑', () => {
    const required = ['성수', '뚝섬', '한양대', '왕십리', '마장', '용마산', '중곡'];
    const names = new Set(stationIndex.entries.map((e) => e.stationName));
    for (const name of required) expect(names.has(name)).toBe(true);
  });

  it('각 bssid entry의 stationName + line이 stations.json과 (normalize 후) 정합', () => {
    const { normalizeStationName } = require('../../src/shared/utils/normalizeStationName');
    const stationKey = new Set(stations.map((s) => `${normalizeStationName(s.name)}|${s.line}`));
    let unresolved = 0;
    for (const key of Object.keys(bssidMap.entries)) {
      const entry = bssidMap.entries[key];
      const k = `${normalizeStationName(entry.stationName)}|${entry.line}`;
      if (!stationKey.has(k)) unresolved += 1;
    }
    // unresolved는 KORAIL stations.json 미수록 역(고덕, 군포, 금정 line 1 등)에 한정 — 전체의 5% 미만.
    expect(unresolved / Object.keys(bssidMap.entries).length).toBeLessThan(0.05);
  });

  it('파일 사이즈는 bssidMap 3MB, stationIndex 200KB 이하', () => {
    const ROOT = path.join(__dirname, '..', '..');
    const bssidSize = fs.statSync(path.join(ROOT, 'src', 'data', 'subwayWifiBssidMap.json')).size;
    const indexSize = fs.statSync(path.join(ROOT, 'src', 'data', 'subwayWifiStationIndex.json')).size;
    expect(bssidSize).toBeLessThan(3 * 1024 * 1024);
    expect(indexSize).toBeLessThan(200 * 1024);
  });
});
