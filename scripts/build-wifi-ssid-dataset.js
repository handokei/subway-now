#!/usr/bin/env node
/**
 * #1451 (Epic #1432, B3) — tnSubwayWifi CSV → 역 platform WiFi 데이터셋 빌더.
 *
 * 입력: scripts/서울교통공사_지하철역_WiFi_20260618.csv
 *   - 컬럼: SSID_MAC주소, SSID등록통신사, 지하철역ID, 지하철역명, 지하철호선ID, WIFI신호세기
 *   - 인코딩: UTF-8 BOM. 매 cell 시작에 EFBBBF 가 prepend 됨 (header + 모든 row). CRLF 라인.
 *   - 18601 row (header 제외)
 *
 * 출력 1: src/data/subwayWifiBssidMap.json — MAC(BSSID) → {stationName, line, ssid, carrier}
 *   - BSSID는 한 역 platform에서 unique 식별자 (SSID는 carrier-generic이라 다중 역 공유).
 *   - 향후 BSSID 조회 가능한 native bridge가 붙으면 lookupStationByBssid로 즉시 활용.
 *
 * 출력 2: src/data/subwayWifiStationIndex.json — station → {line, ssids, bssids, carriers, count}
 *   - 역별 platform WiFi 통계. DebugModal / 운영 검증용.
 *   - ssids/carriers는 distinct list로 truncate (중복 제거 후 보존).
 *
 * 호선 코드 매핑: scripts 단독 사용을 위해 인라인. src/shared/constants/lineApiNames.ts와 일치 필수.
 *   1001~1009 = 1~9호선, 1063=경의중앙선(gyeongui), 1065=공항철도(airport),
 *   1075=수인분당선(bundang), 1077=신분당선(sinbundang), 9999=미배정/공통.
 *
 * 사용법: node scripts/build-wifi-ssid-dataset.js
 * 단위 테스트: scripts/__tests__/build-wifi-ssid-dataset.test.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { applyStationAlias } = require('../src/data/stationAliases');
const { normalizeStationName } = require('../src/shared/utils/normalizeStationName');

const ROOT = path.join(__dirname, '..');
const CSV_PATH = path.join(ROOT, 'scripts', '서울교통공사_지하철역_WiFi_20260618.csv');
const STATIONS_JSON = path.join(ROOT, 'src', 'data', 'stations.json');
const BSSID_OUT = path.join(ROOT, 'src', 'data', 'subwayWifiBssidMap.json');
const STATION_INDEX_OUT = path.join(ROOT, 'src', 'data', 'subwayWifiStationIndex.json');

const BOM = '﻿';

/**
 * subwayId(호선 코드) → LineNumber (stations.json `line` 필드와 동일 표기).
 * `9999`는 통합/미배정 row를 위한 sentinel — 우리 LineNumber로 못 잡히면 skip한다.
 */
const SUBWAY_ID_TO_LINE = Object.freeze({
  1001: '1',
  1002: '2',
  1003: '3',
  1004: '4',
  1005: '5',
  1006: '6',
  1007: '7',
  1008: '8',
  1009: '9',
  1063: 'gyeongui',
  1065: 'airport',
  1075: 'bundang',
  1077: 'sinbundang',
});

/**
 * BOM(EFBBBF)을 문자열의 모든 위치에서 제거한다.
 * 입력 CSV는 각 cell마다 BOM이 prepend되어 있어 단순 head BOM strip으로는 부족.
 */
function stripBom(value) {
  if (typeof value !== 'string') return '';
  return value.split(BOM).join('');
}

/**
 * CSV 한 줄을 콤마로 split하고 각 셀의 BOM/공백을 제거한다.
 * 본 CSV에는 quoted field가 없어 단순 split으로 충분 (SSID에 콤마 없음 — 통신사 default 4종 + MAC 16진수).
 */
function parseCsvLine(line) {
  return line.split(',').map((cell) => stripBom(cell).trim());
}

/**
 * subwayId 코드를 LineNumber로 변환. 미등록 코드는 null.
 */
function lineFromSubwayId(code) {
  const key = Number(code);
  if (!Number.isFinite(key)) return null;
  return SUBWAY_ID_TO_LINE[key] ?? null;
}

