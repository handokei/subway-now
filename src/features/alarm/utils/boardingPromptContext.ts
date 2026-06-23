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

import type { Station } from '../../../shared/types/station';
import type { Route } from '../../../shared/utils/stationRoute';
import {
  findStationByNameAndLine,
  getFirstLeg,
  getNextStationName,
} from '../../../shared/utils/stationRoute';
import { resolveTravelDirection } from '../../route/utils/travelDirection';
import { inferLoopDirection } from '../../route/utils/loopDirection';

export interface BoardingPromptContext {
  promptGeoContext: {
    origin: { lat: number; lng: number };
    nextStation: { lat: number; lng: number };
    direction: 'up' | 'down' | null;
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
}

export function buildBoardingPromptContext({
  route,
  currentStation,
  destination,
}: BuildInputs): BoardingPromptContext | null {
  if (!route || !currentStation || !destination) return null;

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

  return {
    promptGeoContext: {
      origin: { lat: currentStation.lat, lng: currentStation.lng },
      nextStation: { lat: nextStation.lat, lng: nextStation.lng },
      direction,
    },
    promptDisplay: {
      originStation: currentStation.name,
      line: leg.line,
    },
  };
}
