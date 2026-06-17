/**
 * stations.json + lineTopology.json 정합성 검증 (#1039).
 *
 * Errors (exit 1):
 *   - station 필수 필드 누락/형식 오류 (id/name/line/lineColor 비어있음)
 *   - lat/lng가 finite 아님 또는 한반도 bounding box 밖
 *   - id 중복
 *   - monotonicLines의 노선이 stations.json에 2개 미만으로 존재
 *   - endpoints[line].low / .high 가 비어있는 문자열
 *
 * Warnings (exit 0):
 *   - 같은 line 내 name 중복 (데이터 오류 의심)
 *   - 단조 노선의 id-sort 첫/마지막이 endpoints와 다름 — lineTopology.json의
 *     `_endpoints_comment`에 명시된 의도된 divergence (4/7/8/9/sinbundang 연장)
 *
 * 본 스크립트는 SSOT(stations.json, lineTopology.json)을 절대 수정하지 않는다.
 * 문제를 보고만 한다.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// 한반도 widest reasonable bounding box.
// Seoul subway는 위도 37.x, 경도 126.x 부근이지만, 미래 노선 확장(인천공항 등) 여유 포함.
const LAT_MIN = 33;
const LAT_MAX = 39;
const LNG_MIN = 124;
const LNG_MAX = 132;

// #1397: 단조 노선 인접 id 간 좌표 거리(haversine, m) sanity 한계.
// 서울 지하철 평균 hop ≈ 1.0~1.5km, p99 ≈ 4km. 8km 초과는 누락된 중간역 강한 의심.
// 9호선 김포공항(공항철도 환승) 같이 특수 구조 hop도 6~7km 수준이라 8km는 보수적 floor.
const ADJACENT_DISTANCE_MAX_METERS = 8000;

const STATIONS_PATH = path.resolve(__dirname, '..', 'src', 'data', 'stations.json');
const TOPOLOGY_PATH = path.resolve(__dirname, '..', 'src', 'data', 'lineTopology.json');

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function isInRange(v, min, max) {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

// haversine 거리(미터). validate-stations 전용 단순 구현 — 다른 noses의 ETA 정밀도와 무관하므로
// 의존성 그래프(SSOT shared/utils/haversine.ts) 도입 없이 inline 유지.
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * @param {{ stations: unknown, topology: unknown }} input
 * @returns {{ errors: string[], warnings: string[], stationCount: number, monotonicLineCount: number }}
 */
