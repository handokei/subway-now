#!/usr/bin/env node
// 공식 역사심도정보 → src/data/platformExitSide.json 빌드 스크립트 (#3129).
//
// 하차문 방향은 승강장 구조(형식) + 열차 주행방향(좌/우측통행)으로 결정되는 고정 정보.
//   우측통행: 상대식 → right / 섬식 → left. 좌측통행 노선은 반전.
//
// 추정 금지 원칙 — 아래 중 하나라도 해당하면 값을 만들지 않는다(null = 출력에서 키 생략):
//   - 심도 CSV에 행이 없음 / 형식이 단순 섬식·상대식이 아님(섬식(복합), 단선 …)
//   - 건축 CSV에 없고 override도 없음 / 심도 CSV와 형식이 다름(교차 검증 실패)
//     (override는 건축 행이 없을 때만 쓰이며, 심도와 다르면 override-disagree로 null)
//   - 노선의 주행방향 근거가 없음(line-running-side.json의 side가 null)
// 'both'는 어떤 경로로도 만들지 않는다 (종착역 override 제거).
//
// 입력:
//   data/raw/used/서울교통공사_역사심도정보_20241104.csv  (공식, OA-13305) — 주 소스
//   scripts/fixtures/seoul-station-architecture.csv       (역사건축정보) — 교차 검증용
//   scripts/fixtures/platform-name-aliases.json           (CSV 간 역명 표기 불일치 13쌍)
//   scripts/fixtures/line-running-side.json               (노선별 주행방향 + 근거)
//   scripts/fixtures/platform-format-overrides.json       (건축 CSV에 행이 없는 역의 독립 출처 형식. 심도와 일치할 때만 사용)
//   src/data/stations.json                                (id ← (line, name))
//
// 출력:
//   src/data/platformExitSide.json  ({ "<id>": { side: "left|right", grade: "official-derived" } })
//   콘솔 리포트 (노선별 left/right/null + null 사유)
//
// 방향별 override(위키 등)는 src/data/platformExitSideByDirection.json에 수작업으로 둔다.
//
// ── 공식 데이터셋 밖 노선: 위키 교차검증 (#3177, 사용자 결정 2026-11-22 옵션 1) ──
//   두 위키가 일치할 때만 채운다 (grade 'wiki-crosschecked'):
//     · 위키백과 개별 역 문서의 승강장 형식 (scripts/fixtures/wiki-platform-formats/<line>.json)
//     · 나무위키 노선 '역 목록' 승강장 열 글리프 (│■│=섬식 2선, ■││■=상대식 2선; ■=승강장, │=선로)
//   도출 조건: 두 소스가 같은 단순형(섬식/상대식) + 선로 정확히 2개(3선↑·복합·두단식·단선 제외)
//             + 해당 구간 주행방향(좌/우측통행)이 인용과 함께 확립됨.
//   구간별 주행방향은 scripts/fixtures/section-running-side.json (line-running-side.json의
//   1~8호선 값은 서울교통공사 구간 전용이라 건드리지 않는다). 하나라도 어긋나면 키 생략(null).
//   나무위키(CC BY-NC-SA)는 교차검증 용도로만 쓰고 값의 직접 출처로 삼지 않는다.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEPTH_CSV_PATH = path.join(
  PROJECT_ROOT,
  'data/raw/used/서울교통공사_역사심도정보_20241104.csv',
);
const ARCH_CSV_PATH = path.join(PROJECT_ROOT, 'scripts/fixtures/seoul-station-architecture.csv');
const ALIASES_PATH = path.join(PROJECT_ROOT, 'scripts/fixtures/platform-name-aliases.json');
const OVERRIDES_PATH = path.join(PROJECT_ROOT, 'scripts/fixtures/platform-format-overrides.json');
const RUNNING_SIDE_PATH = path.join(PROJECT_ROOT, 'scripts/fixtures/line-running-side.json');
const SECTION_RUNNING_SIDE_PATH = path.join(
  PROJECT_ROOT,
  'scripts/fixtures/section-running-side.json',
);
const WIKI_FORMATS_DIR = path.join(PROJECT_ROOT, 'scripts/fixtures/wiki-platform-formats');
const STATIONS_JSON_PATH = path.join(PROJECT_ROOT, 'src/data/stations.json');
const OUTPUT_PATH = path.join(PROJECT_ROOT, 'src/data/platformExitSide.json');

