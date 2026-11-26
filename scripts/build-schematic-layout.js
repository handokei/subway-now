#!/usr/bin/env node
/**
 * #3371 PR-1: 지도 탭 "노선도" 모드용 배치 데이터 생성 (결정적 — 같은 입력 → 같은 출력).
 *
 * 입력
 *  - src/data/schematicLines.json  노선별 branch 배열(공식 역 순서, 출처·조회일 포함)
 *  - src/data/stations.json        앱 역 데이터(읽기 전용, 좌표·id 소스)
 *  - scripts/fixtures/schematic-overrides.json  수작업 보정(node 좌표·라벨 고정)
 * 출력
 *  - src/data/schematicLayout.json { version, bounds, nodes, edges }
 *
 * 파이프라인
 *  1. (line, 정규화 역명) 단위 entity 생성 → stations.json 매핑(supported)
 *  2. 환승 병합: 정규화(+별칭) 이름이 같고(transferTimes.json 키는 전부 여기 포함 — 테스트가 115키 검증) 좌표 거리 ≤ 500m 인 서로 다른 노선 entity는 한 node
 *  3. 좌표: 지리 좌표(m) → 앱에 없는 역은 이웃 사이 보간/연장 → 어안(fisheye) 압축으로 도심 확대
 *  4. 이완: 8방위 스냅 스프링 + 최소 간격 + node-선분 통과 반발 → 정수 좌표 반복 보정
 *  5. edge 각도는 어떤 배치에서도 45° 배수가 되도록 필요 시 꺾임점(points) 1개로 라우팅
 *  6. 라벨 8방위 × 거리 사다리 후보 중 겹침 0인 위치 선택 → 최종 정수 좌표로 평행 이동
 *
 * 앱 데이터(stations.json)·경로 탐색과 독립 — 읽기만 한다. TS 모듈 require 금지(JS만).
 */
const fs = require('fs');
const path = require('path');
const { normalizeStationName } = require('../src/shared/utils/normalizeStationName');
const { applyStationAlias } = require('../src/data/stationAliases');

const LINES_PATH = path.join(__dirname, '..', 'src', 'data', 'schematicLines.json');
const STATIONS_PATH = path.join(__dirname, '..', 'src', 'data', 'stations.json');
const OVERRIDES_PATH = path.join(__dirname, 'fixtures', 'schematic-overrides.json');
const OUT_PATH = path.join(__dirname, '..', 'src', 'data', 'schematicLayout.json');

// ---- 상수 (테스트·미리보기가 import) ----
const MIN_SPACING = 36; // node 중심 간 최소 거리(px)
const NODE_RADIUS = 8; // 환승 node 기준 반지름(px)
const LABEL_CHAR_W = 11; // 라벨 글자 1개 폭 근사(px)
const LABEL_H = 14; // 라벨 높이(px)
const MERGE_MAX_METERS = 500; // 환승 병합 최대 좌표 거리
const MARGIN = 40;
const EDGE_MIN = MIN_SPACING + 6;
const EDGE_MAX = 96;
const OUTER_RADIUS_M = 10000; // 도심 중심에서 이 거리(m) 밖의 node는 외곽 — 양 끝이 모두 외곽인 edge는 길이 상한을 줄인다
const OUTER_EDGE_MAX = MIN_SPACING + 12; // 외곽 edge 길이 상한(균일 간격)
const OUTER_COMPRESS = 0.15; // 외곽 반경 초과분(m)의 선형 압축 계수 — 이완 수렴 전에 긴 꼬리를 먼저 접는다
const ANCHOR_WEIGHT = 0.02;
const OUTER_ANCHOR_WEIGHT = 0.003; // 외곽은 지리 앵커를 약하게 — 긴 꼬리가 도심 쪽으로 접힐 수 있게
const FISHEYE_K = 3;
const FISHEYE_EXP = 0.6;
const RELAX_ITER = 500;
const REPAIR_ITER = 400;
const LABEL_RINGS = 8;
const LABEL_RING_STEP = 6;
const EARTH_LAT_M = 110574;
const EARTH_LNG_M = 111320;
const BRANCH_ROTATE_RAD = (35 * Math.PI) / 180;
const EXTRAPOLATE_STEP_MIN_M = 700;
const EXTRAPOLATE_STEP_MAX_M = 2500;

