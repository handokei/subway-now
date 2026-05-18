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
const SERVICE = process.env.SERVICE ?? 'getFstExit';
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

// 시설 종류 명칭(plfmCmgFac) → 내부 카테고리 매핑.
// 에스컬레이터는 "걸어서 이동" 성격이라 stairs 카테고리에 합친다 (접근성 우선순위에서 EV 우선이 됨).
const FACILITY_PATTERNS = [
  { pattern: /엘리베이터|EV|elevator|승강기/i, category: 'elevator' },
  { pattern: /환승|transfer/i, category: 'transfer' },
  { pattern: /계단|에스컬레이터|escalator|stairs/i, category: 'stairs' },
];

function classifyFacility(label) {
  if (!label) return null;
  for (const { pattern, category } of FACILITY_PATTERNS) {
    if (pattern.test(label)) return category;
  }
  return null;
}

// 서울 OpenAPI `getFstExit` (OA-22749) 응답 필드 (data.seoul.go.kr 명세 기준).
// upbdnbSe 값 '상행'/'하행'/'내선'/'외선' 등 한글 그대로 옴 — TravelDirection 매핑.
const UP_DIRECTION_VALUES = new Set(['상행', '내선']);
const DOWN_DIRECTION_VALUES = new Set(['하행', '외선']);

function classifyDirection(value) {
  if (!value) return null;
  if (UP_DIRECTION_VALUES.has(value)) return 'up';
  if (DOWN_DIRECTION_VALUES.has(value)) return 'down';
  return null;
}

function stringOrNull(value) {
  if (value == null || value === '') return null;
  return String(value);
}

// 한 행을 stations.json id 기준의 시설별 엔트리로 변환.
// 매핑 실패 시 (역 매칭 불가, 시설 분류 불가, 문번호 누락) null 반환.
// 응답 필드:
//   - stnNm: 역명, lineNm: 호선명 (참고)
//   - plfmCmgFac: 승강장출입설비 (시설 분류 소스)
//   - qckgffVhclDoorNo: 빠른하차차량출입문번호 (사용자 노출용 핵심)
//   - upbdnbSe: 상하행구분 → TravelDirection
//   - drtnInfo: 방면정보 (예: "○○방면")
//   - fwkPstnNm/facPstnNm: 기능위치명/설비위치명 (보조)
function mapRow(row) {
  const stationName = stringOrNull(row.stnNm);
  const doorNumber = stringOrNull(row.qckgffVhclDoorNo);
  const category = classifyFacility(row.plfmCmgFac);

  if (!stationName || !doorNumber || !category) return null;

  const station = STATIONS.find((s) => s.name === stationName);
  if (!station) return null;

  const direction = classifyDirection(row.upbdnbSe);
  const towardLabel = stringOrNull(row.drtnInfo);

  return {
    stationId: station.id,
    category,
    entry: {
      doorNumber,
      ...(direction && { direction }),
      ...(towardLabel && { towardLabel }),
    },
  };
}

async function fetchPage(start, end) {
  const url = `http://openapi.seoul.go.kr:8088/${API_KEY}/json/${SERVICE}/${start}/${end}/`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${start}-${end}`);
  const text = await res.text();
  // 서울 OpenAPI는 인증 실패/SERVICE 명 오류 시 200 + XML(<RESULT><CODE>...) 형태로 회신.
  // JSON 파싱 전에 감지해 사용자에게 구체적 안내를 한다.
  const trimmed = text.trimStart();
  if (trimmed.startsWith('<')) {
    const codeMatch = trimmed.match(/<CODE>([^<]+)<\/CODE>/);
    const msgMatch = trimmed.match(/<MESSAGE>([^<]+)<\/MESSAGE>/);
    const code = codeMatch?.[1] ?? 'UNKNOWN';
    const message = msgMatch?.[1] ?? trimmed.slice(0, 200);
    throw new Error(
      `서울 OpenAPI가 XML 에러를 반환했습니다 (code=${code}): ${message}\n` +
      `  - EXPO_PUBLIC_SEOUL_DATA_API_KEY 가 실제 발급키인지 확인하세요 ('xxxx' 등 더미 금지).\n` +
      `  - SERVICE=${SERVICE} 가 OA-22749 의 실제 endpoint 명인지 data.seoul.go.kr 명세에서 재확인.`,
    );
  }
  return JSON.parse(text);
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
