#!/usr/bin/env node
/**
 * #1397: stations.json 빌드타임 재생성 파이프라인.
 *
 * 손유지 SSOT가 야기한 staleness(자양=옛 뚝섬유원지 등)를 근절하기 위해 권위 소스에서
 * 역명을 재생성한다. 좌표는 오프라인 보장을 위해 기존 SSOT를 유지하고, 역명·i18n 누락만
 * API/매핑으로 갱신한다.
 *
 * 데이터 소스 (서울 열린데이터광장):
 *   subwayStationMaster — { BLDN_ID, BLDN_NM, ROUTE, LAT, LOT }
 *   라이선스: 공공누리 제1유형 (출처 표시)
 *
 * 흐름:
 *   1) `subwayStationMaster` fetch (페이지네이션, sample 키도 5건까지 동작)
 *   2) ROUTE → stations.json의 line 매핑 (LINE_TO_ROUTES)
 *   3) BLDN_NM의 base name(괄호 앞)을 키로 (line, baseName) → 정식명 인덱스 빌드
 *   4) 기존 stations.json 순회하며 base name 일치 시 정식명으로 교체
 *   5) RENAME_MAP(SSOT 보강) — API가 늦게 반영하거나 매핑 모호한 케이스는 수동 보강
 *      (예: 7호선 뚝섬유원지 → 자양(뚝섬한강공원))
 *   6) 매칭률 floor 검사 후 결정론적 출력
 *
 * 사용법:
 *   # 사용자 API 키 (full data)
 *   EXPO_PUBLIC_SEOUL_DATA_API_KEY=xxxx node scripts/regenerate-stations.js
 *
 *   # offline mode — RENAME_MAP 만으로 patch (CI/스모크 가능)
 *   node scripts/regenerate-stations.js --offline
 *
 * acceptance:
 *   - 자양(뚝섬한강공원) 등 알려진 개명/병기역명이 stations.json에 반영된다
 *   - 좌표/i18n은 보존된다 (역명만 갱신)
 *   - 결정론적 — 같은 입력으로 두 번 실행해도 byte-identical
 *
 * 옛 boardingLock 호환은 src/data/stationAliases.js의 STATION_ALIASES가 책임진다.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STATIONS_PATH = path.join(__dirname, '..', 'src', 'data', 'stations.json');

const PAGE_SIZE = 1000;
const SLEEP_MS = 200;
const MATCH_RATIO_FLOOR = 0.9;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// stations.json의 line 키 → 서울 열린데이터 API의 ROUTE 후보들.
// scripts/update-coordinates.js와 동일 매핑 유지(SSOT 일원화는 후속 #1397 follow-up).
const LINE_TO_ROUTES = {
  '1': ['1호선', '경부선', '경원선', '경인선', '장항선'],
  '2': ['2호선'],
  '3': ['3호선', '일산선'],
  '4': ['4호선', '과천선', '안산선'],
  '5': ['5호선'],
  '6': ['6호선'],
  '7': ['7호선', '7호선(인천)'],
  '8': ['8호선'],
  '9': ['9호선', '9호선(연장)'],
  airport: ['공항철도1호선'],
  gyeongui: ['경의중앙선', '중앙선'],
  bundang: ['분당선', '수인선'],
  sinbundang: ['신분당선', '신분당선(연장)', '신분당선(연장2)'],
};

const ROUTE_TO_LINE = (() => {
  const out = new Map();
  for (const [line, routes] of Object.entries(LINE_TO_ROUTES)) {
    for (const r of routes) out.set(r, line);
  }
  return out;
})();

/**
 * 손유지 SSOT 보강: API에 정식명으로 등록됐지만 (line, baseName) → 정식명 매핑이
 * 정규화로는 안 잡히거나, API에 아직 미반영된 개명/병기역명 케이스.
 * 모두 권위 소스(서울시 보도자료/노선 표지)로 검증된 SSOT 데이터.
 *
 * value 형식:
 *   - 문자열: 한글 정식명만 교체 (i18n 보존)
 *   - 객체: { name, nameEn?, nameJa?, nameHanja? } 부분 갱신 — 누락 필드는 기존 값 유지
 *
 * key 표기: `${line}|${stations.json의 옛 name}` 또는 `${line}|${baseName}`.
 */
