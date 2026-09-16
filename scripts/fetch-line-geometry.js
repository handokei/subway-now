#!/usr/bin/env node
/**
 * 서울 지하철 1~9호선 폴리라인 좌표를 OSM Overpass API에서 받아
 * src/data/lineGeometry.json으로 저장한다.
 *
 * Data: © OpenStreetMap contributors (ODbL).
 *
 * 사용:
 *   node scripts/fetch-line-geometry.js
 *
 * 출력 형식 (src/data/lineGeometry.json):
 *   { "1": [[[lat, lng], ...], ...], "2": [...], ... }
 *   - key: 호선 ref ("1" ~ "9")
 *   - value: way 단위 segments. 각 segment = [lat, lng] 좌표 시퀀스
 */
const fs = require('fs');
const path = require('path');

const LINES = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
const BBOX = '37.30,126.60,37.85,127.30'; // 수도권 대략 영역
const ENDPOINT = 'https://overpass-api.de/api/interpreter';
const TIMEOUT_QUERY = 120;
const TIMEOUT_HTTP_MS = 180000;
const SLEEP_BETWEEN_MS = 3000;

const OUTPUT_PATH = path.join(__dirname, '..', 'src', 'data', 'lineGeometry.json');

async function fetchLine(ref) {
  const data = `[out:json][timeout:${TIMEOUT_QUERY}];relation["route"="subway"]["ref"="${ref}"](${BBOX});out geom;`;
  const body = new URLSearchParams({ data }).toString();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_HTTP_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'User-Agent': 'subway-now/1.0', 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function extractUniqueWays(json) {
  const seen = new Map();
  for (const el of json.elements || []) {
    if (el.type !== 'relation') continue;
    for (const m of el.members || []) {
      if (m.type !== 'way' || !m.geometry) continue;
      if (m.role && !['', 'forward', 'backward'].includes(m.role)) continue;
      if (seen.has(m.ref)) continue;
      const coords = m.geometry.map((p) => [+p.lat.toFixed(6), +p.lon.toFixed(6)]);
      if (coords.length >= 2) seen.set(m.ref, coords);
    }
  }
  return [...seen.values()];
}

async function main() {
  const result = {};
  for (const ref of LINES) {
    process.stdout.write(`Fetching line ${ref}... `);
    const json = await fetchLine(ref);
    const segs = extractUniqueWays(json);
    const pts = segs.reduce((s, x) => s + x.length, 0);
    result[ref] = segs;
    console.log(`segments=${segs.length}, points=${pts}`);
    await new Promise((r) => setTimeout(r, SLEEP_BETWEEN_MS));
  }
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result));
  const kb = (fs.statSync(OUTPUT_PATH).size / 1024).toFixed(1);
  console.log(`Wrote ${OUTPUT_PATH} (${kb} KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
