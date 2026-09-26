#!/usr/bin/env node
/**
 * 환승역 실제 소요시간 데이터 생성 v2 — 호차/문 단위 신규 CSV 적용.
 *
 * 입력: scripts/서울교통공사_서울 도시철도 환승정보_20260303.csv (UTF-8 BOM)
 *   출처: 공공데이터포털 — 서울교통공사 도시철도 환승정보(호차/문 단위) 1024 row.
 *   start호선 명시 + 종료호선은 종료 코드(0427 등) prefix → 호선 매핑으로 추론.
 *
 * 출력: src/data/transferTimes.json
 *   키 = `${fromLine}|${toLine}|${정규화된 환승역명}` (양방향 모두 등록)
 *   값 = 호선쌍별 평균 초(반올림).
 *
 * 정렬: sonar S2871 호환 — `localeCompare` 안정 정렬.
 *
 * 호선 normalize: stations.json의 line 키와 일치시킨다.
 *   1~9호선 → '1'~'9'
 *   공항철도 → 'airport'
 *   경의(중앙)선 → 'gyeongui'
 *   수인분당선 → 'bundang'
 *   신분당선 → 'sinbundang'
 *   경춘선 → 'gyeongchun'
 *   서해선 → 'seohae'
 *   인천선/인천1 → 'incheon'
 *   인천2 → 'incheon2'
 *   * stations.json에 line 키가 없는 호선(경강/우이신설/의정부/신림 등)은 폐기 + 통계 리포트.
 */
const fs = require('fs');
const path = require('path');
const { normalizeStationName } = require('../src/shared/utils/normalizeStationName');
const { applyStationAlias } = require('../src/data/stationAliases');

const CSV_PATH = path.join(
  __dirname,
  '서울교통공사_서울 도시철도 환승정보_20260303.csv',
);
const STATIONS_PATH = path.join(__dirname, '..', 'src', 'data', 'stations.json');
const OUT_PATH = path.join(__dirname, '..', 'src', 'data', 'transferTimes.json');
// diff baseline 은 환경변수로 외부 지정 가능 (PR diff 박제용). 기본은 현재 JSON.
const PREV_JSON_FOR_DIFF = process.env.TRANSFER_TIMES_PREV || OUT_PATH;

const LINE_NAME_MAP = {
  1: '1',
  2: '2',
  3: '3',
  4: '4',
  5: '5',
  6: '6',
  7: '7',
  8: '8',
  9: '9',
  공항철도: 'airport',
  경의선: 'gyeongui',
  경의중앙선: 'gyeongui',
  수인분당선: 'bundang',
  신분당선: 'sinbundang',
  경춘선: 'gyeongchun',
  서해선: 'seohae',
  인천선: 'incheon',
  인천1: 'incheon',
  인천2: 'incheon2',
};

function normalizeLine(raw) {
  const trimmed = String(raw).trim().replace(/^\d호선$/, (m) => m[0]);
  if (LINE_NAME_MAP[trimmed] !== undefined) return LINE_NAME_MAP[trimmed];
  if (/^[1-9]$/.test(trimmed)) return trimmed;
  return null;
}

function parseMmSsToSeconds(mmss) {
  const [mm, ss] = mmss.trim().split(':').map(Number);
  if (Number.isNaN(mm) || Number.isNaN(ss)) return null;
  return mm * 60 + ss;
}

// 따옴표/BOM 제거 + 컬럼 분리. RFC4180 풀-파서는 과도하므로 본 CSV 구조(따옴표 안 컴마 없음)에 맞춰 단순화.
function splitCsvLine(line) {
  return line.split(',').map((v) => v.replace(/^"|"$/g, '').trim());
}

function buildEndCodePrefixToLine(rows, idxStartCode = 2, idxStartLine = 3) {
  // 학습: start 코드 prefix(2자리) → start 호선(normalize) 단일이면 채택.
  // 종료 코드 prefix도 동일 매핑을 따른다고 가정 (서울 도시철도 표준 station code 규칙).
  // 원본 CSV 전용 — slim CSV(#1481)에는 환승종료 호선이 이미 명시되어 prefix 학습 X.
  const prefixToLines = {};
  for (const row of rows) {
    const startCode = row[idxStartCode];
    const startLineRaw = row[idxStartLine];
    const line = normalizeLine(startLineRaw);
    if (!line || !startCode || startCode.length < 2) continue;
    const prefix = startCode.slice(0, 2);
    (prefixToLines[prefix] = prefixToLines[prefix] || new Set()).add(line);
  }
  // map[prefix] = Set<line> — 단일/다중 구분 없이 후보 집합을 유지하고 resolve 시 station으로 좁힌다.
  const map = {};
  for (const [prefix, set] of Object.entries(prefixToLines)) {
    map[prefix] = set;
  }
  return { map };
}

