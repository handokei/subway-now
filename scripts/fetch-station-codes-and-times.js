#!/usr/bin/env node
/**
 * #1484 — STATION_CD/FR_CODE 매핑 + 첫차/막차 데이터셋 빌드 파이프라인.
 *
 * 두 산출물을 한 스크립트에서 deterministic 생성한다.
 *
 * ## 산출물 1: src/data/stationCodes.json
 *
 * SearchInfoBySubwayNameService 1회 호출(list_total_count ≈ 799)로 1~9호선 + 외부 노선 전체 row.
 * row 각각: { STATION_CD: '2525', STATION_NM: '영등포시장', LINE_NUM: '05호선', FR_CODE: '524' }
 *
 * stations.json(id: `${line}-${seq}` 형식) 순회하며 (line, baseName(STATION_NM)) 매칭으로 STATION_CD/FR_CODE 부착.
 *
 * 출력 형식:
 *   { "2-009": { "stationCd": "0228", "frCode": "210" }, ... }
 *
 * ## 산출물 2: src/data/firstLastTrainTimes.json
 *
 * 기존 src/data/timetables/line-{1..9}.json 정적 데이터에서 derive.
 * - 첫차: 첫 non-zero entry (down 종착역의 "0000" placeholder skip)
 * - 막차: 마지막 entry (24h+ 표기 보존 — formatHHmm으로 mod 24)
 *
 * 출력 형식:
 *   { "2-009": { "weekday": { "up": { "first": "05:18", "last": "00:48" }, "down": {...} }, "saturday": {...}, "sunday": {...} } }
 *
 * 첫차/막차 전용 OpenAPI(OA-15492)는 data.seoul.go.kr에서 "종료된 서비스" + 실제 호출 ERROR-500.
 * 정적 timetable derive가 안정적 SSOT.
 *
 * ## 사용법
 *
 *   EXPO_PUBLIC_SEOUL_DATA_API_KEY=xxxx node scripts/fetch-station-codes-and-times.js
 *   # 오프라인 derive만 (산출물 2만 갱신):
 *   node scripts/fetch-station-codes-and-times.js --derive-only
 *
 * ## 매칭률 floor
 *
 *   1~9호선 매핑 누락 1건이라도 있으면 stderr 경고. STATION_CD 부재 = Sub C STATION_CD 기반
 *   timetable lookup에서 fallback 필수 — graceful이지만 유지보수 시 즉시 인지.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SEOUL_API_BASE = 'http://openapi.seoul.go.kr:8088';
const SEARCH_INFO_SERVICE = 'SearchInfoBySubwayNameService';

const STATIONS_PATH = path.join(__dirname, '..', 'src', 'data', 'stations.json');
const TIMETABLES_DIR = path.join(__dirname, '..', 'src', 'data', 'timetables');
const STATION_CODES_OUT = path.join(__dirname, '..', 'src', 'data', 'stationCodes.json');
const FIRST_LAST_OUT = path.join(__dirname, '..', 'src', 'data', 'firstLastTrainTimes.json');

const TARGET_LINES = new Set(['1', '2', '3', '4', '5', '6', '7', '8', '9']);

// SearchInfoBySubwayNameService.LINE_NUM → stations.json.line 매핑.
// 1~9호선은 두 자리 표기를 한 자리로 정규화. 외부 노선은 best-effort(노선 자체가 stations.json에 부분만 존재).
const LINE_NUM_MAP = {
  '01호선': '1',
  '02호선': '2',
  '03호선': '3',
  '04호선': '4',
  '05호선': '5',
  '06호선': '6',
  '07호선': '7',
  '08호선': '8',
  '09호선': '9',
  공항철도: 'airport',
  수인분당선: 'bundang',
  경의선: 'gyeongui',
  신분당선: 'sinbundang',
};

// STATION_NM 정규화: 괄호 부역명/한자 제거. stations.json의 name 기준.
const BASE_NAME_RE = /\s*[(（].*$/;
function toBaseName(name) {
  return name.replace(BASE_NAME_RE, '').trim();
}

// sample 키는 페이지당 5개 제한 — page size를 작게 잡고 페이지네이션으로 전체 수집.
// 실제 키는 1000까지 한 번에 가능하지만 같은 페이지 로직으로 통합.
const SAMPLE_PAGE_SIZE = 5;
const REAL_PAGE_SIZE = 1000;
const RATE_LIMIT_MS = 200;

async function fetchOnePage(apiKey, start, end) {
  const url = `${SEOUL_API_BASE}/${apiKey}/json/${SEARCH_INFO_SERVICE}/${start}/${end}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${SEARCH_INFO_SERVICE} ${start}/${end}`);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON parse failed at ${start}/${end} (${e.message}): ${text.slice(0, 200)}`);
  }
  const wrapper = json[SEARCH_INFO_SERVICE];
  if (!wrapper) {
    if (json.RESULT?.CODE) {
      throw new Error(`API error: ${json.RESULT.CODE} ${json.RESULT.MESSAGE}`);
    }
    throw new Error(`unexpected response: ${text.slice(0, 200)}`);
  }
  if (wrapper.RESULT?.CODE && wrapper.RESULT.CODE !== 'INFO-000') {
    throw new Error(`API error: ${wrapper.RESULT.CODE} ${wrapper.RESULT.MESSAGE}`);
  }
  return { rows: wrapper.row ?? [], total: wrapper.list_total_count ?? 0 };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchStationInfoRows(apiKey) {
  const pageSize = apiKey === 'sample' ? SAMPLE_PAGE_SIZE : REAL_PAGE_SIZE;
  // 첫 페이지 — total 확인 + (실제 키 + total ≤ 1000일 때) 단일 호출로 종료
  const first = await fetchOnePage(apiKey, 1, pageSize);
  const total = first.total;
  if (total === 0) {
    throw new Error('list_total_count=0');
  }
  process.stdout.write(`# list_total_count=${total}\n`);
  if (first.rows.length >= total) {
    return first.rows;
  }
  // 페이지네이션 — sample 키 케이스 + 실제 키 1000 초과 케이스 모두 커버
  const all = [...first.rows];
  for (let start = pageSize + 1; start <= total; start += pageSize) {
    const end = Math.min(start + pageSize - 1, total);
    await sleep(RATE_LIMIT_MS);
    const page = await fetchOnePage(apiKey, start, end);
    all.push(...page.rows);
  }
  if (all.length < total) {
    process.stderr.write(`# WARN: collected ${all.length} < total ${total}\n`);
  }
  return all;
}

function buildStationCodeMap(rows) {
  // 인덱스: `${line}|${baseName}` → { stationCd, frCode }
  const index = new Map();
  for (const row of rows) {
    const line = LINE_NUM_MAP[row.LINE_NUM];
    if (!line) continue; // 인천선/경춘선 등 stations.json 미포함 노선 skip
    const base = toBaseName(row.STATION_NM);
    const key = `${line}|${base}`;
    // 중복(같은 line, baseName) 처리: 첫 entry 보존. 우이/김포 등 일부 노선 분기 case 대비.
    if (!index.has(key)) {
      index.set(key, { stationCd: row.STATION_CD, frCode: row.FR_CODE });
    }
  }
  return index;
}

function buildStationCodesFromStations(stationsJson, codeIndex) {
  const out = {};
  const missing = [];
  for (const s of stationsJson) {
    const base = toBaseName(s.name);
    const key = `${s.line}|${base}`;
    const entry = codeIndex.get(key);
    if (entry) {
      out[s.id] = entry;
    } else if (TARGET_LINES.has(s.line)) {
      missing.push(s);
    }
  }
  return { codes: out, missing };
}

// ---- 산출물 2: firstLastTrainTimes.json ----

const HOURS_PER_DAY = 24;
function formatHHmm(raw) {
  const hourRaw = Number.parseInt(raw.slice(0, 2), 10);
  const minute = Number.parseInt(raw.slice(2, 4), 10);
  const hour = hourRaw % HOURS_PER_DAY;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

const ZERO_TIME = '0000';
function firstRunningEntry(times) {
  if (!Array.isArray(times) || times.length === 0) return null;
  for (const t of times) {
    if (t !== ZERO_TIME) return t;
  }
  return null;
}

function lastRunningEntry(times) {
  if (!Array.isArray(times) || times.length === 0) return null;
  return times.at(-1) ?? null;
}

const DAYS = ['weekday', 'saturday', 'sunday'];
const DIRECTIONS = ['up', 'down'];

function formatOrNull(raw) {
  return raw === null ? null : formatHHmm(raw);
}

function deriveDayDirections(dayTimetable) {
  const dayOut = {};
  for (const dir of DIRECTIONS) {
    const times = dayTimetable[dir];
    const first = firstRunningEntry(times);
    const last = lastRunningEntry(times);
    if (first === null && last === null) continue;
    dayOut[dir] = { first: formatOrNull(first), last: formatOrNull(last) };
  }
  return dayOut;
}

function deriveFirstLast(timetable) {
  // timetable = { weekday: { up: [], down: [] }, saturday: ..., sunday: ... }
  const out = {};
  for (const day of DAYS) {
    const dayTimetable = timetable[day];
    if (!dayTimetable) continue;
    const dayOut = deriveDayDirections(dayTimetable);
    if (Object.keys(dayOut).length > 0) {
      out[day] = dayOut;
    }
  }
  return out;
}

function buildFirstLastTimes(stationsJson) {
  const out = {};
  const missing = [];
  for (const s of stationsJson) {
    if (!TARGET_LINES.has(s.line)) continue;
    const timetablePath = path.join(TIMETABLES_DIR, `line-${s.line}.json`);
    if (!fs.existsSync(timetablePath)) {
      missing.push({ ...s, reason: 'timetable file 없음' });
      continue;
    }
    const lineData = JSON.parse(fs.readFileSync(timetablePath, 'utf8'));
    const base = toBaseName(s.name);
    // timetable JSON의 키는 STATION_NM (base name과 동등할 수도, 부역명 포함일 수도)
    const stationTimetable = lineData.stations[s.name] ?? lineData.stations[base];
    if (!stationTimetable) {
      missing.push({ ...s, reason: 'timetable 내 역 없음' });
      continue;
    }
    const derived = deriveFirstLast(stationTimetable);
    if (Object.keys(derived).length > 0) {
      out[s.id] = derived;
    }
  }
  return { times: out, missing };
}

// ---- 결정론적 정렬 ----

// Object.keys()의 순서 보장 — locale 무관 비교 (#1430 회귀 회피)
function sortedEntries(obj) {
  const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b, 'en'));
  return keys.reduce((acc, k) => {
    acc[k] = obj[k];
    return acc;
  }, {});
}

function writeJsonSorted(filePath, obj) {
  const sorted = sortedEntries(obj);
  fs.writeFileSync(filePath, JSON.stringify(sorted, null, 2) + '\n');
}

// ---- main ----

async function main() {
  const args = process.argv.slice(2);
  const deriveOnly = args.includes('--derive-only');

  const stationsJson = JSON.parse(fs.readFileSync(STATIONS_PATH, 'utf8'));
  process.stdout.write(`# stations.json: ${stationsJson.length} entries\n`);

  // 산출물 1: stationCodes.json
  if (!deriveOnly) {
    const apiKey = process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY;
    if (!apiKey) {
      process.stderr.write('# ERROR: EXPO_PUBLIC_SEOUL_DATA_API_KEY 환경변수 부재 (또는 --derive-only 사용)\n');
      process.exit(1);
    }
    process.stdout.write(`# fetch ${SEARCH_INFO_SERVICE} ...\n`);
    const rows = await fetchStationInfoRows(apiKey);
    process.stdout.write(`# got ${rows.length} rows\n`);
    const codeIndex = buildStationCodeMap(rows);
    process.stdout.write(`# indexed ${codeIndex.size} (line, baseName) entries\n`);
    const { codes, missing } = buildStationCodesFromStations(stationsJson, codeIndex);
    process.stdout.write(`# stationCodes.json: ${Object.keys(codes).length} entries\n`);
    if (missing.length > 0) {
      process.stderr.write(`# WARN: 1~9호선 STATION_CD 누락 ${missing.length}건:\n`);
      for (const m of missing) {
        process.stderr.write(`  ${m.id} line=${m.line} name=${m.name}\n`);
      }
    }
    writeJsonSorted(STATION_CODES_OUT, codes);
    process.stdout.write(`# wrote ${STATION_CODES_OUT}\n`);
  }

  // 산출물 2: firstLastTrainTimes.json
  process.stdout.write(`# derive firstLastTrainTimes.json from timetables/ ...\n`);
  const { times, missing: ftMissing } = buildFirstLastTimes(stationsJson);
  process.stdout.write(`# firstLastTrainTimes.json: ${Object.keys(times).length} entries\n`);
  if (ftMissing.length > 0) {
    process.stderr.write(`# WARN: 첫차/막차 derive 누락 ${ftMissing.length}건:\n`);
    for (const m of ftMissing) {
      process.stderr.write(`  ${m.id} line=${m.line} name=${m.name} reason=${m.reason}\n`);
    }
  }
  writeJsonSorted(FIRST_LAST_OUT, times);
  process.stdout.write(`# wrote ${FIRST_LAST_OUT}\n`);

  process.stdout.write(`# done.\n`);
}

main().catch((e) => {
  process.stderr.write(`${e.stack || e.message}\n`);
  process.exit(1);
});
