#!/usr/bin/env node
/**
 * 서울교통공사 공식 CSV의 영문명 컬럼을 stations.json에 합쳐 nameEn 필드를 추가한다.
 *
 * 데이터 소스: scripts/서울교통공사_노선별 지하철역 정보.csv (CP949)
 * 컬럼: 전철역코드, 전철역명, 전철역명(영문), 호선, 외부코드, 전철역명(중문), 전철역명(일문)
 *
 * 매핑 키: 한글 역명 (동명이역 케이스는 별도 처리). 호선이 다른 동명이역의 영문 표기는 동일하므로
 * 한글 이름만으로 매핑하면 충분.
 *
 * 사용법: node scripts/merge-station-names-en.js
 */

const iconv = require('iconv-lite');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CSV_PATH = path.join(ROOT, 'scripts', '서울교통공사_노선별 지하철역 정보.csv');
const STATIONS_JSON_PATH = path.join(ROOT, 'src', 'data', 'stations.json');

// CSV에 누락된 역의 Seoul Metro 공식 영문 표기 보정. 신규 노선 개통이나 CSV 갱신으로 추가됐을 때
// CSV 매칭이 우선이고, 여기 상수는 폴백 역할.
const MANUAL_NAME_EN = {
  당고개: 'Danggogae',
  뚝섬유원지: 'Ttukseom Resort',
  화전: 'Hwajeon',
};

function parseCsv(buffer) {
  const text = iconv.decode(buffer, 'cp949');
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const rows = lines.map((line) => {
    // 간단한 CSV 파서: 따옴표로 감싸진 필드만 처리 (이 CSV는 모든 필드가 따옴표로 감싸져 있음)
    const fields = [];
    const regex = /"([^"]*)"/g;
    let match;
    while ((match = regex.exec(line)) !== null) {
      fields.push(match[1]);
    }
    return fields;
  });
  const header = rows[0];
  const nameIdx = header.indexOf('전철역명');
  const nameEnIdx = header.findIndex((col) => col.includes('영문'));
  if (nameIdx === -1 || nameEnIdx === -1) {
    throw new Error(`CSV 헤더를 찾을 수 없습니다: name=${nameIdx}, nameEn=${nameEnIdx}`);
  }
  return rows.slice(1).map((row) => ({
    name: row[nameIdx],
    nameEn: row[nameEnIdx],
  }));
}

function buildNameMap(entries) {
  const map = new Map();
  for (const { name, nameEn } of entries) {
    if (!name || !nameEn) continue;
    // 첫 등장 우선. 이후 동일 한글명은 무시.
    if (!map.has(name)) {
      map.set(name, nameEn);
    }
  }
  return map;
}

function main() {
  const buffer = fs.readFileSync(CSV_PATH);
  const entries = parseCsv(buffer);
  const nameMap = buildNameMap(entries);
  console.log(`[merge] CSV 로드 완료: ${entries.length} rows, unique names: ${nameMap.size}`);

  // CSV 갱신으로 누락 보정이 더 이상 필요 없는지 검사
  for (const name of Object.keys(MANUAL_NAME_EN)) {
    if (nameMap.has(name)) {
      console.log(`[merge] '${name}'이 CSV에도 존재합니다. MANUAL_NAME_EN에서 제거를 검토하세요.`);
    }
  }

  const stations = JSON.parse(fs.readFileSync(STATIONS_JSON_PATH, 'utf-8'));
  let matched = 0;
  const unmatched = [];
  const updated = stations.map((station) => {
    // stations.json의 부역명("왕십리(성동구청)") vs CSV의 본역명("왕십리")
    const baseName = station.name.replace(/\(.*\)$/, '').trim();
    const nameEn =
      nameMap.get(station.name) ??
      nameMap.get(baseName) ??
      MANUAL_NAME_EN[station.name] ??
      MANUAL_NAME_EN[baseName];
    if (nameEn) {
      matched += 1;
      return { ...station, nameEn };
    }
    unmatched.push(station.name);
    return station;
  });

  console.log(`[merge] 매칭: ${matched} / ${stations.length}`);
  if (unmatched.length > 0) {
    const unique = Array.from(new Set(unmatched));
    console.log(`[merge] 영문명 누락 (${unique.length}개): ${unique.slice(0, 30).join(', ')}${unique.length > 30 ? ' ...' : ''}`);
  }

  fs.writeFileSync(STATIONS_JSON_PATH, JSON.stringify(updated, null, 2) + '\n');
  console.log(`[merge] stations.json 업데이트 완료`);
}

main();
