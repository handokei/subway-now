#!/usr/bin/env node
/**
 * #474 — `firstLastTrainTimes.json` (#1497 산출물)을 바탕으로 `lastTrains.json`을 1회 시드한다.
 *
 * - `fetch-last-train.js`가 OpenAPI에서 직접 받는 것이 일상 SSOT이지만, 본 스크립트는
 *   네트워크/시크릿 없이도 동등한 결과를 만들 수 있게 해주는 ETL 보조.
 * - `firstLastTrainTimes.json`은 `{stationsJsonId: { dayType: { direction: { first, last } } }}` 형식.
 *   여기서 `.last`만 떼서 `{stationsJsonId: { dayType: { direction: "HH:MM" } }}` 형태로 변환한다.
 * - lines 맵은 ALL_LINES 13개 중 등장한 노선만 'covered', 나머지는 'uncovered'.
 *
 * 사용법: `node scripts/seed-last-trains-from-first-last.js`
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FIRST_LAST_PATH = path.join(ROOT, 'src', 'data', 'firstLastTrainTimes.json');
const STATIONS_PATH = path.join(ROOT, 'src', 'data', 'stations.json');
const OUT_PATH = path.join(ROOT, 'src', 'data', 'lastTrains.json');

const ALL_LINES = [
  '1', '2', '3', '4', '5', '6', '7', '8', '9',
  'airport', 'gyeongui', 'bundang', 'sinbundang',
];

function buildLinesMap(coveredLines) {
  const set = new Set(coveredLines);
  const map = {};
  for (const line of ALL_LINES) {
    map[line] = set.has(line) ? 'covered' : 'uncovered';
  }
  return map;
}

function seedFromFirstLast(firstLast, stationsById) {
  const stations = {};
  const coveredLines = new Set();
  const sortedIds = Object.keys(firstLast).sort((a, b) => a.localeCompare(b, 'en'));
  for (const id of sortedIds) {
    const station = stationsById.get(id);
    if (!station) continue;
    const dayMap = firstLast[id];
    const slim = {};
    let any = false;
    for (const [dayType, directions] of Object.entries(dayMap)) {
      slim[dayType] = {};
      for (const [direction, times] of Object.entries(directions)) {
        const last = times && typeof times.last === 'string' ? times.last : null;
        slim[dayType][direction] = last;
        if (last !== null) any = true;
      }
    }
    if (!any) continue;
    stations[id] = slim;
    coveredLines.add(station.line);
  }
  return { stations, coveredLines };
}

function main() {
  if (!fs.existsSync(FIRST_LAST_PATH)) {
    process.stderr.write(`firstLastTrainTimes.json 없음: ${FIRST_LAST_PATH}\n`);
    process.exit(1);
  }
  const firstLast = JSON.parse(fs.readFileSync(FIRST_LAST_PATH, 'utf8'));
  const stations = JSON.parse(fs.readFileSync(STATIONS_PATH, 'utf8'));
  const stationsById = new Map(stations.map((s) => [s.id, s]));
  const { stations: out, coveredLines } = seedFromFirstLast(firstLast, stationsById);
  const sorted = Object.keys(out)
    .sort((a, b) => a.localeCompare(b, 'en'))
    .reduce((acc, k) => {
      acc[k] = out[k];
      return acc;
    }, {});
  const payload = {
    version: '1',
    lines: buildLinesMap(coveredLines),
    stations: sorted,
  };
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  process.stdout.write(
    `# seed 완료 — ${Object.keys(out).length}역, 노선 ${coveredLines.size}개, ${OUT_PATH}\n`,
  );
  return { stationCount: Object.keys(out).length, coveredLines: [...coveredLines] };
}

module.exports = { buildLinesMap, seedFromFirstLast, main };

if (require.main === module) {
  main();
}
