#!/usr/bin/env node
/**
 * cross-check-line-1-8-environment.js — E1 (#1434) follow-up cross-check (#1465).
 *
 * 1~8호선 stations.json `environment` 분류를 서울교통공사 역사심도정보 CSV와
 * cross-check + mixed 케이스를 정거장깊이(m)로 정밀화한다.
 *
 * ## 데이터 출처
 * - `scripts/fixtures/seoul-station-depth.csv` (utf-8, cp949→utf8 변환)
 * - 컬럼: `연번,호선,역명,층수,형식,지반고,레일면고,선로기준정거장깊이,정거장깊이,비고`
 * - 층수 표현: `B1`~`B8` (지하) / `고가`/`지상` (지상). 본 CSV는 mixed 단일 값 없음.
 *
 * ## 분류 룰
 * - 층수 `B[0-9]+` → underground
 * - 층수 `고가` 또는 `지상` → surface
 * - 그 외 → unknown
 *
 * ## mixed 정밀화 룰 (#1465 §1)
 * 기존 stations.json `environment === 'mixed'` 케이스를 본 CSV로 재분류:
 * - 새 CSV가 명확 분류(B prefix / 고가 / 지상)면 그 값 채택
 * - 본 CSV에 없는 mixed entry는 보류 (별 검수 필요)
 *
 * 정거장깊이 ≥ 10m 룰은 본 CSV 데이터셋에 mixed 자체가 없어 적용 불요.
 * 깊이는 리포트에만 출력 (검수 보조 정보).
 *
 * ## 결정성
 * 네트워크 의존 X, 같은 입력 → 같은 출력. CI 안전.
 *
 * ## 사용
 *   node scripts/cross-check-line-1-8-environment.js              # 적용(stations.json 덮어쓰기) + 차이 리포트
 *   node scripts/cross-check-line-1-8-environment.js --dry-run    # 리포트만, 파일 변경 X
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { normalizeStationName } = require('../src/shared/utils/normalizeStationName');

const ROOT = path.join(__dirname, '..');
const STATIONS_PATH = path.join(ROOT, 'src', 'data', 'stations.json');
const DEPTH_CSV_PATH = path.join(__dirname, 'fixtures', 'seoul-station-depth.csv');

const LINES_IN_SCOPE = new Set(['1', '2', '3', '4', '5', '6', '7', '8']);
const VALID_ENVIRONMENTS = new Set(['surface', 'underground', 'mixed', 'unknown']);

/**
 * @param {string} floor CSV `층수` 값 (예: "B2", "고가", "지상")
 * @returns {'surface'|'underground'|'unknown'}
 */
function classifyDepthFloor(floor) {
  if (typeof floor !== 'string') return 'unknown';
  const trimmed = floor.trim();
  if (trimmed.length === 0) return 'unknown';
  if (trimmed === '고가' || trimmed === '지상') return 'surface';
  // bounded — ReDoS 방어. B 다음 1-2자리 숫자.
  if (/^B\d{1,2}$/u.test(trimmed)) return 'underground';
  return 'unknown';
}

/**
 * CSV row parser — quoted 값이 섞일 수 있는 (#1481 slim) + unquoted 원본 모두 지원.
 * 값 내부 쉼표는 quoted 블록 안에서만 출현하므로 quoted block 단위로 split.
 *
 * @param {string} row
 * @returns {string[]}
 */
