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
 * Closed loop 본선 subset(순서대로 idx 목록) 안에서 fromIdx → toIdx 최단 경로의 방향 산출.
 *
 * `plusHops`(subset 안에서 +1 방향 hop 수)와 `minusHops`(-1 방향 hop 수, wraparound 포함)를
 * 비교해 짧은 쪽을 고른다 — #2867 arc-length ground truth(plusHops <= minusHops → '+1' 방향).
 * 같으면 +1 방향 선택(안정성). `shortestLinePathIndices`(경로 생성)와 `travelDirectionSign`
 * (방향 부호만 필요한 호출자)이 **이 하나의 계산만** 공유한다 — #2949: 호출자가 이 값을 버리고
 * `path[1]`을 idx와 다시 크기 비교하면 seam(subPos 0/본선 끝)에서 틀린다(wrap이 "idx 증가"로
 * 오인됨). 틀릴 수 있는 재계산 코드를 아예 없애는 것이 이 함수의 목적.
 */
function resolveClosedLoopSubsetDirection(
  mainLineIndices: readonly number[],
  subFromPos: number,
  subToPos: number,
): { usePlusDirection: boolean; totalHops: number } {
  const subLen = mainLineIndices.length;
  const plusHops = (subToPos - subFromPos + subLen) % subLen;
  const minusHops = subLen - plusHops;
  const usePlusDirection = plusHops <= minusHops;
  const totalHops = usePlusDirection ? plusHops : minusHops;
  return { usePlusDirection, totalHops };
}

/** closed loop 본선 subset(idx 목록) 조회 — `shortestLinePathIndices`/`travelDirectionSign` 공유. */
function closedLoopMainIndices(lineStations: readonly Station[], line: LineNumber): number[] {
  const mainLineIndices: number[] = [];
  for (let i = 0; i < lineStations.length; i++) {
    if (isClosedLoopMainStation(line, lineStations[i].id)) {
      mainLineIndices.push(i);
    }
  }
  return mainLineIndices;
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

  const mainLineIndices = closedLoopMainIndices(lineStations, line);
  const subFromPos = mainLineIndices.indexOf(fromIdx);
  const subToPos = mainLineIndices.indexOf(toIdx);
  /* istanbul ignore next -- 위 isClosedLoopMainStation 통과 시 본선 list에 포함 invariant */
  if (subFromPos === -1 || subToPos === -1) return forwardIndices;

  const subLen = mainLineIndices.length;
  const { usePlusDirection, totalHops } = resolveClosedLoopSubsetDirection(
    mainLineIndices,
    subFromPos,
    subToPos,
  );
  const directionSign = usePlusDirection ? 1 : -1;

  const indices: number[] = [];
  for (let step = 0; step <= totalHops; step++) {
    const subPos = (subFromPos + directionSign * step + subLen) % subLen;
    indices.push(mainLineIndices[subPos]);
  }
  return indices;
}

/**
 * 같은 line 위 두 station idx 사이의 진행 방향 부호 — #2949 단일 primitive.
 *
 * `shortestLinePathIndices`가 경로를 만들며 계산하고 버리던 `directionSign`
 * (`usePlusDirection ? 1 : -1`)을 그대로 반환한다. 호출자는 이 부호만으로 'up'/'down'을
 * 매핑하고, **`path[1]`을 idx와 다시 크기 비교하지 않는다** — 그 재계산이 closed loop seam
 * (시청 idx=0, 충정로 idx=42)에서 틀린 원인이었다(#2949): seam station을 fromIdx로 쓰면
 * wraparound 여부와 무관하게 `path[1] > fromIdx`가 항상 참(시청)/거짓(충정로)이 되어 방향이
 * 고정값으로 오판된다.
 *
 * - Closed loop 본선 양 끝(둘 다 `isClosedLoopMainStation`)이면 그 subset 안에서 wraparound-aware
 *   plusHops/minusHops 비교로 부호 산출 — `shortestLinePathIndices`와 동일 계산(공유, 사본 아님).
 * - 그 외(단조 노선, 지선, 또는 한쪽만 본선)는 wraparound가 없으므로 단순 idx 대소.
 * - `fromIdx === toIdx` 또는 둘 중 하나라도 유효하지 않은 idx면 null(판정 불가).
 *
 * @returns `1`(plus/증가 방향 — closed loop 본선이면 내선) | `-1`(그 반대) | `null`.
 */
export function travelDirectionSign(
  lineStations: readonly Station[],
  fromIdx: number,
  toIdx: number,
  line: LineNumber,
): 1 | -1 | null {
  if (fromIdx === toIdx) return null;

  const fromId = lineStations[fromIdx]?.id;
  const toId = lineStations[toIdx]?.id;
  if (!fromId || !toId) return null;

  if (!isClosedLoopMainStation(line, fromId) || !isClosedLoopMainStation(line, toId)) {
    return fromIdx < toIdx ? 1 : -1;
  }

  const mainLineIndices = closedLoopMainIndices(lineStations, line);
  const subFromPos = mainLineIndices.indexOf(fromIdx);
  const subToPos = mainLineIndices.indexOf(toIdx);
  /* istanbul ignore next -- 위 isClosedLoopMainStation 통과 시 본선 list에 포함 invariant
     (shortestLinePathIndices와 동일 방어 패턴) */
  if (subFromPos === -1 || subToPos === -1) return fromIdx < toIdx ? 1 : -1;

  const { usePlusDirection } = resolveClosedLoopSubsetDirection(mainLineIndices, subFromPos, subToPos);
  return usePlusDirection ? 1 : -1;
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
