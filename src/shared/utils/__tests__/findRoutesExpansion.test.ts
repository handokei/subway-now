import {
  findRouteCandidatesByCategory,
  findRoutes,
  findStationByNameAndLine,
  routeSignature,
  type RouteCandidate,
} from '../stationRoute';
import { MULTI_TRANSFER_CANDIDATE_LIMIT } from '../../constants/routeCandidates';

// #1480 PR-2 — 후보 확장: 단일 환승 모든 공통역 + 다중 환승 (t1,t2) 상위 K, routeSignature 중복 제거.
// 기본 findRoutes(알람·findRoute 폴백)는 불변, `{ expand: true }`만 확장한다.
const id = (name: string, line: '1' | '2' | '7') => findStationByNameAndLine(name, line)!.id;
const transferNames = (list: RouteCandidate[]) =>
  list.flatMap(({ route }) => (route.type === 'transfer' ? [route.transferName] : []));
const multiCandidates = (list: RouteCandidate[]) => list.filter(({ route }) => route.type === 'multi-transfer');

describe('findRoutes { expand: true }', () => {
  it('7 -> 2 용마산 -> 뚝섬: 건대입구뿐 아니라 대림 환승 후보가 존재한다', () => {
    const names = transferNames(findRoutes(id('용마산', '7'), id('뚝섬', '2'), { expand: true }));
    expect(names).toEqual(expect.arrayContaining(['건대입구', '대림']));
  });

  it('2 -> 7 성수 -> 용마산: 두 단일 환승 후보 + 다중 환승 후보가 존재한다', () => {
    const list = findRoutes(id('성수', '2'), id('용마산', '7'), { expand: true });
    expect(transferNames(list)).toEqual(expect.arrayContaining(['건대입구', '대림']));
    expect(multiCandidates(list).length).toBeGreaterThan(0);
  });

  it('다중 환승 후보는 상한 K를 넘지 않고, routeSignature가 모두 유일하다', () => {
    const list = findRoutes(id('성수', '2'), id('용마산', '7'), { expand: true });
    expect(multiCandidates(list).length).toBeLessThanOrEqual(MULTI_TRANSFER_CANDIDATE_LIMIT);
    const sigs = list.map(({ route }) => routeSignature(route));
    expect(new Set(sigs).size).toBe(sigs.length);
  });

  it('travelMinutes 오름차순으로 정렬돼 반환된다', () => {
    const list = findRoutes(id('용마산', '7'), id('뚝섬', '2'), { expand: true });
    const minutes = list.map((c) => c.travelMinutes);
    expect(minutes).toEqual([...minutes].sort((a, b) => a - b));
  });

  it('같은 노선 직통은 확장해도 후보 1개', () => {
    expect(findRoutes(id('용마산', '7'), id('건대입구', '7'), { expand: true })).toHaveLength(1);
  });

  it('확장 후보는 기본 후보(최소 정거장 단일 + 최소 다중)를 모두 포함한다(기존 1위를 잃지 않는다)', () => {
    const base = findRoutes(id('용마산', '7'), id('뚝섬', '2')).map(({ route }) => routeSignature(route));
    const expanded = findRoutes(id('용마산', '7'), id('뚝섬', '2'), { expand: true }).map(({ route }) => routeSignature(route));
    for (const sig of base) expect(expanded).toContain(sig);
  });
});

describe('findRoutes 기본(확장 없음) — 알람·findRoute 폴백 동작 불변', () => {
  it('용마산 -> 뚝섬: 최소 정거장 단일 1개 + 다중 1개, 대림 후보 없음', () => {
    const list = findRoutes(id('용마산', '7'), id('뚝섬', '2'));
    expect(list.map((c) => c.route.type).sort()).toEqual(['multi-transfer', 'transfer']);
    expect(transferNames(list)).toEqual(['건대입구']);
  });
});

describe('findRouteCandidatesByCategory — 확장 후보에서 고른다', () => {
  it('칩 후보 풀에 대림 환승이 포함된다(풀 최소 travelMinutes가 단일 최소 정거장 후보 이하)', () => {
    const [optimal] = findRouteCandidatesByCategory([id('용마산', '7')], id('뚝섬', '2'));
    const pool = findRoutes(id('용마산', '7'), id('뚝섬', '2'), { expand: true });
    expect(optimal.candidate.travelMinutes).toBe(Math.min(...pool.map((c) => c.travelMinutes)));
  });
});
