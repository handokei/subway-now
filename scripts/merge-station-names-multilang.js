#!/usr/bin/env node
/**
 * 서울교통공사 공식 CSV에서 일본어(nameJa)와 한자(nameHanja, 번체)를 stations.json에 머지한다.
 *
 * 데이터 소스 (둘 다 CP949):
 * 1) scripts/서울교통공사_노선별 지하철역 정보.csv
 *    - 컬럼: 전철역코드, 전철역명, 전철명명(영문), 호선, 외부코드, 전철명명(중문), 전철명명(일문)
 *    - 798행. 영문/일문 거의 완전. 중문은 간체 시도하다 CP949 인코딩 한계로 약 43% '?' 손실
 * 2) scripts/서울교통공사_역명다국어표기_20241101.csv
 *    - 컬럼: 연번, 호선, 한글, 한자, 영문, 중국어, 일본어
 *    - 294행 (1~9호선 본선 위주). 한자(번체) 컬럼 100% 깨끗
 *
 * 전략: 일문은 1)에서, 한자(번체)는 2)에서. 중문은 보류(이후 Wikidata 보강 예정).
 * '?'가 섞인 값은 머지에서 제외 → UI에서 영문(nameEn) fallback.
 *
 * 사용법: npm run data:merge
 *   내부적으로 `merge-station-names-en.js` (영문 머지)를 먼저 실행한 뒤 이 스크립트를
 *   실행해야 한다. 영문 우선순위가 보장된 상태에서 일문/한자가 추가되는 구조이기 때문.
 */

const iconv = require('iconv-lite');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LINES_CSV = path.join(ROOT, 'scripts', '서울교통공사_노선별 지하철역 정보.csv');
const MULTILANG_CSV = path.join(ROOT, 'scripts', '서울교통공사_역명다국어표기_20241101.csv');
const STATIONS_JSON = path.join(ROOT, 'src', 'data', 'stations.json');

// 노선별 CSV의 일문 컬럼은 장음부호(ー)와 일부 한자(国 등)가 CP949에 없어 '?'로
// 손실되거나 행 자체가 누락된 역이 있다. 서울교통공사 공식 가타카나 표기를 폴백으로 둔다.
// CSV 매칭이 우선이고 여기 상수는 보정 역할.
const MANUAL_NAME_JA = {
  고속터미널: 'コソクターミナル',
  남부터미널: 'ナンブターミナル',
  당고개: 'タンゴゲ',
  뚝섬유원지: 'トゥクソムユウォンジ',
  월드컵경기장: 'ワールドカップキョンギジャン',
  인천공항1터미널: '仁川空港第1ターミナル',
  인천공항2터미널: '仁川空港第2ターミナル',
  화전: 'ファジョン',
  남동인더스파크: 'ナムドンインドスパーク',
};

function decodeCp949(filePath) {
  return iconv.decode(fs.readFileSync(filePath), 'cp949');
}

function parseQuotedCsv(text) {
  // 모든 필드가 따옴표로 감싸진 CSV용 간단 파서 (노선별 CSV 형식)
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const fields = [];
      const regex = /"([^"]*)"/g;
      let match;
      while ((match = regex.exec(line)) !== null) {
        fields.push(match[1]);
      }
      return fields;
    });
}

function parsePlainCsv(text) {
  // 다국어표기 CSV는 대부분 따옴표 없는 단순 CSV지만, 일부 비고 컬럼에 콤마가 들어간
  // 따옴표 묶음 필드가 섞여 있다. 따옴표 안의 콤마는 분리하지 않는다.
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const fields = [];
      let buf = '';
      let inQuote = false;
      for (const ch of line) {
        if (ch === '"') {
          inQuote = !inQuote;
        } else if (ch === ',' && !inQuote) {
          fields.push(buf.trim());
          buf = '';
        } else {
          buf += ch;
        }
      }
      fields.push(buf.trim());
      return fields;
    });
}

function isClean(value) {
  return value && value !== '-' && !value.includes('?');
}

