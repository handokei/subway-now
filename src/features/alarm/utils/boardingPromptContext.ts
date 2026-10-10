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
import type { LineNumber, Station } from '../../../shared/types/station';
import type { Route } from '../../../shared/utils/stationRoute';
import {
  findStationByNameAndLine,
  getFirstLeg,
  getNextStationName,
  getNextStationOnLine,
} from '../../../shared/utils/stationRoute';
import { haversine } from '../../../shared/utils/haversine';
import { directionOnLine } from '../../route/utils/directionOnLine';
import { findLocklessActiveLegWaypoint } from '../../route/utils/findActiveTransferContext';
import { findSegmentEndStationName } from './buildBoardingLockMeta';
import lineTopology from '../../../data/lineTopology.json';

/**
 * #2946 (H-7 결함2) — 이전엔 `resolveTravelDirection`(단조 노선)과 `inferLoopDirection`(순환/
 * 하이브리드 노선, forward/backward 호 길이 비교)을 `??`로 조합했다. 둘은 서로 다른 화이트리스트
 * (`monotonicLines`/`closedLoops`)를 쓰므로 한 line에서 동시에 값을 내지 않아 "조합 자체가
 * 충돌"하지는 않지만, 2호선 seam(시청↔충정로·시청↔교대)에서 `inferLoopDirection`의 forward/
 * backward 호 길이 비교가 `directionOnLine`(`shortestLinePathIndices` 기반, #2455/#2867 ground
 * truth와 같은 단일 알고리즘, `resolveTripDirection`이 app 전역에서 쓰는 것과 동일 계산)과
 * **다른 답**을 낸다(실측: 시청→충정로 old=down new=up). `directionOnLine`으로 교체해
 * device 내부에서 "방향을 아는 두 가지 다른 방법"을 하나로 통일한다.
 *
 * `directionOnLine` 자체는 화이트리스트가 없어 모든 line에 콘크리트 방향을 내지만, 기존
 * 코드가 `monotonicLines ∪ closedLoops` 밖 line(1/5/경의중앙선처럼 다중 종착·분기가 있어
 * "방향 미해결 → 양방향 허용"이 안전한 기본값이었던 노선)에서 null을 반환하던 범위는
 * 그대로 보존한다(DIRECTION_RESOLVABLE_LINES 게이트) — 이 PR의 범위는 #2455가 지적한
 * 기존 두 유틸(2호선/6호선) 조합의 불일치 해소이며, 직선/분기 노선에 새로 방향 판정을
 * 도입하는 것은 별도 스펙 없이 다루지 않는다(전수 대조 결과 PR 본문 참고).
 */
const DIRECTION_RESOLVABLE_LINES = new Set<LineNumber>([
  ...(lineTopology.monotonicLines as LineNumber[]),
  ...(Object.keys(lineTopology.closedLoops) as LineNumber[]),
]);

function resolveStableDirection(
  line: LineNumber,
  fromStationId: string,
  toName: string,
): 'up' | 'down' | null {
  if (!DIRECTION_RESOLVABLE_LINES.has(line)) return null;
  const toStation = findStationByNameAndLine(toName, line);
  /* istanbul ignore next -- toName(leg.endName/segmentEndName)은 getFirstLeg/
   * findSegmentEndStationName이 같은 route의 같은 line 위에서 산출한 station 이름이라
   * line 위에 항상 존재한다는 invariant(옛 resolveTravelDirection/inferLoopDirection의
   * indexOf 실패 분기도 같은 이유로 실측 호출에서 도달 불능이었다). findStationByNameAndLine의
   * normalize fallback까지 거치므로 BLDN_NM drift(#1410)도 흡수 — 방어용으로만 유지. */
  if (!toStation) return null;
  return directionOnLine(line, fromStationId, toStation.id);
}

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

  // lock 미활성. #2830 — currentStation이 환승 waypoint(=leg-2 진입점)에 도달했으면
  // leg-aware(환승 후 진행 leg)로 stamp한다. #2858 — #2830의 exact-match(findLocklessTransferWaypoint)
  // 는 환승역 자체일 때만 매칭해, release 후 leg-2를 더 진행하면 다시 getFirstLeg(leg-1)로 fall
  // back하는 좀비 프롬프트 재발 지점이었다. findLocklessActiveLegWaypoint로 교체해 "지금 어느
  // leg 위에 있는가"를 역순 스캔으로 넓게 판정한다(leg-1/mid-leg/direct는 여전히 wp===null이라
  // 기존 getFirstLeg 경로를 그대로 탄다 — 회귀 안전).
  const wp = findLocklessActiveLegWaypoint(route, destination.name, currentStation);
  if (wp != null) {
    return buildSegmentContext({
      currentStation,
      line: wp.nextLine,
      segmentEndName: wp.nextWaypointName,
      gpsFix,
    });
  }

  // 기존 first-leg 기반 path 보존.
  const leg = getFirstLeg(route, destination.name);
  const nextName = getNextStationName(currentStation.id, destination.id, route);
  if (!nextName) return null;

  const nextStation = findStationByNameAndLine(nextName, leg.line);
  /* istanbul ignore next -- getNextStationName이 같은 line에서 lookup한 name이므로 재조회 실패 불가 */
  if (!nextStation) return null;

  // #2946 (H-7 결함2) — directionOnLine 단일 알고리즘(resolveStableDirection, 파일 상단).
  // monotonicLines∪closedLoops 밖 line은 null(양방향 후보 허용, 기존 범위 보존).
  //
  // #2946 (H-7 결함2 (b)) — 이전 주석("stationName 필터로 implicit 방향 해소")은 거짓이었다.
  // backend(`arrivalsFromPositions.ts:111-129`)의 실체는 "경로상 어느 역에 있는가"
  // (segmentStations.indexOf)만 본다 — 10/9 5559가 군자(segmentStations[0])에 있어 idx=0으로
  // 통과한 사례가 보여주듯 탑승역 그 자리의 열차 방향은 원리적으로 구분 불가하다. 교차 링크:
  // #2944(H-6, backend 대응) / docs/agents/invariants.md(#2944가 소유 — 본 PR은 미기록).
  const direction = resolveStableDirection(leg.line, currentStation.id, leg.endName);

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
 * lock-활성 분기(#1921)와 leg-aware lockless 분기(#2830)가 공유하는 순수 세그먼트 stamp 빌더.
 * currentStation ~ segmentEndName 사이(line 위)의 다음 역 좌표 + 방향을 산출한다.
 *
 * 실패 조건 (null 반환 — backend는 자동 skip): currentStation이 line 위에 없거나
 * 이미 segmentEndName에 도달(다음 역 없음).
 */
function buildSegmentContext({
  currentStation,
  line,
  segmentEndName,
  gpsFix,
}: {
  currentStation: Station;
  line: LineNumber;
  segmentEndName: string;
  gpsFix?: GpsFix | null;
}): BoardingPromptContext | null {
  const nextName = getNextStationOnLine(line, currentStation.name, segmentEndName);
  if (nextName == null) return null;

  const nextStation = findStationByNameAndLine(nextName, line);
  /* istanbul ignore next -- getNextStationOnLine이 line 위에서 찾은 name이므로 재조회 실패 불가 */
  if (nextStation == null) return null;

  // #2946 (H-7 결함2) — directionOnLine 단일 알고리즘(resolveStableDirection, 파일 상단 참고).
  const direction = resolveStableDirection(line, currentStation.id, segmentEndName);

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
      line,
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

  return buildSegmentContext({
    currentStation,
    line: lock.boardingLine,
    segmentEndName,
    gpsFix,
  });
}
