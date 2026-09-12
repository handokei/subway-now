#!/usr/bin/env node
/**
 * #1111 PoC 분석: stationDistances.json(실측 트랙 거리) vs stations.json 좌표 haversine(직선 거리)
 * 의 비율 분포를 노선별로 출력한다.
 *
 * 현재 fusion ETA(src/shared/utils/stationEta.ts)는 haversine 직선거리를 사용 — 트랙이 곡선이거나
 * 우회 구간에서 실측이 직선보다 길어 ETA가 과소 추정될 가능성을 정량 확인한다.
 *
 * 사용법: node scripts/analyze-station-distances.js
 */

const fs = require('node:fs');
const path = require('node:path');

const STATIONS_PATH = path.join(__dirname, '..', 'src', 'data', 'stations.json');
const DISTANCES_PATH = path.join(__dirname, '..', 'src', 'data', 'stationDistances.json');

// haversine — src/shared/utils/haversine.ts와 동일 공식, km 반환.
const EARTH_RADIUS_KM = 6371;
const toRad = (d) => (d * Math.PI) / 180;
function haversineMeters(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a)) * 1000;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

function main() {
  const stations = JSON.parse(fs.readFileSync(STATIONS_PATH, 'utf8'));
  const distances = JSON.parse(fs.readFileSync(DISTANCES_PATH, 'utf8'));
  const byId = new Map(stations.map((s) => [s.id, s]));

  const perLine = new Map();
  // 중복 카운트 방지: 양방향 키 중 하나만 본다.
  const seen = new Set();

  for (const key of Object.keys(distances)) {
    const [line, fromId, toId] = key.split('|');
    const canonical = fromId < toId ? `${line}|${fromId}|${toId}` : `${line}|${toId}|${fromId}`;
    if (seen.has(canonical)) continue;
    seen.add(canonical);

    const from = byId.get(fromId);
    const to = byId.get(toId);
    if (!from || !to) continue;
    const actualM = distances[key];
    const lineDistM = haversineMeters(from.lat, from.lng, to.lat, to.lng);
    if (lineDistM <= 0) continue;
    const ratio = actualM / lineDistM;

    let row = perLine.get(line);
    if (!row) {
      row = [];
      perLine.set(line, row);
    }
    row.push({ fromId, toId, actualM, lineDistM, ratio });
  }

  console.log('# 역간거리 PoC 분석 — 실측(DIST_KM) ÷ haversine 직선거리');
  console.log('# ratio = 1.0 → 직선 = 트랙. 1.0 초과 → 트랙이 곡선/우회로 더 김.');
  console.log('');
  console.log('| 노선 | hops | mean | median | p90 | max | min |');
  console.log('|------|------|------|--------|-----|-----|-----|');
  const lines = [...perLine.keys()].sort();
  const allRatios = [];
  for (const line of lines) {
    const rows = perLine.get(line);
    const ratios = rows.map((r) => r.ratio).sort((a, b) => a - b);
    allRatios.push(...ratios);
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    const median = percentile(ratios, 0.5);
    const p90 = percentile(ratios, 0.9);
    const max = ratios[ratios.length - 1];
    const min = ratios[0];
    console.log(
      `| ${line}호선 | ${ratios.length} | ${mean.toFixed(3)} | ${median.toFixed(3)} | ${p90.toFixed(3)} | ${max.toFixed(3)} | ${min.toFixed(3)} |`,
    );
  }
  const all = allRatios.sort((a, b) => a - b);
  const allMean = all.reduce((a, b) => a + b, 0) / all.length;
  console.log(
    `| 전체 | ${all.length} | ${allMean.toFixed(3)} | ${percentile(all, 0.5).toFixed(3)} | ${percentile(all, 0.9).toFixed(3)} | ${all[all.length - 1].toFixed(3)} | ${all[0].toFixed(3)} |`,
  );

  // 가장 ratio가 큰 hop top 10 — 트랙 우회/곡선이 심한 구간.
  const flat = [];
  for (const [line, rows] of perLine) {
    for (const r of rows) flat.push({ line, ...r });
  }
  flat.sort((a, b) => b.ratio - a.ratio);
  console.log('');
  console.log('# 트랙 vs 직선 비율 상위 10 hop (우회/곡선 심한 구간)');
  for (const r of flat.slice(0, 10)) {
    const from = byId.get(r.fromId);
    const to = byId.get(r.toId);
    console.log(
      `  ${r.line}호선 ${from.name} ↔ ${to.name}: 실측 ${r.actualM}m / 직선 ${Math.round(r.lineDistM)}m = ${r.ratio.toFixed(2)}x`,
    );
  }
}

if (require.main === module) {
  main();
}

module.exports = { haversineMeters, percentile };
