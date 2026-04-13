#!/usr/bin/env node
/**
 * 서울 열린데이터 API에서 역 좌표를 가져와 stations.json을 업데이트합니다.
 * 기존 역 목록은 유지하고 좌표(lat, lng)만 정밀값으로 패치합니다.
 *
 * 사용법: node scripts/update-coordinates.js
 */

const fs = require('node:fs');
const path = require('node:path');

const API_KEY = process.env.EXPO_PUBLIC_SEOUL_DATA_API_KEY;
if (!API_KEY) {
  console.error('EXPO_PUBLIC_SEOUL_DATA_API_KEY 환경변수를 설정하세요.');
  process.exit(1);
}
const API_URL = `https://openapi.seoul.go.kr:8088/${API_KEY}/json/subwayStationMaster/1/800/`;
const STATIONS_JSON_PATH = path.join(__dirname, '..', 'src', 'data', 'stations.json');

// stations.json의 line → API ROUTE 매핑
const LINE_TO_ROUTES = {
  '1': ['1호선', '경부선', '경원선', '경인선', '장항선'],
  '2': ['2호선'],
  '3': ['3호선', '일산선'],
  '4': ['4호선', '과천선', '안산선'],
  '5': ['5호선'],
  '6': ['6호선'],
  '7': ['7호선', '7호선(인천)'],
  '8': ['8호선'],
  '9': ['9호선', '9호선(연장)'],
};

async function fetchApiStations() {
  const res = await fetch(API_URL);
  const data = await res.json();

  if (data.subwayStationMaster?.RESULT?.CODE !== 'INFO-000') {
    throw new Error(`API 오류: ${data.subwayStationMaster?.RESULT?.MESSAGE}`);
  }

  return data.subwayStationMaster.row;
}

function buildLookup(apiRows) {
  // (역명, line) → { lat, lng } 매핑 테이블
  // 정확 매칭 + 부분 매칭 (API: "교대(법원.검찰청)" → stations.json: "교대")
  const exact = new Map();
  const byPrefix = new Map(); // 괄호 앞 이름 기준

  for (const row of apiRows) {
    const fullName = row.BLDN_NM;
    const baseName = fullName.replace(/\(.*\)/, '').trim();
    const lat = Number.parseFloat(row.LAT);
    const lng = Number.parseFloat(row.LOT);

    for (const [line, routes] of Object.entries(LINE_TO_ROUTES)) {
      if (routes.includes(row.ROUTE)) {
        exact.set(`${fullName}|${line}`, { lat, lng });
        exact.set(`${baseName}|${line}`, { lat, lng });
        // 부분 매칭: stations.json 이름이 API 이름에 포함되는 경우
        if (!byPrefix.has(`${baseName}|${line}`)) {
          byPrefix.set(`${baseName}|${line}`, { lat, lng });
        }
      }
    }
  }

  return { exact, byPrefix };
}

// API에서 다른 노선으로 등록된 역 (환승역이지만 stations.json에서 다른 호선으로 분류)
const MANUAL_OVERRIDES = {
  '창동|1': { apiName: '창동', apiRoute: '4호선' },
  '회기|1': { apiName: '회기', apiRoute: '중앙선' },
};

async function main() {
  console.log('서울 열린데이터 API에서 역 좌표 조회 중...');
  const apiRows = await fetchApiStations();
  console.log(`API: ${apiRows.length}개 역 수신`);

  const { exact, byPrefix } = buildLookup(apiRows);

  const stations = JSON.parse(fs.readFileSync(STATIONS_JSON_PATH, 'utf-8'));
  console.log(`stations.json: ${stations.length}개 역`);

  let updated = 0;
  let notFound = 0;

  for (const station of stations) {
    const key = `${station.name}|${station.line}`;
    const baseName = station.name.replace(/\(.*\)/, '').trim();
    const baseKey = `${baseName}|${station.line}`;

    const match = exact.get(key) || exact.get(baseKey) || byPrefix.get(baseKey);

    if (match) {
      station.lat = match.lat;
      station.lng = match.lng;
      updated++;
    } else {
      // 수동 매핑 확인
      const override = MANUAL_OVERRIDES[key] || MANUAL_OVERRIDES[baseKey];
      if (override) {
        const apiMatch = apiRows.find(
          (r) => r.BLDN_NM === override.apiName && r.ROUTE === override.apiRoute,
        );
        if (apiMatch) {
          station.lat = Number.parseFloat(apiMatch.LAT);
          station.lng = Number.parseFloat(apiMatch.LOT);
          updated++;
          continue;
        }
      }
      notFound++;
      console.log(`  매칭 실패: ${station.name} (${station.line}호선)`);
    }
  }

  fs.writeFileSync(
    STATIONS_JSON_PATH,
    JSON.stringify(stations, null, 2) + '\n',
    'utf-8',
  );

  console.log(`\n완료: ${updated}개 업데이트, ${notFound}개 매칭 실패`);
}

main().catch(console.error);
