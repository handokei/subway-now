/**
 * `resolvePromptAnchor` — boarding-prompt anchor(=어느 역/노선에서 "탑승하셨나요?"를 묻는가)를
 * 산출하는 공유 primitive (#3046, 10/18 편측 감사 G1+F1).
 *
 * ## 왜 이 파일이 존재하는가
 *
 * #3038이 `trip.promptDisplay` 유실(등록 race, 1초 간격 2연발 중 context-null 쪽이
 * last-write) 시 `trip.originStationName`(#2280 SSoT 출발역) + waypoint line으로 파생하는
 * fallback을 **`maybeFireOriginBoardingPromptGpsFree`(scheduled.ts) 한 곳에만** 지역 변수로
 * 심었다. 같은 유실 상태에서 다른 두 소비자가 각자 `trip.promptDisplay`만 읽고 포기한다:
 *
 *   1. `liveActivity.ts computeBoardingContext` — 둘 다 없으면 `return {}` → LA 탑승
 *      버튼/phase 필드가 전부 비어 "LA에 탑승여부 없음"으로 보인다.
 *   2. `boardingAnchorResolver.ts resolveActiveLegOrigin` — null 반환 → anchor 없음 →
 *      backend auto-lock 자체가 불가능해진다(명시 의향 trip이 race를 맞은 경우).
 *
 * 세 소비자가 수렴해야 할 지점은 하나뿐이다 — 이 함수.
 *
 * ## currentLegAnchor와의 관계 (손대지 않는 경계)
 *
 * 이 함수는 **leg-1(origin) anchor만** 다룬다. `currentLegAnchor`(leg 2+)가 있으면 그게
 * 항상 우선이고, 그 분기는 각 소비자 호출부에 그대로 남아 있다 — 이 함수가 그 우선순위를
 * 대체하지 않는다. 호출자는 `trip.currentLegAnchor`가 없을 때만 이 함수를 쓴다.
 *
 * ## line 파생 — G3 교정
 *
 * `trip.waypoints[0].line`을 고정 소스로 쓰면 순환선/회차(#1193 — 같은 stationName이 원본
 * waypoint 시퀀스에 중복 등장)에서 틀린 line을 고를 수 있다. `originStationName`과
 * `stationName`이 일치하는 waypoint가 있으면(원 노선 재등장) 그 waypoint의 `line`을 우선
 * 쓰고, 없으면(통상 — 출발역은 이미 통과해 waypoints에 남아 있지 않은 경우) `waypoints[0]`로
 * fallback한다(#3038 기존 동작 보존).
 */
import type { Trip } from './types';

export interface PromptAnchor {
  originStation: string;
  line: string;
}

export type PromptAnchorFailureReason =
  /** `promptDisplay` 없음 + `originStationName`도 없음 — 파생 재료 자체가 없다. */
  | 'no-origin-station-name'
  /** `originStationName`은 있으나 line을 파생할 waypoint가 없다(waypoints 빈 배열 등). */
  | 'no-waypoint-line';

export interface ResolvePromptAnchorResult {
  anchor: PromptAnchor | null;
  /**
   * true면 `promptDisplay`가 아니라 `originStationName` + waypoint line으로 파생된 값(#3038).
   * anchor===null이면 항상 false.
   */
  derived: boolean;
  /** anchor===null일 때만 설정 — E1(#3037) 흡수: 이 실패도 관측 가능해야 한다. */
  failureReason?: PromptAnchorFailureReason;
}

/**
 * leg-1(origin) anchor를 `promptDisplay ?? (originStationName + waypoint line 파생)` 순으로
 * 산출한다. caller는 `trip.currentLegAnchor`가 없을 때만 이 함수를 호출해야 한다(그 우선순위는
 * 이 함수 밖에서 유지).
 */
export function resolvePromptAnchor(
  trip: Pick<Trip, 'promptDisplay' | 'originStationName' | 'waypoints'>,
): ResolvePromptAnchorResult {
  if (trip.promptDisplay) {
    return {
      anchor: { originStation: trip.promptDisplay.originStation, line: trip.promptDisplay.line },
      derived: false,
    };
  }

  const originStationName = trip.originStationName;
  if (originStationName === undefined) {
    return { anchor: null, derived: false, failureReason: 'no-origin-station-name' };
  }

  // G3 — 순환선 재등장 waypoint를 우선 매칭, 없으면 waypoints[0]로 fallback(#3038 기존 동작).
  const matchingWaypoint = trip.waypoints.find((wp) => wp.stationName === originStationName);
  const line = matchingWaypoint?.line ?? trip.waypoints[0]?.line;
  if (line === undefined) {
    return { anchor: null, derived: false, failureReason: 'no-waypoint-line' };
  }

  return { anchor: { originStation: originStationName, line }, derived: true };
}
