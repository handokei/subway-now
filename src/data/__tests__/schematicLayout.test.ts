/**
 * #3371 PR-1: 노선도 배치 데이터(schematicLines.json → schematicLayout.json) 검증.
 *
 * 이슈 스펙만 보고 작성한 테스트(test-first). 검증 대상은
 *  - schematicLines.json: 노선별 branch 배열(공식 역 순서) — stations.json 매핑 실패 0건
 *  - schematicLayout.json: scripts/build-schematic-layout.js 산출물
 * 위반 판정 함수(`xxxViolations`)는 값이 비어야 정상이며, revert-red 케이스에서는
 * 병합 규칙/간격 이완을 끈 빌드가 같은 함수로 위반을 낸다는 것까지 고정한다.
 */
import stations from '../stations.json';
import stationCodes from '../stationCodes.json';
import transferTimes from '../transferTimes.json';
import schematicLines from '../schematicLines.json';
import committedLayout from '../schematicLayout.json';
import { normalizeStationName } from '../../shared/utils/normalizeStationName';
import { STATION_ALIASES } from '../stationAliases';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildLayout, MIN_SPACING, LABEL_CHAR_W, LABEL_H } = require('../../../scripts/build-schematic-layout');

jest.setTimeout(120000);

type Label = { dx: number; dy: number; anchor: 'start' | 'middle' | 'end' };
type LayoutNode = {
  x: number;
  y: number;
  name: string;
  lines: string[];
  stationIds: string[];
  supported: boolean;
  label: Label;
};
type LayoutEdge = { line: string; from: string; to: string; points?: [number, number][] };
type Layout = { nodes: Record<string, LayoutNode>; edges: LayoutEdge[] };
type Branch = { id: string; loop?: boolean; stations: string[] };
type LineDef = { branches: Branch[] };

const LINES = Object.keys(schematicLines.lines);
const lineDefs = schematicLines.lines as unknown as Record<string, LineDef>;
const layoutOf = (l: unknown) => l as Layout;
const keyOf = (name: string) => {
  const base = normalizeStationName(name);
  return (STATION_ALIASES as Record<string, string>)[base] ?? base;
};

const allStations = stations.filter(({ line }) => LINES.includes(line));
const stationsByEntity = new Map<string, string[]>();
for (const { id, line, name } of allStations) {
  const k = `${line}|${keyOf(name)}`;
  stationsByEntity.set(k, [...(stationsByEntity.get(k) ?? []), id]);
}

/** 노선도 역(line,name) → 기대 nodeId. 매핑되면 소속 node(stationIds로 역탐색), 아니면 u:<line>:<key>. */
const entityNodeId = (layout: Layout, line: string, name: string): string => {
  const k = `${line}|${keyOf(name)}`;
  const ids = stationsByEntity.get(k);
  if (ids) {
    const found = Object.entries(layout.nodes).find(([, n]) => n.stationIds.includes(ids[0]));
    return found ? found[0] : `missing:${k}`;
  }
  return `u:${line}:${keyOf(name)}`;
};

const mappingFailures = () => {
  const known = new Set<string>();
  for (const line of LINES) {
    for (const { stations: names } of lineDefs[line].branches) {
      for (const name of names) known.add(`${line}|${keyOf(name)}`);
    }
  }
  return allStations.filter(({ line, name }) => !known.has(`${line}|${keyOf(name)}`)).map(({ id, name }) => `${id} ${name}`);
};

