#!/usr/bin/env node
// 승강장 구조 CSV → src/data/platformExitSide.json 빌드 스크립트.
//
// 사용자 통찰: 하차문 방향은 승강장 구조로 결정되는 고정 정보.
//   상대식 → right
//   섬식   → left
//   복합식/단선/시종착역 → both
//
// 입력:
//   scripts/fixtures/seoul-station-architecture.csv (호선, 역명, 형식 ...)
//   scripts/fixtures/seoul-station-depth.csv (연번, 호선, 역명, 층수, 형식 ...)
//   src/data/stations.json (id ← (line, name) 역인덱스)
//   src/data/lineTerminals.json (시종착역 override)
//
// 출력:
//   src/data/platformExitSide.json  ({ "<id>": "left|right|both" })
//   콘솔 리포트 (매핑 통계 + unknown 리스트)

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ARCH_CSV_PATH = path.join(PROJECT_ROOT, 'scripts/fixtures/seoul-station-architecture.csv');
const DEPTH_CSV_PATH = path.join(PROJECT_ROOT, 'scripts/fixtures/seoul-station-depth.csv');
const STATIONS_JSON_PATH = path.join(PROJECT_ROOT, 'src/data/stations.json');
const LINE_TERMINALS_PATH = path.join(PROJECT_ROOT, 'src/data/lineTerminals.json');
const OUTPUT_PATH = path.join(PROJECT_ROOT, 'src/data/platformExitSide.json');

// CSV "형식" 컬럼 → PlatformExitSide 매핑.
// 입력값은 build 시점에 알려진 것만 매핑하고, 그 외는 null (unknown 처리).
const FORMAT_TO_SIDE = Object.freeze({
  상대식: 'right',
  섬식: 'left',
  복합식: 'both',
  '섬식(복합)': 'both',
  단선: 'both',
});

// 본 데이터셋 범위. CSV가 1~8호선만 커버하므로 stations.json에서 동일 범위만 추출.
const SUPPORTED_LINES = Object.freeze(['1', '2', '3', '4', '5', '6', '7', '8']);

function mapFormatToSide(format) {
  if (format == null) return null;
  return FORMAT_TO_SIDE[format.trim()] ?? null;
}

// CSV 한 줄을 따옴표 포함/미포함 컬럼으로 파싱한다.
// 본 fixtures의 형식은 단순(escape 없음)해 정규식 한 번으로 충분.
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

function loadArchCsv() {
  const text = fs.readFileSync(ARCH_CSV_PATH, 'utf8');
  const lines = text.split(/\r?\n/);
  // header: "호선","역명","형식","길이(M)","층수","면적(㎡)","준공년도"
  const map = new Map();
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i];
    if (!row.trim()) continue;
    const cols = parseCsvLine(row);
    if (cols.length < 3) continue;
    const [ho, nm, fmt] = cols;
    map.set(`${ho}|${nm}`, fmt);
  }
  return map;
}

function loadDepthCsv() {
  const text = fs.readFileSync(DEPTH_CSV_PATH, 'utf8');
  const lines = text.split(/\r?\n/);
  // header: 연번,호선,역명,층수,형식,...
  const map = new Map();
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i];
    if (!row.trim()) continue;
    const cols = parseCsvLine(row);
    if (cols.length < 5) continue;
    const ho = cols[1];
    const nm = cols[2];
    const fmt = cols[4];
    map.set(`${ho}|${nm}`, fmt);
  }
  return map;
}

function loadStations() {
  return JSON.parse(fs.readFileSync(STATIONS_JSON_PATH, 'utf8'));
}

function loadLineTerminals() {
  return JSON.parse(fs.readFileSync(LINE_TERMINALS_PATH, 'utf8'));
}

// stations.json 이름과 CSV 표기 사이의 변형을 모두 시도한다.
//   1) 원본
//   2) 괄호 부제 제거(예: '청량리(서울시립대입구)' → '청량리')
//   3) '역' 접미사 제거(예: '서울역' → '서울')
function buildNameAliases(name) {
  // ReDoS-safe: `[^)]*`는 부정 character class라 backtracking이 발생하지 않는다.
  // (lazy `.*?`는 입력에 따라 super-linear가 될 수 있어 SonarCloud S5852가 차단.)
  const baseName = name.replace(/\([^)]*\)/g, '').trim();
  const aliases = new Set([name, baseName]);
  if (baseName.endsWith('역')) {
    aliases.add(baseName.slice(0, -1));
  }
  return Array.from(aliases);
}

