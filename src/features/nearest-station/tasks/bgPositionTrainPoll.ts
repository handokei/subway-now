/**
 * #2383 — BG position-train-lock 폴링. `bgUndergroundArrivalPoll.ts`(#2381 Gap A)와 동일한
 * "조건부 폴링 — always-on 금지" 정책을 realtimePosition API(`fetchTrainPositions`)에 적용한다.
 * 공통 쿨다운-폴링 스켈레톤은 `pollWithCooldown.ts`(SonarCloud dup-density fix)로 추출됨 — 본
 * 모듈은 도메인 특화 fetcher/키만 주입하는 thin wrapper다.
 *
 * 호출자(`bgPositionTrainFire.ts`)가 이미 MINIMAL_ALARM 플래그 + lock + lock.trainCode 게이트를
 * 통과한 tick에서만 호출한다 — 본 모듈 자체는 그 게이트를 걸지 않는다.
 *
 * `fetchTrainPositions`(순수 fetch, `positionApi.ts`)를 그대로 재사용 — 새 fetch 로직 발명 없음.
 */
import { fetchTrainPositions, type LinePositions } from '../api/positionApi';
import type { LineNumber } from '../../../shared/types/station';
import {
  BG_POSITION_TRAIN_POLLED_AT_KEY,
  BG_POSITION_TRAIN_CACHE_KEY,
} from '../../../shared/constants/storageKeys';
import { pollWithCooldown } from './pollWithCooldown';

/**
 * 최소 폴링 간격 — `BG_UNDERGROUND_ARRIVAL_POLL_MIN_INTERVAL_MS`(#2381)와 동일 25s.
 */
export const BG_POSITION_TRAIN_POLL_MIN_INTERVAL_MS = 25_000;

/**
 * lock.boardingLine 전체 열차 위치(`LinePositions`)를 조건부 폴링한다. 정책 상세는
 * `pollWithCooldown.ts` 참고.
 */
export async function pollTrainPositionsIfDue(
  line: LineNumber,
  now: number = Date.now(),
): Promise<LinePositions | null> {
  return pollWithCooldown<LinePositions>({
    polledAtKey: BG_POSITION_TRAIN_POLLED_AT_KEY,
    cacheKey: BG_POSITION_TRAIN_CACHE_KEY,
    minIntervalMs: BG_POSITION_TRAIN_POLL_MIN_INTERVAL_MS,
    now,
    fetcher: () => fetchTrainPositions(line),
    logLabel: 'position-train',
  });
}
