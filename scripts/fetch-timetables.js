#!/usr/bin/env node
/**
 * 서울 열린데이터광장 SearchSTNTimeTableByFRCodeService에서 노선별 시간표를 수집해
 * src/data/timetables/line-{N}.json으로 저장한다.
 *
 * #1497 — FR_CODE 범위 확장. stationCodes.json (#1484 산출물)을 SSOT로 사용해
 * 지선/순환선 종착역(예: 5호선 마천 지선, 6호선 응암 순환, 4호선 당고개, 2호선 까치산/신설동,
 * 1호선 가산디지털단지)의 FR_CODE를 자동 발견한다.
 *
 * ## 사용법
 *
 *   # 기본: 1~9호선 전체, stationCodes.json 기반
 *   EXPO_PUBLIC_SEOUL_DATA_API_KEY=xxxx node scripts/fetch-timetables.js
 *
 *   # 단일 노선
 *   EXPO_PUBLIC_SEOUL_DATA_API_KEY=xxxx LINE=5 node scripts/fetch-timetables.js
 *
 *   # 누락 16역(firstLastTrainTimes.json 기준)만 — 빠른 보강용
 *   EXPO_PUBLIC_SEOUL_DATA_API_KEY=xxxx node scripts/fetch-timetables.js --missing-only
 *
 *   # 레거시 range probe 모드 (회귀 방지용)
 *   EXPO_PUBLIC_SEOUL_DATA_API_KEY=xxxx LINE=1 node scripts/fetch-timetables.js --legacy-range
 *
 * ## API 사양
 *
 *   엔드포인트: /SearchSTNTimeTableByFRCodeService/{start}/{end}/{FR_CODE}/{WEEK_TAG}/{INOUT_TAG}
 *   FR_CODE: 3자리 정수 (노선별 100단위가 base, 지선/순환선은 별도 대역 — stationCodes.json 참조)
 *   WEEK_TAG: 1=평일, 2=토요일, 3=일요일/공휴일
 *   INOUT_TAG: 1=상행/내선, 2=하행/외선
 *
 * ## 출력 형식 (line-N.json)
 *
 *   {
 *     "stations": {
 *       "서울역": {
 *         "weekday":  { "up": ["0518", "0525", ...], "down": [...] },
 *         "saturday": { ... },
 *         "sunday":   { ... }
 *       }
 *     }
 *   }
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const STATION_CODES_PATH = path.join(ROOT, 'src', 'data', 'stationCodes.json');
const STATIONS_PATH = path.join(ROOT, 'src', 'data', 'stations.json');
const FIRST_LAST_PATH = path.join(ROOT, 'src', 'data', 'firstLastTrainTimes.json');
const OUT_DIR = path.join(ROOT, 'src', 'data', 'timetables');

const SLEEP_MS = 800;
const TARGET_LINES = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

const WEEK_INOUT_PLAN = [
  { weekTag: '1', inoutTag: '1', weekKey: 'weekday', inoutKey: 'up' },
  { weekTag: '1', inoutTag: '2', weekKey: 'weekday', inoutKey: 'down' },
  { weekTag: '2', inoutTag: '1', weekKey: 'saturday', inoutKey: 'up' },
  { weekTag: '2', inoutTag: '2', weekKey: 'saturday', inoutKey: 'down' },
  { weekTag: '3', inoutTag: '1', weekKey: 'sunday', inoutKey: 'up' },
  { weekTag: '3', inoutTag: '2', weekKey: 'sunday', inoutKey: 'down' },
];

const ARRIVE_TIME_RE = /^(\d{2}):(\d{2}):/;

// "HH:MM:SS" → "HHMM". 24h+ 표기("24:09:30")는 익일 시각으로 보존 (정렬은 문자열 비교).
function compactTime(arriveTime) {
  if (typeof arriveTime !== 'string') return null;
  const m = ARRIVE_TIME_RE.exec(arriveTime);
  if (!m) return null;
  return `${m[1]}${m[2]}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchOne(apiKey, frCode, weekTag, inoutTag, { fetchImpl = fetch } = {}) {
  const url = `http://openapi.seoul.go.kr:8088/${apiKey}/json/SearchSTNTimeTableByFRCodeService/1/1000/${frCode}/${weekTag}/${inoutTag}`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for FR_CODE=${frCode} W=${weekTag} I=${inoutTag}`);
  const json = await res.json();
  const wrapper = json.SearchSTNTimeTableByFRCodeService;
  if (!wrapper) {
    if (json.RESULT?.CODE === 'INFO-200') return null;
    throw new Error(`unexpected response for FR_CODE=${frCode}: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return wrapper.row ?? [];
}

async function fetchStation(apiKey, frCode, { fetchImpl = fetch, sleepImpl = sleep } = {}) {
  // 평일 상행 probe — 데이터 없으면 나머지 5호출 생략
  const [probe, ...rest] = WEEK_INOUT_PLAN;
  const probeRows = await fetchOne(apiKey, frCode, probe.weekTag, probe.inoutTag, { fetchImpl });
  await sleepImpl(SLEEP_MS);
  if (!probeRows || probeRows.length === 0) return { stationName: null, timetable: {} };
  const stationName = probeRows[0].STATION_NM;
  const result = {
    [probe.weekKey]: {
      [probe.inoutKey]: probeRows.map((r) => compactTime(r.ARRIVETIME)).filter(Boolean).sort(),
    },
  };
  for (const step of rest) {
    const rows = await fetchOne(apiKey, frCode, step.weekTag, step.inoutTag, { fetchImpl });
    await sleepImpl(SLEEP_MS);
    if (!rows || rows.length === 0) continue;
    const times = rows.map((r) => compactTime(r.ARRIVETIME)).filter(Boolean).sort();
    if (!result[step.weekKey]) result[step.weekKey] = {};
    result[step.weekKey][step.inoutKey] = times;
  }
  return { stationName, timetable: result };
}

// ---- frCode source resolution ----

function loadStationCodes() {
  if (!fs.existsSync(STATION_CODES_PATH)) return {};
  return JSON.parse(fs.readFileSync(STATION_CODES_PATH, 'utf8'));
}

function loadStations() {
  return JSON.parse(fs.readFileSync(STATIONS_PATH, 'utf8'));
}

function loadFirstLastTimes() {
  if (!fs.existsSync(FIRST_LAST_PATH)) return {};
  return JSON.parse(fs.readFileSync(FIRST_LAST_PATH, 'utf8'));
}

/**
 * stationCodes.json + stations.json을 join해 노선별 FR_CODE 집합을 반환.
 * 반환: Map<line, Set<frCode3digit>>
 */
