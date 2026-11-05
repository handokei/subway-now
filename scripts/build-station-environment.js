#!/usr/bin/env node
/**
 * build-station-environment.js — ADR-015 §1 Deterministic Environment SSOT (#1434).
 *
 * stations.json 528역에 `environment` 필드를 채워 넣는다. 분기 판정은 데이터
 * 기반 deterministic — barometer warm-up 결과 기다리지 않고 지상/지하/복합/미상을
 * 사전 결정한다.
 *
 * ## 데이터 출처 + 우선순위
 * 1. **명시적 override** (이 파일 ENVIRONMENT_OVERRIDES) — 외부 노선 + CSV 매칭
 *    불가 케이스. 사용자 검증 trip의 역들(성수/뚝섬/한양대/왕십리/마장)은 모두
 *    명시 — CSV 매칭과 cross-check 대상.
 * 2. **국가철도공단 승강장 CSV** (`scripts/fixtures/<lineKey>-platform.csv`)
 *    — 1~9호선 + 분당선(수인분당) + 신분당 + 공항철도 + 경의중앙선 등 KRRIC가
 *    발행한 노선별 승강장 정보. 상행/하행 row의 `지상구분`(지상/지하) 그룹화:
 *      - 둘 다 `지상` → surface
 *      - 둘 다 `지하` → underground
 *      - 상행/하행 다름 → mixed
 *    출처: 공공데이터포털 — 국가철도공단_수도권<N>호선/분당선/신분당/공항/
 *    경의중앙선_승강장_정보. (#1460 9호선, #1461 경의중앙, #1466 1~8호선 + 분당,
 *    #1469 신분당 + 공항)
 * 3. **서울교통공사 역사건축정보 CSV** (`scripts/fixtures/seoul-station-architecture.csv`)
 *    — 1~8호선 약 275역 (서울교통공사 운영 구간만, KORAIL 구간 누락).
 *    층수 컬럼으로 자동 분류:
 *      - B prefix (B2, B3, B4...) → underground
 *      - F prefix (1F, 2F, 3F...) → surface
 *      - 둘 다 포함 (2FB3, 5FB2, 1FB5...) → mixed
 *    출처: 서울 열린데이터 광장 — 서울교통공사_역사건축정보. KRRIC CSV에서
 *    누락된 entry의 fallback.
 * 4. **매칭 실패** → `unknown`. 표준 출력에 리스트 출력 (사용자 검수용).
 *
 * ## 매칭 규칙
 * - KRRIC CSV는 fixture file당 lineKey가 고정. CSV 선명 컬럼은 무시 (운영기관
 *   별 표기 다양: "1호선" / "수인분당" / "9호선" / "경의중앙" / "신분당" /
 *   "공항철도" 등 → stations.json line key는 `"1"`~`"9"`/`"bundang"`/
 *   `"sinbundang"`/`"airport"`/`"gyeongui"`). lineKey 매핑은 `KRRIC_SOURCES`
 *   테이블 단일 SSOT.
 * - seoul CSV는 첫 컬럼이 호선 (`"1"`~`"8"`).
 * - 역명은 `normalizeStationName`으로 후행 괄호 부제 제거 후 매칭
 *   (예: stations.json "왕십리(성동구청)" ↔ CSV "왕십리",
 *    CSV "양원(서울시북부병원)" ↔ stations.json "양원").
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
 *   source 분포 (override / krric / seoul / unknown)
 *   unknown 리스트 (검수용)
 *   cross-check 차이 리포트 (KRRIC ↔ seoul 일치하지 않는 (line,name))
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { normalizeStationName } = require('../src/shared/utils/normalizeStationName');

const ROOT = path.join(__dirname, '..');
const STATIONS_PATH = path.join(ROOT, 'src', 'data', 'stations.json');
const SEOUL_CSV_PATH = path.join(__dirname, 'fixtures', 'seoul-station-architecture.csv');

/**
 * KRRIC CSV fixture 파일 매핑. 각 fixture는 cp949 → UTF-8 변환된 단일 노선 CSV.
 * 키는 stations.json의 `line` 값과 일치한다.
 *
 * 새 노선 추가 절차:
 *   1. cp949 → UTF-8 변환 후 `scripts/fixtures/<lineKey>-platform.csv` 저장
 *   2. 본 테이블에 entry 추가
 *   3. `npm run build:stations:environment`로 재생성
 */
