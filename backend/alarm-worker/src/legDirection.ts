/**
 * #1719 — Backend leg-direction 추론.
 * #2943 (plan 2026-10-10 J1+J2, 방안 H-1) — 화이트리스트 분기(monotonic/closedLoop) 제거,
 * device `directionOnLine`(#2455, `src/features/route/utils/directionOnLine.ts`)과 **같은**
 * `shortestLinePathIndices` 기반 단일 알고리즘으로 교체. 전 노선 커버(1·5·경의중앙 포함).
 *
 * 배경
 * ====
 * `lockSwap.attachTrainCodeForLeg` 는 `direction=null` 로 `resolveTrainCodeWithFallback` 을
 * 호출하므로, 양방향 trains 가 같은 station 에 있으면 wrong direction train 도 candidate 로
 * 통과한다. 2호선 외선/내선, 6호선 응암 방향 train 같은 사례에서 silent push 정확도 회귀.
 *
 * #2943 전 정책은 `MONOTONIC_LINES`/`CLOSED_LOOPS` 화이트리스트 밖(1/5/경의중앙선)이면 무조건
 * null을 반환했다 — 10/9 실측(군자→광화문, 5호선)에서 반대 방향 열차(5559, 마천행 하행)가
 * null 방향 필터를 그대로 통과해 프롬프트에 제시·lock됐다(이슈 #2943 본문).
 *
 * device 쪽은 `directionOnLine`이 **화이트리스트 없이** 이미 전 노선을 커버한다 — 같은 노선
 * 위 두 station id 사이를 `shortestLinePathIndices`(2호선 closed-loop wraparound-aware 최단
 * 경로, `lineLoopPath.ts`)로 구하고 첫 step의 idx 증감만으로 방향을 결정한다. 그 설계 근거
 * (`directionOnLine.ts` 상단 doc)는 `resolveTravelDirection`(단조)/`inferLoopDirection`(호
 * 길이 비교) **조합 방식을 폐기**한 이유를 적어뒀다 — 2호선 seam(시청↔충정로)에서 그 두
 * 알고리즘의 wraparound 판정이 서로 어긋나는 사례가 있었다(#2455). backend의 기존 화이트리스트
 * 분기(monotonic id 비교 + pure-loop arc 비교)가 정확히 그 "조합" 방식이었다.
 *
 * 공유 가능성 판단(이슈 #2943 요구) — import, 이식 아님
 * ====
 * `shortestLinePathIndices`/`isClosedLoopMainStation`(`src/shared/utils/lineLoopPath.ts`)을
 * **그대로 import** 한다 — 순수 함수이고 타입만 import하는 `station.ts` 외 런타임 의존이
 * 없어, 이 파일 상단 doc이 경고하는 "frontend `getStationsOnLine` 의존 그래프(stationRoute →
 * logger, lineColors, stationEta, transferTimes, lineSpeeds)"를 전혀 끌어오지 않는다.
 * `directionOnLine.ts` 자체(또는 `getStationsOnLine`)는 import하지 않는다 — 그 모듈이 의존하는
 * `stationRoute.ts`가 바로 그 무거운 그래프이기 때문이다. 대신 `getStationsOnLine`이 내부적으로
 * 하는 일(`stations.filter(line).sort(id)`, `stationRoute.ts:91-98`)을 `getLineStationsSorted`로
 * backend-local 재구현한다 — 이 2줄짜리 로직은 backend가 이미 pure-loop 분기에서 쓰고 있던
 * 패턴과 동일해 "이식"이 아니라 이미 존재하던 backend-local 코드의 연장이다. 화이트리스트
 * 분기 로직(알고리즘의 핵심)은 공유, 역 목록 조회(인프라 디테일)만 로컬 — 이 둘을 섞으면
 * 비대칭이 재생산되므로 알고리즘 쪽을 공유 대상으로 선택했다.
 *
 * 정책
 * ====
 *  - 노선 위 모든 station id를 정렬한 배열에서 from/to idx를 구하고 `shortestLinePathIndices`로
 *    최단 경로를 구한다. 2호선처럼 closed-loop 본선(`isClosedLoopMainStation`)이면 그 안에서
 *    wraparound-aware 최단 경로, 그 외(1/3/4/5/6/7/8/9/경의중앙/공항/분당/신분당 지선 포함)는
 *    단순 forward slice — `lineLoopPath.ts`가 이미 그 분기를 품고 있다.
 *  - 첫 step(`path[1]`)이 fromIdx보다 크면(= id 증가 방향으로 진행) 그 반대, 작으면 그대로 —
 *    closed-loop 본선 양 끝이면 idx 증가=내선='up'(#2867 실측 52쌍 ground truth, device
 *    `directionOnLine`과 동일 분기), 그 외는 idx 증가='down'(id 감소=상행 전역 관례) 이다.
 *  - **신분당·수인분당**(`REVERSED_ORIENTATION_LINES`, #2877 실측 136건)만 역 정렬 극성이
 *    반대라 이 두 노선에서만 idx 증가='up'으로 뒤집는다 — 이 예외는 유지한다(이슈 #2943 스펙).
 *    device 쪽은 이 예외를 `directionOnLine.ts`가 아니라 더 상위 레이어 `resolveTripDirection`
 *    (`tripDirection.ts:163`)에서 적용한다 — backend는 leg 단위 두 station명만 받는 단일
 *    함수라 같은 보정을 이 함수 안에서 바로 적용한다.
 *  - 역이 그 노선에 없음(`findStationByNameAndLine` null) / from === to / idx 조회 실패 →
 *    null(판정 불가, caller는 기존 direction=null 동작 유지).
 *
 * 과차단 검증(#2943 거부 케이스 ⓒⓓ) — 지선 교차
 * ====
 * 5호선 마천/하남검단산 분기, 1호선 다중 종착/지선(소요산·인천·신창·광명·서동탄)에서
 * `shortestLinePathIndices`가 틀린 방향을 낼 위험을 직접 검증했다(`legDirection.test.ts`
 * "#2943 거부 케이스" describe 블록):
 *  - 5호선: `stations.json`에 하남검단산/하남풍산/하남시청이 **전혀 없다**(마천 분기 쪽만
 *    046까지 선형으로 존재) — 하남 방향 역명 조회는 항상 null이 되어 교차 쌍 자체가
 *    표현 불가능하다. 과차단 위험 자체가 데이터상 없음(검증 결과: 안전).
 *  - 1호선: 유일한 실제 분기점은 구로(1-042)↔가산디지털단지(1-100, 경부선 방면 유일 등록
 *    station)다. `shortestLinePathIndices`의 forward slice가 물리적으로 틀린 경로(인천
 *    경유)를 만들어내지만, 방향 판정은 **path[1]과 fromIdx의 대소(부호)만** 보므로 — 두
 *    분기 모두 구로보다 id가 크므로(인천행도, 가산디지털단지행도 "하행") 부호는 항상 맞게
 *    나온다(검증 결과: 안전, `legDirection.test.ts` 실측 검증). 광명/신창/서동탄/금천구청/
 *    병점/수원/천안 등은 stations.json에 없어 null(과차단 아님 — 판정 불가로 안전하게 수렴).
 *
 * 사용처
 * ======
 * `lockSwap.attachTrainCodeForLeg` 가 segmentStations[0] + segmentStations[last] 로 호출.
 * segmentStations.length < 2 (target == leg 마지막) 일 때는 caller 가 segmentStations[0] +
 * targetStation 으로 호출해도 결과 null(동일 역). **"안전"이 아니다** — 거짓 근거였다
 * (#2944 H-6 정정). null 은 이 함수 아래 fail-open 소비자(`pickAutoTrainCode` 구버전,
 * `freshCandidatesAtAnchor` 등)에서 "양방향 허용"으로 해석돼 반대 방향 열차가 후보에 그대로
 * 남는다 — 10/9 반대 방향 lock 사고(군자→광화문, 5호선)가 바로 이 null이 fail-open으로
 * 소비된 결과다. #2944 이후 이 null의 소비처는 전부 fail-closed로 전환됐고,
 * `lockSwap.ts:resolveLegOriginStation`가 segmentStations.length<2 (트립 꼬리)인 경우
 * trip의 leg 시작 앵커(`currentLegAnchor`/`originStationName`)를 "첫 역"으로 보강해 애초에
 * 이 null 자체를 줄인다 — 앵커조차 없을 때만 null이 남고, 그 경우는 fail-closed(후보 0건)로
 * 수렴한다. 상세는 `docs/agents/invariants.md` "거짓 근거" 항목 참고 — 이 근거로 새
 * fail-open을 만들지 말 것.
 */

