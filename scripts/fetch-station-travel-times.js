#!/usr/bin/env node
/**
 * 서울 열린데이터광장 StationDstncReqreTimeHm에서 1~8호선 역간 실제 운행시간(HM, MM:SS)을
 * 수집해 src/data/stationTravelTimes.json으로 저장한다.
 *
 * 사용법:
 *   EXPO_PUBLIC_SEOUL_DATA_API_KEY=xxxx node scripts/fetch-station-travel-times.js
 *
 * API 사양:
 *   엔드포인트: /StationDstncReqreTimeHm/{START}/{END}/
 *   응답 row 컬럼: SBWY_ROUT_LN(호선명), SBWY_STNS_NM(역명), HM(시간 MM:SS),
 *                 DIST_KM(구간거리), ACML_DIST(누계거리)
 *   row[i]는 "이전 역에서 i번째 역까지의 hop" — 첫 row의 DIST_KM/HM이 0 또는 누락이면 시점이고,
 *   해당 노선 첫 row를 hop으로 보지 않는다(보수적으로 두 케이스 모두 처리).
 *
 * 출력 형식 (stationTravelTimes.json):
 *   {
 *     "1|1-001|1-002": 90,      // 1호선 소요산 → 동두천 90초
 *     "1|1-002|1-001": 90,      // 역방향 동일 시간 보장
 *     ...
 *   }
 *
 * 매칭률 출력: 노선별 총 hop 수 / 매칭 성공 hop 수.
 */

const fs = require('node:fs');
const path = require('node:path');