/**
 * CSV 텍스트 전체를 파싱해 row 배열을 만든다. header는 제거.
 *
 * Slim CSV (#1481, 3 col): `SSID_MAC주소` / `지하철역명` / `지하철호선ID`.
 * `SSID등록통신사` / `지하철역ID` / `WIFI신호세기`는 미사용 컬럼으로 slim 시 제거.
 * `wifiBssidLookup`은 MAC+역명+호선만 활용한다.
 *
 * 후방 호환 — header에 6 컬럼이 모두 있는 원본 CSV도 동일 코드로 처리. 원본의
 * `SSID등록통신사` 컬럼이 있을 경우 `row.ssid`에 보존하지만, slim 본은 row.ssid=''.
 *
 * row shape: { bssid, ssid, stationName, line }
 * 잘못된 line(미등록 호선 코드) row는 stationName 정규화는 그대로지만 line=null로 둔다 — 호출자가 skip.
 */
function parseCsv(text) {
  const rows = [];
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return rows;
  // 첫 줄 header에서 컬럼 인덱스 lookup.
  const header = parseCsvLine(lines[0]);
  const idxMac = header.indexOf('SSID_MAC주소');
  const idxName = header.indexOf('지하철역명');
  const idxLine = header.indexOf('지하철호선ID');
  const idxSsid = header.indexOf('SSID등록통신사'); // 원본 한정 (slim 본은 -1).
  if (idxMac === -1 || idxName === -1 || idxLine === -1) return rows;
  const minCols = Math.max(idxMac, idxName, idxLine) + 1;
  for (let i = 1; i < lines.length; i += 1) {
    const raw = lines[i];
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const cells = parseCsvLine(raw);
    if (cells.length < minCols) continue;
    const bssid = cells[idxMac];
    const stationName = cells[idxName];
    const lineCode = cells[idxLine];
    if (bssid.length === 0 || stationName.length === 0) continue;
    const ssid = idxSsid !== -1 && cells.length > idxSsid ? cells[idxSsid] : '';
    rows.push({
      bssid: bssid.toLowerCase(),
      ssid,
      stationName: applyStationAlias(stationName),
      line: lineFromSubwayId(lineCode),
    });
  }
  return rows;
}

/**
 * row 배열을 BSSID → meta 맵으로 변환. 중복 BSSID(같은 MAC이 다른 역에 등장)는
 * 첫 row 보존 + 충돌 카운트만 stats에 기록 (이론상 unique지만 데이터 결함 방어).
 *
 * #1481 — `wifiBssidLookup`은 MAC+역명+호선만 활용하므로 ssid 필드는 제외.
 */
function buildBssidMap(rows) {
  const entries = {};
  let bssidCollisions = 0;
  for (const row of rows) {
    if (row.line === null) continue;
    if (entries[row.bssid] !== undefined) {
      bssidCollisions += 1;
      continue;
    }
    entries[row.bssid] = {
      stationName: row.stationName,
      line: row.line,
    };
  }
  return { entries, bssidCollisions };
}

/**
 * row 배열을 (stationName, line) → { bssidCount } 인덱스로 변환.
 * bssidCount는 platform AP 개수 (distinct BSSID).
 *
 * #1481 — SSID 컬럼 slim 후 `ssids` distinct list는 제외.
 */
