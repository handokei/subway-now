#!/usr/bin/env node
/**
 * CSV → stations.json 변환 스크립트
 * 서울교통공사 1-8호선 좌표 CSV에서 6호선, 8호선 역을 추출하여 stations.json에 추가합니다.
 *
 * 사용법: node scripts/generate-stations.js
 */

const iconv = require('iconv-lite');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CSV_PATH = path.join(
  ROOT,
  'subway',
  '서울교통공사_1-8호선 역사 좌표(위경도) 정보_20250814.csv'
);
const STATIONS_JSON_PATH = path.join(ROOT, 'src', 'data', 'stations.json');

const LINE_COLORS = {
  '6': '#CD7C2F',
  '8': '#E6186C',
};

function parseCsvEucKr(filePath) {
  const buf = fs.readFileSync(filePath);
  const utf8 = iconv.decode(buf, 'euc-kr');
  const lines = utf8.trim().split('\n');
  const headers = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(',').map((v) => v.trim());
    return Object.fromEntries(headers.map((h, i) => [h, values[i]]));
  });
}

function buildStations(rows, lineFilter) {
  const grouped = {};
  for (const row of rows) {
    const line = row['호선'];
    if (!lineFilter.includes(line)) continue;
    if (!grouped[line]) grouped[line] = [];
    grouped[line].push(row);
  }

  const result = [];
  for (const line of lineFilter) {
    const lineRows = grouped[line] || [];
    lineRows.forEach((row, idx) => {
      result.push({
        id: `${line}-${String(idx + 1).padStart(3, '0')}`,
        name: row['역명'],
        line,
        lineColor: LINE_COLORS[line],
        lat: Number.parseFloat(row['위도']),
        lng: Number.parseFloat(row['경도']),
      });
    });
  }
  return result;
}

function main() {
  console.log('CSV 파일 읽는 중...');
  const rows = parseCsvEucKr(CSV_PATH);
  console.log(`총 ${rows.length}개 행 파싱 완료`);

  const newStations = buildStations(rows, ['6', '8']);
  const line6Count = newStations.filter((s) => s.line === '6').length;
  const line8Count = newStations.filter((s) => s.line === '8').length;
  console.log(`추출: 6호선 ${line6Count}개, 8호선 ${line8Count}개`);

  const existing = JSON.parse(fs.readFileSync(STATIONS_JSON_PATH, 'utf-8'));
  console.log(`기존 stations.json: ${existing.length}개 역`);

  // 이미 있는 노선은 추가하지 않음 (중복 방지)
  const existingLines = new Set(existing.map((s) => s.line));
  const toAdd = newStations.filter((s) => !existingLines.has(s.line));

  const merged = [...existing, ...toAdd];
  fs.writeFileSync(STATIONS_JSON_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  console.log(`완료: ${existing.length}개 → ${merged.length}개 역`);
}

main();