const compareStrings = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const keyOf =(name) => applyStationAlias(normalizeStationName(name));

function haversineMeters(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

// ---- 1. entity ----
function buildEntities(linesDef, stations) {
  const stationIndex = new Map();
  for (const st of stations) {
    const k = `${st.line}|${keyOf(st.name)}`;
    if (!stationIndex.has(k)) stationIndex.set(k, []);
    stationIndex.get(k).push(st);
  }
  const entities = [];
  const entityIndex = new Map();
  const sequences = [];
  for (const [line, def] of Object.entries(linesDef.lines)) {
    for (const branch of def.branches) {
      const seq = [];
      for (const name of branch.stations) {
        const key = keyOf(name);
        const ek = `${line}|${key}`;
        if (!entityIndex.has(ek)) {
          const matched = stationIndex.get(ek) ?? [];
          const lat = matched.length ? matched.reduce((s, m) => s + m.lat, 0) / matched.length : null;
          const lng = matched.length ? matched.reduce((s, m) => s + m.lng, 0) / matched.length : null;
          entityIndex.set(ek, entities.length);
          entities.push({
            line,
            key,
            name: matched.length ? normalizeStationName(matched[0].name) : normalizeStationName(name),
            stationIds: matched.map(({ id }) => id),
            lat,
            lng,
          });
        }
        seq.push(entityIndex.get(ek));
      }
      sequences.push({ line, branchId: branch.id, loop: Boolean(branch.loop), entities: seq });
    }
  }
  return { entities, sequences };
}

// ---- 2. 환승 병합 ----
function mergeEntities(entities, enabled) {
  const parent = entities.map((_, i) => i);
  const find = (x) => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    parent[x] = r;
    return r;
  };
  if (enabled) {
    const byKey = new Map();
    entities.forEach((e, i) => {
      if (!byKey.has(e.key)) byKey.set(e.key, []);
      byKey.get(e.key).push(i);
    });
    for (const group of byKey.values()) {
      for (let a = 0; a < group.length; a += 1) {
        for (let b = a + 1; b < group.length; b += 1) {
          const ea = entities[group[a]];
          const eb = entities[group[b]];
          if (ea.line === eb.line) continue;
          const bothUnsupported = ea.lat === null && eb.lat === null;
          const bothSupported = ea.lat !== null && eb.lat !== null;
          // transferTimes.json 키(`A|B|정규화 역명`)는 항상 같은 이름의 두 노선 역 — 이름 일치 + 거리 ≤ 500m 로 전부 포함된다.
          // 거리 조건이 '이름만 같은 다른 역'(예: 양평 5호선 vs 경의중앙)의 병합을 막는다.
          if (bothUnsupported || (bothSupported && haversineMeters(ea, eb) <= MERGE_MAX_METERS)) {
            parent[find(group[b])] = find(group[a]);
          }
        }
      }
    }
  }
  return entities.map((_, i) => find(i));
}

