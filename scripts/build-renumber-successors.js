#!/usr/bin/env node
/**
 * #3158 — 2호선 성수 열차 번호 변경(renumber) 후속표 오프라인 빌드.
 *
 * 서울 열린데이터광장 OA-22750 열차시간표(`getTrainSch`)에서 2호선 4조합(내선/외선 x 평일/주말)을
 * 전량 받아, 성수에서 종착하는 열차(E)와 성수에서 시발하는 열차(S)를 짝지어
 * `backend/alarm-worker/src/data/line2RenumberSuccessors.json`을 생성한다.
 * 런타임에는 이 JSON만 읽는다(키 노출·ATS·Worker 포트 8088 문제 없음).
 *
 * 짝짓기 규칙(리서치 tasks/research-2026-10-21-seoul-shtrmpath.md §1.2): 각 S에 "직전의 미배정 E(<=300초)"를
 * 짝짓는다. 단순 FIFO는 차고지 입출고 구간에서 오배정한다. 실시간 (2|3)ddd <-> 시간표 2ddd(끝 3자리 보존).
 * 키는 정규화 열차번호(끝 3자리). 같은 번호가 하루에 여러 번 성수에서 종착할 수 있어 값은 배열.
 *
 * ## 사용법
 *   SEOUL_OPENAPI_KEY=xxxx node scripts/build-renumber-successors.js
 *   # 원자료 캐시 재사용(재다운로드 없이 재생성): --cache <raw.json>  (없으면 받아서 저장)
 *   SEOUL_OPENAPI_KEY=xxxx node scripts/build-renumber-successors.js --cache /tmp/ts_l2.json
 *
 * 키는 환경변수로만 받는다(하드코딩·로그 출력 금지). 평일/주말 외 공휴일 구분은 API에 없다.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// 서울 열린데이터광장 OpenAPI는 포트 8088이 평문 http 전용이다(https 시도: 8088은 ERR_SSL_WRONG_VERSION_NUMBER,
// 443은 연결 타임아웃 — 2026-10-21 확인). 이 스크립트는 개발자 PC에서 오프라인 빌드용으로만 실행되며
// 런타임/앱 번들에는 포함되지 않는다.
const API_HOST = 'http://openapi.seoul.go.kr:8088'; // NOSONAR — https 미제공(위 주석), 오프라인 빌드 전용
const LINE_NAME = '2호선';
const LINE_ID = '2';
const RENUMBER_STATION = '성수';
const DIRECTIONS = ['내선', '외선'];
/** API 요일 구분 -> JSON 테이블 키. */
const DAY_TYPES = { 평일: 'weekday', 주말: 'weekend' };
const PAGE_SIZE = 1000;
/** 종착->시발 최대 허용 간격(초). 초과분은 차고지 입출고로 보고 짝짓지 않는다. */
const MAX_PAIR_GAP_SEC = 300;
/** 통상 간격 상한(초) — 초과 짝은 경고만 출력(리서치: 전부 <=120초). */
const EXPECTED_GAP_SEC = 120;
/** 이 시각(시) 미만은 익일(자정 넘김) 운행으로 본다. */
const SERVICE_DAY_WRAP_HOUR = 3;
const SECONDS_PER_DAY = 86400;
/** 본선 번호 prefix — 지선(1xxx/5xxx)은 제외. */
const MAIN_LINE_PREFIX = '2';
/** 엔트리 튜플 `[next, dir, endSec, startSec]` — 용량 절감(메타 `entryFields`에도 기록). */
const ENTRY_FIELDS = ['next', 'dir', 'endSec', 'startSec'];
const ENTRY_END_SEC_INDEX = ENTRY_FIELDS.indexOf('endSec');
const OUTPUT_PATH = path.join(__dirname, '..', 'backend', 'alarm-worker', 'src', 'data', 'line2RenumberSuccessors.json');

function parseArgs(argv) {
  const idx = argv.indexOf('--cache');
  return { cachePath: idx >= 0 ? argv[idx + 1] : null };
}

function toSeconds(hhmmss) {
  const [h, m, s] = hhmmss.split(':').map(Number);
  const sec = h * 3600 + m * 60 + s;
  return sec < SERVICE_DAY_WRAP_HOUR * 3600 ? sec + SECONDS_PER_DAY : sec;
}

function normalizeTrainNo(trainno) {
  return trainno.slice(-3);
}

