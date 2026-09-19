/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: boarding-prompt 컨텍스트 빌더는 alarm 슬라이스에서 발사하는 push의
 * 평가 입력을 route 슬라이스의 단조-노선 방향 유틸로부터 빌드한다. boarding-prompt 자체가 alarm + route를
 * 가로지르는 본질적 cross-feature 게이트라 직접 import가 자연스러움. 후속 PR에서 resolveTravelDirection을
 * src/shared/utils/로 추출하거나 orchestration 슬라이스로 이전 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
/**
 * "탔어요?" 푸시(#819) 평가 컨텍스트 빌더.
 *
 * backend `evaluateAndMaybeFireBoardingPrompt`는 `trip.promptGeoContext` +
 * `trip.promptDisplay`가 모두 있어야 9단 게이트 평가를 진행한다. 둘 중 하나라도
 * 없으면 skip이므로, register payload에 컨텍스트를 동봉해야 발사 0건 상태를 해소한다.
 *
 * 전제: boarding-prompt는 **leg 0 미시작(=탑승 전)** 상황에서만 의미 있다. backend의
 * 9단 게이트가 `origin` 근접 + `nextStation` 방향 이동을 검사하므로, 사용자가 첫 leg를
 * 이미 진행 중이면 게이트가 자연 차단된다(또는 다른 분기로 위임). 따라서 mid-trip
 * transfer 등에서 first-leg와 active-leg가 어긋나도 잘못된 발사로 이어지지 않는다.
 *
 * 컨텍스트:
 *   - origin: 호출 시점의 GPS-nearest 역(= 탑승 후보) 좌표
 *   - nextStation: 첫 leg에서 origin 다음 역 좌표
 *   - direction: 첫 leg의 진행 방향(단조 라인만), 비단조면 null (양방향 허용)
 *   - originStation: 사용자 표시용 역 이름
 *   - line: 첫 leg 라인 (boarding 단계 노선)
 *
 * `currentStation === null`이거나 next/lookup 실패 시 null 반환 — backend는 자동 skip.
 */

import type { BoardingLock } from '../../../shared/types/boardingLock';
import type { Station } from '../../../shared/types/station';
import type { Route } from '../../../shared/utils/stationRoute';
import {
  findStationByNameAndLine,
  getFirstLeg,
  getNextStationName,
  getNextStationOnLine,
} from '../../../shared/utils/stationRoute';
import { haversine } from '../../../shared/utils/haversine';
import { resolveTravelDirection } from '../../route/utils/travelDirection';
import { inferLoopDirection } from '../../route/utils/loopDirection';
import { findSegmentEndStationName } from './buildBoardingLockMeta';

/** #2130 (B-2) — 등록 시점 GPS fix. 근접 스탬프 입력. */
export interface GpsFix {
  lat: number;
  lng: number;
  accuracyM: number;
}

export interface BoardingPromptContext {
  promptGeoContext: {
    origin: { lat: number; lng: number };
    nextStation: { lat: number; lng: number };
    direction: 'up' | 'down' | null;
    /**
     * #2130 (B-2) — origin과 GPS fix 사이 거리(m). backend 근접 게이트(B-backend, 별도 PR)의
     * 입력. GPS fix가 아예 없을 때만 생략 — backend는 부재를 관대하게(지하/구 클라) 통과시킨다.
     */
    originDistanceM?: number;
    /** #2130 (B-2) — GPS fix 정확도(m). originDistanceM과 항상 짝으로만 존재. */
    originAccuracyM?: number;
  };
  promptDisplay: {
    originStation: string;
    line: string;
  };
}

interface BuildInputs {
  route: Route;
  currentStation: Station | null;
  destination: Station | null;
  /**
   * #1921 — 활성 BoardingLock이 있으면 lock.boardingLine + currentStation 기준으로 컨텍스트를 빌드.
   *
   * cross-trip 자동 전환 시 route는 RC-11 #1883 freeze 정책에 따라 원본 trip의 line을 유지하지만
   * (예: 7호선 용마산→…→강변→2호선 잠실 multi-transfer) lock은 현재 진행 중인 leg의 line(2)을
   * 가리킨다. 기존 `getFirstLeg(route, destination.name)` 경로는 route 원본 line(7)을 따라가서
   * currentStation(2-012 강변)이 7호선에 없으면 nextName=null로 빠지고, 호출자(useApnsTripRegistration)
   * 가 stale lastPromptContextRef로 fallback → backend KV가 옛 line/originStation으로 영원히 고정.
   *
   * lock이 있으면 line의 모호함이 사라지므로 우선 분기 — lock metadata는 별 wire(buildBoardingLockMeta)가
   * 담당하고 본 컨텍스트는 prompt 전용 stamp만 갱신한다.
   */
  lock?: BoardingLock | null;
  /**
   * #2130 (B-2) — 등록 시점 GPS fix. 제공되면 origin과의 거리를 계산해 promptGeoContext에
   * 동봉한다. 미제공(undefined/null)이면 필드 자체를 생략(GPS fix 없음 — 지하/권한거절 graceful).
   */
  gpsFix?: GpsFix | null;
}

