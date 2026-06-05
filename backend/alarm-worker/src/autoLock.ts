/**
 * #916 — trip-bound trainCode auto-lock (A1).
 *
 * lockMissing trip에서 9단 게이트(`boardingPrompt.ts`)가 통과한 시점에 backend가
 * Seoul arrivals의 `pickAutoTrainCode`(arvlCd 우선순위)로 trainCode를 자동 결정해
 * `BoardingLock`을 합성한다. 사용자가 "탑승" 액션을 직접 탭하지 않아도 cron이 매역 추적을
 * 시작할 수 있게 한다.
 *
 * Confidence threshold:
 *  - 9단 AND 게이트 (#819 ADR Section 2) — 9개의 독립 조건 곱으로 발사 임계 자체가 매우 높다.
 *    (정확도, 방향 cosine, fused speed, motion 등 모두 통과 시점에만 호출된다)
 *  - arvlCd 우선순위 (#819 ADR Section 1.2)의 ambiguity 해소 — 같은 우선순위 후보 2개 이상이면
 *    `pickAutoTrainCode`가 null을 반환해 자동 lock을 자연 차단한다 → 다음 cycle에 narrow.
 *
 * 두 임계가 곱(AND)이라 단일 magic number 대신 "통과한 게이트의 곱"이 threshold다.
 * 본 모듈은 두 신호 양쪽이 모두 만족할 때만 lock 합성을 시도한다.
 *
 * 거짓 양성 차단: 사용자가 자동 lock 직후 다른 trainCode를 탭하면 client가 새 lock POST →
 * 기존 #864/#704 same-session 분기가 새 lock으로 자연 교체 (Seam F swap과 동일 경로).
 */

import { pickAutoTrainCode } from './boardingPrompt';
import { subwayIdForLine } from './lineAlias';
import { buildLegSegmentStations, SWAP_LOCK_TTL_MS } from './lockSwap';
import type { SeoulArrivalClient } from './seoul';
import type { BoardingLockMeta, Trip, Waypoint } from './types';

/**
 * 자동 lock의 TTL. lockSwap의 `SWAP_LOCK_TTL_MS`와 동일 30분 — 두 흐름 모두 "사용자 명시
 * 입력 없이 backend가 lock을 합성"한 케이스라 같은 마진이 적절.
 *
 * 본 모듈에서 별도 상수를 두지 않고 `lockSwap.SWAP_LOCK_TTL_MS`를 그대로 재사용한다 — 한쪽 정책
 * 변경 시 두 흐름이 동시에 따라가야 한다.
 */
export const AUTO_LOCK_TTL_MS = SWAP_LOCK_TTL_MS;

/**
 * #916 follow-up B — auto-prompt 발사 dedup 윈도우.
 *
 * `evaluateAndMaybeFireBoardingPrompt`가 9단 게이트 통과 직후 `attemptAutoLock`을 시도/성공한
 * trip은 이 윈도우 내에서 다시 prompt를 평가하지 않는다. lock이 사라져도(transfer release,
 * 사용자 swap, isSameSession=false로 boardingPromptState 리셋) 같은 trip token에 대한 자동
 * prompt 재발사를 차단해 시도 - 클리어 - 재시도 ping-pong 회귀를 방지한다.
 *
 * 길이는 `AUTO_LOCK_TTL_MS`(=30분)와 동일 — 자동 lock TTL이 끝나면 prompt dedup도 자연 만료.
 * 두 정책이 한 번에 바뀌도록 같은 상수를 재사용한다.
 */
export const AUTO_PROMPT_DEDUP_WINDOW_MS = AUTO_LOCK_TTL_MS;

export interface AttemptAutoLockInputs {
  trip: Trip;
  /** 다음 추적 대상 waypoint — arrivals 폴링 대상 (현재 leg 첫 waypoint). */
  targetWaypoint: Waypoint;
  /**
   * 사용자 boarding 출발역 표시명. `BoardingLockMeta.segmentStations` 첫 원소로 prepend된다
   * (#902 swap path와 달리 사용자가 origin에 머무는 시점이라 origin도 segment에 포함되어야
   * positions-fallback이 origin 인덱스를 찾을 수 있다).
   */
  originStation: string;
  /**
   * 진행 방향. `promptGeoContext.direction` 그대로 — null이면 양방향 허용
   * (`pickAutoTrainCode` 내부에서 stationName 필터가 implicit 방향 해소).
   */
  direction: 'up' | 'down' | null;
  seoul: SeoulArrivalClient;
  now: number;
}

/**
 * lockMissing trip에 대해 trainCode 자동 결정 시도.
 *
 * 성공 (return non-null):
 *  - subwayId 매핑 성공
 *  - segmentStations 비어있지 않음 (origin + 같은 line 유지 구간)
 *  - arrivals 비어있지 않음
 *  - `pickAutoTrainCode`가 단일 후보로 수렴 (ambiguity 없음)
 *
 * 실패 (return null):
 *  - 위 중 하나라도 실패 → caller가 기존 boarding-prompt push fallback 진행
 *
 * 본 함수는 KV I/O를 하지 않는다 (순수 pipeline). caller가 결과를 trip에 stamp + putTrip.
 */
export async function attemptAutoLock(
  inputs: AttemptAutoLockInputs,
): Promise<BoardingLockMeta | null> {
  const { trip, targetWaypoint, originStation, direction, seoul, now } = inputs;
  const line = targetWaypoint.line;
  const subwayId = subwayIdForLine(line);
  if (!subwayId) return null;

  const legStations = buildLegSegmentStations(trip.waypoints, line);
  if (legStations.length === 0) return null;
  // origin은 leg의 시작점 — positions fallback이 train.stationName === origin인 케이스를
  // segmentStations.indexOf로 찾을 수 있도록 prepend. legStations 첫 원소(=waypoints[0])와
  // 중복되지 않게 dedup 한다 (이론상 origin과 waypoints[0]는 서로 다른 역이어야 하지만 방어).
  const segmentStations = legStations[0] === originStation
    ? legStations
    : [originStation, ...legStations];

  const arrivals = await seoul.fetchArrivals(targetWaypoint.stationName);
  if (arrivals.length === 0) return null;

  const trainCode = pickAutoTrainCode(arrivals, line, direction);
  if (!trainCode) return null;

  return {
    trainCode,
    line,
    subwayId,
    selectedDepartureTime: now,
    segmentStations,
    expiresAt: now + AUTO_LOCK_TTL_MS,
    // #916 follow-up A — server-set 표시. POST /trips 재등록 시 incoming.boardingLock=undefined
    // 케이스에서 existing lock을 보존할지 판단하는 마커 (사용자 명시 lock과 구분).
    autoLockedAt: now,
  };
}