const PAGE_SIZE = 1000;
const SLEEP_MS = 200;
// 매칭률이 이 비율 미만으로 떨어지면 fail-safe — 기존 데이터 보호.
const MATCH_RATIO_FLOOR = 0.9;
const OUT_PATH = path.join(__dirname, '..', 'src', 'data', 'stationTravelTimes.json');
const STATIONS_PATH = path.join(__dirname, '..', 'src', 'data', 'stations.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseHm(hm) {
  if (typeof hm !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return null;
  return Number.parseInt(m[1], 10) * 60 + Number.parseInt(m[2], 10);
}

function normalizeLineName(raw) {
  // API 표기: 숫자 문자열 "1"~"8". 방어적으로 "01호선" 류도 흡수.
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const m = /^0?(\d{1,2})(?:호선)?$/.exec(trimmed);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return n >= 1 && n <= 8 ? String(n) : null;
}

function normalizeStationName(name) {
  if (typeof name !== 'string') return '';
  const trimmed = name.trim();
  // 후행 괄호 부제 제거 (예: "상봉(시외버스터미널)" → "상봉")
  if (trimmed.endsWith(')')) {
    const open = trimmed.lastIndexOf('(');
    if (open > 0) return trimmed.slice(0, open).trimEnd();
  }
  return trimmed;
}

async function fetchPage(apiKey, start, end) {
  const url = `http://openapi.seoul.go.kr:8088/${apiKey}/json/StationDstncReqreTimeHm/${start}/${end}/`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${start}-${end}`);
  const json = await res.json();
  const wrapper = json.StationDstncReqreTimeHm;
  if (!wrapper) {
    if (json.RESULT && json.RESULT.CODE === 'INFO-200') return [];
    throw new Error(`unexpected response: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return wrapper.row || [];
}

async function fetchAll(apiKey) {
  const all = [];
  let start = 1;
  for (;;) {
    const end = start + PAGE_SIZE - 1;
    const rows = await fetchPage(apiKey, start, end);
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    start += PAGE_SIZE;
    // rate limit 회피: 연속 페이지 사이 짧은 대기.
    await sleep(SLEEP_MS);
  }
  return all;
}

function buildNameIndex(stations) {
  // line → name → id
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

function lookupStationId(byLine, line, rawName) {
  const idx = byLine.get(line);
  if (!idx) return null;
  const normalized = normalizeStationName(rawName);
  return idx.get(rawName) || idx.get(normalized) || null;
}

function groupRowsByLine(rows) {
  // 노선별로 row를 그룹화. 각 그룹 내부 순서는 응답이 주는 순서 그대로(노선 끝에서 끝까지)를 보존.
  const groups = new Map();
  for (const row of rows) {
    const line = normalizeLineName(row.SBWY_ROUT_LN);
    if (!line) continue;
    let g = groups.get(line);
    if (!g) {
      g = [];
      groups.set(line, g);
    }
    g.push(row);
  }
  return groups;
}

// line별 station id → stations.json 위치 인덱스. 인접 검증용.
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
  const lineIdxMap = new Map();
  for (const [line, arr] of byLine) {
    // id가 `line-NNN`(역 진행 순서대로 부여된 번호) 패턴이라 id 정렬 = 노선 물리 순서.
    // stationRoute.ts의 getLineStationsCached와 동일 정렬 기준이라 인접 판정이 런타임과 일치한다.
    arr.sort((a, b) => a.id.localeCompare(b.id));
    const idxMap = new Map();
    arr.forEach((s, i) => idxMap.set(s.id, i));
    lineIdxMap.set(line, idxMap);
  }
  return lineIdxMap;
}

// rows + stations로부터 travelTimes 맵과 매칭 통계를 계산. 순수 함수 — 외부 호출 없음.
// 인접성 가드: stations.json 위에서 prev/cur idx 차이가 1이 아니면 hop 으로 보지 않는다 —
// 노선 분기(예: 5호선 강동 분기, 6호선 응암 순환)나 순환선 wrap(2호선 시청 → 시청)에서 발생.
function buildTravelTimes(rows, stations) {
  const byLine = buildNameIndex(stations);
  const lineIdxMap = buildLineIdxMap(stations);
  const groups = groupRowsByLine(rows);
  const travelTimes = {};
  const unmatched = [];
  let totalHops = 0;
  let matchedHops = 0;

  for (const [line, lineRows] of groups) {
    const idxMap = lineIdxMap.get(line);
    let prevId = null;
    let prevName = null;
    for (const row of lineRows) {
      const rawName = row.SBWY_STNS_NM;
      const stationId = lookupStationId(byLine, line, rawName);
      const seconds = parseHm(row.HM);

      if (prevName !== null) {
        const prevIdx = prevId && idxMap ? idxMap.get(prevId) : undefined;
        const curIdx = stationId && idxMap ? idxMap.get(stationId) : undefined;
        const isAdjacent =
          prevIdx !== undefined && curIdx !== undefined && Math.abs(prevIdx - curIdx) === 1;

        if (isAdjacent) {
          totalHops++;
          if (seconds !== null && seconds > 0) {
            // 양방향 동일 시간 가정 (시간표 기반이지만 평균 운행시간이므로 방향 무관)
            travelTimes[`${line}|${prevId}|${stationId}`] = seconds;
            travelTimes[`${line}|${stationId}|${prevId}`] = seconds;
            matchedHops++;
          } else {
            unmatched.push({ line, from: prevName, to: rawName, hm: row.HM });
          }
        }
        // 인접하지 않으면 분기/시작점/순환 wrap. hop으로 보지 않고 무시 (totalHops 미증가).
      }
      prevId = stationId;
      prevName = rawName;
    }
  }

  return { travelTimes, unmatched, totalHops, matchedHops, groups };
}

async function main() {
  const apiKey = process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY;
  if (!apiKey) {
    console.error('EXPO_PUBLIC_SEOUL_DATA_API_KEY 환경변수가 없습니다.');
    process.exit(1);
  }

  const stations = JSON.parse(fs.readFileSync(STATIONS_PATH, 'utf8'));

  console.log('# StationDstncReqreTimeHm fetch 시작');
  const rows = await fetchAll(apiKey);
  console.log(`# 총 ${rows.length}건 수신`);

  const { travelTimes, unmatched, totalHops, matchedHops, groups } = buildTravelTimes(rows, stations);

  // 인접 hop 기준 매칭률. 분기/순환 경계는 totalHops에서 제외되므로 100%가 정상.
  const ratio = totalHops > 0 ? matchedHops / totalHops : 0;
  console.log(`# 인접 hop 매칭률: ${matchedHops}/${totalHops} (${(ratio * 100).toFixed(1)}%)`);
  console.log(`# 노선별 row 수:`);
  for (const [line, lineRows] of groups) {
    console.log(`  ${line}호선: ${lineRows.length} rows`);
  }
  if (unmatched.length > 0) {
    console.log(`# 인접 hop 중 HM 누락 (${unmatched.length}):`);
    for (const u of unmatched.slice(0, 30)) {
      console.log(`  ${u.line}호선 ${u.from} → ${u.to} (HM=${u.hm})`);
    }
    if (unmatched.length > 30) console.log(`  ... 외 ${unmatched.length - 30}건`);
  }

  // totalHops===0(전체 정규화 실패/빈 응답)도 abort — 빈 {} 로 기존 데이터를 무음 덮어쓰기 방지.
  if (totalHops === 0 || ratio < MATCH_RATIO_FLOOR) {
    console.error(`# 인접 hop ${totalHops}개 · 매칭률 ${(ratio * 100).toFixed(1)}% < ${MATCH_RATIO_FLOOR * 100}% — 기존 JSON 보존, abort`);
    process.exit(1);
  }

  // atomic write: tmp에 쓰고 rename. 부분 실패에서 기존 JSON 손상 방지.
  const tmpPath = `${OUT_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(travelTimes, null, 0));
  fs.renameSync(tmpPath, OUT_PATH);
  const stat = fs.statSync(OUT_PATH);
  console.log(`# 저장: ${OUT_PATH}`);
  console.log(`# 크기: ${stat.size} bytes (${(stat.size / 1024).toFixed(1)} KB)`);
}

// require로 import되는 케이스에서는 main 자동 실행을 막는다 (단위 테스트 대응).
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  parseHm,
  normalizeLineName,
  normalizeStationName,
  buildNameIndex,
  lookupStationId,
  groupRowsByLine,
  buildTravelTimes,
  fetchPage,
  fetchAll,
};
