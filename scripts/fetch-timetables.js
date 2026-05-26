#!/usr/bin/env node
/**
 * 서울 열린데이터광장 SearchSTNTimeTableByFRCodeService에서 노선별 시간표를 수집해
 * src/data/timetables/line-{N}.json으로 저장한다.
 *
 * Phase 1 스코프: 1호선만 시범 ETL. 크기 실측 및 동적 import 호환성 검증용.
 *
 * 사용법:
 *   EXPO_PUBLIC_SEOUL_DATA_API_KEY=xxxx node scripts/fetch-timetables.js
 *   EXPO_PUBLIC_SEOUL_DATA_API_KEY=xxxx LINE=1 node scripts/fetch-timetables.js
 *
 * API 사양:
 *   엔드포인트: /SearchSTNTimeTableByFRCodeService/{start}/{end}/{FR_CODE}/{WEEK_TAG}/{INOUT_TAG}
 *   FR_CODE: 3자리 정수 (노선별 100단위, 예: 1호선=100~199, 3호선=300~399)
 *   WEEK_TAG: 1=평일, 2=토요일, 3=일요일/공휴일
 *   INOUT_TAG: 1=상행/내선, 2=하행/외선
 *
 * 출력 형식 (line-N.json):
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

const fs = require('fs');
const path = require('path');

const API_KEY = process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY;
if (!API_KEY) {
  console.error('EXPO_PUBLIC_SEOUL_DATA_API_KEY 환경변수가 없습니다.');
  process.exit(1);
}

const TARGET_LINE = process.env.LINE ? parseInt(process.env.LINE, 10) : 1;
const SLEEP_MS = 800;
const FR_CODE_START = TARGET_LINE * 100;
const FR_CODE_END = FR_CODE_START + 99;

const WEEK_TAGS = [
  { tag: '1', key: 'weekday' },
  { tag: '2', key: 'saturday' },
  { tag: '3', key: 'sunday' },
];
const INOUT_TAGS = [
  { tag: '1', key: 'up' },
  { tag: '2', key: 'down' },
];

const OUT_DIR = path.join(__dirname, '..', 'src', 'data', 'timetables');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOne(frCode, weekTag, inoutTag) {
  const url = `http://openapi.seoul.go.kr:8088/${API_KEY}/json/SearchSTNTimeTableByFRCodeService/1/1000/${frCode}/${weekTag}/${inoutTag}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for FR_CODE=${frCode} W=${weekTag} I=${inoutTag}`);
  const json = await res.json();
  const wrapper = json.SearchSTNTimeTableByFRCodeService;
  if (!wrapper) {
    if (json.RESULT?.CODE === 'INFO-200') return null;
    throw new Error(`unexpected response for FR_CODE=${frCode}: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return wrapper.row ?? [];
}

// "HH:MM:SS" → "HHMM"(2자리×2). 24시간 초과 표기("24:09:30")는 익일 시각으로 보존
// (정렬은 문자열 비교로 가능, 24+ 시각이 23대보다 큰 값).
function compactTime(arriveTime) {
  if (typeof arriveTime !== 'string') return null;
  const m = arriveTime.match(/^(\d{2}):(\d{2}):/);
  if (!m) return null;
  return `${m[1]}${m[2]}`;
}

async function fetchStation(frCode) {
  // 평일 상행으로 probe — 데이터 없으면 나머지 5호출 생략.
  const probe = await fetchOne(frCode, '1', '1');
  await sleep(SLEEP_MS);
  if (!probe || probe.length === 0) return { stationName: null, timetable: {} };
  const stationName = probe[0].STATION_NM;
  const result = {
    weekday: {
      up: probe.map((r) => compactTime(r.ARRIVETIME)).filter(Boolean).sort(),
    },
  };
  // 나머지 5개 호출 (평일 하행, 토 상/하, 일 상/하)
  const remaining = [
    { weekTag: '1', inoutTag: '2', weekKey: 'weekday', inoutKey: 'down' },
    { weekTag: '2', inoutTag: '1', weekKey: 'saturday', inoutKey: 'up' },
    { weekTag: '2', inoutTag: '2', weekKey: 'saturday', inoutKey: 'down' },
    { weekTag: '3', inoutTag: '1', weekKey: 'sunday', inoutKey: 'up' },
    { weekTag: '3', inoutTag: '2', weekKey: 'sunday', inoutKey: 'down' },
  ];
  for (const { weekTag, inoutTag, weekKey, inoutKey } of remaining) {
    const rows = await fetchOne(frCode, weekTag, inoutTag);
    await sleep(SLEEP_MS);
    if (!rows || rows.length === 0) continue;
    const times = rows.map((r) => compactTime(r.ARRIVETIME)).filter(Boolean).sort();
    if (!result[weekKey]) result[weekKey] = {};
    result[weekKey][inoutKey] = times;
  }
  return { stationName, timetable: result };
}

async function main() {
  console.log(`# 시간표 ETL 시작 — 노선 ${TARGET_LINE} (FR_CODE ${FR_CODE_START}~${FR_CODE_END})`);
  const stations = {};
  let stationCount = 0;
  for (let frCode = FR_CODE_START; frCode <= FR_CODE_END; frCode++) {
    const code3 = String(frCode).padStart(3, '0');
    let stationName, timetable;
    try {
      ({ stationName, timetable } = await fetchStation(code3));
    } catch (e) {
      console.error(`  ERROR FR_CODE=${code3}: ${e.message}`);
      continue;
    }
    if (!stationName || Object.keys(timetable).length === 0) {
      process.stdout.write('.');
      continue;
    }
    stations[stationName] = timetable;
    stationCount++;
    console.log(`\n  ${code3} ${stationName} ✓ (weekday up=${timetable.weekday?.up?.length ?? 0})`);
  }
  console.log(`\n# 총 ${stationCount}개 역 수집`);
  const outPath = path.join(OUT_DIR, `line-${TARGET_LINE}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ stations }, null, 0));
  const stat = fs.statSync(outPath);
  console.log(`# 저장: ${outPath}`);
  console.log(`# 크기 (minified): ${stat.size} bytes (${(stat.size / 1024).toFixed(1)} KB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
