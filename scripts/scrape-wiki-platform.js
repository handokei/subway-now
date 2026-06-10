#!/usr/bin/env node
/**
 * scrape-wiki-platform.js — #1092 follow-up PoC
 *
 * 위키백과(ko.wikipedia.org)의 한국 지하철역 인포박스에서 "승강장" 필드를 추출해
 * 승강장 구조(섬식/상대식/혼합)를 추정한다. exitSide cross-check 보조 자료 후보.
 *
 * 데이터 출처: 위키백과 한국어판 — CC BY-SA 4.0
 *   https://ko.wikipedia.org/wiki/위키백과:저작권
 *
 * 사용:
 *   node scripts/scrape-wiki-platform.js --sample 30
 *     # stations.json에서 무작위/대표 30개 역만 시도 → data/wiki-platform-sample.json
 *   node scripts/scrape-wiki-platform.js --only 강남,잠실,사당
 *     # 특정 역만 시도
 *
 * 한계:
 *   - section=0(인포박스)만 파싱. 동음이의 페이지(예: "시청역")는 매칭 실패 → 'unknown'.
 *   - "1면 2선" → 섬식, "2면 2선" → 상대식 휴리스틱은 지상/지하 혼합역에서 오류 가능
 *     (예: 신도림, 노원, 서울역 등 다중 인포박스 보유 역).
 *   - rate limit 보호용 1.1s sleep. 전체 528개 실행 금지(약 10분, 위키 정책 권장 범위 밖 작업
 *     아니지만 본 PoC는 sample만 검증).
 *
 * 출력 스키마:
 *   { generatedAt: ISO8601, source: 'ko.wikipedia.org', license: 'CC BY-SA 4.0',
 *     results: Array<{ stationName, line, rawField, layout, confidence }> }
 *   - layout: 'island' | 'side' | 'mixed' | 'unknown'
 *   - confidence: 'high' (명시적 섬식/상대식 키워드) | 'medium' (N면N선 휴리스틱) | 'low' (추정 실패)
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const STATIONS = require(path.join(ROOT, 'src', 'data', 'stations.json'));
const OUT_DIR = path.join(ROOT, 'data');
const OUT_FILE = path.join(OUT_DIR, 'wiki-platform-sample.json');

const SLEEP_MS = 1100;
const USER_AGENT = 'subway-now-poc/1.0 (https://github.com/handokei/subway-now; CC BY-SA cross-check)';

function readOption(args, flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 인포박스 wikitext에서 `|승강장 = ...` 필드 값을 모두 추출한다.
 * 여러 노선이 한 페이지에 있으면(예: 강남역 = 2호선 + 신분당선) 여러 매칭이 나온다.
 * @param {string} wikitext
 * @returns {string[]}
 */
function extractPlatformFields(wikitext) {
  if (!wikitext || typeof wikitext !== 'string') return [];
  // `[ \t]*` (not `\s*`) prevents the value capture from crossing newlines into the next field.
  const matches = [...wikitext.matchAll(/\|[ \t]*승강장[ \t]*=[ \t]*([^\n]*)/g)];
  return matches.map((m) => m[1].trim()).filter((v) => v.length > 0);
}

/**
 * 추출한 raw 필드 문자열로부터 승강장 구조를 판정한다.
 * @param {string} raw
 * @returns {{ layout: 'island'|'side'|'mixed'|'unknown', confidence: 'high'|'medium'|'low' }}
 */
function classifyLayout(raw) {
  if (!raw) return { layout: 'unknown', confidence: 'low' };
  const hasIsland = /섬식/.test(raw);
  const hasSide = /상대식/.test(raw);
  if (hasIsland && hasSide) return { layout: 'mixed', confidence: 'high' };
  if (hasIsland) return { layout: 'island', confidence: 'high' };
  if (hasSide) return { layout: 'side', confidence: 'high' };

  // 휴리스틱: N면 M선 패턴
  // 1면 2선 → 섬식 (1 platform between 2 tracks)
  // 2면 2선 → 상대식 (2 side platforms, 2 tracks)
  // 그 외(2면 4선 등) → mixed/unknown
  const dim = raw.match(/(\d+)\s*면\s*(\d+)\s*선/);
  if (dim) {
    const platforms = Number(dim[1]);
    const tracks = Number(dim[2]);
    if (platforms === 1 && tracks === 2) return { layout: 'island', confidence: 'medium' };
    if (platforms === 2 && tracks === 2) return { layout: 'side', confidence: 'medium' };
    return { layout: 'mixed', confidence: 'low' };
  }
  return { layout: 'unknown', confidence: 'low' };
}

/**
 * 한 페이지의 모든 라인 인포박스를 합쳐서 대표 layout을 정한다.
 * 여러 노선이 같은 layout이면 그대로, 다르면 'mixed'.
 * @param {string[]} fields
 */