const GRADE_OFFICIAL_DERIVED = 'official-derived';
const GRADE_WIKI_CROSSCHECKED = 'wiki-crosschecked';

// 나무위키 승강장 열 글리프 → 형식. ■=승강장, │=선로. 2선 단순형만 형식을 가진다.
const NAMU_GLYPH_TO_FORMAT = Object.freeze({
  '│■│': '섬식',
  '■││■': '상대식',
});
const NAMU_TRACK_CHAR = '│';
const REQUIRED_TRACKS = 2;

// 우측통행 기준 형식 → 좌/우. 좌측통행은 FLIP으로 반전. 여기 없는 형식은 모두 null.
const RIGHT_HAND_FORMAT_TO_SIDE = Object.freeze({
  상대식: 'right',
  섬식: 'left',
});
const FLIP_SIDE = Object.freeze({ left: 'right', right: 'left' });

// 본 데이터셋 범위. 심도정보가 서울교통공사 1~8호선만 커버한다.
const SUPPORTED_LINES = Object.freeze(['1', '2', '3', '4', '5', '6', '7', '8']);

// 형식 + 주행방향 → 좌/우. 단순형이 아니거나 주행방향이 left/right가 아니면 null.
function mapFormatToSide(format, runningSide) {
  if (format == null || !(runningSide in FLIP_SIDE)) return null;
  const rightHandSide = RIGHT_HAND_FORMAT_TO_SIDE[format.trim()];
  if (!rightHandSide) return null;
  return runningSide === 'right' ? rightHandSide : FLIP_SIDE[rightHandSide];
}

// 한 역의 좌/우를 결정하고, null이면 사유를 함께 돌려준다.
function resolveStationSide({ depthFormat, archFormat, overrideFormat = null, runningSide }) {
  if (depthFormat == null) return { side: null, reason: 'no-depth-row' };
  if (!(depthFormat.trim() in RIGHT_HAND_FORMAT_TO_SIDE)) {
    return { side: null, reason: 'depth-not-plain' };
  }
  if (archFormat == null) {
    if (overrideFormat == null) return { side: null, reason: 'arch-missing' };
    if (overrideFormat.trim() !== depthFormat.trim()) {
      return { side: null, reason: 'override-disagree' };
    }
  } else if (archFormat.trim() !== depthFormat.trim()) {
    return { side: null, reason: 'format-disagree' };
  }
  const side = mapFormatToSide(depthFormat, runningSide);
  if (side == null) return { side: null, reason: 'running-side-unknown' };
  return { side, reason: 'derived' };
}

// 나무위키 글리프 → { format, tracks }. 단순 2선형이 아니면 format null(선로 수만 센다).
function classifyNamuGlyph(glyph) {
  if (!glyph) return { format: null, tracks: null };
  const tracks = Array.from(glyph).filter((ch) => ch === NAMU_TRACK_CHAR).length;
  return { format: NAMU_GLYPH_TO_FORMAT[glyph.trim()] ?? null, tracks };
}

// 위키백과 + 나무위키가 일치할 때만 좌/우를 도출한다. null이면 사유를 함께 돌려준다.
function resolveWikiCrosscheckSide({ wikipedia, namuGlyph, runningSide }) {
  if (!wikipedia || !namuGlyph) return { side: null, reason: 'missing-source' };
  const namu = classifyNamuGlyph(namuGlyph);
  if (wikipedia.tracks !== REQUIRED_TRACKS || namu.tracks !== REQUIRED_TRACKS) {
    return { side: null, reason: 'not-two-tracks' };
  }
  const isPlain = (format) => format != null && Object.hasOwn(RIGHT_HAND_FORMAT_TO_SIDE, format);
  if (!isPlain(wikipedia.format) || !isPlain(namu.format)) {
    return { side: null, reason: 'not-plain' };
  }
  if (wikipedia.format !== namu.format) return { side: null, reason: 'format-disagree' };
  const side = mapFormatToSide(wikipedia.format, runningSide);
  if (side == null) return { side: null, reason: 'running-side-unknown' };
  return { side, reason: 'derived' };
}

// 구간 테이블에서 (노선, 역 id)에 적용되는 주행방향. stationIds 미지정 구간은 매핑 보류라 적용 안 함.
function findSectionRunningSide(sections, line, stationId) {
  const section = sections.find(
    (s) =>
      s.line === line &&
      (s.stationIds === 'all' ||
        (Array.isArray(s.stationIds) && s.stationIds.includes(stationId))),
  );
  return section?.side ?? null;
}