function collectFrCodesByLine(stationCodes, stations, lines = TARGET_LINES) {
  const byLine = new Map();
  for (const line of lines) byLine.set(line, new Set());
  const stationsById = new Map(stations.map((s) => [s.id, s]));
  for (const [id, entry] of Object.entries(stationCodes)) {
    const st = stationsById.get(id);
    if (!st) continue;
    if (!byLine.has(st.line)) continue;
    if (!entry || typeof entry.frCode !== 'string') continue;
    byLine.get(st.line).add(entry.frCode.padStart(3, '0'));
  }
  return byLine;
}

/**
 * 누락 station id 집합(line별)을 반환 — firstLastTrainTimes.json에 빠진 1~9호선 entry.
 * Map<line, Set<frCode3digit>> 형태로 frCode만 추림.
 */
function collectMissingFrCodes(stationCodes, stations, firstLastTimes, lines = TARGET_LINES) {
  const byLine = new Map();
  for (const line of lines) byLine.set(line, new Set());
  const lineSet = new Set(lines);
  for (const s of stations) {
    if (!lineSet.has(s.line)) continue;
    if (firstLastTimes[s.id]) continue;
    const entry = stationCodes[s.id];
    if (!entry || typeof entry.frCode !== 'string') continue;
    byLine.get(s.line).add(entry.frCode.padStart(3, '0'));
  }
  return byLine;
}

/**
 * 레거시 range probe — line * 100 ~ line * 100 + 99.
 */
function legacyRangeFrCodes(line) {
  const start = Number.parseInt(line, 10) * 100;
  const codes = new Set();
  for (let i = 0; i < 100; i++) codes.add(String(start + i).padStart(3, '0'));
  return codes;
}

// ---- arg parsing ----

function parseArgs(argv, env = process.env) {
  const args = new Set(argv);
  return {
    legacyRange: args.has('--legacy-range'),
    missingOnly: args.has('--missing-only'),
    lineEnv: env.LINE ? env.LINE.trim() : null,
  };
}

function selectTargetLines({ lineEnv }) {
  if (!lineEnv) return [...TARGET_LINES];
  if (!TARGET_LINES.includes(lineEnv)) {
    throw new Error(`LINE=${lineEnv} 은 지원 대상이 아닙니다 (1~9만 가능)`);
  }
  return [lineEnv];
}

/**
 * 노선별 FR_CODE 후보 집합 결정 — 모드/누락 옵션 반영.
 */
