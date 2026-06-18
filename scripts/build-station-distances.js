#!/usr/bin/env node
/**
 * #1472 — 국가철도공단 KRRIC 역간거리 CSV 6건을 읽어 stations.json의 노선/역과 매칭하여
 * `src/data/stationDistances.json`을 보강한다.
 *
 * 기존 1~8호선 데이터(#1111 서울 열린데이터 수집분)는 보존하고, 미커버 노선만 보강:
 *   - sinbundang  ← 국가철도공단_신분당선_역간거리
 *   - bundang     ← 국가철도공단_코레일 역간거리 (수인분당)
 *   - gyeongui    ← 국가철도공단_코레일 역간거리 (경의중앙)
 *
 * stations.json에 entry가 없는 노선(우이신설/인천1·2/인천 7호선 일부)은 미스 로깅 후 skip —
 * 노선 entry 추가 작업 머지 후 재실행 시 자동 흡수된다.
 *
 * 사용법:
 *   CSV_DIR=/path/to/csvs node scripts/build-station-distances.js
 *   CSV_DIR 미지정 시 기본값 ~/Downloads.
 *
 * 출력 포맷 (stationDistances.json):
 *   {
 *     "1|1-001|1-002": 1820,         // 기존 서울교통공사 데이터 (보존)
 *     "sinbundang|sinbundang-016|sinbundang-015": 700,  // KRRIC 보강분
 *     ...
 *   }
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const iconv = require('iconv-lite');

const STATIONS_PATH = path.join(__dirname, '..', 'src', 'data', 'stations.json');
const OUT_PATH = path.join(__dirname, '..', 'src', 'data', 'stationDistances.json');
const DEFAULT_CSV_DIR = path.join(os.homedir(), 'Downloads');

// CSV 파일명 → stations.json line key 매핑. 한 CSV가 여러 노선을 포함하면 선명(row)로 추가 분기.
const CSV_FILES = [
  {
    filename: '국가철도공단_서울교통공사 역간거리_20231231.csv',
    encoding: 'cp949',
    // 1호선~8호선 모두 — 기존 서울 열린데이터와 중복이지만 머지 시 동일 값(±1m)으로 무해.
    lineMap: { '1호선': '1', '2호선': '2', '3호선': '3', '4호선': '4', '5호선': '5', '6호선': '6', '7호선': '7', '8호선': '8' },
  },
  {
    filename: '국가철도공단_신분당선_역간거리_20250630.csv',
    encoding: 'cp949',
    lineMap: { 신분당: 'sinbundang' },
  },
  // 인천교통공사 7호선 인천연장 + 인천1·2호선 — stations.json에 인천1·2 entry 없으므로 7호선 인천분만 매칭 시도.
  {
    filename: '국가철도공단_인천교통공사 역간거리_20251231.CSV',
    encoding: 'cp949',
    lineMap: { '7호선': '7' },
  },
  {
    filename: '국가철도공단_인천1호선 역간거리_20250630.csv',
    encoding: 'cp949',
    // stations.json 미커버 — skip되지만 추후 entry 추가 시 자동 활성. line key는 placeholder.
    lineMap: { '인천1': 'incheon1' },
  },
  {
    filename: '국가철도공단_인천2호선 역간거리_20251231.CSV',
    encoding: 'cp949',
    lineMap: { '인천2': 'incheon2' },
  },
  {
    filename: '694.우이신설역간거리.csv',
    encoding: 'cp949',
    lineMap: { 우이신설: 'ui' },
  },
  // 코레일 — 분당/경의중앙만 추출 (1호선 경부/경인은 서울교통공사 중복, 4호선 수도권연장은 별도).
  {
    filename: '국가철도공단_코레일 역간거리_20251231.CSV',
    encoding: 'cp949',
    lineMap: { 수인분당: 'bundang', 경의중앙: 'gyeongui' },
  },
];

// 부역명 제거: "광교(경기대)" → "광교".
function normalizeStationName(name) {
  if (typeof name !== 'string') return '';
  const trimmed = name.trim();
  if (trimmed.endsWith(')')) {
    const open = trimmed.lastIndexOf('(');
    if (open > 0) return trimmed.slice(0, open).trimEnd();
  }
  return trimmed;
}

// CSV 한 줄 → 필드 배열. KRRIC CSV는 따옴표 없음, 쉼표만 — 단순 split으로 충분.
function parseCsvLine(line) {
  return line.split(',').map((s) => s.trim());
}

// utf-8 decoded 문자열 → row 객체 배열. 헤더 키는 그대로 사용 (역간거리 / 역간거리(km) 등 컬럼 변동 흡수).
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const fields = parseCsvLine(line);
    const obj = {};
    for (let i = 0; i < headers.length; i++) obj[headers[i]] = fields[i] ?? '';
    return obj;
  });
  return { headers, rows };
}

// 헤더 candidate 후보군 (CSV마다 컬럼명 미세하게 다름).
const NAME_KEYS = ['역명'];
const LINE_KEYS = ['선명'];
const DIST_KEYS = ['역간거리(km)', '역간거리'];

function pickField(row, keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== '') return row[k];
  }
  return null;
}

function parseDistKm(raw) {
  if (raw === null || raw === undefined) return null;
  const n = Number.parseFloat(String(raw).trim());
  // KRRIC 첫 역은 역간거리=0 (이전 역 없음). 0은 hop 없음으로 간주, null.
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

// stations.json → { line: Map<normalizedName, id> }
function buildNameIndex(stations) {
  const byLine = new Map();
  for (const s of stations) {
    let m = byLine.get(s.line);
    if (!m) {
      m = new Map();
      byLine.set(s.line, m);
    }
    const normalized = normalizeStationName(s.name);
    m.set(s.name, s.id);
    if (normalized !== s.name) m.set(normalized, s.id);
  }
  return byLine;
}

function buildLineIdxMap(stations) {
  const byLine = new Map();
  for (const s of stations) {
    let arr = byLine.get(s.line);
    if (!arr) {
      arr = [];
      byLine.set(s.line, arr);
    }
    arr.push(s);
  }
  const result = new Map();
  for (const [line, arr] of byLine) {
    arr.sort((a, b) => a.id.localeCompare(b.id));
    const idxMap = new Map();
    arr.forEach((s, i) => idxMap.set(s.id, i));
    result.set(line, idxMap);
  }
  return result;
}

function lookupStationId(byLine, line, rawName) {
  const idx = byLine.get(line);
  if (!idx) return null;
  const normalized = normalizeStationName(rawName);
  return idx.get(rawName) || idx.get(normalized) || null;
}

/**
 * 하나의 CSV에서 (선명→stationsLine 매핑된) 인접 hop 거리를 추출해 distances에 머지한다.
 *
 * KRRIC CSV는 각 행이 (이전 역 → 현재 역) 거리를 담고 있다. 즉 row[i]의 "역간거리"는
 * row[i-1] 역에서 row[i] 역까지의 거리. 같은 노선 안에서 연속된 row만 인접 hop으로 본다.
 */
