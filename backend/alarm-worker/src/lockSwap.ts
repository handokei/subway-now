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
 * 방향 매칭 (#1719, #2944 H-6 정정 — 아래 "거짓 근거 제거" 참고):
 *  - `inferLegDirection(line, segmentStations[0], segmentStations[last])` 로 leg 진행 방향 추론.
 *    #2943(H-1) 이후 화이트리스트 없이 전 노선 커버 — wrong-direction trains 가 candidate pool 에
 *    들어가지 않는다 (2호선 외선/내선 / 6호선 응암 방향 회귀 봉쇄).
 *  - segmentStations 가 1개뿐(트립 꼬리 — 남은 정류장이 타깃 1개)이면 첫/마지막 비교가 동일
 *    역이라 추론 불가 — `resolveLegOriginStation`(trip.currentLegAnchor/originStationName)으로
 *    이 leg의 실제 탑승 앵커 역을 가져와 그 역→타깃으로 추론한다(아래 함수 참고). 앵커조차
 *    없으면(구 client / 캡처 전) null.
 *  - **direction=null → fail-closed**(#2944, 10/9 반대 방향 lock 사고 이후 정정 — 구 동작은
 *    "양방향 허용"이었다). 구 주석("stationName + segmentStations 인덱스 필터로 진행 방향
 *    implicit 해소")은 **거짓 근거였다** — `arrivalsFromPositions.ts:synthesizeArrivalsFromPositions`
 *    의 그 인덱스 필터는 "경로상 어느 역에 있는가"만 보고 방향(`isUp`)은 전혀 보지 않는다.
 *    10/9 실측(군자→광화문, 5호선)에서 반대 방향 열차(5559)가 탑승역 그 자리(segmentStations[0])
 *    에 있어 인덱스 조건을 그대로 통과했다 — "탑승역에 서 있는 열차"가 가장 중요한 순간에
 *    바로 이 implicit 해소가 무력했다는 뜻. 상세는 `docs/agents/invariants.md` "거짓 근거"
 *    항목 참고 — 이 근거로 새 fail-open을 또 남기지 말 것.
 *  - `pickAutoTrainCode` 의 arvlCd 우선순위(2>1>0) + ambiguity null 반환으로 후보 확정.
 */

import { resolveTrainCodeWithFallback } from './arrivalsFromPositions';
import { isLockLineAllowed } from './consensusGate';
import { inferLegDirection } from './legDirection';
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
 *  - direction: #1719 — `inferLegDirection(line, segmentStations[0], segmentStations[last])` 로
 *    leg 의 진행 방향을 추론해 `resolveTrainCodeWithFallback` 에 forward. 단일-station leg는
 *    `resolveLegOriginStation` fallback으로 보강(아래 함수 참고). 추론 실패(매핑 실패/앵커
 *    부재) 시 null → **fail-closed**(#2944) — 양방향 train 이 같은 station 에 있는 케이스
 *    (2호선 외선/내선, 6호선 응암 방향, 10/9 5호선)의 wrong-direction lock을 차단한다.
 *
 * subwayId 매핑 누락 line이면 null — backend는 stations.json 없이 line code만 신뢰.
 */
/**
 * #2944 (H-6) — segmentStations가 1개뿐(트립 꼬리)일 때 `inferLegDirection`의 "첫/마지막 비교"가
 * 동일 역이 되어 방향을 구할 수 없다. 이 leg의 실제 탑승 앵커(환승 후 leg면 `currentLegAnchor`,
 * leg 1이면 device가 등록 시점에 고정한 `originStationName`)가 있으면 그 역을 "첫 역"으로 써서
 * 추론한다 — segmentStations.length>=2 경로와 동일하게 "서로 다른 두 역"만 있으면 되므로.
 * fail-closed(direction=null)로 매 마지막 hop마다 swap이 통째로 막히는 과차단(ADR-010 거부
 * 케이스 ⓓ)을 줄인다. 앵커도 없으면(구 client/캡처 전 트립) 진짜로 추론 불가 — null 유지.
 */
function resolveLegOriginStation(trip: Trip, line: string): string | undefined {
  return trip.currentLegAnchor?.line === line
    ? trip.currentLegAnchor.boardingStation
    : trip.originStationName;
}
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

  // #1719 — leg 진행 방향 추론. segmentStations 가 2개 이상이면 첫/마지막으로 바로 추론.
  // #2944 (H-6) — 1개뿐(트립 꼬리)이면 `resolveLegOriginStation` 앵커를 "첫 역"으로 fallback.
  // 둘 다 실패(매핑 실패/앵커 부재)면 null → fail-closed(아래 `resolveTrainCodeWithFallback`이
  // 후보 0건으로 수렴, 구 "양방향 허용" 동작 폐기).
  const legOrigin = resolveLegOriginStation(trip, line);
  const direction =
    segmentStations.length >= 2
      ? inferLegDirection(line, segmentStations[0], segmentStations[segmentStations.length - 1])
      : legOrigin !== undefined
        ? inferLegDirection(line, legOrigin, segmentStations[segmentStations.length - 1])
        : null;

  const realArrivals = await seoul.fetchArrivals(targetWaypoint.stationName);
  // #1702 (B2-A) — Seoul OpenAPI 단방향/0건 시 realtimePosition fallback. autoLock 과 동일 패턴.
  // direction (#1719) 으로 양방향 합성/real arrivals 양쪽에서 wrong-direction trains 차단 —
  // transfer 후 leg + vanish 후 재부착 모두 같은 게이트.
  const resolved = resolveTrainCodeWithFallback({
    realArrivals,
    positions: selfPollPositions,
    line,
    direction,
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
