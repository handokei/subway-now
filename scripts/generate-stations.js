#!/usr/bin/env node
/**
 * CSV → stations.json 변환 스크립트
 * 공식 CSV 데이터에서 전체 1~9호선 역 좌표를 생성합니다.
 *
 * 데이터 소스:
 * - 1~8호선: 서울교통공사_1-8호선 역사 좌표(위경도) 정보
 * - 9호선:   서울시 역사마스터 정보 (9호선 + 9호선 연장)
 *
 * 사용법: node scripts/generate-stations.js
 */

const iconv = require('iconv-lite');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CSV_1_8 = path.join(
  ROOT,
  'subway',
  '서울교통공사_1-8호선 역사 좌표(위경도) 정보_20250814.csv',
);
const CSV_MASTER = path.join(ROOT, 'subway', '서울시 역사마스터 정보.csv');
const STATIONS_JSON_PATH = path.join(ROOT, 'src', 'data', 'stations.json');

const LINE_COLORS = {
  '1': '#0052A4',
  '2': '#009D3E',
  '3': '#EF7C1C',
  '4': '#00A2D1',
  '5': '#996CAC',
  '6': '#CD7C2F',
  '7': '#747F00',
  '8': '#E6186C',
  '9': '#BDB092',
};

function parseCsvEucKr(filePath) {
  const buf = fs.readFileSync(filePath);
  const utf8 = iconv.decode(buf, 'euc-kr');
  const lines = utf8.trim().split('\n');
  const headers = lines[0].split(',').map((h) => h.trim().replace(/"/g, ''));
  return lines.slice(1).map((line) => {
    const values = line.split(',').map((v) => v.trim().replace(/"/g, ''));
    return Object.fromEntries(headers.map((h, i) => [h, values[i]]));
  });
}

function buildLine1to8(csvPath) {
  const rows = parseCsvEucKr(csvPath);
  console.log(`1-8호선 CSV: ${rows.length}개 행`);

  const grouped = {};
  for (const row of rows) {
    const line = row['호선'];
    if (!grouped[line]) grouped[line] = [];
    grouped[line].push(row);
  }

  const result = [];
  for (const line of ['1', '2', '3', '4', '5', '6', '7', '8']) {
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
    console.log(`  ${line}호선: ${lineRows.length}개`);
  }
  return result;
}

function buildLine9(csvPath) {
  const rows = parseCsvEucKr(csvPath);
  const line9Rows = rows.filter(
    (r) => r['호선'] === '9호선' || r['호선'] === '9호선(연장)',
  );

  // 역사마스터는 연장→본선 순이므로 역순 정렬 (개화→중앙보훈병원)
  line9Rows.reverse();

  console.log(`9호선 (역사마스터): ${line9Rows.length}개`);

  return line9Rows.map((row, idx) => ({
    id: `9-${String(idx + 1).padStart(3, '0')}`,
    name: row['역사명'],
    line: '9',
    lineColor: LINE_COLORS['9'],
    lat: Number.parseFloat(row['위도']),
    lng: Number.parseFloat(row['경도']),
  }));
}

function main() {
  console.log('stations.json 재생성 시작\n');

  const line1to8 = buildLine1to8(CSV_1_8);
  const line9 = buildLine9(CSV_MASTER);

  const all = [...line1to8, ...line9];
  fs.writeFileSync(
    STATIONS_JSON_PATH,
    JSON.stringify(all, null, 2) + '\n',
    'utf-8',
  );

  console.log(`\n완료: 총 ${all.length}개 역 → ${STATIONS_JSON_PATH}`);
}

main();