function buildLinesMap() {
  const rows = parseQuotedCsv(decodeCp949(LINES_CSV));
  const header = rows[0];
  const nameIdx = header.indexOf('전철역명');
  const jaIdx = header.findIndex((col) => col.includes('일문'));
  if (nameIdx === -1 || jaIdx === -1) {
    throw new Error(`노선별 CSV 헤더 누락: name=${nameIdx}, ja=${jaIdx}`);
  }
  const map = new Map();
  for (const row of rows.slice(1)) {
    const name = row[nameIdx];
    const ja = row[jaIdx];
    if (name && isClean(ja) && !map.has(name)) {
      map.set(name, ja);
    }
  }
  return map;
}

function buildMultilangMap() {
  const rows = parsePlainCsv(decodeCp949(MULTILANG_CSV));
  const header = rows[0];
  const nameIdx = header.indexOf('한글');
  const hanjaIdx = header.indexOf('한자');
  if (nameIdx === -1 || hanjaIdx === -1) {
    throw new Error(`다국어 CSV 헤더 누락: name=${nameIdx}, hanja=${hanjaIdx}`);
  }
  const map = new Map();
  for (const row of rows.slice(1)) {
    const name = row[nameIdx];
    const hanjaRaw = row[hanjaIdx];
    if (!isClean(hanjaRaw)) continue;
    // 한자 컬럼에 공백 섞여 있음 ("市 廳" → "市廳")
    const hanja = hanjaRaw.replace(/\s+/g, '');
    if (name && !map.has(name)) {
      map.set(name, hanja);
    }
  }
  return map;
}

function getBaseName(name) {
  // "왕십리(성동구청)" → "왕십리"
  const openIdx = name.lastIndexOf('(');
  if (openIdx >= 0 && name.endsWith(')')) {
    return name.slice(0, openIdx).trim();
  }
  return name;
}

function lookup(map, name) {
  return map.get(name) ?? map.get(getBaseName(name));
}

function main() {
  const jaMap = buildLinesMap();
  const hanjaMap = buildMultilangMap();
  console.log(`[merge] 일문 unique: ${jaMap.size}, 한자(번체) unique: ${hanjaMap.size}`);

  const stations = JSON.parse(fs.readFileSync(STATIONS_JSON, 'utf-8'));
  let jaMatched = 0;
  let hanjaMatched = 0;
  const jaMissing = [];
  const hanjaMissing = [];

  // CSV 갱신으로 매뉴얼 보정이 더 이상 필요 없는지 검사
  for (const name of Object.keys(MANUAL_NAME_JA)) {
    if (jaMap.has(name)) {
      console.log(`[merge] '${name}'이 CSV에도 존재합니다. MANUAL_NAME_JA에서 제거를 검토하세요.`);
    }
  }

  const updated = stations.map((station) => {
    const ja =
      lookup(jaMap, station.name) ??
      MANUAL_NAME_JA[station.name] ??
      MANUAL_NAME_JA[getBaseName(station.name)];
    const hanja = lookup(hanjaMap, station.name);
    if (ja) jaMatched += 1;
    else jaMissing.push(station.name);
    if (hanja) hanjaMatched += 1;
    else hanjaMissing.push(station.name);
    return {
      ...station,
      ...(ja && { nameJa: ja }),
      ...(hanja && { nameHanja: hanja }),
    };
  });

  console.log(`[merge] 일문 매칭: ${jaMatched} / ${stations.length}`);
  console.log(`[merge] 한자 매칭: ${hanjaMatched} / ${stations.length}`);

  const printMissing = (label, list) => {
    const unique = Array.from(new Set(list));
    if (unique.length === 0) return;
    console.log(
      `[merge] ${label} 누락 (${unique.length}): ${unique.slice(0, 15).join(', ')}${
        unique.length > 15 ? ' ...' : ''
      }`
    );
  };
  printMissing('일문', jaMissing);
  printMissing('한자', hanjaMissing);

  fs.writeFileSync(STATIONS_JSON, JSON.stringify(updated, null, 2) + '\n');
  console.log(`[merge] stations.json 업데이트 완료`);
}

main();