const RENAME_MAP = {
  // 2010-10 개명 (7호선 자양역) — BLDN_ID 2522.
  // 공식 영문/일문은 서울교통공사 다국어표기 자료 기준.
  '7|뚝섬유원지': {
    name: '자양(뚝섬한강공원)',
    nameEn: 'Jayang(Ttukseom Hangang Park)',
    nameJa: 'チャヤン(トゥクソム漢江公園)',
    nameHanja: '紫陽(纛島漢江公園)',
  },
};

function joinKey(line, name) {
  return `${line}|${name}`;
}

/**
 * BLDN_NM의 괄호 부제 분리: `"교대(법원.검찰청)"` → `{ base: '교대', full: '교대(법원.검찰청)' }`.
 * 괄호가 없거나 첫 글자가 '('이면 base = full.
 */
function splitName(name) {
  if (typeof name !== 'string') return { base: '', full: '' };
  const full = name.trim();
  if (!full.endsWith(')')) return { base: full, full };
  const open = full.lastIndexOf('(');
  if (open <= 0) return { base: full, full };
  const base = full.slice(0, open).trimEnd();
  return { base, full };
}

/**
 * 페이지네이션 fetch (sample 키는 1~5만 허용 → 첫 페이지에서 list_total_count로 끝).
 */
