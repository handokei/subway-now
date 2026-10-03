import type { LineNumber, Station } from '../types/station';

/**
 * Closed loop 본선의 id 범위 SSOT.
 *
 * 2호선 본선은 시청(2-001) ↔ 충정로(2-043)가 인접한 closed loop이지만
 * `getLineStationsCached('2')`는 id 사전순으로 정렬되어 인접관계를 잃는다.
 * 단순 `step ±1` walk만 사용하면 외선(잠실 우회) 27 hop을 강제 선택해
 * 사용자 의도(내선 16 hop)와 정반대 방향이 산출된다 (이슈 #1698).
 *
 * 까치산 지선(2-105) / 신설동 지선(2-205)은 본선과 별도 경로이므로
 * wraparound를 적용하지 않는다 (lastId 안에 포함되지 않으면 자동 제외).
 *
 * 새 closed loop 추가는 이 상수만 갱신한다.
 */
const CLOSED_LOOP_MAIN_ID_RANGES: Partial<Record<LineNumber, { firstId: string; lastId: string }>> = {
  '2': { firstId: '2-001', lastId: '2-043' },
};

/**
 * 주어진 line/id가 closed loop 본선 range에 속하는지.
 * 지선/직선 line은 false.
 */
export function isClosedLoopMainStation(line: LineNumber, id: string): boolean {
  const range = CLOSED_LOOP_MAIN_ID_RANGES[line];
  if (!range) return false;
  return id >= range.firstId && id <= range.lastId;
}

/**
 * 같은 line 위 두 station idx 사이의 짧은 path indices.
 *
 * - Closed loop 본선(양 끝 모두 본선 range 안)이면 정방향 vs wraparound 짧은 쪽 선택.
 * - 그 외(지선 포함 또는 직선 line)는 기존 단순 정방향 slice.
 * - 두 방향 hop 수가 같으면 정방향 (안정성).
 *
 * @returns 진행 방향으로 정렬된 idx 배열 (양 끝 포함). `fromIdx === toIdx`면 `[fromIdx]`.
 */
export function shortestLinePathIndices(
  lineStations: readonly Station[],
  fromIdx: number,
  toIdx: number,
  line: LineNumber,
): number[] {
  if (fromIdx === toIdx) return [fromIdx];

  const forwardIndices = buildForward(fromIdx, toIdx);

  const fromId = lineStations[fromIdx]?.id;
  const toId = lineStations[toIdx]?.id;
  /* istanbul ignore next -- caller가 valid idx를 넘긴다는 invariant */
  if (!fromId || !toId) return forwardIndices;
  if (!isClosedLoopMainStation(line, fromId) || !isClosedLoopMainStation(line, toId)) {
    return forwardIndices;
  }

  const mainLineIndices: number[] = [];
  for (let i = 0; i < lineStations.length; i++) {
    if (isClosedLoopMainStation(line, lineStations[i].id)) {
      mainLineIndices.push(i);
    }
  }
  const subFromPos = mainLineIndices.indexOf(fromIdx);
  const subToPos = mainLineIndices.indexOf(toIdx);
  /* istanbul ignore next -- 위 isClosedLoopMainStation 통과 시 본선 list에 포함 invariant */
  if (subFromPos === -1 || subToPos === -1) return forwardIndices;

  const subLen = mainLineIndices.length;
  // 본선 subset 안에서 +1 (idx 증가) / -1 (idx 감소) 두 방향 hop 수 비교.
  // 같으면 +1 방향 선택 (안정성).
  const plusHops = (subToPos - subFromPos + subLen) % subLen;
  const minusHops = subLen - plusHops;
  const usePlusDirection = plusHops <= minusHops;
  const totalHops = usePlusDirection ? plusHops : minusHops;
  const directionSign = usePlusDirection ? 1 : -1;

  const indices: number[] = [];
  for (let step = 0; step <= totalHops; step++) {
    const subPos = (subFromPos + directionSign * step + subLen) % subLen;
    indices.push(mainLineIndices[subPos]);
  }
  return indices;
}

function buildForward(fromIdx: number, toIdx: number): number[] {
  const step = fromIdx < toIdx ? 1 : -1;
  const out: number[] = [];
  for (let i = fromIdx; i !== toIdx; i += step) {
    out.push(i);
  }
  out.push(toIdx);
  return out;
}

/**
 * 같은 line 위 두 station idx 사이 hop 수(wraparound aware).
 *
 * Closed loop 본선이면 짧은 쪽 hop 수, 그 외(지선/직선)는 정방향 idx 차이.
 * `pickCandidateTrains` 같은 anchor 기준 거리 비교에 사용 — 직선 `Math.abs(a-b)`로는
 * 2호선 본선 wraparound 가까운 train이 멀리 인식되어 window/sort에서 누락된다(#1722).
 */
export function hopsOnLine(
  lineStations: readonly Station[],
  fromIdx: number,
  toIdx: number,
  line: LineNumber,
): number {
  return shortestLinePathIndices(lineStations, fromIdx, toIdx, line).length - 1;
}