function parseSlimCsvRow(row) {
  const cells = [];
  let buf = '';
  let inQuote = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      // "" inside quoted → literal "
      if (inQuote && row[i + 1] === '"') {
        buf += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
    } else if (ch === ',' && !inQuote) {
      cells.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  cells.push(buf);
  return cells;
}

/**
 * Slim CSV (#1481, 5 col: 호선/역명/형식/층수/비고 — 비고 quoted) +
 * 원본 CSV (10 col, unquoted regex fallback) 둘 다 처리.
 *
 * Slim 본은 정거장깊이 컬럼이 제거 → depth=null (사용처는 리포트 출력만, environment 결정 X).
 *
 * @param {string} row
 * @param {Array<string>} [header] header 셀 — 있으면 column-name 기반, 없으면 원본 regex fallback.
 * @returns {{ line: string, name: string, floor: string, depth: number | null } | null}
 */
function parseDepthRow(row, header) {
  if (!header) {
    // 원본 10 col fallback — 첫 9개 컬럼 unquoted (숫자/한글), 10번째 비고만 quote 가능.
    const match = /^(\d+),(\d+),([^,]+),([^,]+),([^,]+),([^,]+),([^,]+),([^,]+),(-?[\d.]+)/u.exec(row);
    if (!match) return null;
    const line = match[2];
    const name = normalizeStationName(match[3]);
    const floor = match[4];
    const depthRaw = match[9];
    const depth = Number.parseFloat(depthRaw);
    /* istanbul ignore next -- regex `(-?[\d.]+)`이 match된 시점에 parseFloat는 항상 finite. 방어용 fallback. */
    const depthOut = Number.isFinite(depth) ? depth : null;
    return { line, name, floor, depth: depthOut };
  }
  const cells = parseSlimCsvRow(row);
  const idxLine = header.indexOf('호선');
  const idxName = header.indexOf('역명');
  const idxFloor = header.indexOf('층수');
  const idxDepth = header.indexOf('정거장깊이');
  if (idxLine === -1 || idxName === -1 || idxFloor === -1) return null;
  const minCols = Math.max(idxLine, idxName, idxFloor) + 1;
  if (cells.length < minCols) return null;
  const line = cells[idxLine];
  const name = normalizeStationName(cells[idxName]);
  const floor = cells[idxFloor];
  let depth = null;
  if (idxDepth !== -1 && cells.length > idxDepth) {
    const parsed = Number.parseFloat(cells[idxDepth]);
    if (Number.isFinite(parsed)) depth = parsed;
  }
  if (!line || name.length === 0 || !floor) return null;
  return { line, name, floor, depth };
}

/**
 * @param {string} csvText utf-8
 * @returns {Map<string, { environment: 'surface'|'underground'|'unknown', floor: string, depth: number | null }>}
 */
function parseDepthCsv(csvText) {
  const rows = csvText.split(/\r?\n/u).filter((l) => l.length > 0);
  const map = new Map();
  if (rows.length === 0) return map;
  // 첫 줄 header 파싱. slim/원본 둘 다 호선/역명/층수가 header에 있으면 column-name 기반.
  // 없으면 (구버전 CSV) regex fallback.
  const headerCells = parseSlimCsvRow(rows[0]);
  const useHeader = ['호선', '역명', '층수'].every((col) => headerCells.indexOf(col) !== -1);
  for (let i = 1; i < rows.length; i++) {
    const parsed = useHeader ? parseDepthRow(rows[i], headerCells) : parseDepthRow(rows[i]);
    if (parsed === null) continue;
    const environment = classifyDepthFloor(parsed.floor);
    map.set(`${parsed.line}|${parsed.name}`, {
      environment,
      floor: parsed.floor,
      depth: parsed.depth,
    });
  }
  return map;
}

/**
 * @param {{ stations: Array<Record<string, unknown>>, csvText: string }} input
 * @returns {{
 *   stations: Array<Record<string, unknown>>,
 *   stats: {
 *     scoped: number,
 *     matched: number,
 *     agree: number,
 *     refinedMixed: Array<{ line: string, name: string, before: string, after: string, floor: string, depth: number | null }>,
 *     conflicts: Array<{ line: string, name: string, current: string, csv: string, floor: string, depth: number | null }>,
 *     unmatched: Array<{ line: string, name: string, current: string }>,
 *   },
 * }}
 */
function build({ stations, csvText }) {
  const csvMap = parseDepthCsv(csvText);
  const stats = {
    scoped: 0,
    matched: 0,
    agree: 0,
    refinedMixed: [],
    conflicts: [],
    unmatched: [],
  };

  const next = stations.map((stn) => {
    const line = typeof stn.line === 'string' ? stn.line : '';
    if (!LINES_IN_SCOPE.has(line)) return stn;
    stats.scoped += 1;

    const name = typeof stn.name === 'string' ? normalizeStationName(stn.name) : '';
    const current = typeof stn.environment === 'string' ? stn.environment : 'unknown';
    const entry = csvMap.get(`${line}|${name}`);

    if (entry === undefined) {
      stats.unmatched.push({ line, name, current });
      return stn;
    }
    stats.matched += 1;

    // CSV가 unknown이면 정밀화 정보 없음 — 기존 값 유지.
    if (entry.environment === 'unknown') {
      stats.unmatched.push({ line, name, current });
      return stn;
    }

    // mixed → CSV 명확값으로 정밀화.
    if (current === 'mixed') {
      stats.refinedMixed.push({
        line,
        name,
        before: 'mixed',
        after: entry.environment,
        floor: entry.floor,
        depth: entry.depth,
      });
      return { ...stn, environment: entry.environment };
    }

    // 동일 → agree.
    if (current === entry.environment) {
      stats.agree += 1;
      return stn;
    }

    // unknown → CSV 명확값으로 채움 (정밀화).
    if (current === 'unknown') {
      stats.refinedMixed.push({
        line,
        name,
        before: 'unknown',
        after: entry.environment,
        floor: entry.floor,
        depth: entry.depth,
      });
      return { ...stn, environment: entry.environment };
    }

    // 진짜 충돌 (current=surface vs CSV=underground 등) — 자동 갱신 X, 사용자 검수.
    stats.conflicts.push({
      line,
      name,
      current,
      csv: entry.environment,
      floor: entry.floor,
      depth: entry.depth,
    });
    return stn;
  });

  return { stations: next, stats };
}

/* istanbul ignore next -- CLI 진입은 require.main 분기, build/parse/classify는 단위 테스트로 커버 */
function main(argv, deps = {}) {
  const writeOut = deps.writeOut ?? ((s) => process.stdout.write(s + '\n'));
  const writeErr = deps.writeErr ?? ((s) => process.stderr.write(s + '\n'));
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, 'utf8'));
  const writeFile = deps.writeFile ?? ((p, c) => fs.writeFileSync(p, c));
  const stationsPath = deps.stationsPath ?? STATIONS_PATH;
  const csvPath = deps.csvPath ?? DEPTH_CSV_PATH;
  const dryRun = argv.includes('--dry-run');

  let stations;
  let csvText;
  try {
    stations = JSON.parse(readFile(stationsPath));
  } catch (e) {
    writeErr(`cross-check: stations.json 읽기 실패 — ${e.message}`);
    return 1;
  }
  try {
    csvText = readFile(csvPath);
  } catch (e) {
    writeErr(`cross-check: depth CSV 읽기 실패 — ${e.message}`);
    return 1;
  }

  const { stations: nextStations, stats } = build({ stations, csvText });

  writeOut(`✅ 1~8호선 ${stats.scoped} stations scoped`);
  writeOut(`   matched=${stats.matched}  agree=${stats.agree}  refinedOrFilled=${stats.refinedMixed.length}  conflicts=${stats.conflicts.length}  unmatched=${stats.unmatched.length}`);

  if (stats.refinedMixed.length > 0) {
    writeOut(`✏️  refined ${stats.refinedMixed.length} entries (mixed→정확값 / unknown→채움):`);
    for (const r of stats.refinedMixed) {
      writeOut(`     ${r.line}\t${r.name}\t${r.before}→${r.after}\tfloor=${r.floor}\tdepth=${r.depth}m`);
    }
  }

  if (stats.conflicts.length > 0) {
    writeOut(`⚠️  ${stats.conflicts.length} conflicts (자동 갱신 X — 사용자 검수 필요):`);
    for (const c of stats.conflicts) {
      writeOut(`     ${c.line}\t${c.name}\tcurrent=${c.current}\tcsv=${c.csv}\tfloor=${c.floor}\tdepth=${c.depth}m`);
    }
  }

  if (stats.unmatched.length > 0) {
    writeOut(`ℹ️  ${stats.unmatched.length} unmatched (CSV에 없음, 기존 값 유지)`);
  }

  if (dryRun) {
    writeOut(`(dry-run) stations.json not written`);
  } else if (stats.refinedMixed.length === 0 && stats.conflicts.length === 0) {
    writeOut(`(no changes) stations.json not written`);
  } else {
    writeFile(stationsPath, JSON.stringify(nextStations, null, 2) + '\n');
    writeOut(`✏️  wrote ${stationsPath}`);
  }

  return 0;
}

module.exports = {
  classifyDepthFloor,
  parseDepthRow,
  parseSlimCsvRow,
  parseDepthCsv,
  build,
  LINES_IN_SCOPE,
  VALID_ENVIRONMENTS,
  main,
};

/* istanbul ignore if -- CLI 진입은 require.main 분기 */
if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
