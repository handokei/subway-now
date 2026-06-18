#!/usr/bin/env node
/**
 * #1111: 서울 열린데이터광장 StationDstncReqreTimeHm에서 1~8호선 인접 역간 실측 거리(DIST_KM)를
 * 수집해 src/data/stationDistances.json으로 저장한다. #655(scripts/fetch-station-travel-times.js)와
 * 동일 API · 동일 row를 사용하지만 HM 대신 DIST_KM 컬럼을 캡처한다.
 *
 * 사용법:
 *   EXPO_PUBLIC_SEOUL_DATA_API_KEY=xxxx node scripts/fetch-station-distances.js
 *
 * 출력 형식 (stationDistances.json):
 *   {
 *     "1|1-001|1-002": 1820,    // 1호선 소요산 → 동두천 인접 hop, 미터
 *     "1|1-002|1-001": 1820,    // 역방향 동일 거리 보장
 *     ...
 *   }
 *
 * 활용 후보 (별도 이슈):
 *   - src/shared/utils/stationEta.ts의 fusion ETA가 현재 haversine 직선거리 ÷ GPS speed로 계산.
 *     실측 트랙 거리(곡선 + 우회)는 직선거리보다 길어 ETA 과소 추정. getStopDistanceMeters()로
 *     교체 시 fusion 정확도 향상 가능.
 *   - hopTime.ts는 이미 HM 기반이지만, 속도 컨디션(고속·완행) 분리 분석에도 거리/시간 비율이 유용.
 *
 * 데이터 소스: 서울 열린데이터광장 OpenAPI StationDstncReqreTimeHm
 *   - data.go.kr 15057802 (서울교통공사_역간거리 및 소요시간)
 *   - 라이선스: 공공누리 제1유형 (출처 표시)
 */

const fs = require('node:fs');
const path = require('node:path');
const { normalizeStationName, buildNameIndex, lookupStationId } = require('./lib/stationNameIndex');

const PAGE_SIZE = 1000;
const SLEEP_MS = 200;
// 매칭률이 이 비율 미만으로 떨어지면 fail-safe — 기존 데이터 보호.
const MATCH_RATIO_FLOOR = 0.9;
const OUT_PATH = path.join(__dirname, '..', 'src', 'data', 'stationDistances.json');
const STATIONS_PATH = path.join(__dirname, '..', 'src', 'data', 'stations.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseDistKm(raw) {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function normalizeLineName(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const m = /^0?(\d{1,2})(?:호선)?$/.exec(trimmed);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return n >= 1 && n <= 8 ? String(n) : null;
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
    await sleep(SLEEP_MS);
  }
  return all;
}

function groupRowsByLine(rows) {
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
    arr.sort((a, b) => a.id.localeCompare(b.id));
    const idxMap = new Map();
    arr.forEach((s, i) => idxMap.set(s.id, i));
    lineIdxMap.set(line, idxMap);
  }
  return lineIdxMap;
}

// rows + stations → 양방향 거리 맵(미터) + 매칭 통계. 인접성 가드는 fetch-station-travel-times와 동일.
// DIST_KM은 km → m로 반올림(정수 미터)해 JSON 크기를 줄인다 — 1m 미만 정밀도는 ETA 용도에서 무의미.
function buildDistances(rows, stations) {
  const byLine = buildNameIndex(stations);
  const lineIdxMap = buildLineIdxMap(stations);
  const groups = groupRowsByLine(rows);
  const distances = {};
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
      const km = parseDistKm(row.DIST_KM);

      if (prevName !== null) {
        const prevIdx = prevId && idxMap ? idxMap.get(prevId) : undefined;
        const curIdx = stationId && idxMap ? idxMap.get(stationId) : undefined;
        const isAdjacent =
          prevIdx !== undefined && curIdx !== undefined && Math.abs(prevIdx - curIdx) === 1;

        if (isAdjacent) {
          totalHops++;
          if (km !== null) {
            const meters = Math.round(km * 1000);
            distances[`${line}|${prevId}|${stationId}`] = meters;
            distances[`${line}|${stationId}|${prevId}`] = meters;
            matchedHops++;
          } else {
            unmatched.push({ line, from: prevName, to: rawName, distKm: row.DIST_KM });
          }
        }
      }
      prevId = stationId;
      prevName = rawName;
    }
  }

  return { distances, unmatched, totalHops, matchedHops, groups };
}

async function main() {
  const apiKey = process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY;
  if (!apiKey) {
    console.error('EXPO_PUBLIC_SEOUL_DATA_API_KEY 환경변수가 없습니다.');
    process.exit(1);
  }

  const stations = JSON.parse(fs.readFileSync(STATIONS_PATH, 'utf8'));

  console.log('# StationDstncReqreTimeHm fetch 시작 (DIST_KM)');
  const rows = await fetchAll(apiKey);
  console.log(`# 총 ${rows.length}건 수신`);

  const { distances, unmatched, totalHops, matchedHops, groups } = buildDistances(rows, stations);

  const ratio = totalHops > 0 ? matchedHops / totalHops : 0;
  console.log(`# 인접 hop 매칭률: ${matchedHops}/${totalHops} (${(ratio * 100).toFixed(1)}%)`);
  console.log(`# 노선별 row 수:`);
  for (const [line, lineRows] of groups) {
    console.log(`  ${line}호선: ${lineRows.length} rows`);
  }
  if (unmatched.length > 0) {
    console.log(`# 인접 hop 중 DIST_KM 누락 (${unmatched.length}):`);
    for (const u of unmatched.slice(0, 30)) {
      console.log(`  ${u.line}호선 ${u.from} → ${u.to} (DIST_KM=${u.distKm})`);
    }
    if (unmatched.length > 30) console.log(`  ... 외 ${unmatched.length - 30}건`);
  }

  if (totalHops === 0 || ratio < MATCH_RATIO_FLOOR) {
    console.error(`# 인접 hop ${totalHops}개 · 매칭률 ${(ratio * 100).toFixed(1)}% < ${MATCH_RATIO_FLOOR * 100}% — 기존 JSON 보존, abort`);
    process.exit(1);
  }

  const tmpPath = `${OUT_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(distances, null, 0));
  fs.renameSync(tmpPath, OUT_PATH);
  const stat = fs.statSync(OUT_PATH);
  console.log(`# 저장: ${OUT_PATH}`);
  console.log(`# 크기: ${stat.size} bytes (${(stat.size / 1024).toFixed(1)} KB)`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  parseDistKm,
  normalizeLineName,
  normalizeStationName,
  buildNameIndex,
  lookupStationId,
  groupRowsByLine,
  buildDistances,
  fetchPage,
  fetchAll,
};