import { findStationByNameAndLine } from '../../../src/shared/utils/stationLookup';
import stationsRaw from '../../../src/data/stations.json';
import lineTopology from '../../../src/data/lineTopology.json';
import {
  isClosedLoopMainStation,
  shortestLinePathIndices,
} from '../../../src/shared/utils/lineLoopPath';
import type { Station } from '../../../src/shared/types/station';
import type { LineNumber as SharedLineNumber } from '../../../src/shared/types/station';
import type { LineNumber } from './types';

/** stations.json 전체 — 노선별 station 목록 조회용. */
const stations = stationsRaw as Station[];

/** 노선별 station id 정렬 캐시 — `src/shared/utils/stationRoute.ts:getLineStationsCached`와
 *  동일 정렬 정책(id localeCompare)을 backend-local로 재구현(위 doc "공유 가능성" 참고). */
const lineStationsCache = new Map<string, Station[]>();
function getLineStationsSorted(line: string): Station[] {
  let cached = lineStationsCache.get(line);
  if (!cached) {
    cached = stations.filter((s) => s.line === line).sort((a, b) => a.id.localeCompare(b.id));
    lineStationsCache.set(line, cached);
  }
  return cached;
}

// #2877 — 신분당·수인분당은 stations.json 정렬 극성이 반대(id 증가=상행). 실측 근거는
// lineTopology.json의 `_reversedOrientationLines_comment` 참고.
const REVERSED_ORIENTATION_LINES: ReadonlySet<string> = new Set(lineTopology.reversedOrientationLines);

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

  const lineStations = getLineStationsSorted(line);
  const fromIdx = lineStations.findIndex((s) => s.id === fromStation.id);
  const toIdx = lineStations.findIndex((s) => s.id === toStation.id);
  /* istanbul ignore next -- invariant: fromStation/toStation은 findStationByNameAndLine이
     line으로 매칭해 찾았고 getLineStationsSorted(line)도 같은 line으로 필터하므로
     fromIdx/toIdx가 -1일 수 없다(lineLoopPath.ts:65-66과 동일 방어 패턴). */
  if (fromIdx === -1 || toIdx === -1) return null;

  const sharedLine = line as unknown as SharedLineNumber;
  const path = shortestLinePathIndices(lineStations, fromIdx, toIdx, sharedLine);
  // shortestLinePathIndices invariant: fromIdx !== toIdx → path.length >= 2
  const firstStepIdx = path[1];

  // closed-loop 본선(2호선) 양 끝 — idx 증가(wrap 포함) = 내선 = 'up'(#2867 실측 52쌍).
  if (
    isClosedLoopMainStation(sharedLine, fromStation.id) &&
    isClosedLoopMainStation(sharedLine, toStation.id)
  ) {
    return firstStepIdx > fromIdx ? 'up' : 'down';
  }

  // #2877 — 신분당·수인분당은 idx 증가=상행(나머지 노선은 idx 증가=하행, 전역 관례).
  if (REVERSED_ORIENTATION_LINES.has(line)) {
    return firstStepIdx > fromIdx ? 'up' : 'down';
  }
  return firstStepIdx > fromIdx ? 'down' : 'up';
}
