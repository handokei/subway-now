'use strict';

/**
 * 노선별 공식 역명이 달라 정규화(후행 괄호 제거)만으로 매칭되지 않는 환승역 별칭.
 * key: 별칭 표기, value: canonical 표기로 통일.
 *
 * 단일 SSOT — 런타임(stationRoute.ts, wifiSsidLookup.ts)과 빌드 스크립트(build-transfer-times.js)가
 * 모두 이 파일을 import하여 silent drift를 방지한다.
 * TypeScript import는 stationAliases.d.ts 타입 선언을 통해 처리.
 */
const STATION_ALIASES = {
  이수: '총신대입구',
};

function applyStationAlias(name) {
  return STATION_ALIASES[name] ?? name;
}

module.exports = { STATION_ALIASES, applyStationAlias };