const KRRIC_SOURCES = Object.freeze({
  1: 'line1-platform.csv',
  2: 'line2-platform.csv',
  3: 'line3-platform.csv',
  4: 'line4-platform.csv',
  5: 'line5-platform.csv',
  6: 'line6-platform.csv',
  7: 'line7-platform.csv',
  8: 'line8-platform.csv',
  9: 'line9-platform.csv',
  bundang: 'bundang-platform.csv',
  sinbundang: 'sinbundang-platform.csv',
  airport: 'airport-platform.csv',
  gyeongui: 'krric-gyeongui-platform.csv',
});

const KRRIC_SURFACE_LABEL = '지상';
const KRRIC_UNDERGROUND_LABEL = '지하';

const VALID_ENVIRONMENTS = new Set(['surface', 'underground', 'mixed', 'unknown']);

/**
 * 외부 노선(airport/gyeongui/sinbundang) + CSV에 없는 역 +
 * 사용자 검증 trip 역들의 명시적 분류.
 *
 * 출처: 한국어 위키백과/나무위키 각 역 페이지 "구조" 절 + 운영사 공식 안내도
 * + 서울 열린데이터 역사심도정보(`scripts/fixtures/seoul-station-depth.csv`).
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
  // 수인분당선 왕십리는 분리 지하 승강장 (CSV 선명 컬럼 무시되므로 override).
  'bundang|왕십리': 'underground',
  // 경의중앙선 왕십리 분리 승강장은 국가철도공단 CSV 기준 지상.
  // SSOT는 물리적 승강장 환경 → CSV(지상)가 정답이므로 override 없음.
  // ---- 경의중앙선 — KRRIC CSV에 누락된 환승/지방 종착역 ----
  // 서울역 경의선 승강장은 KTX/1호선과 분리된 지하 승강장 (출처: 한국어 위키백과 "서울역 (경의선)").
  'gyeongui|서울역': 'underground',
  // 효창공원앞 경의중앙선 승강장은 지하 (출처: 한국어 위키백과 "효창공원앞역").
  'gyeongui|효창공원앞': 'underground',
  // 신촌(경의선)·외대앞·임진강·지평·화전은 지상 (출처: 한국어 위키백과 각 역 페이지 "구조" 절).
  'gyeongui|신촌': 'surface',
  'gyeongui|외대앞': 'surface',
  'gyeongui|임진강': 'surface',
  'gyeongui|지평': 'surface',
  'gyeongui|화전': 'surface',
  // ---- #1465 역사심도정보 CSV cross-check로 정밀화 (KRRIC 분류와 다름) ----
  // 신내(6호선) — KRRIC는 underground지만 역사심도 -1.7m(지상). 6호선 신내 차고지 인근 평지 운영.
  '6|신내': 'surface',
});

/**
 * seoul-station-architecture.csv 층수 분류.
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
 * seoul-station-architecture.csv → (line|name) → env 맵.
 *
 * 첫 줄 header에서 `호선` / `역명` / `층수` 컬럼 인덱스를 indexOf로 lookup.
 * slim 본 (#1481, 4 col: 호선/역명/형식/층수) 과 원본 (7 col) 모두 동일 코드로 처리.
 *
 * @param {string} csvText UTF-8
 * @returns {Map<string, 'surface'|'underground'|'mixed'|'unknown'>}
 */
