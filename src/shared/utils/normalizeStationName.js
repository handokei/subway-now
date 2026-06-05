'use strict';

/**
 * 후행 괄호 부제(예: "상봉(시외버스터미널)" → "상봉")를 제거해 노선별 표기 불일치를 흡수한다.
 *
 * 단일 SSOT — 런타임(stationRoute.ts)과 빌드 스크립트(build-transfer-times.js)가
 * 모두 이 파일을 import하여 silent drift를 방지한다. 정규식 대신 lastIndexOf로 구현 (ReDoS 회피).
 */
function normalizeStationName(name) {
  const trimmed = name.trim();
  if (!trimmed.endsWith(')')) return trimmed;
  const open = trimmed.lastIndexOf('(');
  if (open <= 0) return trimmed;
  return trimmed.slice(0, open).trimEnd();
}

module.exports = { normalizeStationName };