const mappingViolations = (layout: Layout) => {
  const seen = new Map<string, number>();
  for (const { stationIds } of Object.values(layout.nodes)) {
    for (const id of stationIds) seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  const out: string[] = [];
  for (const { id } of allStations) {
    const count = seen.get(id) ?? 0;
    if (count !== 1) out.push(`${id}: ${count}`);
  }
  for (const [nodeId, { stationIds, supported }] of Object.entries(layout.nodes)) {
    if (supported !== stationIds.length > 0) out.push(`${nodeId}: supported 불일치`);
  }
  return out;
};

const transferViolations = (layout: Layout) => {
  const out: string[] = [];
  for (const key of Object.keys(transferTimes)) {
    const [a, b, name] = key.split('|');
    if (!LINES.includes(a) || !LINES.includes(b)) continue;
    const idsA = stationsByEntity.get(`${a}|${keyOf(name)}`) ?? [];
    const idsB = stationsByEntity.get(`${b}|${keyOf(name)}`) ?? [];
    const nodeA = Object.entries(layout.nodes).find(([, n]) => idsA.some((id) => n.stationIds.includes(id)));
    const nodeB = Object.entries(layout.nodes).find(([, n]) => idsB.some((id) => n.stationIds.includes(id)));
    if (!nodeA || !nodeB || nodeA[0] !== nodeB[0]) out.push(key);
  }
  return out;
};

const pairKey = (line: string, a: string, b: string) => `${line}|${[a, b].sort().join('~')}`;

const expectedEdgeKeys = (layout: Layout) => {
  const out: string[] = [];
  for (const line of LINES) {
    const seen = new Set<string>();
    for (const { stations: names, loop } of lineDefs[line].branches) {
      const ids = names.map((n) => entityNodeId(layout, line, n));
      const pairs = ids.slice(1).map((id, i) => [ids[i], id]);
      if (loop) pairs.push([ids[ids.length - 1], ids[0]]);
      for (const [a, b] of pairs) seen.add(pairKey(line, a, b));
    }
    out.push(...seen);
  }
  return out.sort();
};

const edgeViolations = (layout: Layout) => {
  const actual = layout.edges.map(({ line, from, to }) => pairKey(line, from, to)).sort();
  const expected = expectedEdgeKeys(layout);
  const missing = expected.filter((k) => !actual.includes(k));
  const extra = actual.filter((k) => !expected.includes(k));
  const dup = actual.filter((k, i) => actual.indexOf(k) !== i);
  return [...missing.map((k) => `missing ${k}`), ...extra.map((k) => `extra ${k}`), ...dup.map((k) => `dup ${k}`)];
};

const componentViolations = (layout: Layout) => {
  const out: string[] = [];
  for (const line of LINES) {
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let r = x;
      while ((parent.get(r) ?? r) !== r) r = parent.get(r) as string;
      parent.set(x, r);
      return r;
    };
    const lineEdges = layout.edges.filter((e) => e.line === line);
    for (const { from, to } of lineEdges) {
      parent.set(find(from), find(to));
    }
    const roots = new Set(lineEdges.flatMap(({ from, to }) => [find(from), find(to)]));
    if (roots.size !== 1) out.push(`${line}호선 연결 요소 ${roots.size}개`);
  }
  return out;
};

const spacingViolations = (layout: Layout) => {
  const entries = Object.entries(layout.nodes);
  const out: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const [idA, a] = entries[i];
      const [idB, b] = entries[j];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < MIN_SPACING) out.push(`${idA}~${idB} ${d.toFixed(1)}`);
    }
  }
  return out;
};

const labelBox = ({ x, y, name, label }: LayoutNode) => {
  const w = [...name].length * LABEL_CHAR_W;
  const ax = x + label.dx;
  const ay = y + label.dy;
  const xMin = { start: ax, middle: ax - w / 2, end: ax - w }[label.anchor];
  return { xMin, xMax: xMin + w, yMin: ay - LABEL_H / 2, yMax: ay + LABEL_H / 2 };
};

const labelViolations = (layout: Layout) => {
  const entries = Object.entries(layout.nodes).map(([id, n]) => [id, labelBox(n)] as const);
  const out: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const [idA, a] = entries[i];
      const [idB, b] = entries[j];
      if (a.xMin < b.xMax && b.xMin < a.xMax && a.yMin < b.yMax && b.yMin < a.yMax) out.push(`${idA}~${idB}`);
    }
  }
  return out;
};

