/* eslint-disable import/no-restricted-paths --
 * Cross-feature: `createArrivalProvider()`(arrival feature 소유)를 nearest-station BG task가
 * 그대로 재사용한다 — `bgUndergroundArrivalPoll.ts`(#2381)와 동일한 이유의 본질적 cross-feature
 * 의존. Phase 5 enforce 모드에서 file-level disable로 옵트인.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
/**
 * #2480 — BG waypoint arvlCd 직폴링. FG(`useStationAlarm` #396)가 목적지 도착정보를 직접
 * 폴링(`useArrivalInfo`)해 lock된 열차가 ENTERING/ARRIVED면 발사하는 클린 신호를 BG spine
 * (`bgWaypointArvlcdFire.ts`)이 그대로 이식할 수 있도록 조건부 폴링만 담당한다.
 *
 * `bgUndergroundArrivalPoll.ts`(#2381)와 거의 동일한 skeleton이지만 지하+WiFi 후보 게이트에
 * 묶이지 않고, 호출자가 이미 lock.trainCode(real)로 정한 "다음 waypoint" 역을 그대로 조회 대상
 * 으로 받는다 — 별도 station 모듈(각 도메인 전용 캐시/타임스탬프 키)로 분리해 두 폴링이 서로의
 * 쿨다운/캐시를 침범하지 않도록 한다.
 *
 * Provider는 `createArrivalProvider()`(순수 fetch, `useArrivalInfo`/`bgUndergroundArrivalPoll`과
 * 동일 factory)를 그대로 재사용 — 새 fetch 로직 발명 없음.
 *
 * 공통 쿨다운-폴링 스켈레톤은 `pollWithCooldown.ts`(#2383)를 그대로 재사용 — 본 모듈은 provider
 * 싱글톤 관리 + 도메인 특화 fetcher/키만 주입하는 thin wrapper다.
 *
 * 호출자(`evaluateWaypointArvlcdFire`)가 게이트(플래그/lock/waypoint 선정 등)를 이미 통과한
 * tick에서만 호출한다 — 본 모듈 자체는 그 게이트를 걸지 않는다(단일 책임: 폴링 주기 관리 +
 * graceful fetch/캐시만).
 */
import type { ArrivalProvider } from '../../arrival/providers/types';
import { createArrivalProvider } from '../../arrival/providers/factory';
import type { StationArrival } from '../../../shared/types/arrival';
import type { LineNumber } from '../../../shared/types/station';
import {
  BG_WAYPOINT_ARRIVAL_POLLED_AT_KEY,
  BG_WAYPOINT_ARRIVAL_CACHE_KEY,
} from '../../../shared/constants/storageKeys';
import { pollWithCooldown } from './pollWithCooldown';

/**
 * 최소 폴링 간격 — #2381(25s)보다 짧게. 도착창(ENTERING→ARRIVED)이 좁아 폴링 간격이 길면
 * 그 창을 통째로 놓칠 위험이 있어(도착 자동알림 척추 목적) 더 촘촘한 간격을 쓴다.
 */
export const BG_WAYPOINT_ARRIVAL_POLL_MIN_INTERVAL_MS = 20_000;

let arrivalProvider: ArrivalProvider | null = null;
function getProvider(): ArrivalProvider {
  if (!arrivalProvider) arrivalProvider = createArrivalProvider();
  return arrivalProvider;
}

/** 테스트 격리용 — 본 모듈 사용처 외에는 호출하지 말 것. */
export function __resetBgWaypointArrivalPollForTests(): void {
  arrivalProvider = null;
}

/**
 * 다음 waypoint(환승역 또는 도착역)의 arvlCd를 조건부 폴링한다. 정책 상세는
 * `pollWithCooldown.ts` 참고.
 */
export async function pollWaypointArrivalIfDue(
  stationName: string,
  lineHint: LineNumber,
  now: number = Date.now(),
): Promise<StationArrival | null> {
  return pollWithCooldown<StationArrival>({
    polledAtKey: BG_WAYPOINT_ARRIVAL_POLLED_AT_KEY,
    cacheKey: BG_WAYPOINT_ARRIVAL_CACHE_KEY,
    minIntervalMs: BG_WAYPOINT_ARRIVAL_POLL_MIN_INTERVAL_MS,
    now,
    fetcher: () => getProvider().getArrival(stationName, { lineHint }),
    logLabel: 'waypoint arvlCd',
  });
}
