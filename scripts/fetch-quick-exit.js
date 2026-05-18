#!/usr/bin/env node
/**
 * 서울 열린데이터광장 "빠른하차정보" API (OA-22749)에서 시설별 차량·문 번호를
 * 일괄 수집해 src/data/quickExit.json 으로 직렬화한다.
 *
 * 사용:
 *   EXPO_PUBLIC_SEOUL_DATA_API_KEY=xxxx node scripts/fetch-quick-exit.js
 *   EXPO_PUBLIC_SEOUL_DATA_API_KEY=xxxx SERVICE=tbTraficElvtr node scripts/fetch-quick-exit.js
 *   EXPO_PUBLIC_SEOUL_DATA_API_KEY=xxxx node scripts/fetch-quick-exit.js --inspect   # 첫 행 raw 덤프
 *
 * SERVICE는 API 명세에서 확인한 컨테이너 이름. data.seoul.go.kr "참고문서" 또는
 * Swagger UI에서 OA-22749의 endpoint 명을 확인해서 지정. 미지정 시 환경 기본값 사용.
 *
 * --inspect 모드: 첫 페이지의 첫 행을 그대로 출력해 필드명을 확인할 때 사용.
 * 실 매핑은 mapRow()를 보고 응답 필드명에 맞게 조정한다.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'data', 'quickExit.json');
const STATIONS = require(path.join(ROOT, 'src', 'data', 'stations.json'));

const API_KEY = process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY;
const SERVICE = process.env.SERVICE ?? 'tbTraficElvtr';
const PAGE = 1000;
const INSPECT = process.argv.includes('--inspect');

if (!API_KEY) {
  console.error('EXPO_PUBLIC_SEOUL_DATA_API_KEY 환경변수가 없습니다.');
  process.exit(1);
}

// 서울 OpenAPI 공통 envelope에서 row 배열을 찾는다.
// 응답이 { <SERVICE>: { RESULT, list_total_count, row: [...] } } 형태인 경우와
// 행 자체가 최상위에 있는 경우 모두 대응.
function extractRows(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const container = payload[SERVICE] ?? payload;
  if (Array.isArray(container)) return container;
  if (Array.isArray(container?.row)) return container.row;
  return null;
}

function extractTotal(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const container = payload[SERVICE] ?? payload;
  const total = container?.list_total_count;
  return typeof total === 'number' ? total : null;
}

// 시설 종류 명칭 → 내부 카테고리 매핑.
// 실 응답이 한글 명칭으로 오므로 substring 매칭으로 안전하게 분류.
const FACILITY_PATTERNS = [
  { pattern: /엘리베이터|EV|elevator/i, category: 'elevator' },
  { pattern: /환승|transfer/i, category: 'transfer' },
  { pattern: /계단|stairs/i, category: 'stairs' },
];

function classifyFacility(label) {
  if (!label) return null;
  for (const { pattern, category } of FACILITY_PATTERNS) {
    if (pattern.test(label)) return category;
  }
  return null;
}

// 후보 필드 이름들 — 응답 명세가 확정되면 정확한 키 하나로 좁힐 것 (후속 이슈).
// 1글자/모호한 한국어 키('칸'·'문' 등)는 다른 필드와 silent 충돌 위험이 있어 제외.
const FIELD_CANDIDATES = {
  stationName: ['STATN_NM', 'STATION_NM', 'STATION_NAME', '역명'],
  lineNumber: ['LINE_NUM', 'LINE_NO', 'LINE', '호선'],
  carNumber: ['CAR_NO', 'CAR_NUM', 'TRAIN_NO', '차량번호'],
  doorNumber: ['DOOR_NO', 'DOOR_NUM', 'EXIT_NO', '출입문번호'],
  facility: ['FCLTY_NM', 'MV_FCLTY_NM', 'EXIT_FCLTY_NM', 'FCLTY_TY', '시설명', '이동설비명'],
  targetLine: ['TRSF_LINE_NUM', 'TRANSFER_LINE', '환승호선'],
};

function pick(row, candidates) {
  for (const key of candidates) {
    if (row[key] != null && row[key] !== '') return row[key];
  }
  return null;
}

// 한 행을 stations.json id 기준의 시설별 엔트리로 변환.
// 매핑 실패 시 (역 매칭 불가, 시설 분류 불가, 문번호 누락) null 반환.
// transfer 분류는 라벨 기반이지만, targetLine 필드 존재 여부로 cross-check해서 silent
// 오분류(예: "환승통로 계단"이 transfer로 잘못 묶이는 케이스)를 stairs로 강등시킨다.
function mapRow(row) {
  const stationName = pick(row, FIELD_CANDIDATES.stationName);
  const doorNumber = pick(row, FIELD_CANDIDATES.doorNumber);
  const carNumber = pick(row, FIELD_CANDIDATES.carNumber);
  const facilityLabel = pick(row, FIELD_CANDIDATES.facility);
  let category = classifyFacility(facilityLabel);
  const targetLine = pick(row, FIELD_CANDIDATES.targetLine);

  if (!stationName || !doorNumber || !category) return null;
  if (category === 'transfer' && !targetLine) {
    // transfer로 분류됐지만 환승 대상 노선이 비어 있으면 transfer 의미 성립 안 됨 → stairs 강등.
    category = 'stairs';
  }

  const station = STATIONS.find((s) => s.name === stationName);
  if (!station) return null;

  return {
    stationId: station.id,
    category,
    entry: {
      doorNumber: String(doorNumber),
      ...(carNumber != null && { carNumber: String(carNumber) }),
      ...(category === 'transfer' && { targetLine: String(targetLine) }),
    },
  };
}

async function fetchPage(start, end) {
  const url = `http://openapi.seoul.go.kr:8088/${API_KEY}/json/${SERVICE}/${start}/${end}/`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${start}-${end}`);
  return res.json();
}

async function main() {
  console.log(`[fetch-quick-exit] SERVICE=${SERVICE} START`);

  const first = await fetchPage(1, PAGE);
  if (INSPECT) {
    const rows = extractRows(first) ?? [];
    console.log(JSON.stringify(rows[0] ?? first, null, 2));
    process.exit(0);
  }

  const total = extractTotal(first) ?? 0;
  if (total === 0) {
    console.error('list_total_count를 찾지 못했습니다. --inspect로 응답 구조를 확인하세요.');
    process.exit(1);
  }
  console.log(`[fetch-quick-exit] total=${total}`);

  const allRows = [...(extractRows(first) ?? [])];
  for (let start = PAGE + 1; start <= total; start += PAGE) {
    const end = Math.min(start + PAGE - 1, total);
    const page = await fetchPage(start, end);
    allRows.push(...(extractRows(page) ?? []));
  }

  const map = {};
  let mapped = 0;
  let skipped = 0;
  for (const row of allRows) {
    const result = mapRow(row);
    if (!result) {
      skipped += 1;
      continue;
    }
    mapped += 1;
    const bucket = (map[result.stationId] ??= { stairs: [], elevator: [], transfer: [] });
    bucket[result.category].push(result.entry);
  }

  // 빈 카테고리는 출력 슬림화를 위해 제거
  for (const station of Object.values(map)) {
    for (const key of Object.keys(station)) {
      if (station[key].length === 0) delete station[key];
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(map, null, 2) + '\n');
  console.log(`[fetch-quick-exit] mapped=${mapped} skipped=${skipped} stations=${Object.keys(map).length}`);
  console.log(`[fetch-quick-exit] wrote ${OUT}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { extractRows, extractTotal, classifyFacility, mapRow, FIELD_CANDIDATES };