async function fetchPage(key, start, end, direction, dayType) {
  const segs = ['', 'N', direction, dayType, LINE_NAME].map((s) => (s === '' ? '%20' : encodeURIComponent(s)));
  const url = `${API_HOST}/${key}/json/getTrainSch/${start}/${end}/${segs.join('/')}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`getTrainSch HTTP ${res.status} (${direction}/${dayType} ${start}-${end})`);
  const json = await res.json();
  const body = json?.response?.body;
  if (!body?.items?.item) throw new Error(`getTrainSch 응답 형식 오류 (${direction}/${dayType} ${start}-${end})`);
  return { items: body.items.item, totalCount: body.totalCount };
}

async function fetchAllRows(key) {
  const raw = {};
  for (const direction of DIRECTIONS) {
    for (const dayType of Object.keys(DAY_TYPES)) {
      const rows = [];
      for (let page = 1; ; page += 1) {
        const { items, totalCount } = await fetchPage(key, (page - 1) * PAGE_SIZE + 1, page * PAGE_SIZE, direction, dayType);
        rows.push(...items);
        if (rows.length >= totalCount || items.length === 0) break;
      }
      raw[`${direction}|${dayType}`] = rows;
      console.error(`fetched ${direction}/${dayType}: ${rows.length} rows`);
    }
  }
  return raw;
}

/** 한 조합의 행에서 성수 종착(ends)·시발(starts) 본선 열차를 뽑는다. */
function extractTerminals(rows) {
  const byTrain = new Map();
  for (const row of rows) {
    if (!byTrain.has(row.trainno)) byTrain.set(row.trainno, []);
    byTrain.get(row.trainno).push(row);
  }
  const ends = [];
  const starts = [];
  for (const [trainno, trainRows] of byTrain) {
    if (!trainno.startsWith(MAIN_LINE_PREFIX)) continue;
    const timed = trainRows
      .map((r) => ({ r, sec: toSeconds(r.trainDptreTm || r.trainArvlTm) }))
      .sort((a, b) => a.sec - b.sec);
    const first = timed[0];
    const last = timed[timed.length - 1];
    if (first.r.stnNm === RENUMBER_STATION && first.r.trainArvlTm == null) starts.push({ sec: first.sec, trainno });
    if (last.r.stnNm === RENUMBER_STATION && last.r.trainDptreTm == null) ends.push({ sec: last.sec, trainno });
  }
  return { ends, starts };
}

/** 각 시발(S)에 직전의 미배정 종착(E, <=MAX_PAIR_GAP_SEC)을 짝짓는다. */
function pairTerminals({ ends, starts }) {
  const events = [
    ...ends.map((e) => ({ ...e, kind: 0 })),
    ...starts.map((s) => ({ ...s, kind: 1 })),
  ].sort((a, b) => a.sec - b.sec || a.kind - b.kind);
  const pending = [];
  const pairs = [];
  let depotStarts = 0;
  for (const ev of events) {
    if (ev.kind === 0) {
      pending.push(ev);
      continue;
    }
    const candidates = pending.filter((e) => ev.sec - e.sec >= 0 && ev.sec - e.sec <= MAX_PAIR_GAP_SEC);
    if (candidates.length === 0) {
      depotStarts += 1;
      continue;
    }
    const end = candidates[candidates.length - 1];
    pending.splice(pending.indexOf(end), 1);
    pairs.push({ from: end.trainno, to: ev.trainno, endSec: end.sec, startSec: ev.sec });
  }
  return { pairs, depotStarts, unmatchedEnds: pending.length };
}

function buildTables(raw) {
  const tables = {};
  const stats = [];
  for (const dayTypeKey of Object.values(DAY_TYPES)) tables[dayTypeKey] = {};
  for (const [combo, rows] of Object.entries(raw)) {
    const [direction, dayType] = combo.split('|');
    const table = tables[DAY_TYPES[dayType]];
    const { pairs, depotStarts, unmatchedEnds } = pairTerminals(extractTerminals(rows));
    for (const { from, to, endSec, startSec } of pairs) {
      const key = normalizeTrainNo(from);
      (table[key] ??= []).push([normalizeTrainNo(to), direction, endSec, startSec]);
    }
    const overGap = pairs.filter((p) => p.startSec - p.endSec > EXPECTED_GAP_SEC).length;
    stats.push(`${combo}: pairs=${pairs.length} depotStarts=${depotStarts} unmatchedEnds=${unmatchedEnds} gap>${EXPECTED_GAP_SEC}s=${overGap}`);
  }
  for (const table of Object.values(tables)) {
    for (const key of Object.keys(table)) table[key].sort((a, b) => a[ENTRY_END_SEC_INDEX] - b[ENTRY_END_SEC_INDEX]);
  }
  const sorted = {};
  for (const [dayTypeKey, table] of Object.entries(tables)) {
    sorted[dayTypeKey] = Object.fromEntries(Object.keys(table).sort((a, b) => a.localeCompare(b)).map((k) => [k, table[k]]));
  }
  return { tables: sorted, stats };
}

async function main() {
  const { cachePath } = parseArgs(process.argv.slice(2));
  let raw;
  if (cachePath && fs.existsSync(cachePath)) {
    raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } else {
    const key = process.env.SEOUL_OPENAPI_KEY;
    if (!key) throw new Error('SEOUL_OPENAPI_KEY 환경변수가 필요합니다 (OA-22750 인증키).');
    raw = await fetchAllRows(key);
    if (cachePath) fs.writeFileSync(cachePath, JSON.stringify(raw));
  }
  const baseDates = new Set(Object.values(raw).flat().map((r) => r.crtrYmd));
  const temporary = Object.values(raw).flat().filter((r) => r.tmprTmtblYn !== 'N').length;
  if (baseDates.size !== 1) throw new Error(`시간표 기준일이 단일하지 않습니다: ${[...baseDates].join(',')}`);
  const { tables, stats } = buildTables(raw);
  const out = {
    meta: {
      line: LINE_ID,
      renumberStation: RENUMBER_STATION,
      source: 'OA-22750 getTrainSch (schInclYn=N, 정적 시간표)',
      timetableBaseDate: [...baseDates][0],
      temporaryTimetableRows: temporary,
      pairing: `성수 시발(S)마다 직전 미배정 종착(E, <=${MAX_PAIR_GAP_SEC}s) 짝짓기, 키=끝 3자리, 실시간 prefix(2|3) 보존`,
      entryFields: ENTRY_FIELDS,
      dayTypes: DAY_TYPES,
    },
    tables,
  };
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(out)}\n`);
  console.error(stats.join('\n'));
  console.error(`wrote ${OUTPUT_PATH} (${fs.statSync(OUTPUT_PATH).size} bytes), baseDate=${out.meta.timetableBaseDate}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