// ---- 3. node / edge ----
function buildGraph(entities, sequences, roots) {
  const rootOrder = [];
  const rootNode = new Map();
  entities.forEach((_, i) => {
    if (!rootNode.has(roots[i])) {
      rootNode.set(roots[i], { members: [] });
      rootOrder.push(roots[i]);
    }
    rootNode.get(roots[i]).members.push(i);
  });
  const nodes = [];
  const entityNode = new Array(entities.length);
  for (const r of rootOrder) {
    const members = rootNode.get(r).members.map((i) => entities[i]);
    const supportedMembers = members.filter((m) => m.lat !== null);
    const stationIds = members.flatMap((m) => m.stationIds);
    const first = supportedMembers[0] ?? members[0];
    const id = stationIds.length ? [...stationIds].sort(compareStrings)[0] : `u:${first.line}:${first.key}`;
    const node = {
      id,
      name: first.name,
      lines: [...new Set(members.map((m) => m.line))].sort(compareStrings),
      stationIds: [...stationIds].sort(compareStrings),
      supported: stationIds.length > 0,
      lat: supportedMembers.length ? supportedMembers.reduce((s, m) => s + m.lat, 0) / supportedMembers.length : null,
      lng: supportedMembers.length ? supportedMembers.reduce((s, m) => s + m.lng, 0) / supportedMembers.length : null,
    };
    rootNode.get(r).index = nodes.length;
    nodes.push(node);
  }
  entities.forEach((_, i) => {
    entityNode[i] = rootNode.get(roots[i]).index;
  });
  const seqNodes = [];
  const edges = [];
  const seen = new Set();
  for (const { line, loop, entities: seq } of sequences) {
    const ns = seq.map((e) => entityNode[e]).filter((n, i, arr) => i === 0 || n !== arr[i - 1]);
    seqNodes.push({ line, nodes: ns });
    const pairs = ns.slice(1).map((n, i) => [ns[i], n]);
    if (loop && ns.length > 2) pairs.push([ns[ns.length - 1], ns[0]]);
    for (const [from, to] of pairs) {
      const k = `${line}|${Math.min(from, to)}~${Math.max(from, to)}`;
      if (from === to || seen.has(k)) continue;
      seen.add(k);
      edges.push({ line, from, to });
    }
  }
  return { nodes, edges, seqNodes };
}

// ---- 4. 초기 좌표 (m) ----
function projectSupported(nodes) {
  const sup = nodes.filter((n) => n.lat !== null);
  const lat0 = sup.reduce((s, n) => s + n.lat, 0) / sup.length;
  const lng0 = sup.reduce((s, n) => s + n.lng, 0) / sup.length;
  const kx = EARTH_LNG_M * Math.cos((lat0 * Math.PI) / 180);
  return nodes.map((n) =>
    n.lat === null ? null : { x: (n.lng - lng0) * kx, y: -(n.lat - lat0) * EARTH_LAT_M },
  );
}

function rotate(v, rad) {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

function norm(v) {
  const len = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / len, y: v.y / len };
}

/** 앱에 없는 역: 알려진 이웃 사이 선형 보간, 끝단은 마지막 진행방향으로 연장. */
function fillUnknown(pos, seqNodes, edges) {
  const neighbors = pos.map(() => []);
  for (const { from, to } of edges) {
    neighbors[from].push(to);
    neighbors[to].push(from);
  }
  for (let pass = 0; pass < 50; pass += 1) {
    let changed = false;
    for (const { nodes: ns } of seqNodes) {
      const knownIdx = ns.map((n, i) => (pos[n] ? i : -1)).filter((i) => i >= 0);
      if (knownIdx.length === 0 || knownIdx.length === ns.length) continue;
      const steps = knownIdx.slice(1).map((ki, j) => {
        const a = pos[ns[knownIdx[j]]];
        const b = pos[ns[ki]];
        return Math.hypot(b.x - a.x, b.y - a.y) / (ki - knownIdx[j]);
      });
      const avg = steps.length ? steps.reduce((s, v) => s + v, 0) / steps.length : 1500;
      const step = Math.min(EXTRAPOLATE_STEP_MAX_M, Math.max(EXTRAPOLATE_STEP_MIN_M, avg));
      for (let i = 0; i < ns.length; i += 1) {
        if (pos[ns[i]]) continue;
        const prevK = [...knownIdx].reverse().find((k) => k < i);
        const nextK = knownIdx.find((k) => k > i);
        if (prevK !== undefined && nextK !== undefined) {
          const a = pos[ns[prevK]];
          const b = pos[ns[nextK]];
          const t = (i - prevK) / (nextK - prevK);
          pos[ns[i]] = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
          changed = true;
          continue;
        }
        const anchorK = prevK ?? nextK;
        const dirSign = prevK !== undefined ? 1 : -1;
        const anchorNode = ns[anchorK];
        const innerK = knownIdx.find((k) => k !== anchorK && Math.sign(k - anchorK) === -dirSign);
        let dir;
        if (innerK !== undefined) {
          const a = pos[anchorNode];
          const b = pos[ns[innerK]];
          dir = norm({ x: a.x - b.x, y: a.y - b.y });
        } else {
          const around = neighbors[anchorNode].filter((n) => pos[n] && !ns.includes(n));
          if (around.length === 0) continue;
          const mean = {
            x: around.reduce((s, n) => s + pos[n].x, 0) / around.length,
            y: around.reduce((s, n) => s + pos[n].y, 0) / around.length,
          };
          dir = rotate(norm({ x: pos[anchorNode].x - mean.x, y: pos[anchorNode].y - mean.y }), BRANCH_ROTATE_RAD);
        }
        const dist = Math.abs(i - anchorK) * step;
        const base = pos[anchorNode];
        pos[ns[i]] = { x: base.x + dir.x * dist, y: base.y + dir.y * dist };
        changed = true;
      }
    }
    if (!changed) break;
  }
  const missing = pos.findIndex((p) => !p);
  if (missing >= 0) throw new Error(`좌표를 추정하지 못한 node index ${missing}`);
}