/** #2130 (B-2) — GPS fix가 있을 때만 origin 근접 스탬프 필드를 만든다. */
function buildOriginGpsStamp(
  origin: { lat: number; lng: number },
  gpsFix: GpsFix | null | undefined,
): { originDistanceM: number; originAccuracyM: number } | Record<string, never> {
  if (gpsFix == null) return {};
  const originDistanceM = Math.round(haversine(gpsFix.lat, gpsFix.lng, origin.lat, origin.lng) * 1000);
  return { originDistanceM, originAccuracyM: gpsFix.accuracyM };
}

export function buildBoardingPromptContext({
  route,
  currentStation,
  destination,
  lock,
  gpsFix,
}: BuildInputs): BoardingPromptContext | null {
  if (!route || !currentStation || !destination) return null;

  // #1921 — lock 활성 분기. route 원본 line이 lock leg와 어긋난 cross-trip 자동 전환에서
  // currentStation 기준으로 lock.boardingLine 위의 다음 역 좌표 + direction을 stamp.
  if (lock != null) {
    return buildLockActiveContext({ route, currentStation, destination, lock, gpsFix });
  }

  // lock 미활성 — 기존 first-leg 기반 path 보존.
  const leg = getFirstLeg(route, destination.name);
  const nextName = getNextStationName(currentStation.id, destination.id, route);
  if (!nextName) return null;

  const nextStation = findStationByNameAndLine(nextName, leg.line);
  /* istanbul ignore next -- getNextStationName이 같은 line에서 lookup한 name이므로 재조회 실패 불가 */
  if (!nextStation) return null;

  // 단조 노선은 resolveTravelDirection이, 순환/하이브리드 노선(2호선/6호선)은 inferLoopDirection
  // 이 fallback으로 방향을 채운다(#1703). 둘 다 null이면 양방향 후보 허용 — backend
  // `pickAutoTrainCode`는 stationName 필터로 implicit 방향 해소(허용 가능한 false negative).
  const direction =
    resolveTravelDirection(leg.line, currentStation.name, leg.endName)?.direction ??
    inferLoopDirection(leg.line, currentStation.name, leg.endName);

  const origin = { lat: currentStation.lat, lng: currentStation.lng };
  return {
    promptGeoContext: {
      origin,
      nextStation: { lat: nextStation.lat, lng: nextStation.lng },
      direction,
      ...buildOriginGpsStamp(origin, gpsFix),
    },
    promptDisplay: {
      originStation: currentStation.name,
      line: leg.line,
    },
  };
}

/**
 * #1921 — lock 활성 분기. lock.boardingLine + currentStation을 기준 좌표로 사용해
 * route의 어느 segment가 lock leg인지 찾고 그 segment의 끝 역(다음 환승역 or 최종 도착역)을
 * direction 산출 anchor로 쓴다.
 *
 * 실패 조건 (모두 null 반환 — backend는 자동 skip):
 *   - lock.boardingLine이 route segment 어느 것에도 일치 안 함 (비정상 schema)
 *   - currentStation이 lock.boardingLine 위에 없음 (라인 일관성 깨짐)
 *   - currentStation === segmentEnd (이미 leg 끝 도달 — 본 cycle은 prompt 대상 아님)
 */
function buildLockActiveContext({
  route,
  currentStation,
  destination,
  lock,
  gpsFix,
}: {
  route: NonNullable<Route>;
  currentStation: Station;
  destination: Station;
  lock: BoardingLock;
  gpsFix?: GpsFix | null;
}): BoardingPromptContext | null {
  const segmentEndName = findSegmentEndStationName(route, lock.boardingLine, destination.name);
  if (segmentEndName == null) return null;

  const nextName = getNextStationOnLine(lock.boardingLine, currentStation.name, segmentEndName);
  if (nextName == null) return null;

  const nextStation = findStationByNameAndLine(nextName, lock.boardingLine);
  /* istanbul ignore next -- getNextStationOnLine이 lock.boardingLine 위에서 찾은 name이므로 재조회 실패 불가 */
  if (nextStation == null) return null;

  const direction =
    resolveTravelDirection(lock.boardingLine, currentStation.name, segmentEndName)?.direction ??
    inferLoopDirection(lock.boardingLine, currentStation.name, segmentEndName);

  const origin = { lat: currentStation.lat, lng: currentStation.lng };
  return {
    promptGeoContext: {
      origin,
      nextStation: { lat: nextStation.lat, lng: nextStation.lng },
      direction,
      ...buildOriginGpsStamp(origin, gpsFix),
    },
    promptDisplay: {
      originStation: currentStation.name,
      line: lock.boardingLine,
    },
  };
}
