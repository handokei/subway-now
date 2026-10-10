#!/usr/bin/env node
/**
 * #474 — 막차 시간표 ETL.
 *
 * 서울 열린데이터광장 "역외부코드로 지하철 막차 시간표 검색"
 * (`SearchLastTrainTimeByIDService`) → `src/data/lastTrains.json`.
 *
 * 입력 SSOT:
 *  - `src/data/stationCodes.json` — stationsJsonId → {stationCd, frCode}
 *  - `src/data/stations.json`     — stationsJsonId → {name, line}
 *
 * 출력 형식 (lastTrains.json):
 *
 *   {
 *     "version": "1",
 *     "lines": { "1": "covered", "2": "covered", ..., "airport": "uncovered" },
 *     "stations": {
 *       "1-001": {
 *         "weekday":  { "up": "00:36", "down": "23:47" },
 *         "saturday": { "up": "00:27", "down": "23:48" },
 *         "sunday":   { "up": "00:27", "down": "23:48" }
 *       },
 *       ...
 *     }
 *   }
 *
 * 정책:
 *  - 13개 LineNumber 모두 lines 맵에 entry 보유 (uncovered도 명시) — graceful 데이터 주도.
 *  - 종착역에서 한쪽 방향만 운행하면 그 방향 entry는 null.
 *  - 막차 시각은 24h+ 표기("24:36")를 자정 넘김 표기로 정규화("00:36").
 *
 * ## 사용법
 *
 *   EXPO_PUBLIC_SEOUL_DATA_API_KEY=xxxx node scripts/fetch-last-train.js
 *   EXPO_PUBLIC_SEOUL_DATA_API_KEY=xxxx LINE=5 node scripts/fetch-last-train.js
 *
 * ## API 사양
 *
 *   엔드포인트: /SearchLastTrainTimeByIDService/{start}/{end}/{STATION_CD}/{INOUT_TAG}/{WEEK_TAG}
 *   STATION_CD: 4자리 정수 (stationCodes.json `.stationCd`).
 *   INOUT_TAG: 1=상행/내선, 2=하행/외선
 *   WEEK_TAG: 1=평일, 2=토요일, 3=일요일/공휴일
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const STATION_CODES_PATH = path.join(ROOT, 'src', 'data', 'stationCodes.json');
const STATIONS_PATH = path.join(ROOT, 'src', 'data', 'stations.json');
const OUT_PATH = path.join(ROOT, 'src', 'data', 'lastTrains.json');

const SLEEP_MS = 800;
const TARGET_LINES = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
const ALL_LINES = [
  '1', '2', '3', '4', '5', '6', '7', '8', '9',
  'airport', 'gyeongui', 'bundang', 'sinbundang',
];

const WEEK_INOUT_PLAN = [
  { weekTag: '1', inoutTag: '1', weekKey: 'weekday', inoutKey: 'up' },
  { weekTag: '1', inoutTag: '2', weekKey: 'weekday', inoutKey: 'down' },
  { weekTag: '2', inoutTag: '1', weekKey: 'saturday', inoutKey: 'up' },
  { weekTag: '2', inoutTag: '2', weekKey: 'saturday', inoutKey: 'down' },
  { weekTag: '3', inoutTag: '1', weekKey: 'sunday', inoutKey: 'up' },
  { weekTag: '3', inoutTag: '2', weekKey: 'sunday', inoutKey: 'down' },
];

const LAST_TIME_RE = /^(\d{2}):(\d{2})/;
const HOURS_PER_DAY = 24;

/** "HH:MM[:SS]" → "HH:MM". 24h+("24:36")는 익일 표기로 정규화("00:36"). */
function normalizeLastTime(raw) {
  if (typeof raw !== 'string') return null;
  const m = LAST_TIME_RE.exec(raw);
  if (!m) return null;
  const hourRaw = Number.parseInt(m[1], 10);
  const minute = Number.parseInt(m[2], 10);
  const hour = hourRaw % HOURS_PER_DAY;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchLastTime(apiKey, stationCd, weekTag, inoutTag, { fetchImpl = fetch } = {}) {
  const url = `http://openapi.seoul.go.kr:8088/${apiKey}/json/SearchLastTrainTimeByIDService/1/5/${stationCd}/${inoutTag}/${weekTag}`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for STATION_CD=${stationCd} W=${weekTag} I=${inoutTag}`);
  const json = await res.json();
  const wrapper = json.SearchLastTrainTimeByIDService;
  if (!wrapper) {
    if (json.RESULT?.CODE === 'INFO-200') return null;
    throw new Error(`unexpected response for STATION_CD=${stationCd}: ${JSON.stringify(json).slice(0, 200)}`);
  }
  const rows = wrapper.row ?? [];
  if (rows.length === 0) return null;
  // API는 행 1개 이상을 반환할 수 있다(주말 적용일자 분기 등). 가장 늦은 시각을 막차로 채택.
  const candidates = rows
    .map((r) => normalizeLastTime(r.LAST_TIME))
    .filter((v) => v !== null);
  if (candidates.length === 0) return null;
  // "00:36" < "23:47" 이지만 0~3시는 익일 막차 → 가장 큰 시각이 아니라 가장 *나중* 시각을 골라야 한다.
  // 자정 넘김 시간은 23:59 이후로 간주하므로 정렬 시 "00~03"을 24+로 가산해 비교.
  const toMinutes = (hhmm) => {
    const [h, m] = hhmm.split(':').map((v) => Number.parseInt(v, 10));
    return (h < 4 ? h + HOURS_PER_DAY : h) * 60 + m;
  };
  let latest = candidates[0];
  let latestMinutes = toMinutes(latest);
  for (const c of candidates) {
    const cm = toMinutes(c);
    if (cm > latestMinutes) {
      latest = c;
      latestMinutes = cm;
    }
  }
  return latest;
}

async function fetchStation(apiKey, stationCd, { fetchImpl = fetch, sleepImpl = sleep } = {}) {
  const result = {};
  for (const step of WEEK_INOUT_PLAN) {
    const last = await fetchLastTime(apiKey, stationCd, step.weekTag, step.inoutTag, { fetchImpl });
    await sleepImpl(SLEEP_MS);
    if (!result[step.weekKey]) result[step.weekKey] = {};
    result[step.weekKey][step.inoutKey] = last;
  }
  return result;
}

function loadStationCodes() {
  if (!fs.existsSync(STATION_CODES_PATH)) return {};
  return JSON.parse(fs.readFileSync(STATION_CODES_PATH, 'utf8'));
}

function loadStations() {
  return JSON.parse(fs.readFileSync(STATIONS_PATH, 'utf8'));
}

/**
 * stationCodes + stations join → 처리 대상 [{stationsJsonId, stationCd, line}].
 * stationCd 누락 / TARGET_LINES 외 노선은 제외.
 */
function collectTargets(stationCodes, stations, lines = TARGET_LINES) {
  const lineSet = new Set(lines);
  const stationsById = new Map(stations.map((s) => [s.id, s]));
  const targets = [];
  for (const [id, entry] of Object.entries(stationCodes)) {
    const st = stationsById.get(id);
    if (!st) continue;
    if (!lineSet.has(st.line)) continue;
    if (!entry || typeof entry.stationCd !== 'string') continue;
    targets.push({ stationsJsonId: id, stationCd: entry.stationCd, line: st.line });
  }
  // 결정적 출력 — id 사전순.
  targets.sort((a, b) => a.stationsJsonId.localeCompare(b.stationsJsonId, 'en'));
  return targets;
}

function parseArgs(argv, env = process.env) {
  return {
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

/** 13 노선 lines 맵 빌드 — coveredLines 안에 있으면 'covered', 아니면 'uncovered'. */
function buildLinesMap(coveredLines) {
  const set = new Set(coveredLines);
  const map = {};
  for (const line of ALL_LINES) {
    map[line] = set.has(line) ? 'covered' : 'uncovered';
  }
  return map;
}

function writeOutput(stations, coveredLines) {
  const sortedKeys = Object.keys(stations).sort((a, b) => a.localeCompare(b, 'en'));
  const sorted = sortedKeys.reduce((acc, k) => {
    acc[k] = stations[k];
    return acc;
  }, {});
  const out = {
    version: '1',
    lines: buildLinesMap(coveredLines),
    stations: sorted,
  };
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(out, null, 2)}\n`);
  return OUT_PATH;
}

