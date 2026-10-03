#!/usr/bin/env node
/**
 * 나무위키 역 페이지의 "빠른 환승" 섹션에서 (출발노선, 도착노선, 진행방면) → 도어번호 매핑을
 * 추출해 src/data/transferExit.json 으로 직렬화한다.
 *
 * 사용:
 *   node scripts/fetch-transfer-exit.js                   # 환승역 전체
 *   node scripts/fetch-transfer-exit.js --only 군자,건대입구
 *   node scripts/fetch-transfer-exit.js --inspect 군자    # 단일 역 디버그 덤프
 *
 * 입력 패턴(나무위키 본문에서 HTML 태그 제거 후):
 *   "노선 및 방면 빠른 환승 5호선 (방화 방면) → 7호선 (장암 방면) 8-4"
 *   "7호선 (장암 방면) → 2호선 8-4"
 *   "2호선 외선순환 ( 성수 방향) → 7호선 8-3"
 *
 * 출력(`TransferExitMap`):
 *   {
 *     "<stationName>": [
 *       {
 *         fromLine: "5" | "7" | "airport" | ...,
 *         toLine: "7" | ...,
 *         fromTerminal?: "방화" | "장암" | "성수" | null,
 *         toTerminal?: "장암" | null,
 *         doorNumber: "8-4"
 *       },
 *       ...
 *     ]
 *   }
 *
 * 진행방향(up/down/inner/outer)으로의 변환은 UI 레이어에서 종착역/방면 라벨을 보고 결정한다.
 * 스크립트는 원본에 가까운 텍스트 키만 저장 — 추후 운영 중 표기 변경에 영향 최소화.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'data', 'transferExit.json');
const STATIONS = require(path.join(ROOT, 'src', 'data', 'stations.json'));

const argv = process.argv.slice(2);
const ONLY = readOption(argv, '--only')?.split(',').map((s) => s.trim()).filter(Boolean);
const INSPECT = readOption(argv, '--inspect');
const SLEEP_MS = 1500;

function readOption(args, flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : null;
}

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36';

// "X호선" / 광역철도 표기 → LineNumber. fetch-quick-exit.js의 매핑과 동일 의도, 표기 변형 흡수.
// 매핑되지 않은 노선(경춘선, GTX 등)은 normalize 단계에서 null 반환 → row가 dropped 된다.
const LINE_LABEL_TO_NUMBER = {
  '1호선': '1', '2호선': '2', '3호선': '3', '4호선': '4', '5호선': '5',
  '6호선': '6', '7호선': '7', '8호선': '8', '9호선': '9',
  '공항철도': 'airport', '인천국제공항철도': 'airport',
  '경의중앙선': 'gyeongui', '경의·중앙선': 'gyeongui',
  '분당선': 'bundang', '수인분당선': 'bundang', '수인·분당선': 'bundang',
  '신분당선': 'sinbundang',
};

function normalizeLineLabel(label) {
  if (!label) return null;
  const trimmed = label.trim();
  return LINE_LABEL_TO_NUMBER[trimmed] ?? null;
}

// 페이지 본문에 "빠른 환승" 키워드가 있는지로 본문/disambiguation을 구별.
// 동음이의어(시청/노원/신촌/종합운동장 등)는 "역명역"이 disambiguation이고 "역명역(서울)"이 본문.
async function fetchPage(stationName) {
  const candidates = [
    `https://namu.wiki/w/${encodeURIComponent(stationName)}역`,
    `https://namu.wiki/w/${encodeURIComponent(stationName + '역(서울)')}`,
    `https://namu.wiki/w/${encodeURIComponent(stationName)}`,
  ];
  let lastOk = null;
  for (const url of candidates) {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'ko-KR,ko' },
    });
    if (res.status !== 200) continue;
    const html = await res.text();
    if (html.includes('빠른 환승') || html.includes('빠른환승')) return { url, html };
    lastOk = lastOk ?? { url, html };
  }
  return lastOk;
}

// 원본 HTML을 텍스트만 남기고 공백 정규화. 정규식 가독성을 위해 한 단계 처리.
function htmlToPlainText(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' '); // NOSONAR — 한정 입력(나무위키 HTML)에 대한 1회성 도구, ReDoS 위험 없음
}

// "빠른 환승" 키워드 뒤 ~600자 윈도우를 자른다 (여러 줄 매칭을 한 윈도우에서 처리).
function extractWindows(plain) {
  const windows = [];
  for (const m of plain.matchAll(/빠른\s*환승/g)) {
    const start = m.index + m[0].length;
    windows.push(plain.slice(start, start + 600));
  }
  return windows;
}

// 한 줄 패턴: "노선A (방면라벨1?)? → 노선B (방면라벨2?)? 차-문"
// 한 행에 toLine이 콤마로 여러 개일 수 있다 (예: "5호선 → 6호선, 인천국제공항철도, 경의·중앙선 1-1").
// - 방면 라벨: "장암 방면" / "성수 방향" / "외선순환 ( 성수 방향)" 등.
// - 차-문: "1-1" ~ "10-8" 등 한 자리/두 자리 숫자 - 한 자리 숫자.
const LINE_TOKEN = '(?:[1-9]|10)호선|인천국제공항철도|공항철도|경의[·]?중앙선|수인[·]?분당선|분당선|신분당선';
const PAREN_LABEL = '\\(\\s*([^)]+?)\\s*\\)';
const DOOR_NUMBER = '(\\d{1,2}-\\d)';

const ROW_REGEX = new RegExp(
  `(${LINE_TOKEN})` +                                // 1: fromLineLabel
  `(?:\\s*(외선순환|내선순환))?` +                    // 2: fromLoop (2호선 전용, optional)
  `(?:\\s*${PAREN_LABEL})?` +                       // 3: fromParen
  `\\s*[→➔➡]\\s*` +
  `((?:${LINE_TOKEN})(?:\\s*,\\s*(?:${LINE_TOKEN}))*)` + // 4: toLines (콤마로 여러 개 가능)
  `(?:\\s*(외선순환|내선순환))?` +                    // 5: toLoop
  `(?:\\s*${PAREN_LABEL})?` +                       // 6: toParen
  `\\s+${DOOR_NUMBER}`,                             // 7: doorNumber
  'g',
);

// "6호선, 인천국제공항철도, 경의·중앙선" → ["6호선","인천국제공항철도","경의·중앙선"]
function splitToLines(joined) {
  return joined.split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean); // NOSONAR — 1회성 크롤러, 입력 길이 제한 있음
}

// "성수 방향" / "장암 방면" / "하남검단산, 마천 방면" → 종착역명 배열.
// 콤마로 분리된 다중 종착역(5호선 본선/하남선 분기 등)도 각각 별도 row가 되도록 모두 반환.
// 인자가 falsy면 [null] 한 칸 — 방면 표기 없는 케이스도 한 row를 생성하기 위함.
function extractTerminals(paren) {
  if (!paren) return [null];
  const stripped = paren.replace(/\s*(?:방면|방향)\s*$/, '').trim(); // NOSONAR — 1회성 크롤러, 입력 길이 제한 있음
  if (!stripped) return [null];
  const parts = stripped.split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean); // NOSONAR — 동일
  return parts.length > 0 ? parts : [null];
}

function parseRows(windows) {
  const rows = [];
  for (const w of windows) {
    for (const m of w.matchAll(ROW_REGEX)) {
      const fromLine = normalizeLineLabel(m[1]);
      if (!fromLine) continue;
      const toLineLabels = splitToLines(m[4]);
      const fromLoop = m[2] ?? null;
      const toLoop = m[5] ?? null;
      const fromTerminals = extractTerminals(m[3]);
      const toTerminals = extractTerminals(m[6]);
      // toLine × fromTerminal × toTerminal 모두 펼침. 정의되지 않은 노선 라벨은 row drop.
      for (const toLabel of toLineLabels) {
        const toLine = normalizeLineLabel(toLabel);
        if (!toLine || toLine === fromLine) continue;
        for (const fromTerminal of fromTerminals) {
          for (const toTerminal of toTerminals) {
            rows.push({
              fromLine,
              toLine,
              ...(fromLoop && { fromLoop }),
              ...(toLoop && { toLoop }),
              ...(fromTerminal && { fromTerminal }),
              ...(toTerminal && { toTerminal }),
              doorNumber: m[7],
            });
          }
        }
      }
    }
  }
  return rows;
}

// 한 역 안에서 동일한 (fromLine, toLine, fromLoop, fromTerminal, toLoop, toTerminal) 조합이
// 중복 매칭되면 첫 매치만 유지. toTerminal 같은 도착방면 키가 누락되면 도어가 다른 케이스가
// 합쳐져 잘못된 결과가 나오므로 모두 키에 포함.
function dedupe(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const key = [
      r.fromLine,
      r.toLine,
      r.fromLoop ?? '',
      r.fromTerminal ?? '',
      r.toLoop ?? '',
      r.toTerminal ?? '',
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

async function processStation(stationName) {
  const page = await fetchPage(stationName);
  if (!page) return { status: 'no_page', stationName };
  const plain = htmlToPlainText(page.html);
  const windows = extractWindows(plain);
  if (windows.length === 0) return { status: 'no_window', stationName, url: page.url };
  const rows = dedupe(parseRows(windows));
  if (rows.length === 0) return { status: 'no_match', stationName, url: page.url, windowCount: windows.length };
  return { status: 'ok', stationName, rows, windowCount: windows.length };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// stations.json에서 같은 name으로 2개 이상 line이 등록된 역만 환승역으로 간주.
function collectTransferStationNames() {
  const counts = new Map();
  for (const s of STATIONS) counts.set(s.name, (counts.get(s.name) ?? 0) + 1);
  return [...counts.entries()].filter(([, n]) => n >= 2).map(([name]) => name);
}

async function runInspect() {
  const r = await processStation(INSPECT);
  if (r.status === 'no_page') {
    console.error(`[fetch-transfer-exit] inspect: 페이지 fetch 실패`);
    process.exit(1);
  }
  const page = await fetchPage(INSPECT);
  const plain = htmlToPlainText(page.html);
  const windows = extractWindows(plain);
  const payload = {
    url: page.url,
    plainLength: plain.length,
    windowCount: windows.length,
    windowsPreview: windows.map((w) => w.slice(0, 400)),
    rows: r.rows ?? [],
  };
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

async function runBatch() {
  const all = collectTransferStationNames();
  const targets = ONLY ? all.filter((n) => ONLY.includes(n)) : all;
  console.log(`[fetch-transfer-exit] targets=${targets.length} (전체 환승역=${all.length})`);

  const result = {};
  const counters = { ok: 0, noWindow: 0, noMatch: 0, noPage: 0 };
  const failed = [];

  for (let i = 0; i < targets.length; i++) {
    const name = targets[i];
    try {
      const r = await processStation(name);
      if (r.status === 'ok') {
        result[name] = r.rows;
        counters.ok += 1;
      } else if (r.status === 'no_window') {
        counters.noWindow += 1;
        failed.push(`${name} (no_window)`);
      } else if (r.status === 'no_match') {
        counters.noMatch += 1;
        failed.push(`${name} (no_match, windows=${r.windowCount})`);
      } else {
        counters.noPage += 1;
        failed.push(`${name} (no_page)`);
      }
    } catch (e) {
      failed.push(`${name} (error: ${e.message})`);
    }
    if (i < targets.length - 1) await sleep(SLEEP_MS);
    if ((i + 1) % 20 === 0) {
      console.log(`[fetch-transfer-exit] progress ${i + 1}/${targets.length} ok=${counters.ok}`);
    }
  }

  return { result, counters, failed };
}

async function main() {
  if (INSPECT) {
    await runInspect();
    return;
  }
  const { result, counters, failed } = await runBatch();
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n');
  console.log(
    `[fetch-transfer-exit] ok=${counters.ok} noWindow=${counters.noWindow} noMatch=${counters.noMatch} noPage=${counters.noPage}`,
  );
  if (failed.length > 0) {
    const preview = failed.slice(0, 30);
    console.log(`[fetch-transfer-exit] failed (${failed.length}, first 30):\n  ` + preview.join('\n  '));
  }
  console.log(`[fetch-transfer-exit] wrote ${OUT}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  htmlToPlainText,
  extractWindows,
  parseRows,
  dedupe,
  normalizeLineLabel,
  extractTerminals,
  collectTransferStationNames,
  ROW_REGEX,
};