function validate(input) {
  const errors = [];
  const warnings = [];

  const { stations, topology } = input;

  if (!Array.isArray(stations)) {
    errors.push('stations.json: root가 배열이 아님');
    return { errors, warnings, stationCount: 0, monotonicLineCount: 0 };
  }
  if (!topology || typeof topology !== 'object') {
    errors.push('lineTopology.json: root가 객체가 아님');
    return { errors, warnings, stationCount: stations.length, monotonicLineCount: 0 };
  }

  const idSeen = new Map(); // id -> first index
  stations.forEach((stn, idx) => {
    const where = `stations.json[${idx}]`;
    if (!stn || typeof stn !== 'object') {
      errors.push(`${where}: 객체가 아님`);
      return;
    }
    if (!isNonEmptyString(stn.id)) {
      errors.push(`${where}: id가 비어있거나 문자열이 아님`);
    }
    if (!isNonEmptyString(stn.name)) {
      errors.push(`${where} (id=${stn.id ?? '?'}): name이 비어있거나 문자열이 아님`);
    }
    if (!isNonEmptyString(stn.line)) {
      errors.push(`${where} (id=${stn.id ?? '?'}): line이 비어있거나 문자열이 아님`);
    }
    if (!isNonEmptyString(stn.lineColor)) {
      errors.push(`${where} (id=${stn.id ?? '?'}): lineColor가 비어있거나 문자열이 아님`);
    }
    if (!isInRange(stn.lat, LAT_MIN, LAT_MAX)) {
      errors.push(
        `${where} (id=${stn.id ?? '?'}): lat이 finite number가 아니거나 [${LAT_MIN}, ${LAT_MAX}] 범위 밖 (got ${stn.lat})`,
      );
    }
    if (!isInRange(stn.lng, LNG_MIN, LNG_MAX)) {
      errors.push(
        `${where} (id=${stn.id ?? '?'}): lng가 finite number가 아니거나 [${LNG_MIN}, ${LNG_MAX}] 범위 밖 (got ${stn.lng})`,
      );
    }

    if (isNonEmptyString(stn.id)) {
      if (idSeen.has(stn.id)) {
        errors.push(`${where}: id "${stn.id}" 중복 (이전 index=${idSeen.get(stn.id)})`);
      } else {
        idSeen.set(stn.id, idx);
      }
    }
  });

  const monotonicLines = Array.isArray(topology.monotonicLines) ? topology.monotonicLines : null;
  const endpoints =
    topology.endpoints && typeof topology.endpoints === 'object' ? topology.endpoints : null;

  if (!monotonicLines) {
    errors.push('lineTopology.json: monotonicLines가 배열이 아님');
  }
  if (!endpoints) {
    errors.push('lineTopology.json: endpoints가 객체가 아님');
  }

  let monotonicLineCount = 0;
  if (monotonicLines && endpoints) {
    for (const line of monotonicLines) {
      if (!isNonEmptyString(line)) {
        errors.push(`lineTopology.json: monotonicLines에 비어있는 항목`);
        continue;
      }
      const ep = endpoints[line];
      if (!ep || typeof ep !== 'object') {
        errors.push(`lineTopology.json: endpoints["${line}"] 누락`);
        continue;
      }
      if (!isNonEmptyString(ep.low)) {
        errors.push(`lineTopology.json: endpoints["${line}"].low가 비어있음`);
      }
      if (!isNonEmptyString(ep.high)) {
        errors.push(`lineTopology.json: endpoints["${line}"].high가 비어있음`);
      }

      const stns = stations.filter((s) => s && s.line === line);
      if (stns.length < 2) {
        errors.push(
          `lineTopology.json: 단조 노선 "${line}"이 stations.json에 ${stns.length}개만 존재 (≥2 필요)`,
        );
        continue;
      }

      monotonicLineCount += 1;

      // Warning: id-sort 첫/마지막이 endpoints와 일치하지 않을 때.
      // 의도된 divergence (lineTopology.json _endpoints_comment 참조)이지만
      // 새로 도입된 divergence를 가시화하기 위해 알림만 띄운다.
      const sorted = stns.slice().sort((a, b) => a.id.localeCompare(b.id));
      const first = sorted[0].name;
      const last = sorted[sorted.length - 1].name;
      if (isNonEmptyString(ep.low) && first !== ep.low) {
        warnings.push(
          `line "${line}": id-sort 첫 역 "${first}" ≠ endpoints.low "${ep.low}" (의도된 divergence면 무시)`,
        );
      }
      if (isNonEmptyString(ep.high) && last !== ep.high) {
        warnings.push(
          `line "${line}": id-sort 마지막 역 "${last}" ≠ endpoints.high "${ep.high}" (의도된 divergence면 무시)`,
        );
      }

      // Warning: 같은 line 내 name 중복.
      const nameCount = new Map();
      for (const s of stns) {
        if (!isNonEmptyString(s.name)) continue;
        nameCount.set(s.name, (nameCount.get(s.name) ?? 0) + 1);
      }
      for (const [name, count] of nameCount) {
        if (count > 1) {
          warnings.push(`line "${line}": name "${name}"이 ${count}회 중복`);
        }
      }

      // Warning: 단조 노선 인접 hop 거리가 ADJACENT_DISTANCE_MAX_METERS 초과면
      // 누락된 중간역 의심(개명 누락이 시퀀스 gap을 만들 수 있다 — #1397 자양 케이스 같이).
      // 좌표가 finite한 페어만 검사 (이미 다른 에러로 잡힘).
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const cur = sorted[i];
        if (
          !Number.isFinite(prev.lat) ||
          !Number.isFinite(prev.lng) ||
          !Number.isFinite(cur.lat) ||
          !Number.isFinite(cur.lng)
        ) {
          continue;
        }
        const dist = haversineMeters(prev.lat, prev.lng, cur.lat, cur.lng);
        if (dist > ADJACENT_DISTANCE_MAX_METERS) {
          warnings.push(
            `line "${line}": 인접 hop "${prev.name}" → "${cur.name}" 거리 ${Math.round(dist)}m > ${ADJACENT_DISTANCE_MAX_METERS}m (누락된 중간역 의심)`,
          );
        }
      }
    }
  }

  return {
    errors,
    warnings,
    stationCount: stations.length,
    monotonicLineCount,
  };
}

function readJson(p) {
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw);
}

function main(_argv, deps = {}) {
  const writeOut = deps.writeOut ?? ((s) => process.stdout.write(s + '\n'));
  const writeErr = deps.writeErr ?? ((s) => process.stderr.write(s + '\n'));
  const stationsPath = deps.stationsPath ?? STATIONS_PATH;
  const topologyPath = deps.topologyPath ?? TOPOLOGY_PATH;

  let stations;
  let topology;
  try {
    stations = readJson(stationsPath);
  } catch (e) {
    writeErr(`validate-stations: stations.json 읽기 실패 — ${e.message}`);
    return 1;
  }
  try {
    topology = readJson(topologyPath);
  } catch (e) {
    writeErr(`validate-stations: lineTopology.json 읽기 실패 — ${e.message}`);
    return 1;
  }

  const result = validate({ stations, topology });

  for (const w of result.warnings) {
    writeOut(`⚠️  ${w}`);
  }
  for (const e of result.errors) {
    writeErr(`❌ ${e}`);
  }

  if (result.errors.length > 0) {
    writeErr(`❌ ${result.errors.length} errors`);
    return 1;
  }
  writeOut(
    `✅ ${result.stationCount} stations OK, ${result.monotonicLineCount} monotonic lines OK` +
      (result.warnings.length > 0 ? ` (${result.warnings.length} warnings)` : ''),
  );
  return 0;
}

module.exports = {
  LAT_MIN,
  LAT_MAX,
  LNG_MIN,
  LNG_MAX,
  ADJACENT_DISTANCE_MAX_METERS,
  haversineMeters,
  validate,
  main,
};

/* istanbul ignore if -- CLI 진입은 require.main 분기, 단위 테스트는 main()을 직접 호출 */
if (require.main === module) {
  process.exit(main(process.argv));
}