function parseCsv(csvText) {
  const lines = csvText.split(/\r?\n/u).filter((l) => l.length > 0);
  const map = new Map();
  if (lines.length === 0) return map;
  const header = parseCsvRow(lines[0]);
  const idxLine = header.indexOf('호선');
  const idxName = header.indexOf('역명');
  const idxFloor = header.indexOf('층수');
  if (idxLine === -1 || idxName === -1 || idxFloor === -1) return map;
  const minCols = Math.max(idxLine, idxName, idxFloor) + 1;
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvRow(lines[i]);
    if (cols.length < minCols) continue;
    const line = cols[idxLine];
    const name = normalizeStationName(cols[idxName]);
    const floor = cols[idxFloor];
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
 * 국가철도공단 승강장 CSV → (lineKey|name) → env 맵.
 *
 * 첫 줄 header에서 `역명` / `지상구분` 컬럼 인덱스를 indexOf로 lookup.
 * slim 본 (#1481, 4 col: 선명/역명/지상구분/역층) 과 원본 (10 col) 모두 동일 코드로 처리.
 *
 * 같은 역명에 상행/하행 row가 있고, 지상구분이 일치하면 단일 값, 다르면 mixed로 그룹화한다.
 *
 * CSV 선명 컬럼은 운영기관마다 표기 다양 (`1호선` / `수인분당` / `9호선` /
 * `경의중앙` / `신분당` / `공항철도` 등) → 파싱 시 무시하고 호출 측 `lineKey`로
 * stations.json의 line 값과 직접 매칭한다.
 *
 * @param {string} csvText UTF-8 (cp949 입력은 호출 측에서 사전 변환)
 * @param {string} lineKey stations.json `line` 값 (`"1"`~`"9"`/`"bundang"`/`"sinbundang"`/`"airport"`/`"gyeongui"`)
 * @returns {Map<string, 'surface'|'underground'|'mixed'|'unknown'>}
 */
function parseKrricCsv(csvText, lineKey) {
  const lines = csvText.split(/\r?\n/u).filter((l) => l.length > 0);
  /** @type {Map<string, Set<string>>} */
  const byStation = new Map();
  if (lines.length === 0) return new Map();
  const header = parseCsvRow(lines[0]);
  const idxName = header.indexOf('역명');
  const idxSurface = header.indexOf('지상구분');
  if (idxName === -1 || idxSurface === -1) return new Map();
  const minCols = Math.max(idxName, idxSurface) + 1;
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvRow(lines[i]);
    if (cols.length < minCols) continue;
    const name = normalizeStationName(cols[idxName]);
    const label = cols[idxSurface];
    if (name.length === 0) continue;
    if (label !== KRRIC_SURFACE_LABEL && label !== KRRIC_UNDERGROUND_LABEL) continue;
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
    else if (labels.has(KRRIC_SURFACE_LABEL)) env = 'surface';
    else env = 'underground'; // labels Set은 위 필터로 지상/지하만 들어감 — size>0 && !surface → underground
    out.set(`${lineKey}|${name}`, env);
  }
  return out;
}

/**
 * 역호환 alias — #1460에서 도입된 이름. 신규 호출은 parseKrricCsv 권장.
 * @param {string} csvText
 * @returns {Map<string, 'surface'|'underground'|'mixed'|'unknown'>}
 */
function parseLine9Csv(csvText) {
  return parseKrricCsv(csvText, '9');
}

/**
 * 역호환 alias — #1461에서 도입된 이름. 신규 호출은 parseKrricCsv 권장.
 * @param {string} csvText
 * @returns {Map<string, 'surface'|'underground'|'mixed'|'unknown'>}
 */
function parseGyeonguiCsv(csvText) {
  return parseKrricCsv(csvText, 'gyeongui');
}

/**
 * KRRIC 텍스트 맵 → 모든 노선 합쳐진 (line|name) → env 맵.
 * @param {Record<string, string>} krricCsvTexts lineKey → CSV UTF-8 text
 * @returns {Map<string, 'surface'|'underground'|'mixed'|'unknown'>}
 */
function buildKrricMap(krricCsvTexts) {
  const merged = new Map();
  for (const [lineKey, text] of Object.entries(krricCsvTexts)) {
    const m = parseKrricCsv(text, lineKey);
    for (const [k, v] of m) merged.set(k, v);
  }
  return merged;
}

/**
 * KRRIC ↔ seoul CSV cross-check 차이 리스트.
 * 둘 다 매칭된 (line,name) 중 environment가 다른 entry만 반환.
 * @param {Map<string, string>} krricMap
 * @param {Map<string, string>} seoulMap
 * @returns {Array<{ key: string, krric: string, seoul: string }>}
 */
function diffSources(krricMap, seoulMap) {
  const diffs = [];
  for (const [key, krric] of krricMap) {
    if (!seoulMap.has(key)) continue;
    const seoul = seoulMap.get(key);
    if (seoul === 'unknown' || krric === 'unknown') continue;
    if (seoul !== krric) diffs.push({ key, krric, seoul });
  }
  // 결정적 출력 (테스트 안정성)
  diffs.sort((a, b) => a.key.localeCompare(b.key));
  return diffs;
}

/**
 * @param {{
 *   stations: Array<Record<string, unknown>>,
 *   csvText: string,
 *   krricCsvTexts?: Record<string, string>,
 *   line9CsvText?: string,
 *   gyeonguiCsvText?: string,
 * }} input
 * @returns {{
 *   stations: Array<Record<string, unknown>>,
 *   stats: {
 *     total: number,
 *     bySource: { override: number, krric: number, seoul: number, unknown: number },
 *     byEnv: { surface: number, underground: number, mixed: number, unknown: number },
 *     unknownEntries: Array<{ id: string, name: string, line: string }>,
 *     crossCheckDiffs: Array<{ key: string, krric: string, seoul: string }>,
 *   },
 * }}
 */
function build({ stations, csvText, krricCsvTexts, line9CsvText, gyeonguiCsvText }) {
  const seoulMap = parseCsv(csvText);
  // 역호환: line9CsvText/gyeonguiCsvText 단독 입력은 krricCsvTexts[key]로 흡수.
  // 신규 lineKey 추가 시 legacyInputs에만 entry 추가 (글로벌 룰 #3 확장성).
  const krricInput = { ...krricCsvTexts };
  const legacyInputs = { '9': line9CsvText, gyeongui: gyeonguiCsvText };
  for (const [lineKey, text] of Object.entries(legacyInputs)) {
    if (typeof text === 'string' && krricInput[lineKey] === undefined) {
      krricInput[lineKey] = text;
    }
  }
  const krricMap = buildKrricMap(krricInput);
  const crossCheckDiffs = diffSources(krricMap, seoulMap);

  const stats = {
    total: stations.length,
    bySource: { override: 0, krric: 0, seoul: 0, unknown: 0 },
    byEnv: { surface: 0, underground: 0, mixed: 0, unknown: 0 },
    unknownEntries: [],
    crossCheckDiffs,
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
    } else if (krricMap.has(key)) {
      environment = krricMap.get(key);
      source = environment === 'unknown' ? 'unknown' : 'krric';
    } else if (seoulMap.has(key)) {
      environment = seoulMap.get(key);
      source = environment === 'unknown' ? 'unknown' : 'seoul';
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
  const csvPath = deps.csvPath ?? SEOUL_CSV_PATH;
  const krricSources = deps.krricSources ?? KRRIC_SOURCES;
  const fixturesDir = deps.fixturesDir ?? path.join(__dirname, 'fixtures');
  const dryRun = argv.includes('--dry-run');

  let stations;
  let csvText;
  /** @type {Record<string, string>} */
  const krricCsvTexts = {};
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
  for (const [lineKey, fileName] of Object.entries(krricSources)) {
    const p = path.join(fixturesDir, fileName);
    try {
      krricCsvTexts[lineKey] = readFile(p);
    } catch (e) {
      writeErr(`build-station-environment: KRRIC CSV(${lineKey}) 읽기 실패 — ${e.message}`);
      return 1;
    }
  }

  const { stations: nextStations, stats } = build({ stations, csvText, krricCsvTexts });

  writeOut(`✅ ${stats.total} stations classified`);
  writeOut(
    `  byEnv  : surface=${stats.byEnv.surface} underground=${stats.byEnv.underground} mixed=${stats.byEnv.mixed} unknown=${stats.byEnv.unknown}`,
  );
  writeOut(
    `  source : override=${stats.bySource.override} krric=${stats.bySource.krric} seoul=${stats.bySource.seoul} unknown=${stats.bySource.unknown}`,
  );

  if (stats.crossCheckDiffs.length > 0) {
    writeOut(`ℹ️  ${stats.crossCheckDiffs.length} cross-check diffs (KRRIC vs seoul):`);
    for (const d of stats.crossCheckDiffs) {
      writeOut(`     ${d.key}\tkrric=${d.krric}\tseoul=${d.seoul}`);
    }
  }

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
  parseKrricCsv,
  parseLine9Csv,
  parseGyeonguiCsv,
  buildKrricMap,
  diffSources,
  build,
  ENVIRONMENT_OVERRIDES,
  KRRIC_SOURCES,
  VALID_ENVIRONMENTS,
  main,
};

/* istanbul ignore if -- CLI 진입은 require.main 분기 */
if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
