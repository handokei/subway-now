#!/usr/bin/env node
/**
 * 나무위키 역 페이지에서 진행방향별 좌/우 하차 문 정보를 추출해
 * src/data/exitSide.json 으로 직렬화한다.
 *
 * 사용:
 *   node scripts/fetch-exit-side.js                   # 528역 전체
 *   node scripts/fetch-exit-side.js --only 강남,잠실  # 특정 역만
 *   node scripts/fetch-exit-side.js --inspect 강남    # 발견된 raw 매칭 덤프
 *
 * 동작:
 *   1) stations.json 한글 역명으로 URL 후보 생성 (역명+역 / 역명만 / 한자/병기형 fallback)
 *   2) HTTPS GET (브라우저 UA, 1.5s 슬립)
 *   3) HTML 본문에서 "왼쪽 문이 열립니다" / "오른쪽 문이 열립니다" 매칭 + 인근 컨텍스트에서
 *      상/하행/내선/외선/방면 종착역 추출
 *   4) 노선이 MONOTONIC_LINES(단조 단일축) 인 경우에만 up/down으로 채택, 그 외는 양쪽 모두
 *      'both'로 보일 때만 채택. (잘못된 안내 회피)
 *
 * 출력 스키마는 ExitSideMap (src/types/exitSide.ts): { [stationName]: { up?, down?, both? } }
 * 데이터 없는 역은 출력에서 누락 — 알람 본문에서 graceful fallback.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'data', 'exitSide.json');
const STATIONS = require(path.join(ROOT, 'src', 'data', 'stations.json'));
const { monotonicLines } = require(path.join(ROOT, 'src', 'data', 'lineTopology.json'));

const argv = process.argv.slice(2);
const ONLY = readOption(argv, '--only')?.split(',').map((s) => s.trim()).filter(Boolean);
const INSPECT = readOption(argv, '--inspect');
const SLEEP_MS = 1500;

function readOption(args, flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : null;
}

const MONOTONIC_LINES = new Set(monotonicLines);

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36';

async function fetchPage(stationName) {
  const candidates = [
    `https://namu.wiki/w/${encodeURIComponent(stationName)}역`,
    `https://namu.wiki/w/${encodeURIComponent(stationName)}`,
  ];
  for (const url of candidates) {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'ko-KR,ko' } });
    if (res.status === 200) return { url, html: await res.text() };
  }
  return null;
}

const SIDE_PATTERN = /(왼쪽|오른쪽|좌측|우측|양쪽)\s*(문|도어).{0,15}(열립|개방|개문)/g;
const DIRECTION_HINTS = [
  { pattern: /상행|내선|상선/, key: 'up' },
  { pattern: /하행|외선|하선/, key: 'down' },
];

function classifySide(token) {
  if (token === '왼쪽' || token === '좌측') return 'left';
  if (token === '오른쪽' || token === '우측') return 'right';
  if (token === '양쪽') return 'both';
  return null;
}

// HTML에서 모든 좌/우 매칭과 그 직전 200자 컨텍스트의 방향 힌트를 수집.
// 한 역에 여러 노선이 등록된 경우 매칭이 여러 번 나오므로, 방향별로 가장 마지막에 본 좌/우를 채택.
function extractMatches(html) {
  const matches = [];
  for (const m of html.matchAll(SIDE_PATTERN)) {
    const side = classifySide(m[1]);
    if (!side) continue;
    const start = Math.max(0, m.index - 200);
    const context = html.slice(start, m.index);
    const direction = DIRECTION_HINTS.find((h) => h.pattern.test(context))?.key ?? null;
    matches.push({ side, direction, context: context.slice(-80).replace(/\s+/g, ' ') });
  }
  return matches;
}

function reduceToEntry(matches, line) {
  const entry = {};
  const monotonic = MONOTONIC_LINES.has(line);
  for (const { side, direction } of matches) {
    if (side === 'both') {
      // 섬식 명시 — 진행방향 무관하게 양쪽
      entry.up = 'both';
      entry.down = 'both';
      continue;
    }
    if (!monotonic) continue; // 비단조 노선은 좌/우 채택 보류 (잘못된 안내 회피)
    if (!direction) continue;
    entry[direction] = side;
  }
  return Object.keys(entry).length > 0 ? entry : null;
}

async function processStation(station) {
  const page = await fetchPage(station.name);
  if (!page) return { status: 'no_page', station };
  const matches = extractMatches(page.html);
  if (matches.length === 0) return { status: 'no_match', station, url: page.url };
  if (INSPECT && INSPECT === station.name) {
    console.log(JSON.stringify({ url: page.url, matches }, null, 2));
    process.exit(0);
  }
  const entry = reduceToEntry(matches, station.line);
  if (!entry) return { status: 'no_direction', station, url: page.url, matchCount: matches.length };
  return { status: 'ok', station, entry, matchCount: matches.length };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const targets = ONLY
    ? STATIONS.filter((s) => ONLY.includes(s.name))
    : STATIONS;

  console.log(`[fetch-exit-side] targets=${targets.length}`);

  const result = {};
  let ok = 0;
  let noMatch = 0;
  let noPage = 0;
  let noDir = 0;
  const failed = [];

  for (let i = 0; i < targets.length; i++) {
    const station = targets[i];
    try {
      const r = await processStation(station);
      if (r.status === 'ok') {
        result[station.name] = r.entry;
        ok += 1;
      } else if (r.status === 'no_match') {
        noMatch += 1;
        failed.push(`${station.name} (no_match)`);
      } else if (r.status === 'no_page') {
        noPage += 1;
        failed.push(`${station.name} (no_page)`);
      } else if (r.status === 'no_direction') {
        noDir += 1;
        failed.push(`${station.name} (no_direction, matches=${r.matchCount})`);
      }
    } catch (e) {
      failed.push(`${station.name} (error: ${e.message})`);
    }
    if (i < targets.length - 1) await sleep(SLEEP_MS);
    if ((i + 1) % 50 === 0) {
      console.log(`[fetch-exit-side] progress ${i + 1}/${targets.length} ok=${ok}`);
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n');
  console.log(`[fetch-exit-side] ok=${ok} noMatch=${noMatch} noPage=${noPage} noDir=${noDir}`);
  if (failed.length > 0 && failed.length <= 30) {
    console.log('[fetch-exit-side] failed:\n  ' + failed.join('\n  '));
  } else if (failed.length > 30) {
    console.log(`[fetch-exit-side] failed (${failed.length}, first 30):\n  ` + failed.slice(0, 30).join('\n  '));
  }
  console.log(`[fetch-exit-side] wrote ${OUT}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { extractMatches, classifySide, reduceToEntry, MONOTONIC_LINES };