/** 도심 확대용 어안 압축: r' = K * r^EXP (방향 보존). */
function fisheye(pos, cx, cy) {
  return pos.map((p) => {
    const r0 = Math.hypot(p.x - cx, p.y - cy);
    if (r0 === 0) return { x: 0, y: 0 };
    const r = r0 > OUTER_RADIUS_M ? OUTER_RADIUS_M + (r0 - OUTER_RADIUS_M) * OUTER_COMPRESS : r0;
    const rp = FISHEYE_K * r ** FISHEYE_EXP;
    return { x: ((p.x - cx) / r0) * rp, y: ((p.y - cy) / r0) * rp };
  });
}

// ---- 5. 이완 ----
function makeGrid(xs, ys, cell) {
  const grid = new Map();
  xs.forEach((x, i) => {
    const key = `${Math.floor(x / cell)},${Math.floor(ys[i] / cell)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(i);
  });
  return grid;
}

function gridQuery(grid, cell, minX, minY, maxX, maxY) {
  const out = [];
  for (let gx = Math.floor(minX / cell); gx <= Math.floor(maxX / cell); gx += 1) {
    for (let gy = Math.floor(minY / cell); gy <= Math.floor(maxY / cell); gy += 1) {
      const items = grid.get(`${gx},${gy}`);
      if (items) out.push(...items);
    }
  }
  return out;
}

function nearestOnSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return { t, x: ax + t * dx, y: ay + t * dy };
}

function relax(xs, ys, anchorXs, anchorYs, edges, pinned, outer) {
  const n = xs.length;
  const cell = MIN_SPACING * 1.5;
  const segThreshold = MIN_SPACING * 0.6;
  for (let it = 0; it < RELAX_ITER; it += 1) {
    const dxs = new Float64Array(n);
    const dys = new Float64Array(n);
    // 지리 앵커
    for (let i = 0; i < n; i += 1) {
      const w = outer[i] ? OUTER_ANCHOR_WEIGHT : ANCHOR_WEIGHT;
      dxs[i] += (anchorXs[i] - xs[i]) * w;
      dys[i] += (anchorYs[i] - ys[i]) * w;
    }
    // 8방위 스냅 + 길이 클램프 스프링
    for (const { from, to } of edges) {
      const ex = xs[to] - xs[from];
      const ey = ys[to] - ys[from];
      const len = Math.hypot(ex, ey) || 1e-6;
      const snapped = Math.round(Math.atan2(ey, ex) / (Math.PI / 4)) * (Math.PI / 4);
      const maxLen = outer[from] && outer[to] ? OUTER_EDGE_MAX : EDGE_MAX;
      const target = Math.min(maxLen, Math.max(EDGE_MIN, len));
      const fx = (Math.cos(snapped) * target - ex) * 0.15;
      const fy = (Math.sin(snapped) * target - ey) * 0.15;
      dxs[from] -= fx;
      dys[from] -= fy;
      dxs[to] += fx;
      dys[to] += fy;
    }
    // node-node 반발
    const grid = makeGrid(xs, ys, cell);
    for (let i = 0; i < n; i += 1) {
      for (const j of gridQuery(grid, cell, xs[i] - cell, ys[i] - cell, xs[i] + cell, ys[i] + cell)) {
        if (j <= i) continue;
        let vx = xs[j] - xs[i];
        let vy = ys[j] - ys[i];
        let d = Math.hypot(vx, vy);
        const want = MIN_SPACING * 1.05;
        if (d >= want) continue;
        if (d < 1e-6) {
          vx = Math.cos(i * 2.399963);
          vy = Math.sin(i * 2.399963);
          d = 1e-6;
        }
        const push = ((want - d) / 2) * 0.5;
        const ux = vx / Math.hypot(vx, vy);
        const uy = vy / Math.hypot(vx, vy);
        dxs[i] -= ux * push;
        dys[i] -= uy * push;
        dxs[j] += ux * push;
        dys[j] += uy * push;
      }
    }
    // node-선분 반발
    for (const { from, to } of edges) {
      const ax = xs[from];
      const ay = ys[from];
      const bx = xs[to];
      const by = ys[to];
      const pad = segThreshold;
      for (const k of gridQuery(grid, cell, Math.min(ax, bx) - pad, Math.min(ay, by) - pad, Math.max(ax, bx) + pad, Math.max(ay, by) + pad)) {
        if (k === from || k === to) continue;
        const { t, x: nx, y: ny } = nearestOnSegment(xs[k], ys[k], ax, ay, bx, by);
        let vx = xs[k] - nx;
        let vy = ys[k] - ny;
        const d = Math.hypot(vx, vy);
        if (d >= segThreshold) continue;
        if (d < 1e-6) {
          vx = -(by - ay);
          vy = bx - ax;
        }
        const vl = Math.hypot(vx, vy) || 1;
        const push = (segThreshold - d) * 0.5;
        dxs[k] += (vx / vl) * push;
        dys[k] += (vy / vl) * push;
        dxs[from] -= (vx / vl) * push * 0.25 * (1 - t);
        dys[from] -= (vy / vl) * push * 0.25 * (1 - t);
        dxs[to] -= (vx / vl) * push * 0.25 * t;
        dys[to] -= (vy / vl) * push * 0.25 * t;
      }
    }
    for (let i = 0; i < n; i += 1) {
      if (pinned[i]) continue;
      xs[i] += dxs[i];
      ys[i] += dys[i];
    }
  }
}

// ---- 6. 라우팅(꺾임점) + 정수 보정 ----
function bendVariants(ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy)) return [[]];
  const d = Math.min(Math.abs(dx), Math.abs(dy));
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  return [[[ax + sx * d, ay + sy * d]], [[bx - sx * d, by - sy * d]]];
}

function polylineViolations(pts, nodeXs, nodeYs, skipA, skipB, threshold) {
  const out = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  for (let k = 0; k < nodeXs.length; k += 1) {
    if (k === skipA || k === skipB) continue;
    if (nodeXs[k] < minX - threshold || nodeXs[k] > maxX + threshold || nodeYs[k] < minY - threshold || nodeYs[k] > maxY + threshold) continue;
    let best = Infinity;
    let bx = 0;
    let by = 0;
    for (let s = 1; s < pts.length; s += 1) {
      const { x, y } = nearestOnSegment(nodeXs[k], nodeYs[k], pts[s - 1][0], pts[s - 1][1], pts[s][0], pts[s][1]);
      const d = Math.hypot(nodeXs[k] - x, nodeYs[k] - y);
      if (d < best) {
        best = d;
        bx = x;
        by = y;
      }
    }
    if (best < threshold) out.push({ node: k, d: best, x: bx, y: by });
  }
  return out;
}

function routeEdges(xs, ys, edges) {
  return edges.map(({ from, to }) => {
    const variants = bendVariants(xs[from], ys[from], xs[to], ys[to]);
    let best = null;
    let bestScore = Infinity;
    for (const points of variants) {
      const pts = [[xs[from], ys[from]], ...points, [xs[to], ys[to]]];
      const viol = polylineViolations(pts, xs, ys, from, to, MIN_SPACING / 2);
      const score = viol.length;
      if (score < bestScore) {
        bestScore = score;
        best = { points, pts, viol };
      }
    }
    return best;
  });
}

function repairIntegers(xs, ys, edges, pinned) {
  const n = xs.length;
  let routes = null;
  for (let it = 0; it < REPAIR_ITER; it += 1) {
    for (let i = 0; i < n; i += 1) {
      xs[i] = Math.round(xs[i]);
      ys[i] = Math.round(ys[i]);
    }
    const dxs = new Float64Array(n);
    const dys = new Float64Array(n);
    let dirty = false;
    const cell = MIN_SPACING * 1.5;
    const grid = makeGrid(xs, ys, cell);
    for (let i = 0; i < n; i += 1) {
      for (const j of gridQuery(grid, cell, xs[i] - cell, ys[i] - cell, xs[i] + cell, ys[i] + cell)) {
        if (j <= i) continue;
        const vx = xs[j] - xs[i];
        const vy = ys[j] - ys[i];
        const d = Math.hypot(vx, vy);
        if (d >= MIN_SPACING) continue;
        dirty = true;
        const ang = d === 0 ? i * 2.399963 : Math.atan2(vy, vx);
        const push = (MIN_SPACING - d) / 2 + 1;
        dxs[i] -= Math.cos(ang) * push;
        dys[i] -= Math.sin(ang) * push;
        dxs[j] += Math.cos(ang) * push;
        dys[j] += Math.sin(ang) * push;
      }
    }
    routes = routeEdges(xs, ys, edges);
    for (const { viol } of routes) {
      for (const { node, d, x, y } of viol) {
        dirty = true;
        let vx = xs[node] - x;
        let vy = ys[node] - y;
        if (vx === 0 && vy === 0) {
          vx = 1;
          vy = 0;
        }
        const vl = Math.hypot(vx, vy);
        const push = MIN_SPACING / 2 - d + 1;
        dxs[node] += (vx / vl) * push;
        dys[node] += (vy / vl) * push;
      }
    }
    if (!dirty) break;
    for (let i = 0; i < n; i += 1) {
      if (!pinned[i]) {
        xs[i] += dxs[i];
        ys[i] += dys[i];
      }
    }
  }
  for (let i = 0; i < n; i += 1) {
    xs[i] = Math.round(xs[i]);
    ys[i] = Math.round(ys[i]);
  }
  return routeEdges(xs, ys, edges);
}

// ---- 7. 라벨 ----
const LABEL_PLACEMENTS = [
  { sx: 1, sy: 0, anchor: 'start' },
  { sx: 1, sy: 1, anchor: 'start' },
  { sx: 0, sy: 1, anchor: 'middle' },
  { sx: -1, sy: 0, anchor: 'end' },
  { sx: 0, sy: -1, anchor: 'middle' },
  { sx: 1, sy: -1, anchor: 'start' },
  { sx: -1, sy: 1, anchor: 'end' },
  { sx: -1, sy: -1, anchor: 'end' },
];

function labelBoxFor(x, y, name, { dx, dy, anchor }) {
  const w = [...name].length * LABEL_CHAR_W;
  const ax = x + dx;
  const ay = y + dy;
  const xMin = anchor === 'start' ? ax : anchor === 'middle' ? ax - w / 2 : ax - w;
  return { xMin, xMax: xMin + w, yMin: ay - LABEL_H / 2, yMax: ay + LABEL_H / 2 };
}

const boxesOverlap = (a, b) => a.xMin < b.xMax && b.xMin < a.xMax && a.yMin < b.yMax && b.yMin < a.yMax;

function segmentHitsBox(ax, ay, bx, by, box) {
  // 선분-AABB 교차(Liang–Barsky)
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  const p = [-dx, dx, -dy, dy];
  const q = [ax - box.xMin, box.xMax - ax, ay - box.yMin, box.yMax - ay];
  for (let i = 0; i < 4; i += 1) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) {
        if (r > t1) return false;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return false;
        if (r < t1) t1 = r;
      }
    }
  }
  return true;
}

function placeLabels(nodes, xs, ys, routes, labelOverrides) {
  const placed = new Map();
  const boxes = [];
  const segments = routes.flatMap(({ pts }) => pts.slice(1).map((p, i) => [pts[i][0], pts[i][1], p[0], p[1]]));
  const order = nodes
    .map((node, i) => i)
    .sort((a, b) => nodes[b].lines.length - nodes[a].lines.length || nodes[a].id.localeCompare(nodes[b].id));
  const commit = (i, label) => {
    placed.set(i, label);
    boxes.push(labelBoxFor(xs[i], ys[i], nodes[i].name, label));
  };
  for (const i of order) {
    if (labelOverrides[i]) commit(i, labelOverrides[i]);
  }
  for (const i of order) {
    if (placed.has(i)) continue;
    let best = null;
    let bestCost = Infinity;
    for (let ring = 0; ring < LABEL_RINGS; ring += 1) {
      const gap = NODE_RADIUS + 3 + ring * LABEL_RING_STEP;
      LABEL_PLACEMENTS.forEach(({ sx, sy, anchor }, pref) => {
        const dx = sx * (sx !== 0 && sy !== 0 ? gap * 0.8 : gap);
        const dy = sy * (sy !== 0 ? gap * 0.8 + LABEL_H / 2 - 2 : 0);
        const label = { dx: Math.round(dx), dy: Math.round(dy), anchor };
        const box = labelBoxFor(xs[i], ys[i], nodes[i].name, label);
        const labelHits = boxes.filter((b) => boxesOverlap(b, box)).length;
        const pad = NODE_RADIUS + 1;
        const nodeHits = xs.filter(
          (x, k) => boxesOverlap({ xMin: x - pad, xMax: x + pad, yMin: ys[k] - pad, yMax: ys[k] + pad }, box),
        ).length;
        const edgeHits = segments.filter(([ax, ay, bx, by]) => segmentHitsBox(ax, ay, bx, by, box)).length;
        const cost = labelHits * 1e6 + nodeHits * 1e4 + edgeHits * 40 + ring * 3 + pref;
        if (cost < bestCost) {
          bestCost = cost;
          best = label;
        }
      });
    }
    commit(i, best);
  }
  return nodes.map((_, i) => placed.get(i));
}

// ---- 8. overrides ----
function loadOverrides(overrides) {
  const src = overrides ?? JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf-8'));
  return src.nodes ?? {};
}

/**
 * @param {{ mergeTransfers?: boolean, relax?: boolean, overrides?: object }} [options]
 *   mergeTransfers=false / relax=false 는 revert-red 검증용(해당 단계를 끈 빌드).
 */
function buildLayout(options = {}) {
  const { mergeTransfers = true, relax: doRelax = true } = options;
  const linesDef = JSON.parse(fs.readFileSync(LINES_PATH, 'utf-8'));
  const stations = JSON.parse(fs.readFileSync(STATIONS_PATH, 'utf-8')).filter(({ line }) => linesDef.lines[line]);
  const overrides = loadOverrides(options.overrides);

  const { entities, sequences } = buildEntities(linesDef, stations);
  const roots = mergeEntities(entities, mergeTransfers);
  const { nodes, edges, seqNodes } = buildGraph(entities, sequences, roots);

  const meters = projectSupported(nodes);
  fillUnknown(meters, seqNodes, edges);
  const cx = meters.reduce((sum, p) => sum + p.x, 0) / meters.length;
  const cy = meters.reduce((sum, p) => sum + p.y, 0) / meters.length;
  const outer = meters.map((p) => Math.hypot(p.x - cx, p.y - cy) > OUTER_RADIUS_M);
  const fish = fisheye(meters, cx, cy);
  const xs = fish.map((p) => p.x);
  const ys = fish.map((p) => p.y);
  const anchorXs = [...xs];
  const anchorYs = [...ys];

  const pinned = nodes.map(({ id }) => Boolean(overrides[id] && overrides[id].x !== undefined));
  nodes.forEach(({ id }, i) => {
    if (pinned[i]) {
      xs[i] = overrides[id].x;
      ys[i] = overrides[id].y;
    }
  });

  let routes;
  if (doRelax) {
    relax(xs, ys, anchorXs, anchorYs, edges, pinned, outer);
    routes = repairIntegers(xs, ys, edges, pinned);
  } else {
    xs.forEach((x, i) => {
      xs[i] = Math.round(x);
      ys[i] = Math.round(ys[i]);
    });
    routes = routeEdges(xs, ys, edges);
  }

  const labelOverrides = nodes.map(({ id }) => (overrides[id] && overrides[id].label ? overrides[id].label : null));
  const labels = placeLabels(nodes, xs, ys, routes, labelOverrides);

  // 평행 이동: 모든 요소(node·꺾임점·라벨)가 MARGIN 이상 양수 좌표
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (x0, y0, x1, y1) => {
    minX = Math.min(minX, x0);
    minY = Math.min(minY, y0);
    maxX = Math.max(maxX, x1);
    maxY = Math.max(maxY, y1);
  };
  nodes.forEach((node, i) => {
    grow(xs[i] - NODE_RADIUS, ys[i] - NODE_RADIUS, xs[i] + NODE_RADIUS, ys[i] + NODE_RADIUS);
    const b = labelBoxFor(xs[i], ys[i], node.name, labels[i]);
    grow(b.xMin, b.yMin, b.xMax, b.yMax);
  });
  routes.forEach(({ points }) => points.forEach(([x, y]) => grow(x, y, x, y)));
  const shiftX = Math.ceil(MARGIN - minX);
  const shiftY = Math.ceil(MARGIN - minY);

  const outNodes = {};
  [...nodes.keys()]
    .sort((a, b) => (nodes[a].id < nodes[b].id ? -1 : 1))
    .forEach((i) => {
      const { id, name, lines, stationIds, supported } = nodes[i];
      outNodes[id] = { x: xs[i] + shiftX, y: ys[i] + shiftY, name, lines, stationIds, supported, label: labels[i] };
    });
  const outEdges = edges.map(({ line, from, to }, e) => {
    const { points } = routes[e];
    const edge = { line, from: nodes[from].id, to: nodes[to].id };
    if (points.length) edge.points = points.map(([x, y]) => [x + shiftX, y + shiftY]);
    return edge;
  });
  return {
    version: 1,
    bounds: { w: Math.ceil(maxX + shiftX + MARGIN), h: Math.ceil(maxY + shiftY + MARGIN) },
    nodes: outNodes,
    edges: outEdges,
  };
}

function main() {
  const layout = buildLayout();
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(layout)}\n`);
  const nodeCount = Object.keys(layout.nodes).length;
  const unsupported = Object.values(layout.nodes).filter(({ supported }) => !supported).length;
  const applied = Object.keys(loadOverrides()).filter((id) => layout.nodes[id]).length;
  console.log(
    `schematicLayout.json: nodes ${nodeCount} (supported:false ${unsupported}), edges ${layout.edges.length}, bounds ${layout.bounds.w}x${layout.bounds.h}, overrides applied ${applied}`,
  );
}

if (require.main === module) main();

module.exports = {
  buildLayout,
  MIN_SPACING,
  NODE_RADIUS,
  LABEL_CHAR_W,
  LABEL_H,
  MERGE_MAX_METERS,
  keyOf,
};