async function fetchPage(apiKey, start, end, fetcher = fetch) {
  const url = `http://openapi.seoul.go.kr:8088/${apiKey}/json/subwayStationMaster/${start}/${end}/`;
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${start}-${end}`);
  const json = await res.json();
  const wrapper = json.subwayStationMaster;
  if (!wrapper) {
    if (json.RESULT && json.RESULT.CODE === 'INFO-200') return [];
    throw new Error(`unexpected response: ${JSON.stringify(json).slice(0, 200)}`);
  }
  if (wrapper.RESULT && wrapper.RESULT.CODE !== 'INFO-000') {
    throw new Error(`API error: ${wrapper.RESULT.CODE} ${wrapper.RESULT.MESSAGE}`);
  }
  return wrapper.row || [];
}

async function fetchAll(apiKey, fetcher = fetch, sleepFn = sleep) {
  const all = [];
  let start = 1;
  for (;;) {
    const end = start + PAGE_SIZE - 1;
    const rows = await fetchPage(apiKey, start, end, fetcher);
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    start += PAGE_SIZE;
    await sleepFn(SLEEP_MS);
  }
  return all;
}

/**
 * apiRows에서 (line, base name) → 정식 표기(BLDN_NM) 인덱스 구축.
 * 같은 base가 여러 정식명에 매칭되면 첫 발견을 채택(API는 결정론적 순서 보장).
 * line이 매핑 안되는 ROUTE는 건너뛴다.
 */
function buildApiIndex(apiRows) {
  const idx = new Map();
  for (const row of apiRows) {
    const line = ROUTE_TO_LINE.get(row.ROUTE);
    if (!line) continue;
    const { base, full } = splitName(row.BLDN_NM);
    if (!base) continue;
    const key = joinKey(line, base);
    if (!idx.has(key)) idx.set(key, full);
  }
  return idx;
}

/**
 * 매핑 값(문자열 또는 객체)을 patch 객체로 정규화.
 * 문자열은 { name }로, 객체는 그대로(다만 정의된 필드만).
 */
function normalizePatch(value) {
  if (typeof value === 'string') return { name: value };
  if (value && typeof value === 'object' && typeof value.name === 'string') {
    const patch = { name: value.name };
    if (typeof value.nameEn === 'string') patch.nameEn = value.nameEn;
    if (typeof value.nameJa === 'string') patch.nameJa = value.nameJa;
    if (typeof value.nameHanja === 'string') patch.nameHanja = value.nameHanja;
    return patch;
  }
  return null;
}

/**
 * stations(현재 SSOT)에 API 인덱스 + RENAME_MAP을 적용해 갱신된 stations 배열 반환.
 * 좌표/id/line/lineColor는 보존하고, name(필요 시 nameEn/nameJa/nameHanja)만 갱신.
 * 갱신 발생 시 stats.renamed++, 갱신 없으면 unchanged++.
 *
 * 결정론적: 입력 순서 유지, lookup은 순수 함수.
 */
function applyRenames(stations, apiIndex, renameMap = RENAME_MAP) {
  const stats = { renamed: 0, unchanged: 0, renames: [] };
  const out = stations.map((s) => {
    const { base } = splitName(s.name);
    const apiFull = apiIndex.get(joinKey(s.line, base));
    // 수동 매핑(RENAME_MAP)이 API보다 우선 — API 미반영 개명을 안정적으로 적용.
    const manualValue = renameMap[joinKey(s.line, s.name)] ?? renameMap[joinKey(s.line, base)];
    const manualPatch = normalizePatch(manualValue);
    const patch = manualPatch ?? (apiFull ? { name: apiFull } : null);
    if (!patch || patch.name === s.name) {
      stats.unchanged++;
      return s;
    }
    stats.renamed++;
    stats.renames.push({ id: s.id, line: s.line, from: s.name, to: patch.name });
    return { ...s, ...patch };
  });
  return { stations: out, stats };
}

/**
 * JSON 직렬화 — 기존 SSOT의 2-space indent + trailing newline 컨벤션 유지.
 */
function serialize(stations) {
  return JSON.stringify(stations, null, 2) + '\n';
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * CLI 진입점. deps 주입으로 테스트 가능.
 */
async function main(argv, deps = {}) {
  const writeOut = deps.writeOut ?? ((s) => process.stdout.write(s + '\n'));
  const writeErr = deps.writeErr ?? ((s) => process.stderr.write(s + '\n'));
  const stationsPath = deps.stationsPath ?? STATIONS_PATH;
  const fetcher = deps.fetcher ?? fetch;
  const sleepFn = deps.sleepFn ?? sleep;
  const writeFile = deps.writeFile ?? ((p, c) => fs.writeFileSync(p, c, 'utf8'));
  const env = deps.env ?? process.env;

  const args = argv.slice(2);
  const offline = args.includes('--offline');
  const apiKey = env.EXPO_PUBLIC_SEOUL_DATA_API_KEY;

  if (!offline && !apiKey) {
    writeErr('EXPO_PUBLIC_SEOUL_DATA_API_KEY 환경변수가 없습니다. (또는 --offline 사용)');
    return 1;
  }

  let stations;
  try {
    stations = readJson(stationsPath);
  } catch (e) {
    writeErr(`stations.json 읽기 실패: ${e.message}`);
    return 1;
  }
  if (!Array.isArray(stations)) {
    writeErr('stations.json: root가 배열이 아님');
    return 1;
  }

  let apiIndex = new Map();
  if (!offline) {
    try {
      writeOut('# subwayStationMaster fetch 시작');
      const rows = await fetchAll(apiKey, fetcher, sleepFn);
      writeOut(`# 총 ${rows.length}건 수신`);
      apiIndex = buildApiIndex(rows);
      const ratio = apiIndex.size > 0 ? apiIndex.size / stations.length : 0;
      if (ratio < MATCH_RATIO_FLOOR) {
        writeErr(
          `# API 인덱스 매칭률 ${(ratio * 100).toFixed(1)}% < ${MATCH_RATIO_FLOOR * 100}% — 기존 stations.json 보존, abort`,
        );
        return 1;
      }
      writeOut(`# API 인덱스 매칭률: ${apiIndex.size}/${stations.length} (${(ratio * 100).toFixed(1)}%)`);
    } catch (e) {
      writeErr(`API fetch 실패: ${e.message}`);
      return 1;
    }
  } else {
    writeOut('# offline mode — RENAME_MAP 만으로 patch');
  }

  const { stations: updated, stats } = applyRenames(stations, apiIndex);

  writeOut(`# 갱신: ${stats.renamed}개, 유지: ${stats.unchanged}개`);
  for (const r of stats.renames) {
    writeOut(`  ${r.id} (${r.line}호선): "${r.from}" → "${r.to}"`);
  }

  writeFile(stationsPath, serialize(updated));
  writeOut(`# 저장: ${stationsPath}`);
  return 0;
}

module.exports = {
  LINE_TO_ROUTES,
  ROUTE_TO_LINE,
  RENAME_MAP,
  MATCH_RATIO_FLOOR,
  joinKey,
  splitName,
  fetchPage,
  fetchAll,
  buildApiIndex,
  normalizePatch,
  applyRenames,
  serialize,
  main,
};

/* istanbul ignore if -- CLI 진입은 require.main 분기, 단위 테스트는 main()을 직접 호출 */
if (require.main === module) {
  main(process.argv).then((code) => process.exit(code));
}
