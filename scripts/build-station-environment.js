#!/usr/bin/env node
/**
 * build-station-environment.js — ADR-015 §1 Deterministic Environment SSOT (#1434).
 *
 * stations.json 528역에 `environment` 필드를 채워 넣는다. 분기 판정은 데이터
 * 기반 deterministic — barometer warm-up 결과 기다리지 않고 지상/지하/복합/미상을
 * 사전 결정한다.
 *
 * ## 데이터 출처 + 우선순위
 * 1. **명시적 override** (이 파일 ENVIRONMENT_OVERRIDES) — 외부 노선(9/airport/
 *    gyeongui/bundang/sinbundang) + CSV 매칭 불가 케이스. 사용자 검증 trip의 역들
 *    (성수/뚝섬/한양대/왕십리/마장)은 모두 명시 — CSV 매칭과 cross-check 대상.
 * 2. **서울교통공사 역사건축정보 CSV** (`scripts/fixtures/seoul-station-architecture.csv`)
 *    — 1~8호선 약 275역. 층수 컬럼으로 자동 분류:
 *      - B prefix (B2, B3, B4...) → underground
 *      - F prefix (1F, 2F, 3F...) → surface
 *      - 둘 다 포함 (2FB3, 5FB2, 1FB5...) → mixed
 *    출처: 서울 열린데이터 광장 — 서울교통공사_역사건축정보.
 * 3. **국가철도공단 9호선 승강장 CSV** (`scripts/fixtures/line9-platform.csv`)
 *    — 9호선 38역. 상행/하행 2 row의 `지상구분`(지상/지하) 컬럼 그룹화:
 *      - 둘 다 `지상` → surface
 *      - 둘 다 `지하` → underground
 *      - 상행/하행 다름 → mixed
 *    출처: 공공데이터포털 — 국가철도공단_수도권9호선_승강장_정보 (#1460).
 * 4. **매칭 실패** → `unknown`. 표준 출력에 리스트 출력 (사용자 검수용).
 *
 * ## 매칭 규칙
 * - CSV `호선` ↔ stations.json `line` 직접 비교 (둘 다 `"1"`~`"8"`).
 * - 역명은 `normalizeStationName`으로 후행 괄호 부제 제거 후 매칭
 *   (예: stations.json "왕십리(성동구청)" ↔ CSV "왕십리").
 * - override는 (line, normalized name) 키. CSV보다 우선.
 *
 * ## 결정성
 * 같은 입력 → 같은 출력. 위키 스크랩 같은 네트워크 의존 X. CI 안전.
 *
 * ## 사용
 *   node scripts/build-station-environment.js              # 실 적용 (stations.json 덮어쓰기)
 *   node scripts/build-station-environment.js --dry-run    # 보고만, 파일 변경 X
 *
 * ## 출력 통계
 *   surface / underground / mixed / unknown 카운트
 *   unknown 리스트 (검수용)
 *   override / csv / unknown source 분포
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { normalizeStationName } = require('../src/shared/utils/normalizeStationName');

const ROOT = path.join(__dirname, '..');
const STATIONS_PATH = path.join(ROOT, 'src', 'data', 'stations.json');
const CSV_PATH = path.join(__dirname, 'fixtures', 'seoul-station-architecture.csv');
const LINE9_CSV_PATH = path.join(__dirname, 'fixtures', 'line9-platform.csv');
const BUNDANG_CSV_PATH = path.join(__dirname, 'fixtures', 'bundang-platform.csv');
const SINBUNDANG_CSV_PATH = path.join(__dirname, 'fixtures', 'sinbundang-platform.csv');
const AIRPORT_CSV_PATH = path.join(__dirname, 'fixtures', 'airport-platform.csv');

const LINE9_KEY = '9';
const LINE9_SURFACE_LABEL = '지상';
const LINE9_UNDERGROUND_LABEL = '지하';

/**
 * 외부 운영 노선 CSV → stations.json `line` 키 매핑 (#1469).
 *
 * 국가철도공단 표준 승강장 CSV (`철도운영기관명,선명,역명,승강장번호,상하행,
 * 지상구분,역층,...`)는 9호선과 동일 포맷. 각 CSV의 stations.json `line`
 * key를 명시해 `parseOperatorPlatformCsv`로 일괄 처리한다.
 *
 * 경춘선/우이신설선은 stations.json `line` entry 자체가 없으므로 본 매핑 X
 * (별도 follow-up 이슈에서 신규 entry 추가).
 */