function aggregateLayout(fields) {
  if (fields.length === 0) return { layout: 'unknown', confidence: 'low', rawField: null };
  const classified = fields.map((f) => ({ raw: f, ...classifyLayout(f) }));
  const layouts = new Set(classified.map((c) => c.layout));
  const rawField = fields.join(' || ');
  if (layouts.size === 1) {
    return { layout: classified[0].layout, confidence: classified[0].confidence, rawField };
  }
  // 노선별로 다른 layout이면 mixed
  layouts.delete('unknown');
  if (layouts.size === 1) {
    return { layout: [...layouts][0], confidence: 'medium', rawField };
  }
  return { layout: 'mixed', confidence: 'medium', rawField };
}

/**
 * 위키백과 페이지 wikitext를 가져온다. 동음이의 페이지면 null 반환.
 * @param {string} title
 * @param {typeof fetch} fetchFn
 */
async function fetchWikitext(title, fetchFn) {
  const url = `https://ko.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(title)}&format=json&prop=wikitext&section=0`;
  const res = await fetchFn(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'ko-KR,ko' } });
  if (!res.ok) return null;
  const json = await res.json();
  return json?.parse?.wikitext?.['*'] ?? null;
}

/**
 * 한 역에 대해 위키백과 lookup 시도. 1차: "{name}역", 2차: "{name}역 (서울)" 형태.
 * @param {{ name: string, line: string }} station
 * @param {typeof fetch} fetchFn
 */
async function resolveStation(station, fetchFn) {
  const candidates = [`${station.name}역`, `${station.name}역 (서울)`, station.name];
  for (const title of candidates) {
    const wt = await fetchWikitext(title, fetchFn);
    if (!wt) continue;
    const fields = extractPlatformFields(wt);
    if (fields.length === 0) continue;
    const { layout, confidence, rawField } = aggregateLayout(fields);
    return {
      stationName: station.name,
      line: station.line,
      wikiTitle: title,
      rawField,
      layout,
      confidence,
    };
  }
  return {
    stationName: station.name,
    line: station.line,
    wikiTitle: null,
    rawField: null,
    layout: 'unknown',
    confidence: 'low',
  };
}

/**
 * 샘플 대상 역 리스트를 결정한다.
 *   --only A,B,C → 정확히 그 역들
 *   --sample N → 노선별 균등 샘플
 */
function pickStations(stations, { only, sample }) {
  if (only && only.length > 0) {
    const wanted = new Set(only);
    // 중복 노선 제거: 같은 이름 첫 등장만
    const seen = new Set();
    return stations.filter((s) => {
      if (!wanted.has(s.name) || seen.has(s.name)) return false;
      seen.add(s.name);
      return true;
    });
  }
  if (sample && sample > 0) {
    // 노선별로 1~2개씩 골라 N개에 도달
    const byLine = new Map();
    for (const s of stations) {
      if (!byLine.has(s.line)) byLine.set(s.line, []);
      byLine.get(s.line).push(s);
    }
    const picked = [];
    const seen = new Set();
    let round = 0;
    while (picked.length < sample && round < 50) {
      for (const list of byLine.values()) {
        if (picked.length >= sample) break;
        const candidate = list[round];
        if (!candidate) continue;
        if (seen.has(candidate.name)) continue;
        seen.add(candidate.name);
        picked.push(candidate);
      }
      round += 1;
    }
    return picked;
  }
  return [];
}

async function run(argv, deps = {}) {
  const fetchFn = deps.fetch ?? fetch;
  const sleepFn = deps.sleep ?? sleep;
  const writeFile = deps.writeFile ?? ((p, c) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c);
  });
  const log = deps.log ?? console.log;

  const only = readOption(argv, '--only')?.split(',').map((s) => s.trim()).filter(Boolean);
  const sample = Number(readOption(argv, '--sample') ?? '0') || 0;
  const stations = deps.stations ?? STATIONS;
  const targets = pickStations(stations, { only, sample });

  if (targets.length === 0) {
    log('No target stations. Use --sample N or --only A,B,C.');
    return { results: [], path: null };
  }

  log(`Scraping ${targets.length} stations (sleep ${SLEEP_MS}ms)...`);
  const results = [];
  for (let i = 0; i < targets.length; i += 1) {
    const station = targets[i];
    const result = await resolveStation(station, fetchFn);
    results.push(result);
    log(`[${i + 1}/${targets.length}] ${result.stationName} (line ${result.line}) → ${result.layout} (${result.confidence})`);
    if (i < targets.length - 1) await sleepFn(SLEEP_MS);
  }

  const out = {
    generatedAt: new Date().toISOString(),
    source: 'ko.wikipedia.org',
    license: 'CC BY-SA 4.0',
    results,
  };
  const outPath = deps.outFile ?? OUT_FILE;
  writeFile(outPath, JSON.stringify(out, null, 2) + '\n');
  log(`Wrote ${results.length} results → ${outPath}`);
  return { results, path: outPath };
}

module.exports = {
  extractPlatformFields,
  classifyLayout,
  aggregateLayout,
  fetchWikitext,
  resolveStation,
  pickStations,
  run,
};

if (require.main === module) {
  run(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
