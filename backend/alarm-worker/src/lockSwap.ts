/**
 * #902 Seam F — boardingLock의 trainCode 자동 swap 로직.
 *
 * 두 회귀에 대응:
 *  1) 환승 직후 lock release → 다음 cycle이 새 line의 첫 waypoint에서 옛 trainCode를 찾아
 *     etaMissing 5회 후 trip auto-end (`backend/alarm-worker/src/scheduled.ts` advanceBoardingLockWaypoint).
 *  2) 운행 중 trainCode가 Seoul OpenAPI에서 사라지면 다음 후보 모름 → 같은 line/방향의 신규
 *     trainCode가 같은 시점에 나타나면 자동 swap (`runTrainCodeTracking` 연속 etaMissing 누적 시).
 *
 * 본 모듈은 순수 pipeline (KV I/O 없음). 호출자가 결과 BoardingLockMeta를 trip에 stamp + putTrip.
 *
 * 방향 매칭은 stationName 필터로 implicit 해소:
 *  - 다음 waypoint stationName + 같은 line의 arrivals만 평가 → 잘못된 방향은 station 응답 자체가 없음.
 *  - 추가로 `pickAutoTrainCode`(boardingPrompt.ts)의 arvlCd 우선순위(2>1>0)로 ambiguity 회피.
 */

import { resolveTrainCodeWithFallback } from './arrivalsFromPositions';
import { isLockLineAllowed } from './consensusGate';
import { matchLine, subwayIdForLine } from './lineAlias';
import type { PositionEntry, SeoulArrivalClient } from './seoul';
import type { BoardingLockMeta, LineNumber, Trip, Waypoint } from './types';

/**
 * 자동 swap 후 새 lock의 TTL. 환승 직후엔 사용자가 즉시 새 lock을 client에서 보낼 가능성이
 * 낮으므로(같은 화면 갱신 race) cron 사이클 30분 마진을 둔다. Seam E sync가 가장 먼저 정정해도
 * lock 자체는 계속 활성 유지.
 */
export const SWAP_LOCK_TTL_MS = 30 * 60 * 1000;

/**
 * 새 lock의 segmentStations 산출.
 *
 * `trip.waypoints[0]`(=새 line의 첫 waypoint)부터 시작해 같은 line이 유지되는 동안 stationName을 모은다.
 * line이 바뀌는 waypoint(다음 환승)는 포함하지 않는다 — 이번 leg 범위 한정 (positions fallback 정확도용).
 * destination에 도달하면 destination까지 포함.
 *
 * 빈 배열은 호출자에서 swap 자체를 abort (segmentStations는 BoardingLockMeta 필수 필드).
 */
export function buildLegSegmentStations(
  waypoints: readonly Waypoint[],
  line: string,
): string[] {
  const stations: string[] = [];
  for (const wp of waypoints) {
    if (wp.line !== line) break;
    stations.push(wp.stationName);
    if (wp.kind === 'transfer' || wp.kind === 'destination') break;
  }
  return stations;
}

export interface AttachLockInputs {
  trip: Trip;
  /** 다음 추적 대상 waypoint — arrivals 폴링 대상 (현재 leg 첫 waypoint). */
  targetWaypoint: Waypoint;
  seoul: SeoulArrivalClient;
  now: number;
  /**
   * #1439 (E6, ADR-015 §9) — trip route allowedLines. `targetWaypoint.line`이 본 set 밖이면
   * swap을 abort해 cross-line 잘못된 매핑(분당선 variant 같은 fusion 회귀)을 차단한다.
   * 미전달 시 검증 skip(구 호출자 호환).
   */
  allowedLines?: Set<LineNumber>;
  /**
   * #1702 (B2-A) — Seoul OpenAPI 단방향/0건 fallback 용 realtimePosition snapshot.
   *
   * caller (scheduled.ts `attemptVanishSwap` / transfer-swap site) 가
   * `readSelfPollPosition(env.TRIPS, line)` 결과를 전달한다. arrivals 가 비거나
   * `pickAutoTrainCode` 가 candidate 를 찾지 못한 경우 positions 에서 segmentStations 기반
   * ArrivalEntry 를 합성해 retry. 미전달 / 빈 list 시 기존 동작 (null 반환) 유지.
   */
  selfPollPositions?: readonly PositionEntry[];
}

/**
 * 자동 swap의 핵심 — `targetWaypoint`의 stationName + line에서 후보 trainCode를 1개 골라
 * 새 BoardingLockMeta를 합성한다.
 *
 * 후보 선택 정책:
 *  - 노선 매칭(matchLine) + arvlCd 우선순위(2 출발 > 1 도착 > 0 진입 > 그 외)
 *  - 같은 우선순위 후보 다수 = ambiguity → null (silent skip, caller가 boarding-prompt fallback)
 *  - direction=null: stationName 필터가 이미 진행 방향을 implicit으로 결정 (그 역에 보이지 않는
 *    방향 train은 응답 자체가 없음).
 *
 * subwayId 매핑 누락 line이면 null — backend는 stations.json 없이 line code만 신뢰.
 */
export async function attachTrainCodeForLeg(
  inputs: AttachLockInputs,
): Promise<BoardingLockMeta | null> {
  const { targetWaypoint, seoul, now, trip, allowedLines, selfPollPositions } = inputs;
  const line = targetWaypoint.line;
  const subwayId = subwayIdForLine(line);
  if (!subwayId) return null;
  // #1439 (E6, ADR-015 §9) — line이 trip route allowedLines 밖이면 swap abort.
  if (allowedLines && !isLockLineAllowed({ line }, allowedLines)) return null;

  const segmentStations = buildLegSegmentStations(trip.waypoints, line);
  if (segmentStations.length === 0) return null;

  const realArrivals = await seoul.fetchArrivals(targetWaypoint.stationName);
  // #1702 (B2-A) — Seoul OpenAPI 단방향/0건 시 realtimePosition fallback. autoLock 과 동일 패턴.
  // direction=null 인 swap 흐름에서도 segmentStations 기반 필터로 같은 line 의 진행 방향 trains
  // 만 추출되므로 wrong-direction lock 회귀를 차단한다 (transfer 후 leg + vanish 후 재부착 모두).
  const resolved = resolveTrainCodeWithFallback({
    realArrivals,
    positions: selfPollPositions,
    line,
    direction: null,
    segmentStations,
    targetStation: targetWaypoint.stationName,
  });
  if (!resolved) return null;
  const { trainCode, arrivals } = resolved;

  // line cross-check (2단 방어, #1626 follow-up) — `pickAutoTrainCode`가 이미 `matchLine`을
  // 적용하지만, chosen trainCode entry 의 subwayNm 이 line 과 매칭되는지 한 번 더 verify.
  // swap 흐름은 transfer 직후 + vanish 후 재부착 모두 같은 보호가 필요하다 — autoLock 과
  // 동일 정책으로 wrong-line trainCode lock 합성을 봉쇄. autoLock.ts:258-259 참조.
  const chosen = arrivals.find((a) => a.trainCode === trainCode);
  if (!chosen || !matchLine(chosen.subwayNm, line)) return null;

  return {
    trainCode,
    line,
    subwayId,
    selectedDepartureTime: now,
    segmentStations,
    expiresAt: now + SWAP_LOCK_TTL_MS,
  };
}