async function processTargets(apiKey, targets, { fetchImpl, sleepImpl, log }) {
  const stations = {};
  const coveredLines = new Set();
  for (const target of targets) {
    let perStation;
    try {
      perStation = await fetchStation(apiKey, target.stationCd, { fetchImpl, sleepImpl });
    } catch (e) {
      log(`E(${target.stationsJsonId}:${e.message})`);
      continue;
    }
    const anyEntry = Object.values(perStation).some((day) =>
      Object.values(day).some((v) => v !== null),
    );
    if (!anyEntry) {
      log(`.${target.stationsJsonId}`);
      continue;
    }
    stations[target.stationsJsonId] = perStation;
    coveredLines.add(target.line);
    log(`o${target.stationsJsonId}`);
  }
  return { stations, coveredLines };
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
  if (Object.keys(stationCodes).length === 0) {
    process.stderr.write(
      'stationCodes.json이 비어있습니다 — 먼저 `node scripts/fetch-station-codes-and-times.js`를 실행하세요.\n',
    );
    process.exit(1);
  }
  const targets = collectTargets(stationCodes, stations, targetLines);
  const log = (msg) => process.stdout.write(`${msg}\n`);
  log(`# 막차 ETL — 대상 ${targets.length}역 (${targetLines.length} 노선)`);
  const { stations: out, coveredLines } = await processTargets(apiKey, targets, {
    fetchImpl,
    sleepImpl,
    log,
  });
  const outPath = writeOutput(out, coveredLines);
  log(`# 완료 — ${Object.keys(out).length}역, 노선 ${coveredLines.size}개, ${outPath}`);
  return { stationCount: Object.keys(out).length, coveredLines: [...coveredLines], outPath };
}

module.exports = {
  normalizeLastTime,
  fetchLastTime,
  fetchStation,
  collectTargets,
  parseArgs,
  selectTargetLines,
  buildLinesMap,
  writeOutput,
  processTargets,
  main,
  ALL_LINES,
  TARGET_LINES,
};

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`fatal: ${e.message}\n`);
    process.exit(1);
  });
}