function ingestCsv(csvSpec, rawBuf, stations, distances, stats) {
  const text = iconv.decode(rawBuf, csvSpec.encoding);
  const { rows } = parseCsv(text);
  const byLine = buildNameIndex(stations);
  const lineIdxMap = buildLineIdxMap(stations);

  // CSV 안 선명별로 grouping — 같은 노선 내 연속 row만 인접 hop.
  const groupedByCsvLine = new Map();
  for (const row of rows) {
    const csvLine = pickField(row, LINE_KEYS);
    if (!csvLine) continue;
    const stationsLine = csvSpec.lineMap[csvLine];
    if (!stationsLine) continue;
    let arr = groupedByCsvLine.get(stationsLine);
    if (!arr) {
      arr = [];
      groupedByCsvLine.set(stationsLine, arr);
    }
    arr.push(row);
  }

  for (const [stationsLine, lineRows] of groupedByCsvLine) {
    const idxMap = lineIdxMap.get(stationsLine);
    if (!idxMap) {
      stats.skippedLines.add(`${csvSpec.filename}:${stationsLine}`);
      continue;
    }
    let prevId = null;
    for (const row of lineRows) {
      const rawName = pickField(row, NAME_KEYS);
      if (!rawName) {
        prevId = null;
        continue;
      }
      const stationId = lookupStationId(byLine, stationsLine, rawName);
      const km = parseDistKm(pickField(row, DIST_KEYS));

      if (prevId !== null && stationId !== null && km !== null) {
        const prevIdx = idxMap.get(prevId);
        const curIdx = idxMap.get(stationId);
        const isAdjacent =
          prevIdx !== undefined && curIdx !== undefined && Math.abs(prevIdx - curIdx) === 1;
        if (isAdjacent) {
          const meters = Math.round(km * 1000);
          const fwd = `${stationsLine}|${prevId}|${stationId}`;
          const rev = `${stationsLine}|${stationId}|${prevId}`;
          if (distances[fwd] === undefined) {
            distances[fwd] = meters;
            distances[rev] = meters;
            stats.added++;
          } else {
            stats.preserved++;
          }
        } else {
          stats.nonAdjacent.push(`${stationsLine} ${prevId}↔${stationId} (raw="${rawName}")`);
        }
      } else if (prevId !== null && stationId === null) {
        stats.unmatchedNames.push(`${stationsLine}:${rawName}`);
      }
      prevId = stationId;
    }
  }
}