const EXTERNAL_LINE_CSV_KEYS = Object.freeze({
  BUNDANG: 'bundang',
  SINBUNDANG: 'sinbundang',
  AIRPORT: 'airport',
});

const VALID_ENVIRONMENTS = new Set(['surface', 'underground', 'mixed', 'unknown']);

/**
 * 외부 노선(9/airport/gyeongui/bundang/sinbundang) + CSV에 없는 1~8호선 역 +
 * 사용자 검증 trip 역들의 명시적 분류.
 *
 * 출처: 한국어 위키백과/나무위키 각 역 페이지 "구조" 절 + 운영사 공식 안내도.
 * 데이터셋이 정적이므로 stations.json 다음 갱신 시점에 동일 절차로 갱신한다.
 *
 * 키 형식: `"<line>|<normalizedName>"` (예: `"bundang|왕십리"`).
 * 같은 좌표 다중 line 환승역은 line별로 별도 entry.
 */
const ENVIRONMENT_OVERRIDES = Object.freeze({
  // ---- 사용자 검증 trip 역 (cross-check; CSV와 일치해야 함) ----
  '2|성수': 'surface',
  '2|뚝섬': 'surface',
  '2|한양대': 'surface',
  '2|왕십리': 'underground',
  '5|왕십리': 'underground',
  '5|마장': 'underground',
  'gyeongui|왕십리': 'underground',
  'bundang|왕십리': 'underground',
});

/**
 * @param {string} floor CSV 층수 컬럼 값 (예: "B2", "3F", "5FB2")
 * @returns {'surface'|'underground'|'mixed'|'unknown'}
 */
function classifyFloor(floor) {
  if (typeof floor !== 'string') return 'unknown';
  const trimmed = floor.trim();
  if (trimmed.length === 0) return 'unknown';
  // bounded quantifiers — CSV 층수 컬럼은 1~2자리. ReDoS 방어 (SonarCloud S5852).
  const hasUnderground = /B\d{1,2}/u.test(trimmed);
  const hasSurface = /\d{1,2}F/u.test(trimmed);
  if (hasUnderground && hasSurface) return 'mixed';
  if (hasUnderground) return 'underground';
  if (hasSurface) return 'surface';
  return 'unknown';
}

/**
 * CSV row 배열을 (line, normalizedName) → environment 맵으로 변환.
 * @param {string} csvText UTF-8
 * @returns {Map<string, 'surface'|'underground'|'mixed'|'unknown'>}
 */
function parseCsv(csvText) {
  const lines = csvText.split(/\r?\n/u).filter((l) => l.length > 0);
  const map = new Map();
  // 첫 줄 header skip.
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvRow(lines[i]);
    if (cols.length < 5) continue;
    const line = cols[0];
    const name = normalizeStationName(cols[1]);
    const floor = cols[4];
    const env = classifyFloor(floor);
    const key = `${line}|${name}`;
    map.set(key, env);
  }
  return map;
}

/**
 * 단순 CSV row parser — 모든 값이 `"..."`로 감싸져 있고 값 내부 쉼표/개행이 없는
 * 서울교통공사 CSV 형식 전용. 외부 CSV 일반 파싱 X.
 * @param {string} row
 * @returns {string[]}
 */
function parseCsvRow(row) {
  return row.split(',').map((cell) => cell.replace(/^"|"$/gu, ''));
}

/**
 * 국가철도공단 표준 승강장 CSV → (line|name) → env 맵.
 *
 * CSV 컬럼: 철도운영기관명(0) / 선명(1) / 역명(2) / 승강장번호(3) / 상하행(4) /
 * 지상구분(5) / 역층(6) / ... 같은 역명에 상행/하행 2 row가 있고, 지상구분이
 * 일치하면 단일 값, 다르면 mixed로 그룹화한다.
 *
 * `lineKey` 인자로 stations.json `line` key를 지정한다 — 9호선(`"9"`),
 * 수인분당(`"bundang"`), 신분당(`"sinbundang"`), 공항철도(`"airport"`) 등.
 *
 * @param {string} csvText UTF-8 (cp949 입력은 호출 측에서 사전 변환)
 * @param {string} lineKey stations.json `line` 키 (예: `"9"`, `"bundang"`)
 * @returns {Map<string, 'surface'|'underground'|'mixed'|'unknown'>}
 */