function resolveEndLine(endCode, station, startLine, prefixMap, stationLines) {
  if (!endCode || endCode.length < 2) return null;
  const prefix = endCode.slice(0, 2);
  const prefixCandidates = prefixMap[prefix];
  const stationCandidates = stationLines[station] || new Set();

  // 1순위: prefix ∩ station 후보 (start 제외)
  if (prefixCandidates) {
    const intersect = [...prefixCandidates].filter(
      (l) => stationCandidates.has(l) && l !== startLine,
    );
    if (intersect.length === 1) return intersect[0];
    // intersect 다중인 경우 모호 — 결정 불가
    if (intersect.length > 1) return null;
  }

  // 2순위: prefix 매핑이 없으면 station에서 start 제외 단일이면 채택
  const stationOnly = [...stationCandidates].filter((l) => l !== startLine);
  if (stationOnly.length === 1) return stationOnly[0];
  return null;
}

function main() {
  const raw = fs.readFileSync(CSV_PATH, 'utf-8').replace(/^﻿/, '');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) {
    console.error('CSV empty');
    return;
  }
  // 첫 줄 header에서 컬럼 인덱스 lookup. #1481 slim(5 col: 환승시작 호선/환승시작역/
  // 환승종료 호선/환승종료역/소요시간) + 원본(12 col: 고유번호/환승시작역/환승시작 코드/
  // 환승시작 호선/.../환승종료역(코드)/.../소요시간) 모두 동일 코드로 처리.
  const header = splitCsvLine(lines[0]);
  const idxStartLine = header.indexOf('환승시작 호선');
  const idxStartStation = header.indexOf('환승시작역');
  const idxStartCode = header.indexOf('환승시작 코드');
  const idxEndLine = header.indexOf('환승종료 호선');
  const idxEndStationOrCode = header.indexOf('환승종료역');
  const idxTime = header.indexOf('소요시간');
  // slim 본은 endLine 컬럼 명시(`환승종료 호선` 존재) → prefix 학습 불필요.
  // 원본은 endLine 없음 → endCode prefix 학습.
  const hasEndLine = idxEndLine !== -1;
  if (
    idxStartLine === -1 ||
    idxStartStation === -1 ||
    idxEndStationOrCode === -1 ||
    idxTime === -1
  ) {
    console.error(`header mismatch: ${header.join(',')}`);
    return;
  }
  const rows = lines.slice(1).map(splitCsvLine);
  const stations = JSON.parse(fs.readFileSync(STATIONS_PATH, 'utf-8'));

  // 환승역명별 사용 line 목록 (canonical name 기준)
  const stationLines = {};
  for (const s of stations) {
    const canonical = applyStationAlias(normalizeStationName(s.name));
    (stationLines[canonical] = stationLines[canonical] || new Set()).add(s.line);
  }

  // slim 본은 prefix 학습 불필요. 원본만 endCode prefix → line 학습.
  const prefixMap = hasEndLine
    ? {}
    : buildEndCodePrefixToLine(rows, idxStartCode, idxStartLine).map;
  const minCols = Math.max(
    idxStartLine,
    idxStartStation,
    idxEndStationOrCode,
    idxTime,
    hasEndLine ? idxEndLine : (idxStartCode !== -1 ? idxStartCode : 0),
  ) + 1;

  // (fromLine, toLine, station) → [seconds...]
  const buckets = new Map();
  const stats = {
    rowsTotal: rows.length,
    droppedStartLine: 0,
    droppedEndLine: 0,
    droppedStation: 0,
    droppedTime: 0,
    accepted: 0,
  };
  const droppedSamples = [];

  for (const row of rows) {
    if (row.length < minCols) continue;
    const station = applyStationAlias(normalizeStationName(row[idxStartStation]));
    const startLine = normalizeLine(row[idxStartLine]);
    if (!startLine) {
      stats.droppedStartLine++;
      continue;
    }
    const endLine = hasEndLine
      ? normalizeLine(row[idxEndLine])
      : resolveEndLine(row[idxEndStationOrCode], station, startLine, prefixMap, stationLines);
    if (!endLine) {
      stats.droppedEndLine++;
      if (droppedSamples.length < 10) {
        droppedSamples.push(
          `endLine? ${station} start=${startLine} endRaw=${row[idxEndStationOrCode]}`,
        );
      }
      continue;
    }
    if (startLine === endLine) {
      // 동일 호선 환승은 의미 없음
      stats.droppedStation++;
      continue;
    }
    const lines = stationLines[station];
    if (!lines || !lines.has(startLine) || !lines.has(endLine)) {
      stats.droppedStation++;
      if (droppedSamples.length < 10) {
        droppedSamples.push(
          `stationMismatch ${station} ${startLine}↔${endLine} (has=${[...(lines || [])].join('/')})`,
        );
      }
      continue;
    }
    const seconds = parseMmSsToSeconds(row[idxTime]);
    if (seconds === null || seconds <= 0) {
      stats.droppedTime++;
      continue;
    }
    const key = `${startLine}|${endLine}|${station}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(seconds);
    stats.accepted++;
  }

  // baseline merge: 기존 transferTimes의 entry는 보존하고, CSV에서 얻은 정밀값으로 overwrite.
  // 이렇게 하면 CSV에서 endLine 추론 실패한 호선쌍(예: 청량리 1↔gyeongui)도 v1 데이터로 유지되어 회귀하지 않는다.
  const out = {};
  let baseline = {};
  if (fs.existsSync(PREV_JSON_FOR_DIFF)) {
    baseline = JSON.parse(fs.readFileSync(PREV_JSON_FOR_DIFF, 'utf-8'));
    Object.assign(out, baseline);
  }
  for (const [key, arr] of buckets.entries()) {
    const avg = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
    out[key] = avg;
    const [from, to, station] = key.split('|');
    const reverseKey = `${to}|${from}|${station}`;
    // 양방향이 모두 CSV에 있는 경우 각자 평균을 우선, 한쪽만 있으면 다른쪽도 동일값으로 채움.
    if (!buckets.has(reverseKey) && out[reverseKey] === undefined) {
      out[reverseKey] = avg;
    }
  }

  // 정렬
  const sorted = Object.keys(out)
    .sort((a, b) => a.localeCompare(b))
    .reduce((acc, k) => {
      acc[k] = out[k];
      return acc;
    }, {});

  // 기존과 diff (사용자 검수 리포트) — baseline 이미 위에서 로드.
  const prev = baseline;
  const changes = [];
  const newKeys = [];
  const goneKeys = [];
  for (const k of Object.keys(sorted)) {
    if (prev[k] === undefined) {
      newKeys.push(k);
    } else if (Math.abs(prev[k] - sorted[k]) > 30) {
      changes.push({ key: k, prev: prev[k], next: sorted[k], delta: sorted[k] - prev[k] });
    }
  }
  for (const k of Object.keys(prev)) {
    if (sorted[k] === undefined) goneKeys.push(k);
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(sorted, null, 2) + '\n');

  console.log(`총 CSV row: ${stats.rowsTotal}`);
  console.log(`accept: ${stats.accepted}`);
  console.log(`drop startLine 미지원: ${stats.droppedStartLine}`);
  console.log(`drop endLine 추론 실패: ${stats.droppedEndLine}`);
  console.log(`drop station 매칭 실패: ${stats.droppedStation}`);
  console.log(`drop time parse 실패: ${stats.droppedTime}`);
  console.log(`출력 키 수(양방향): ${Object.keys(sorted).length}`);
  console.log(`이전 entry: ${Object.keys(prev).length}`);
  console.log(`신규 entry: ${newKeys.length}`);
  console.log(`삭제 entry: ${goneKeys.length}`);
  console.log(`±30s 초과 변동: ${changes.length}`);
  if (droppedSamples.length) {
    console.log(`drop 샘플:`, droppedSamples);
  }
  if (changes.length) {
    console.log(`\n검수 리스트 (±30s 초과):`);
    for (const c of changes.slice(0, 30)) {
      console.log(`  ${c.key}: ${c.prev}s → ${c.next}s (Δ${c.delta >= 0 ? '+' : ''}${c.delta})`);
    }
  }
  if (newKeys.length) {
    console.log(`\n신규 호선쌍 샘플:`);
    for (const k of newKeys.slice(0, 20)) console.log(`  ${k}: ${sorted[k]}s`);
  }
  if (goneKeys.length) {
    console.log(`\n삭제 호선쌍 샘플:`);
    for (const k of goneKeys.slice(0, 20)) console.log(`  ${k}: ${prev[k]}s`);
  }
  // stations.json 기준 잔여 누락 호선쌍 리포트 (한방향 기준 + 양방향 누락 모두 포함)
  const missingPairs = [];
  for (const [station, lineSet] of Object.entries(stationLines)) {
    const lines = [...lineSet];
    if (lines.length < 2) continue;
    for (let i = 0; i < lines.length; i++) {
      for (let j = 0; j < lines.length; j++) {
        if (i === j) continue;
        const key = `${lines[i]}|${lines[j]}|${station}`;
        if (sorted[key] === undefined) missingPairs.push(key);
      }
    }
  }
  console.log(`\nstations.json 기준 미커버 호선쌍: ${missingPairs.length}`);
  if (missingPairs.length) {
    for (const k of missingPairs.slice(0, 30)) console.log(`  ${k}`);
  }
  console.log(`\n출력 경로: ${OUT_PATH}`);
}

main();