function main() {
  const csvDir = process.env.CSV_DIR || DEFAULT_CSV_DIR;
  const stations = JSON.parse(fs.readFileSync(STATIONS_PATH, 'utf8'));
  const existing = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
  const existingCount = Object.keys(existing).length;
  const distances = { ...existing };

  const stats = {
    added: 0,
    preserved: 0,
    unmatchedNames: [],
    nonAdjacent: [],
    skippedLines: new Set(),
    missingCsvs: [],
  };

  for (const spec of CSV_FILES) {
    const full = path.join(csvDir, spec.filename);
    if (!fs.existsSync(full)) {
      stats.missingCsvs.push(spec.filename);
      continue;
    }
    const buf = fs.readFileSync(full);
    ingestCsv(spec, buf, stations, distances, stats);
  }

  console.log('# stationDistances.json 보강 통계');
  console.log(`  기존 entry: ${existingCount}`);
  console.log(`  추가 entry: ${stats.added} (양방향 포함)`);
  console.log(`  기존 보존(중복 입력 무시): ${stats.preserved}`);
  console.log(`  최종 entry: ${Object.keys(distances).length}`);
  if (stats.skippedLines.size > 0) {
    console.log(`  stations.json 미커버 노선 skip: ${[...stats.skippedLines].join(', ')}`);
  }
  if (stats.missingCsvs.length > 0) {
    console.log(`  CSV 누락: ${stats.missingCsvs.join(', ')}`);
  }
  if (stats.unmatchedNames.length > 0) {
    const head = stats.unmatchedNames.slice(0, 10).join(', ');
    console.log(`  역명 미매칭 (${stats.unmatchedNames.length}): ${head}${stats.unmatchedNames.length > 10 ? ' ...' : ''}`);
  }
  if (stats.nonAdjacent.length > 0) {
    const head = stats.nonAdjacent.slice(0, 5).join(', ');
    console.log(`  인접하지 않은 hop (${stats.nonAdjacent.length}): ${head}${stats.nonAdjacent.length > 5 ? ' ...' : ''}`);
  }

  if (stats.added === 0 && stats.missingCsvs.length === CSV_FILES.length) {
    console.error('# CSV 파일이 하나도 없음 — CSV_DIR 확인');
    process.exit(1);
  }

  const tmpPath = `${OUT_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(distances, null, 0));
  fs.renameSync(tmpPath, OUT_PATH);
  const stat = fs.statSync(OUT_PATH);
  console.log(`# 저장: ${OUT_PATH} (${(stat.size / 1024).toFixed(1)} KB)`);
}

if (require.main === module) {
  main();
}

module.exports = {
  normalizeStationName,
  parseCsvLine,
  parseCsv,
  parseDistKm,
  pickField,
  buildNameIndex,
  buildLineIdxMap,
  lookupStationId,
  ingestCsv,
  CSV_FILES,
};