function parseOperatorPlatformCsv(csvText, lineKey) {
  const lines = csvText.split(/\r?\n/u).filter((l) => l.length > 0);
  /** @type {Map<string, Set<string>>} */
  const byStation = new Map();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 6) continue;
    const name = normalizeStationName(cols[2]);
    const label = cols[5];
    if (name.length === 0) continue;
    if (label !== LINE9_SURFACE_LABEL && label !== LINE9_UNDERGROUND_LABEL) continue;
    let bucket = byStation.get(name);
    if (!bucket) {
      bucket = new Set();
      byStation.set(name, bucket);
    }
    bucket.add(label);
  }
  /** @type {Map<string, 'surface'|'underground'|'mixed'|'unknown'>} */
  const out = new Map();
  for (const [name, labels] of byStation) {
    let env;
    if (labels.size > 1) env = 'mixed';
    else if (labels.has(LINE9_SURFACE_LABEL)) env = 'surface';
    else if (labels.has(LINE9_UNDERGROUND_LABEL)) env = 'underground';
    else env = 'unknown';
    out.set(`${lineKey}|${name}`, env);
  }
  return out;
}

/**
 * 후방 호환 — 기존 9호선 전용 헬퍼.
 * @param {string} csvText
 * @returns {Map<string, 'surface'|'underground'|'mixed'|'unknown'>}
 */
function parseLine9Csv(csvText) {
  return parseOperatorPlatformCsv(csvText, LINE9_KEY);
}

/**
 * @param {{
 *   stations: Array<Record<string, unknown>>,
 *   csvText: string,
 *   line9CsvText?: string,
 *   externalCsvs?: Array<{ lineKey: string, csvText: string, source: string }>,
 * }} input
 * @returns {{
 *   stations: Array<Record<string, unknown>>,
 *   stats: {
 *     total: number,
 *     bySource: Record<string, number>,
 *     byEnv: { surface: number, underground: number, mixed: number, unknown: number },
 *     unknownEntries: Array<{ id: string, name: string, line: string }>,
 *   },
 * }}
 */
function build({ stations, csvText, line9CsvText, externalCsvs }) {
  const csvMap = parseCsv(csvText);
  const line9Map = typeof line9CsvText === 'string' ? parseLine9Csv(line9CsvText) : new Map();
  /** @type {Map<string, { env: string, source: string }>} */
  const externalMap = new Map();
  if (Array.isArray(externalCsvs)) {
    for (const entry of externalCsvs) {
      const m = parseOperatorPlatformCsv(entry.csvText, entry.lineKey);
      for (const [k, v] of m) {
        externalMap.set(k, { env: v, source: entry.source });
      }
    }
  }
  const stats = {
    total: stations.length,
    bySource: { override: 0, csv: 0, line9: 0, unknown: 0 },
    byEnv: { surface: 0, underground: 0, mixed: 0, unknown: 0 },
    unknownEntries: [],
  };

  const next = stations.map((stn) => {
    const name = typeof stn.name === 'string' ? normalizeStationName(stn.name) : '';
    const line = typeof stn.line === 'string' ? stn.line : '';
    const key = `${line}|${name}`;

    let environment = 'unknown';
    let source = 'unknown';

    if (Object.hasOwn(ENVIRONMENT_OVERRIDES, key)) {
      environment = ENVIRONMENT_OVERRIDES[key];
      source = 'override';
    } else if (externalMap.has(key)) {
      const ext = externalMap.get(key);
      environment = ext.env;
      source = environment === 'unknown' ? 'unknown' : ext.source;
    } else if (line9Map.has(key)) {
      environment = line9Map.get(key);
      source = environment === 'unknown' ? 'unknown' : 'line9';
    } else if (csvMap.has(key)) {
      environment = csvMap.get(key);
      source = environment === 'unknown' ? 'unknown' : 'csv';
    }

    if (!Object.hasOwn(stats.bySource, source)) {
      stats.bySource[source] = 0;
    }
    stats.bySource[source] += 1;
    stats.byEnv[environment] += 1;
    if (environment === 'unknown') {
      const idVal = stn.id;
      const nameVal = stn.name;
      stats.unknownEntries.push({
        id: typeof idVal === 'string' || typeof idVal === 'number' ? String(idVal) : '',
        name: typeof nameVal === 'string' || typeof nameVal === 'number' ? String(nameVal) : '',
        line,
      });
    }

    return { ...stn, environment };
  });

  return { stations: next, stats };
}