function lookupFormat(line, name, archMap, depthMap) {
  const aliases = buildNameAliases(name);
  const tryKeys = aliases.map((alias) => `${line}|${alias}`);
  for (const key of tryKeys) {
    if (archMap.has(key)) return { format: archMap.get(key), source: 'arch' };
  }
  for (const key of tryKeys) {
    if (depthMap.has(key)) return { format: depthMap.get(key), source: 'depth' };
  }
  return null;
}

// 시종착역 override — lineTerminals의 up/down 역명은 분기/회차로 양쪽 문이 열리므로
// CSV가 단순 형식("상대식" 등)이라도 'both'로 덮어쓴다.
function buildTerminalIndex(lineTerminals) {
  const index = new Map(); // key: line|name
  for (const [line, terminals] of Object.entries(lineTerminals)) {
    if (!SUPPORTED_LINES.includes(line)) continue;
    for (const role of ['up', 'down']) {
      const name = terminals[role];
      if (!name) continue;
      index.set(`${line}|${name}`, true);
    }
  }
  return index;
}

// 한 역의 하차문 방향을 결정한다.
// 시종착역이면 분기/회차로 양쪽 문이 열리므로 무조건 'both'로 덮어쓴다.
// CSV 매칭 실패 + 시종착도 아니면 null (caller가 unknown 누적).
function resolveStationSide(station, archMap, depthMap, terminalIndex) {
  const isTerminal = terminalIndex.has(`${station.line}|${station.name}`);
  const lookup = lookupFormat(station.line, station.name, archMap, depthMap);
  const csvSide = lookup ? mapFormatToSide(lookup.format) : null;
  if (isTerminal) {
    return { side: 'both', terminalOverride: true, lookup };
  }
  return { side: csvSide, terminalOverride: false, lookup };
}

function printBuildReport(supported, stats, unknownList) {
  console.log('=== Platform Exit Side 빌드 완료 ===');
  console.log(`출력: ${path.relative(PROJECT_ROOT, OUTPUT_PATH)}`);
  console.log(`총 1~8호선 stations.json: ${supported.length}`);
  console.log(`매핑 결정: ${supported.length - stats.unknown}`);
  console.log(`  right: ${stats.right}`);
  console.log(`  left:  ${stats.left}`);
  console.log(`  both:  ${stats.both} (시종착 override ${stats.terminalOverride}건 포함)`);
  console.log(`unknown: ${stats.unknown} (CSV 미수록 — 매핑 누락)`);

  if (unknownList.length > 0) {
    console.log('\n--- unknown 리스트 (사용자 검수 필요) ---');
    for (const entry of unknownList) {
      console.log(`  ${entry.id} ${entry.line}호선 ${entry.name}`);
    }
  }
}

function build() {
  const archMap = loadArchCsv();
  const depthMap = loadDepthCsv();
  const stations = loadStations();
  const lineTerminals = loadLineTerminals();
  const terminalIndex = buildTerminalIndex(lineTerminals);

  const output = {};
  const stats = { right: 0, left: 0, both: 0, unknown: 0, terminalOverride: 0 };
  const unknownList = [];

  // 매핑은 정렬된 id 순으로 작성해 diff가 안정적이게 한다.
  const supported = stations
    .filter((s) => SUPPORTED_LINES.includes(s.line))
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const station of supported) {
    const { side, terminalOverride, lookup } = resolveStationSide(
      station,
      archMap,
      depthMap,
      terminalIndex,
    );
    if (terminalOverride) stats.terminalOverride++;

    if (side == null) {
      stats.unknown++;
      unknownList.push({
        id: station.id,
        line: station.line,
        name: station.name,
        rawFormat: lookup ? lookup.format : null,
      });
      continue;
    }

    output[station.id] = side;
    stats[side]++;
  }

  // 결정적 출력 — 키 정렬은 id sort된 input 순서로 이미 보장됨.
  // 파일 끝 newline 유지.
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n', 'utf8');

  printBuildReport(supported, stats, unknownList);

  return { output, stats, unknownList };
}

if (require.main === module) {
  build();
}

module.exports = {
  build,
  mapFormatToSide,
  parseCsvLine,
  buildNameAliases,
  FORMAT_TO_SIDE,
  SUPPORTED_LINES,
};
