#!/usr/bin/env node
/**
 * 환승역 실제 소요시간 데이터 생성.
 *
 * 입력: scripts/서울교통공사_환승역거리 소요시간 정보_20250331.csv (UTF-8)
 *   출처: 공공데이터포털 15044419 https://www.data.go.kr/data/15044419/fileData.do
 *   서울교통공사가 보행속도 1.2 m/s 기준으로 측정한 145개 환승역 환승거리/소요시간.
 *
 * 출력: src/data/transferTimes.json
 *   키 = `${fromLine}|${toLine}|${정규화된 환승역명}` (양방향 모두 등록)
 *   값 = 초 단위 정수.
 *
 * stationRoute.ts의 getTransferSeconds()가 이 lookup을 사용한다.
 * 미매칭 키는 fallback 180초(3분).
 */
const fs = require('fs');
const path = require('path');
// 정규화 SSOT — stationRoute.ts와 동일 로직 보장.
const { normalizeStationName } = require('../src/shared/utils/normalizeStationName');
// 별칭 SSOT — 노선별 공식 표기 차이(예: "이수" ↔ "총신대입구")를 흡수.
const { applyStationAlias } = require('../src/data/stationAliases');

const CSV_PATH = path.join(
  __dirname,
  '서울교통공사_환승역거리 소요시간 정보_20250331.csv',
);
const STATIONS_PATH = path.join(__dirname, '..', 'src', 'data', 'stations.json');
const OUT_PATH = path.join(__dirname, '..', 'src', 'data', 'transferTimes.json');

// CSV의 환승노선 한글명 → stations.json line 키
const LINE_MAP = {
  '1호선': '1',
  '2호선': '2',
  '3호선': '3',
  '4호선': '4',
  '5호선': '5',
  '6호선': '6',
  '7호선': '7',
  '8호선': '8',
  '9호선': '9',
  공항철도: 'airport',
  경의중앙선: 'gyeongui',
  수인분당선: 'bundang',
  신분당선: 'sinbundang',
};

function parseHmToSeconds(hm) {
  const [mm, ss] = hm.trim().split(':').map(Number);
  return mm * 60 + ss;
}

// CSV cell 둘러싼 따옴표 제거 — slim CSV(#1481)는 모든 값이 `"..."`로 quoted.
function stripQuote(s) {
  return typeof s === 'string' ? s.replace(/^"|"$/g, '').trim() : '';
}

function main() {
  const csv = fs.readFileSync(CSV_PATH, 'utf-8').replace(/^﻿/, '');
  const lines = csv.split(/\r?\n/u).filter(Boolean);
  if (lines.length === 0) {
    console.error('CSV empty');
    return;
  }
  // 첫 줄 header에서 컬럼 인덱스 lookup.
  // slim CSV (#1481, 4 col): 호선/환승역명/환승노선/환승소요시간.
  // 원본 CSV (6 col): 연번/호선/환승역명/환승노선/환승거리/환승소요시간.
  const header = lines[0].split(',').map(stripQuote);
  const idxLine = header.indexOf('호선');
  const idxStation = header.indexOf('환승역명');
  const idxTransferLine = header.indexOf('환승노선');
  const idxTime = header.indexOf('환승소요시간');
  if (idxLine === -1 || idxStation === -1 || idxTransferLine === -1 || idxTime === -1) {
    console.error(`header mismatch: ${header.join(',')}`);
    return;
  }
  const minCols = Math.max(idxLine, idxStation, idxTransferLine, idxTime) + 1;
  const rows = lines.slice(1);
  const stations = JSON.parse(fs.readFileSync(STATIONS_PATH, 'utf-8'));

  // validStationKey: 역명 조회 시 정규화 후 별칭까지 적용한 canonical 표기로 등록.
  // 예) 7호선 "이수" → normalizeStationName → applyStationAlias → "총신대입구"
  // 이렇게 하면 CSV에 "총신대입구"로 기재된 7호선 측 검증이 통과된다.
  const validStationKey = new Set();
  for (const s of stations) {
    const canonical = applyStationAlias(normalizeStationName(s.name));
    validStationKey.add(`${s.line}|${canonical}`);
  }

  const out = {};
  const stats = { ok: 0, droppedLine: 0, droppedStation: 0 };
  const droppedSamples = [];

  for (const ln of rows) {
    const parts = ln.split(',').map(stripQuote);
    if (parts.length < minCols) continue;
    const csvFromLine = parts[idxLine];
    const station = parts[idxStation];
    const transferLineKo = parts[idxTransferLine];
    const hm = parts[idxTime];

    // CSV 현재 스냅샷은 fromLine을 숫자(1~8)로만 발행하지만, 향후 공항철도/신분당선 등
    // 한글 노선명으로 바뀔 가능성 대비 양쪽 모두 LINE_MAP을 통과시킨다.
    const fromLine = LINE_MAP[csvFromLine] ?? csvFromLine;
    const toLine = LINE_MAP[transferLineKo];
    if (!toLine) {
      stats.droppedLine++;
      continue;
    }
    const name = applyStationAlias(normalizeStationName(station));
    const fromValid = validStationKey.has(`${fromLine}|${name}`);
    const toValid = validStationKey.has(`${toLine}|${name}`);
    if (!fromValid || !toValid) {
      stats.droppedStation++;
      if (droppedSamples.length < 10) {
        droppedSamples.push(`${fromLine}↔${toLine}|${name}`);
      }
      continue;
    }
    const seconds = parseHmToSeconds(hm);
    const key1 = `${fromLine}|${toLine}|${name}`;
    const key2 = `${toLine}|${fromLine}|${name}`;
    out[key1] = seconds;
    if (out[key2] === undefined) out[key2] = seconds;
    stats.ok++;
  }

  // 키에 한글이 섞여 있어 로케일 기반 정렬로 안정적 출력 보장 (sonar S2871).
  const sorted = Object.keys(out)
    .sort((a, b) => a.localeCompare(b))
    .reduce((acc, k) => {
      acc[k] = out[k];
      return acc;
    }, {});

  fs.writeFileSync(OUT_PATH, JSON.stringify(sorted, null, 2) + '\n');

  console.log(`총 row: ${rows.length}`);
  console.log(`매칭 성공: ${stats.ok}`);
  console.log(`타겟 노선 미지원 폐기: ${stats.droppedLine}`);
  console.log(`stations.json 매칭 실패 폐기: ${stats.droppedStation}`);
  if (droppedSamples.length) {
    console.log(`매칭 실패 샘플:`, droppedSamples);
  }
  console.log(`출력 키 수(양방향): ${Object.keys(sorted).length}`);
  console.log(`출력 경로: ${OUT_PATH}`);
}

main();