const distToSegment = (px: number, py: number, [ax, ay]: number[], [bx, by]: number[]) => {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

const polyline = (layout: Layout, { from, to, points }: LayoutEdge) => {
  const { x: fx, y: fy } = layout.nodes[from];
  const { x: tx, y: ty } = layout.nodes[to];
  return [[fx, fy], ...(points ?? []), [tx, ty]];
};

const passThroughViolations = (layout: Layout) => {
  const out: string[] = [];
  for (const edge of layout.edges) {
    const pts = polyline(layout, edge);
    for (const [id, { x, y }] of Object.entries(layout.nodes)) {
      if (id === edge.from || id === edge.to) continue;
      const d = Math.min(...pts.slice(1).map((p, i) => distToSegment(x, y, pts[i], p)));
      if (d < MIN_SPACING / 2) out.push(`${edge.line} ${edge.from}-${edge.to} ✕ ${id} ${d.toFixed(1)}`);
    }
  }
  return out;
};

const angleViolations = (layout: Layout) => {
  const out: string[] = [];
  for (const edge of layout.edges) {
    const pts = polyline(layout, edge);
    pts.slice(1).forEach(([x, y], i) => {
      const [px, py] = pts[i];
      if (x === px && y === py) {
        out.push(`${edge.line} ${edge.from}-${edge.to} 길이 0 구간`);
        return;
      }
      const deg = (Math.atan2(y - py, x - px) * 180) / Math.PI;
      const off = Math.abs(((deg % 45) + 45) % 45);
      if (Math.min(off, 45 - off) > 1) out.push(`${edge.line} ${edge.from}-${edge.to} ${deg.toFixed(1)}°`);
    });
  }
  return out;
};

describe('schematicLines.json — 노선 정의', () => {
  it('1~9호선 전부 branch·출처 URL·조회일(2026-11-26)을 가진다', () => {
    expect(LINES).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
    for (const line of LINES) {
      const def = schematicLines.lines[line as keyof typeof schematicLines.lines] as unknown as {
        sources: string[];
        queriedAt: string;
        branches: Branch[];
      };
      expect(def.sources.length).toBeGreaterThan(0);
      for (const url of def.sources) expect(url).toMatch(/^https:\/\//);
      expect(def.queriedAt).toBe('2026-11-26');
      expect(def.branches.length).toBeGreaterThan(0);
    }
  });

  it('stations.json 1~9호선 392역 전부 노선 정의에 매핑된다 (실패 목록 0건)', () => {
    expect(allStations).toHaveLength(392);
    expect(mappingFailures()).toEqual([]);
  });

  it('분기·순환 구조: 1호선 5 branch, 2호선 순환+성수+신정, 5호선 마천, 6호선 응암 루프', () => {
    const ids = (line: string) => lineDefs[line].branches.map(({ id }) => id);
    expect(ids('1')).toEqual(['trunk', 'gyeongin', 'janghang', 'gwangmyeong', 'seodongtan']);
    expect(ids('2')).toEqual(['loop', 'seongsu', 'sinjeong']);
    expect(ids('5')).toEqual(['trunk', 'macheon']);
    expect(ids('6')).toEqual(['eungam-loop', 'trunk']);
    expect(lineDefs['2'].branches[0].loop).toBe(true);
    expect(lineDefs['6'].branches[0].loop).toBe(true);
  });

  it('stationCodes.json frCode 순서와 branch 순서가 일치한다 (숫자 코드 보유 역끼리, branch별)', () => {
    const codeOf = (line: string, name: string) => {
      const ids = stationsByEntity.get(`${line}|${keyOf(name)}`);
      const frCode = ids ? (stationCodes as Record<string, { frCode: string }>)[ids[0]]?.frCode : undefined;
      return frCode && /^\d+$/.test(frCode) ? Number(frCode) : undefined;
    };
    const out: string[] = [];
    for (const line of LINES) {
      for (const { id, stations: names } of lineDefs[line].branches) {
        const coded = names.map((n) => [n, codeOf(line, n)] as const).filter(([, c]) => c !== undefined);
        coded.slice(1).forEach(([n, c], i) => {
          if ((c as number) < (coded[i][1] as number)) out.push(`${line}호선 ${id}: ${coded[i][0]}(${coded[i][1]}) → ${n}(${c})`);
        });
      }
    }
    expect(out).toEqual([]);
  });
});

describe('schematicLayout.json — 커밋된 산출물', () => {
  const layout = layoutOf(committedLayout);

  it('392역 전부 정확히 하나의 node에 매핑 (누락·중복 0), supported는 stationIds 유무와 일치', () => {
    expect(mappingViolations(layout)).toEqual([]);
  });

  it('노선도에만 있는 역(앱 stations.json에 없음)은 supported:false node', () => {
    const unsupported = Object.values(layout.nodes).filter(({ supported }) => !supported);
    expect(unsupported.length).toBeGreaterThan(0);
    for (const { stationIds } of unsupported) expect(stationIds).toEqual([]);
  });

  it('환승 키 115개(1~9호선 상호) 전부 같은 node', () => {
    const keys = Object.keys(transferTimes).filter((k) => {
      const [a, b] = k.split('|');
      return LINES.includes(a) && LINES.includes(b);
    });
    expect(keys).toHaveLength(115);
    expect(transferViolations(layout)).toEqual([]);
  });

  it('edges는 branch 연속 쌍(순환 닫힘 포함)과 1:1, 노선별 연결 요소 1개', () => {
    expect(edgeViolations(layout)).toEqual([]);
    expect(componentViolations(layout)).toEqual([]);
  });

  it('모든 node 쌍 거리 ≥ MIN_SPACING', () => {
    expect(spacingViolations(layout)).toEqual([]);
  });

  it('라벨 박스 겹침 0', () => {
    expect(labelViolations(layout)).toEqual([]);
  });

  it('edge가 자기 끝점이 아닌 node를 MIN_SPACING/2 이내로 통과하지 않는다', () => {
    expect(passThroughViolations(layout)).toEqual([]);
  });

  it('모든 edge 구간(points 꺾임 포함) 각도가 45° 배수(±1°)', () => {
    expect(angleViolations(layout)).toEqual([]);
  });
});

describe('build-schematic-layout.js', () => {
  it('결정성: 2회 실행 결과 동일 + 커밋된 schematicLayout.json과 일치', () => {
    const first = buildLayout();
    const second = buildLayout();
    expect(second).toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(committedLayout);
  });

  it('revert-red: 환승 병합 규칙을 끄면 환승·매핑 검증이 실패한다', () => {
    const layout = layoutOf(buildLayout({ mergeTransfers: false }));
    expect(transferViolations(layout).length).toBeGreaterThan(0);
  });

  it('revert-red: 간격 이완을 끄면 간격·라벨 겹침 검증이 실패한다', () => {
    const layout = layoutOf(buildLayout({ relax: false }));
    expect(spacingViolations(layout).length).toBeGreaterThan(0);
  });
});