/* istanbul ignore next -- CLI 진입은 require.main 분기, build()/parseCsv()/classifyFloor()는 단위 테스트로 커버 */
function main(argv, deps = {}) {
  const writeOut = deps.writeOut ?? ((s) => process.stdout.write(s + '\n'));
  const writeErr = deps.writeErr ?? ((s) => process.stderr.write(s + '\n'));
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, 'utf8'));
  const writeFile = deps.writeFile ?? ((p, c) => fs.writeFileSync(p, c));
  const stationsPath = deps.stationsPath ?? STATIONS_PATH;
  const csvPath = deps.csvPath ?? CSV_PATH;
  const line9CsvPath = deps.line9CsvPath ?? LINE9_CSV_PATH;
  const bundangCsvPath = deps.bundangCsvPath ?? BUNDANG_CSV_PATH;
  const sinbundangCsvPath = deps.sinbundangCsvPath ?? SINBUNDANG_CSV_PATH;
  const airportCsvPath = deps.airportCsvPath ?? AIRPORT_CSV_PATH;
  const dryRun = argv.includes('--dry-run');

  let stations;
  let csvText;
  let line9CsvText;
  let bundangCsvText;
  let sinbundangCsvText;
  let airportCsvText;
  try {
    stations = JSON.parse(readFile(stationsPath));
  } catch (e) {
    writeErr(`build-station-environment: stations.json 읽기 실패 — ${e.message}`);
    return 1;
  }
  try {
    csvText = readFile(csvPath);
  } catch (e) {
    writeErr(`build-station-environment: CSV 읽기 실패 — ${e.message}`);
    return 1;
  }
  try {
    line9CsvText = readFile(line9CsvPath);
  } catch (e) {
    writeErr(`build-station-environment: 9호선 CSV 읽기 실패 — ${e.message}`);
    return 1;
  }
  try {
    bundangCsvText = readFile(bundangCsvPath);
    sinbundangCsvText = readFile(sinbundangCsvPath);
    airportCsvText = readFile(airportCsvPath);
  } catch (e) {
    writeErr(`build-station-environment: 외부 노선 CSV 읽기 실패 — ${e.message}`);
    return 1;
  }

  const externalCsvs = [
    { lineKey: EXTERNAL_LINE_CSV_KEYS.BUNDANG, csvText: bundangCsvText, source: 'bundang' },
    { lineKey: EXTERNAL_LINE_CSV_KEYS.SINBUNDANG, csvText: sinbundangCsvText, source: 'sinbundang' },
    { lineKey: EXTERNAL_LINE_CSV_KEYS.AIRPORT, csvText: airportCsvText, source: 'airport' },
  ];

  const { stations: nextStations, stats } = build({
    stations,
    csvText,
    line9CsvText,
    externalCsvs,
  });

  writeOut(`✅ ${stats.total} stations classified`);
  writeOut(
    `  byEnv  : surface=${stats.byEnv.surface} underground=${stats.byEnv.underground} mixed=${stats.byEnv.mixed} unknown=${stats.byEnv.unknown}`,
  );
  const sourceSummary = Object.keys(stats.bySource)
    .sort((a, b) => a.localeCompare(b))
    .map((k) => `${k}=${stats.bySource[k]}`)
    .join(' ');
  writeOut(`  source : ${sourceSummary}`);

  if (stats.unknownEntries.length > 0) {
    writeOut(`⚠️  ${stats.unknownEntries.length} stations need manual curation (environment=unknown):`);
    for (const e of stats.unknownEntries) {
      writeOut(`     ${e.line}\t${e.id}\t${e.name}`);
    }
  }

  if (dryRun) {
    writeOut(`(dry-run) stations.json not written`);
  } else {
    writeFile(stationsPath, JSON.stringify(nextStations, null, 2) + '\n');
    writeOut(`✏️  wrote ${stationsPath}`);
  }

  return 0;
}

module.exports = {
  classifyFloor,
  parseCsv,
  parseCsvRow,
  parseLine9Csv,
  parseOperatorPlatformCsv,
  build,
  ENVIRONMENT_OVERRIDES,
  EXTERNAL_LINE_CSV_KEYS,
  VALID_ENVIRONMENTS,
  main,
};

/* istanbul ignore if -- CLI 진입은 require.main 분기 */
if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
