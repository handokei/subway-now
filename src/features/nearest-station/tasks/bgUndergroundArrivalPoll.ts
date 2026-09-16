/* eslint-disable import/no-restricted-paths --
 * Cross-feature: `createArrivalProvider()`(arrival feature 소유)를 nearest-station BG task가
 * 그대로 재사용한다 — `undergroundConsensusFire.ts`(alarm/utils, 동일 provider를 arrival에서
 * import)와 같은 이유의 본질적 cross-feature 의존. Phase 5 enforce 모드에서 file-level
 * disable로 옵트인(#2382 머지 시점부터 존재하던 사전 lint gap — #2383에서 본 파일을 다시
 * 손대며 발견해 함께 정리).
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
/**
 * #2381 (Gap A) — BG 지하 arvlCd 폴링. `backgroundLocationTask.ts:319`가 의도적으로 제외한
 * BG arrival 폴링 gap을 지하+lock 조건부로만 메운다(always-on 폴링 금지 — OS quota 보호).
 *
 * 호출자(`undergroundConsensusFire.ts`)가 지하(underground profile)+BoardingLock 존재 게이트를
 * 이미 통과한 tick에서만 호출한다 — 본 모듈 자체는 그 게이트를 걸지 않는다(단일 책임: 폴링
 * 주기 관리 + graceful fetch만).
 *
 * Provider는 `createArrivalProvider()`(순수 fetch, `useArrivalInfo`와 동일 factory)를 그대로
 * 재사용 — 새 fetch 로직 발명 없음. 모듈 스코프 provider 싱글톤은 `useArrivalInfo.ts`의
 * `prefetchProvider` 패턴과 동일.
 *
 * 공통 쿨다운-폴링 스켈레톤(타임스탬프 due 판정 + 캐시 read/write + isMock 가드 + graceful
 * fetch fallback)은 `pollWithCooldown.ts`(#2383, SonarCloud dup-density fix)로 추출됨 — 본
 * 모듈은 provider 싱글톤 관리 + 도메인 특화 fetcher/키만 주입하는 thin wrapper다.
 */
import type { ArrivalProvider } from '../../arrival/providers/types';
import { createArrivalProvider } from '../../arrival/providers/factory';
import type { StationArrival } from '../../../shared/types/arrival';
import type { LineNumber } from '../../../shared/types/station';
import {
  BG_UNDERGROUND_ARRIVAL_POLLED_AT_KEY,
  BG_UNDERGROUND_ARRIVAL_CACHE_KEY,
} from '../../../shared/constants/storageKeys';
import { pollWithCooldown } from './pollWithCooldown';

/**
 * 최소 폴링 간격 — 스펙 20~30s 범위의 중간값. `POSITION_UPLOAD_MIN_INTERVAL_MS`와 동일하게
 * AsyncStorage 타임스탬프 쿨다운으로 강제한다(TaskManager invocation마다 새 컨텍스트라
 * in-memory ref 불가 — `readBgLastPositionUploadAt`와 동일 패턴).
 */
export const BG_UNDERGROUND_ARRIVAL_POLL_MIN_INTERVAL_MS = 25_000;

let arrivalProvider: ArrivalProvider | null = null;
function getProvider(): ArrivalProvider {
  if (!arrivalProvider) arrivalProvider = createArrivalProvider();
  return arrivalProvider;
}

/** 테스트 격리용 — 본 모듈 사용처 외에는 호출하지 말 것. */
export function __resetBgUndergroundArrivalPollForTests(): void {
  arrivalProvider = null;
}

/**
 * 지하 candidate station(WiFi 매칭 대상)의 arvlCd를 조건부 폴링한다. 정책 상세는
 * `pollWithCooldown.ts` 참고 — `undergroundSSOTConsensus`는 arrival이 null이어도 다른 신호
 * (cellular/accel)로 계속 평가 가능하므로 실패가 전체 파이프라인을 막지 않는다.
 */
export async function pollUndergroundArrivalIfDue(
  stationName: string,
  lineHint: LineNumber,
  now: number = Date.now(),
): Promise<StationArrival | null> {
  return pollWithCooldown<StationArrival>({
    polledAtKey: BG_UNDERGROUND_ARRIVAL_POLLED_AT_KEY,
    cacheKey: BG_UNDERGROUND_ARRIVAL_CACHE_KEY,
    minIntervalMs: BG_UNDERGROUND_ARRIVAL_POLL_MIN_INTERVAL_MS,
    now,
    fetcher: () => getProvider().getArrival(stationName, { lineHint }),
    logLabel: '지하 arrival',
  });
}
