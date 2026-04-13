#!/usr/bin/env node
/**
 * 기존 stations.json에 공항철도/경의중앙선/수인분당선/신분당선 역을 추가합니다.
 * 기존 1~9호선 데이터는 유지하고, 새 노선만 append합니다.
 *
 * 데이터 소스: 서울시 역사마스터 정보 CSV
 *
 * 사용법: node scripts/add-extra-lines.js
 */

const iconv = require('iconv-lite');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CSV_MASTER = path.join(ROOT, 'subway', '서울시 역사마스터 정보.csv');
const STATIONS_JSON_PATH = path.join(ROOT, 'src', 'data', 'stations.json');

const LINE_COLORS = {
  airport: '#4B81BF',
  gyeongui: '#77C4A3',
  bundang: '#F5A200',
  sinbundang: '#D4003B',
};

// 분당선 CSV 순서가 불규칙하므로 올바른 물리적 역 순서를 정의
const BUNDANG_STATION_ORDER = [
  '수원', '매교', '수원시청', '매탄권선', '망포', '영통', '청명',
  '상갈', '기흥', '신갈', '구성', '보정', '죽전', '오리', '미금',
  '정자', '수내', '서현', '이매', '야탑', '모란', '태평', '가천대',
  '수서', '대모산입구', '개포동', '구룡', '도곡', '한티', '선릉',
  '선정릉', '강남구청', '압구정로데오', '서울숲',
];

// 분당선 북단 연장 (서울숲 이후) — CSV에는 분당선으로 분류되지 않아 하드코딩
const BUNDANG_NORTH_EXTENSION = [
  { '역사명': '왕십리', '위도': '37.561827', '경도': '127.038352' },
  { '역사명': '청량리', '위도': '37.580759', '경도': '127.0483' },
];

// 경의중앙선 서울역↔회기 연결 구간 — CSV에서 경원선으로 분류된 역들
const GYEONGUI_BRIDGE_NAMES = [
  '용산', '이촌(국립중앙박물관)', '서빙고', '한남', '옥수', '응봉',
  '왕십리(성동구청)', '청량리(서울시립대입구)', '외대앞',
];

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

function toStation(row, lineKey, idx) {
  return {
    id: `${lineKey}-${String(idx + 1).padStart(3, '0')}`,
    name: row['역사명'],
    line: lineKey,
    lineColor: LINE_COLORS[lineKey],
    lat: Number.parseFloat(row['위도']),
    lng: Number.parseFloat(row['경도']),
  };
}

function main() {
  console.log('기존 stations.json에 추가 노선 추가 시작\n');

  const existing = JSON.parse(fs.readFileSync(STATIONS_JSON_PATH, 'utf-8'));
  // 기존 추가 노선 제거 (재실행 대비)
  const base = existing.filter(
    (s) => !['airport', 'gyeongui', 'bundang', 'sinbundang'].includes(s.line),
  );
  console.log(`기존 역: ${base.length}개 (1~9호선)`);

  const rows = parseCsvEucKr(CSV_MASTER);
  const extra = [];

  // 공항철도: CSV(영종→서울역) → 역순(서울역→인천공항2터미널)
  // 영종역은 검암에서 분기하는 지선이므로 제외
  const airportRows = rows
    .filter((r) => r['호선'] === '공항철도1호선' && r['역사명'] !== '영종')
    .reverse();
  airportRows.forEach((row, idx) => extra.push(toStation(row, 'airport', idx)));
  console.log(`  공항철도: ${airportRows.length}개`);

  // 경의중앙선: 경의중앙선(운천→서울역) + 연결구간(용산→외대앞) + 중앙선(역순: 회기→지평)
  const gyeonguiRows = rows.filter((r) => r['호선'] === '경의중앙선');
  // 서울역↔회기 연결 구간 (경원선/경부선에서 추출)
  const bridgeRows = [];
  for (const name of GYEONGUI_BRIDGE_NAMES) {
    const found = rows.find(
      (r) => r['역사명'] === name && (r['호선'] === '경원선' || r['호선'] === '경부선'),
    );
    if (found) bridgeRows.push(found);
  }
  const jungangRows = rows.filter((r) => r['호선'] === '중앙선');
  jungangRows.reverse();
  const gyeonguiAll = [...gyeonguiRows, ...bridgeRows, ...jungangRows];
  gyeonguiAll.forEach((row, idx) => extra.push(toStation(row, 'gyeongui', idx)));
  console.log(`  경의중앙선: ${gyeonguiAll.length}개`);

  // 수인분당선: 수인선(인천→고색) + 분당선(하드코딩 순서로 정렬)
  const suinRows = rows.filter((r) => r['호선'] === '수인선');
  const bundangRows = rows.filter((r) => r['호선'] === '분당선');
  const bundangByName = new Map();
  for (const row of bundangRows) {
    bundangByName.set(row['역사명'], row);
  }
  const sortedBundang = BUNDANG_STATION_ORDER
    .map((name) => bundangByName.get(name))
    .filter(Boolean);
  const bundangAll = [...suinRows, ...sortedBundang, ...BUNDANG_NORTH_EXTENSION];
  bundangAll.forEach((row, idx) => extra.push(toStation(row, 'bundang', idx)));
  console.log(`  수인분당선: ${bundangAll.length}개`);

  // 신분당선: 연장(광교→미금) + 본선(정자→강남) + 연장2(신논현→신사)
  const sinbundangExt = rows.filter((r) => r['호선'] === '신분당선(연장)');
  const sinbundangMain = rows.filter((r) => r['호선'] === '신분당선');
  const sinbundangExt2 = rows.filter((r) => r['호선'] === '신분당선(연장2)');
  const sinbundangAll = [...sinbundangExt, ...sinbundangMain, ...sinbundangExt2];
  sinbundangAll.forEach((row, idx) => extra.push(toStation(row, 'sinbundang', idx)));
  console.log(`  신분당선: ${sinbundangAll.length}개`);

  const all = [...base, ...extra];
  fs.writeFileSync(
    STATIONS_JSON_PATH,
    JSON.stringify(all, null, 2) + '\n',
    'utf-8',
  );

  console.log(`\n완료: 총 ${all.length}개 역 → ${STATIONS_JSON_PATH}`);
}

main();