function buildStationIndex(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (row.line === null) continue;
    const key = `${row.stationName}|${row.line}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        stationName: row.stationName,
        line: row.line,
        bssids: new Set(),
      });
    }
    const bucket = grouped.get(key);
    bucket.bssids.add(row.bssid);
  }
  const entries = [];
  for (const bucket of grouped.values()) {
    entries.push({
      stationName: bucket.stationName,
      line: bucket.line,
      bssidCount: bucket.bssids.size,
    });
  }
  entries.sort((a, b) => {
    const byName = a.stationName.localeCompare(b.stationName);
    return byName !== 0 ? byName : a.line.localeCompare(b.line);
  });
  return entries;
}

/**
 * stations.json과 교차 검증. 빌드된 entry의 (stationName, line)이 stations.json에 없으면
 * 경고 카운트. CI block은 아님 — 일부 역명 drift는 alias로 흡수되며, 미흡수분은 후속 작업.
 */
function validateAgainstStations(entries, stations) {
  const stationKey = new Set();
  for (const s of stations) {
    stationKey.add(`${normalizeStationName(s.name)}|${s.line}`);
  }
  const missing = [];
  for (const entry of entries) {
    const key = `${normalizeStationName(entry.stationName)}|${entry.line}`;
    if (!stationKey.has(key)) missing.push(key);
  }
  return missing;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readCsv(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function summarize(rows, stationIndex, bssidMap, missingStations) {
  // #1481 — slim CSV는 SSID 컬럼 미포함. 후방 호환을 위해 row.ssid가 있을 때만 카운트.
  const carrierCounts = {};
  for (const row of rows) {
    if (typeof row.ssid === 'string' && row.ssid.length > 0) {
      carrierCounts[row.ssid] = (carrierCounts[row.ssid] ?? 0) + 1;
    }
  }
  const linesCovered = new Set();
  for (const entry of stationIndex) linesCovered.add(entry.line);
  return {
    rowsParsed: rows.length,
    rowsWithKnownLine: rows.filter((r) => r.line !== null).length,
    rowsWithUnknownLine: rows.filter((r) => r.line === null).length,
    bssidEntries: Object.keys(bssidMap.entries).length,
    bssidCollisions: bssidMap.bssidCollisions,
    stationLinePairs: stationIndex.length,
    linesCovered: Array.from(linesCovered).sort((a, b) => a.localeCompare(b)),
    carrierCounts,
    stationsMissingInStationsJson: missingStations.length,
    missingSample: missingStations.slice(0, 10),
  };
}

function buildOutput({ rows, stations, generatedAt }) {
  const stationIndex = buildStationIndex(rows);
  const bssidMap = buildBssidMap(rows);
  const missing = validateAgainstStations(stationIndex, stations);
  const stats = summarize(rows, stationIndex, bssidMap, missing);
  const bssidOutput = {
    _meta: {
      description:
        '지하철 역사 platform WiFi BSSID → 역 매핑 (#1451, Epic #1432, B3). ' +
        '서울교통공사 tnSubwayWifi 공공데이터셋 기반. ' +
        '식별 단위는 BSSID(MAC) 1개당 1 platform. ' +
        'SSID는 carrier-generic이라 식별 가치가 낮아 slim CSV(#1481) 시 컬럼 제거됨.',
      source: 'scripts/서울교통공사_지하철역_WiFi_20260618.csv',
      sourceLicense: '서울교통공사 공공데이터',
      generatedAt,
      rowsParsed: stats.rowsParsed,
      bssidEntries: stats.bssidEntries,
      stationLinePairs: stats.stationLinePairs,
    },
    entries: bssidMap.entries,
  };
  const stationIndexOutput = {
    _meta: {
      description:
        '역별 platform WiFi 통계 (#1451). DebugModal / 운영 검증용. ' +
        'bssidCount는 platform AP 개수. ' +
        '#1481 slim 적용 후 ssids distinct list는 제외 (CSV SSID 컬럼 미보존).',
      source: 'scripts/서울교통공사_지하철역_WiFi_20260618.csv',
      generatedAt,
      stationLinePairs: stats.stationLinePairs,
      linesCovered: stats.linesCovered,
    },
    entries: stationIndex,
  };
  return { bssidOutput, stationIndexOutput, stats };
}

function main(deps) {
  const io = deps ?? {
    readCsv,
    readJson,
    writeJson,
    log: (...args) => console.log(...args),
    now: () => new Date().toISOString(),
  };
  const text = io.readCsv(CSV_PATH);
  const rows = parseCsv(text);
  const stations = io.readJson(STATIONS_JSON);
  const { bssidOutput, stationIndexOutput, stats } = buildOutput({
    rows,
    stations,
    generatedAt: io.now(),
  });
  io.writeJson(BSSID_OUT, bssidOutput);
  io.writeJson(STATION_INDEX_OUT, stationIndexOutput);
  io.log(`[wifi-ssid] rows=${stats.rowsParsed} bssid=${stats.bssidEntries} pairs=${stats.stationLinePairs}`);
  io.log(`[wifi-ssid] lines=${stats.linesCovered.join(',')}`);
  io.log(
    `[wifi-ssid] missing-in-stations.json=${stats.stationsMissingInStationsJson}` +
      (stats.missingSample.length > 0 ? ` sample=${stats.missingSample.join('; ')}` : ''),
  );
  return stats;
}

module.exports = {
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
};

if (require.main === module) {
  main();
}
