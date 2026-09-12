/**
 * #1719 — Backend leg-direction 추론.
 *
 * 배경
 * ====
 * `lockSwap.attachTrainCodeForLeg` 는 `direction=null` 로 `resolveTrainCodeWithFallback` 을
 * 호출하므로, 양방향 trains 가 같은 station 에 있으면 wrong direction train 도 candidate 로
 * 통과한다. 2호선 외선/내선, 6호선 응암 방향 train 같은 사례에서 silent push 정확도 회귀.
 *
 * 본 모듈은 leg 의 첫 station + 마지막 station 의 stations.json id 를 비교해 진행 방향을
 * 추론한다. frontend `loopDirection.ts` + `travelDirection.ts` 와 동일 정책(`lineTopology.json`
 * 단일 SSoT) 이지만, backend 가 frontend `getStationsOnLine` 의존 그래프(stationRoute → logger,
 * lineColors) 를 끌어오지 않도록 backend-local 로 작성한다.
 *
 * 정책
 * ====
 *  - **monotonic 노선** (3/4/7/8/9/airport/bundang/sinbundang): stations.json id 단순 비교.
 *    `from.id > to.id` → 'up' (id 감소 = 상행), 아니면 'down'.
 *  - **closedLoop hybrid 노선** (6호선): mainIdRange 안에서 id 단조 비교. loopTailRange 가
 *    있으면 단방향 꼬리라 wrap 무의미 — 단순 id 비교만으로 frontend `inferLoopDirection` 의
 *    hybrid 분기와 정렬.
 *  - **closedLoop pure 노선** (2호선): mainIdRange 안 stations 의 forward/backward arc 길이
 *    비교. 짧은 호 채택 (forward < backward → down).
 *  - **그 외** (1/5/gyeongui 등 비단조/지선): null 반환. caller 는 기존 direction=null 동작
 *    유지 (현재 회귀 봉쇄 효과 0, 기존 implicit segmentStations 필터에 의존).
 *
 * 사용처
 * ======
 * `lockSwap.attachTrainCodeForLeg` 가 segmentStations[0] + segmentStations[last] 로 호출.
 * segmentStations.length < 2 (target == leg 마지막) 일 때는 caller 가 segmentStations[0] +
 * targetStation 으로 호출해도 결과 null (동일 역) → 안전.
 */

import lineTopology from '../../../src/data/lineTopology.json';
import { findStationByNameAndLine } from '../../../src/shared/utils/stationLookup';
import stationsRaw from '../../../src/data/stations.json';
import type { Station } from '../../../src/shared/types/station';
import type { LineNumber } from './types';

/** stations.json 전체 — 2호선 pure loop 의 mainIdRange 안 stations 만 추출용. */
const stations = stationsRaw as Station[];

interface ClosedLoopMeta {
  mainIdRange: { firstId: string; lastId: string };
  /** 있으면 hybrid 노선(P자 + 단방향 꼬리). 없으면 진짜 순환선. */
  loopTailRange?: { firstId: string; lastId: string };
}

const MONOTONIC_LINES: ReadonlySet<string> = new Set(lineTopology.monotonicLines);
const CLOSED_LOOPS = lineTopology.closedLoops as Partial<Record<string, ClosedLoopMeta>>;

/**
 * leg 의 진행 방향 추론. 추론 불가 시 null.
 *
 * 입력
 *   - line: leg 의 호선 (backend `LineNumber = string`).
 *   - fromStationName: leg 시작 (segmentStations[0] 추천).
 *   - toStationName: leg 끝 (segmentStations[last] 추천).
 *
 * 반환
 *   - 'up' | 'down' | null
 *
 * 동일 역(from === to canonical) 또는 매핑 실패 시 null.
 */
export function inferLegDirection(
  line: LineNumber,
  fromStationName: string,
  toStationName: string,
): 'up' | 'down' | null {
  const fromStation = findStationByNameAndLine(
    fromStationName,
    line as Parameters<typeof findStationByNameAndLine>[1],
  );
  const toStation = findStationByNameAndLine(
    toStationName,
    line as Parameters<typeof findStationByNameAndLine>[1],
  );
  if (!fromStation || !toStation) return null;
  if (fromStation.id === toStation.id) return null;

  // Monotonic 노선 + Hybrid closedLoop(6호선) — 단순 id 비교.
  // Hybrid 는 단방향 꼬리라 wrap 의미 X — frontend `inferLoopDirection` hybrid 분기와 정합.
  const hybrid = CLOSED_LOOPS[line];
  if (MONOTONIC_LINES.has(line) || (hybrid && hybrid.loopTailRange)) {
    return fromStation.id > toStation.id ? 'up' : 'down';
  }

  // Pure closedLoop(2호선) — mainIdRange 안 forward/backward arc 길이 비교.
  if (hybrid && !hybrid.loopTailRange) {
    const { firstId, lastId } = hybrid.mainIdRange;
    const main = stations.filter(
      (s) => s.line === line && s.id >= firstId && s.id <= lastId,
    );
    if (main.length < 2) return null;
    const fromIdx = main.findIndex((s) => s.id === fromStation.id);
    const toIdx = main.findIndex((s) => s.id === toStation.id);
    if (fromIdx === -1 || toIdx === -1) return null; // 지선 (mainIdRange 밖)
    const n = main.length;
    const forward = (toIdx - fromIdx + n) % n;
    const backward = n - forward;
    if (forward === backward) return null; // 정반대 위치 — ambiguous
    return forward < backward ? 'down' : 'up';
  }

  // 비단조 + closedLoop 등록 X (1/5/gyeongui) — 추론 불가.
  return null;
}