function resolveFrCodeSets(targetLines, { legacyRange, missingOnly, stationCodes, stations, firstLastTimes }) {
  if (legacyRange) {
    const byLine = new Map();
    for (const line of targetLines) byLine.set(line, legacyRangeFrCodes(line));
    return byLine;
  }
  if (missingOnly) {
    return collectMissingFrCodes(stationCodes, stations, firstLastTimes, targetLines);
  }
  return collectFrCodesByLine(stationCodes, stations, targetLines);
}

// ---- IO ----

function readExistingLine(line) {
  const filePath = path.join(OUT_DIR, `line-${line}.json`);
  if (!fs.existsSync(filePath)) return { stations: {} };
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return { stations: {} };
  }
}

function writeLine(line, stations) {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const sortedKeys = Object.keys(stations).sort((a, b) => a.localeCompare(b, 'en'));
  const sorted = sortedKeys.reduce((acc, k) => {
    acc[k] = stations[k];
    return acc;
  }, {});
  const outPath = path.join(OUT_DIR, `line-${line}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ stations: sorted }, null, 0));
  return outPath;
}

// ---- main ----

async function processLine(apiKey, line, frCodes, { fetchImpl, sleepImpl, log } = {}) {
  log(`# 시간표 ETL — 노선 ${line} (FR_CODE 후보 ${frCodes.size}개)`);
  if (frCodes.size === 0) {
    log(`# 노선 ${line} 후보 없음 — skip`);
    return { line, stationCount: 0, outPath: null };
  }
  // 기존 데이터 merge — missing-only 모드 등 부분 갱신 케이스 보존
  const existing = readExistingLine(line);
  const stations = { ...(existing.stations ?? {}) };
  let added = 0;
  const sortedCodes = [...frCodes].sort((a, b) => a.localeCompare(b, 'en'));
  for (const frCode of sortedCodes) {
    let stationName, timetable;
    try {
      ({ stationName, timetable } = await fetchStation(apiKey, frCode, { fetchImpl, sleepImpl }));
    } catch (e) {
      log(`E(${frCode}:${e.message})`);
      continue;
    }
    if (!stationName || Object.keys(timetable).length === 0) {
      log(`.${frCode}`);
      continue;
    }
    stations[stationName] = timetable;
    added++;
    log(`o${frCode}:${stationName}`);
  }
  const outPath = writeLine(line, stations);
  log(`# 노선 ${line} 완료 — 신규/갱신 ${added}, 총 ${Object.keys(stations).length}역, ${outPath}`);
  return { line, stationCount: Object.keys(stations).length, added, outPath };
}

async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const { fetchImpl, sleepImpl } = deps;
  const apiKey = env.EXPO_PUBLIC_SEOUL_DATA_API_KEY;
  if (!apiKey) {
    process.stderr.write('EXPO_PUBLIC_SEOUL_DATA_API_KEY 환경변수가 없습니다.\n');
    process.exit(1);
  }
  const opts = parseArgs(argv, env);
  const targetLines = selectTargetLines(opts);
  const stationCodes = loadStationCodes();
  const stations = loadStations();
  const firstLastTimes = loadFirstLastTimes();
  if (!opts.legacyRange && Object.keys(stationCodes).length === 0) {
    process.stderr.write(
      'stationCodes.json이 비어있습니다 — 먼저 `node scripts/fetch-station-codes-and-times.js`를 실행하거나 `--legacy-range`를 사용하세요.\n',
    );
    process.exit(1);
  }
  const sets = resolveFrCodeSets(targetLines, {
    legacyRange: opts.legacyRange,
    missingOnly: opts.missingOnly,
    stationCodes,
    stations,
    firstLastTimes,
  });
  const log = (msg) => process.stdout.write(`${msg}\n`);
  const results = [];
  for (const line of targetLines) {
    const frCodes = sets.get(line) ?? new Set();
    const r = await processLine(apiKey, line, frCodes, { log, fetchImpl, sleepImpl });
    results.push(r);
  }
  log(`# 전체 완료 — ${results.length}개 노선 처리`);
}

module.exports = {
  compactTime,
  fetchOne,
  fetchStation,
  collectFrCodesByLine,
  collectMissingFrCodes,
  legacyRangeFrCodes,
  parseArgs,
  selectTargetLines,
  resolveFrCodeSets,
  readExistingLine,
  writeLine,
  processLine,
  main,
  TARGET_LINES,
};

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`${e.stack || e.message}\n`);
    process.exit(1);
  });
}