// CSV 한 줄을 따옴표 포함/미포함 컬럼으로 파싱한다.
function parseCsvLine(line) {
  const cols = [];
  let cur = '';
  let inQuote = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (ch === ',' && !inQuote) {
      cols.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  cols.push(cur);
  return cols;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// 헤더명(호선/역명/형식)으로 컬럼을 찾아 `${호선}|${정규화된 역명}` → 형식 맵을 만든다.
// 역명은 별칭 테이블(심도 CSV 표기 → 건축 CSV/stations 표기)을 거쳐 canonical로 통일한다.
function loadFormatCsv(csvPath, aliases) {
  const text = fs.readFileSync(csvPath, 'utf8').replace(/^﻿/, '');
  const [header, ...rows] = text.split(/\r?\n/);
  const names = parseCsvLine(header);
  const [lineIdx, nameIdx, formatIdx] = ['호선', '역명', '형식'].map((n) => names.indexOf(n));
  const map = new Map();
  for (const row of rows) {
    if (!row.trim()) continue;
    const cols = parseCsvLine(row);
    if (cols.length <= Math.max(lineIdx, nameIdx, formatIdx)) continue;
    const line = cols[lineIdx].trim();
    const name = cols[nameIdx].trim();
    map.set(`${line}|${aliases[`${line}|${name}`] ?? name}`, cols[formatIdx].trim());
  }
  return map;
}

// 괄호 부제를 정규식 없이 제거한다(예: '청량리(서울시립대입구)' → '청량리').
// indexOf 선형 스캔이라 정의상 super-linear 경로가 없다 (SonarCloud S5852 회피).
function stripParens(input) {
  let out = '';
  let cursor = 0;
  while (cursor < input.length) {
    const open = input.indexOf('(', cursor);
    if (open < 0) {
      out += input.slice(cursor);
      break;
    }
    out += input.slice(cursor, open);
    const close = input.indexOf(')', open + 1);
    if (close < 0) {
      // 짝 안 맞는 여는 괄호: 원본을 그대로 보존 (잘못 잘라내지 않는다).
      out += input.slice(open);
      break;
    }
    cursor = close + 1;
  }
  return out;
}

// stations.json 이름과 CSV 표기 사이의 변형: 원본 / 괄호 부제 제거 / '역' 접미사 제거.
function buildNameAliases(name) {
  const baseName = stripParens(name).trim();
  const aliases = new Set([name, baseName]);
  if (baseName.endsWith('역')) {
    aliases.add(baseName.slice(0, -1));
  }
  return Array.from(aliases);
}

function lookupFormat(line, name, formatMap) {
  for (const alias of buildNameAliases(name)) {
    const key = `${line}|${alias}`;
    if (formatMap.has(key)) return formatMap.get(key);
  }
  return null;
}

// scripts/fixtures/wiki-platform-formats/*.json 전부 로드 (파일 1개 = 노선 1개, 파일명 순).
function loadWikiFormatFixtures() {
  return fs
    .readdirSync(WIKI_FORMATS_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => readJson(path.join(WIKI_FORMATS_DIR, file)));
}

// 공식 데이터셋 밖 노선을 위키 교차검증으로 채운다. fixture가 있는 노선만 대상.
function buildWikiCrosscheck(stations, sections, fixtures) {
  const output = {};
  const wikiStats = {};
  const wikiNullList = [];
  for (const { line, stations: raw } of fixtures) {
    wikiStats[line] = { left: 0, right: 0, unknown: 0 };
    const lineStations = stations
      .filter((s) => s.line === line)
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const { id, name } of lineStations) {
      const { wikipedia, namuwiki } = raw[id] ?? {};
      const runningSide = findSectionRunningSide(sections, line, id);
      const { side, reason } = resolveWikiCrosscheckSide({
        wikipedia,
        namuGlyph: namuwiki?.glyph,
        runningSide,
      });
      if (side == null) {
        wikiStats[line].unknown++;
        wikiNullList.push({ id, line, name, reason });
        continue;
      }
      output[id] = { side, grade: GRADE_WIKI_CROSSCHECKED };
      wikiStats[line][side]++;
    }
  }
  return { output, wikiStats, wikiNullList };
}

function printWikiReport(wikiStats, wikiNullList) {
  console.log('\n=== 위키 교차검증 (wiki-crosschecked) ===');
  for (const [line, counts] of Object.entries(wikiStats)) {
    console.log(`  ${line}호선 left=${counts.left} right=${counts.right} null=${counts.unknown}`);
  }
  for (const entry of wikiNullList) {
    console.log(`  ${entry.id} ${entry.line}호선 ${entry.name} [${entry.reason}]`);
  }
}

function printBuildReport(supported, stats, nullList) {
  console.log('=== Platform Exit Side 빌드 완료 ===');
  console.log(`출력: ${path.relative(PROJECT_ROOT, OUTPUT_PATH)}`);
  console.log(`총 1~8호선 stations.json: ${supported.length}`);
  console.log(`  right: ${stats.right}`);
  console.log(`  left:  ${stats.left}`);
  console.log(`null 리스트: ${stats.unknown} (추정 금지 — 값 생략)`);
  for (const [line, counts] of Object.entries(stats.byLine)) {
    console.log(`  ${line}호선 left=${counts.left} right=${counts.right} null=${counts.unknown}`);
  }

  if (nullList.length > 0) {
    console.log('\n--- null 리스트 (사유별) ---');
    for (const entry of nullList) {
      console.log(
        `  ${entry.id} ${entry.line}호선 ${entry.name} [${entry.reason}] depth=${entry.depthFormat} arch=${entry.archFormat}`,
      );
    }
  }
}

function build() {
  const aliases = readJson(ALIASES_PATH);
  const runningSideByLine = readJson(RUNNING_SIDE_PATH);
  const depthMap = loadFormatCsv(DEPTH_CSV_PATH, aliases);
  const archMap = loadFormatCsv(ARCH_CSV_PATH, aliases);
  const overrides = readJson(OVERRIDES_PATH);
  const stations = readJson(STATIONS_JSON_PATH);

  const output = {};
  const nullList = [];
  const stats = { right: 0, left: 0, unknown: 0, byLine: {} };

  // 매핑은 정렬된 id 순으로 작성해 diff가 안정적이게 한다.
  const supported = stations
    .filter((s) => SUPPORTED_LINES.includes(s.line))
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const station of supported) {
    const { id, line, name } = station;
    const depthFormat = lookupFormat(line, name, depthMap);
    const archFormat = lookupFormat(line, name, archMap);
    const overrideFormat = overrides[`${line}|${name}`]?.format ?? null;
    const runningSide = runningSideByLine[line]?.side ?? null;
    const { side, reason } = resolveStationSide({
      depthFormat,
      archFormat,
      overrideFormat,
      runningSide,
    });

    stats.byLine[line] ??= { left: 0, right: 0, unknown: 0 };
    if (side == null) {
      stats.unknown++;
      stats.byLine[line].unknown++;
      nullList.push({ id, line, name, reason, depthFormat, archFormat });
      continue;
    }

    output[id] = { side, grade: GRADE_OFFICIAL_DERIVED };
    stats[side]++;
    stats.byLine[line][side]++;
  }

  const sections = readJson(SECTION_RUNNING_SIDE_PATH).sections;
  const wiki = buildWikiCrosscheck(stations, sections, loadWikiFormatFixtures());
  Object.assign(output, wiki.output);

  // 결정적 출력 — id 사전순 정렬. 파일 끝 newline 유지.
  const sorted = Object.fromEntries(
    Object.entries(output).sort(([a], [b]) => a.localeCompare(b)),
  );
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(sorted, null, 2) + '\n', 'utf8');

  printBuildReport(supported, stats, nullList);
  printWikiReport(wiki.wikiStats, wiki.wikiNullList);

  return {
    output: sorted,
    stats,
    nullList,
    wikiStats: wiki.wikiStats,
    wikiNullList: wiki.wikiNullList,
  };
}

if (require.main === module) {
  build();
}

module.exports = {
  build,
  mapFormatToSide,
  resolveStationSide,
  parseCsvLine,
  buildNameAliases,
  stripParens,
  classifyNamuGlyph,
  resolveWikiCrosscheckSide,
  findSectionRunningSide,
  SUPPORTED_LINES,
  GRADE_OFFICIAL_DERIVED,
  GRADE_WIKI_CROSSCHECKED,
};
