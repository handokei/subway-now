'use strict';

/**
 * 노선별 공식 역명이 달라 정규화(후행 괄호 제거)만으로 매칭되지 않는 환승역 별칭 +
 * 개명 이후 발사된 옛 boardingLock/favorites/widget 컨텍스트를 새 canonical 표기로 흡수.
 *
 * key: 별칭 표기, value: canonical(정규화) 표기.
 *   - normalizeStationName 통과 후의 형태를 사용 — 괄호 부제를 가진 정식명은 alias의 우변에서
 *     base 형태로 들어가야 검색·환승 그래프와 일관된다.
 *
 * 단일 SSOT — 런타임(stationRoute.ts, wifiSsidLookup.ts)과 빌드 스크립트(build-transfer-times.js)가
 * 모두 이 파일을 import하여 silent drift를 방지한다.
 * TypeScript import는 stationAliases.d.ts 타입 선언을 통해 처리.
 */
const STATION_ALIASES = {
  이수: '총신대입구',
  // #1397: 7호선 자양(뚝섬한강공원)은 stations.json 정식명을 신표기로 교체했으나,
  // 개명 이전 발사된 boardingLock/favorites/위젯 데이터는 옛 '뚝섬유원지'를 가지고 있을 수 있다.
  // normalize → alias 파이프라인이 옛 표기를 정식 base("자양")로 흡수.
  뚝섬유원지: '자양',
};

function applyStationAlias(name) {
  return STATION_ALIASES[name] ?? name;
}

module.exports = { STATION_ALIASES, applyStationAlias };
