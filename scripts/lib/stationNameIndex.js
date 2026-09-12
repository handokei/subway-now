/**
 * #1472 — scripts/* 의 stations.json 기반 역명 lookup helper.
 *
 * scripts/build-station-distances.js / fetch-station-distances.js / fetch-station-travel-times.js가
 * 동일한 normalizeStationName + buildNameIndex + lookupStationId 패턴을 갖고 있어 공통화한다.
 * fetch-* 두 파일은 별 개 PR로 옮길 예정 — 본 PR은 신규 build script만 본 헬퍼를 사용.
 */

// 부역명 제거: "광교(경기대)" → "광교".
function normalizeStationName(name) {
  if (typeof name !== 'string') return '';
  const trimmed = name.trim();
  if (trimmed.endsWith(')')) {
    const open = trimmed.lastIndexOf('(');
    if (open > 0) return trimmed.slice(0, open).trimEnd();
  }
  return trimmed;
}

// stations.json → { line: Map<name | normalizedName, id> }
function buildNameIndex(stations) {
  const byLine = new Map();
  for (const s of stations) {
    let m = byLine.get(s.line);
    if (!m) {
      m = new Map();
      byLine.set(s.line, m);
    }
    const normalized = normalizeStationName(s.name);
    m.set(s.name, s.id);
    if (normalized !== s.name) m.set(normalized, s.id);
  }
  return byLine;
}

function lookupStationId(byLine, line, rawName) {
  const idx = byLine.get(line);
  if (!idx) return null;
  const normalized = normalizeStationName(rawName);
  return idx.get(rawName) || idx.get(normalized) || null;
}

module.exports = {
  normalizeStationName,
  buildNameIndex,
  lookupStationId,
};
