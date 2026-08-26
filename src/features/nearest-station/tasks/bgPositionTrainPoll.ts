/**
 * #2383 — BG position-train-lock 폴링. `bgUndergroundArrivalPoll.ts`(#2381 Gap A)와 동일한
 * "조건부 폴링 — always-on 금지" 패턴을 realtimePosition API(`fetchTrainPositions`)에 적용한다.
 *
 * 호출자(`bgPositionTrainFire.ts`)가 이미 MINIMAL_ALARM 플래그 + lock + lock.trainCode 게이트를
 * 통과한 tick에서만 호출한다 — 본 모듈 자체는 그 게이트를 걸지 않는다(단일 책임: 폴링 주기
 * 관리 + graceful fetch만).
 *
 * `fetchTrainPositions`(순수 fetch, `positionApi.ts`)를 그대로 재사용 — 새 fetch 로직 발명 없음.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchTrainPositions, type LinePositions } from '../api/positionApi';
import type { LineNumber } from '../../../shared/types/station';
import {
  BG_POSITION_TRAIN_POLLED_AT_KEY,
  BG_POSITION_TRAIN_CACHE_KEY,
} from '../../../shared/constants/storageKeys';
import { createLogger } from '../../../shared/utils/logger';

const logger = createLogger('BgPositionTrainPoll');

/**
 * 최소 폴링 간격 — `BG_UNDERGROUND_ARRIVAL_POLL_MIN_INTERVAL_MS`(#2381)와 동일 25s.
 * AsyncStorage 타임스탬프 쿨다운으로 강제한다(TaskManager invocation마다 새 컨텍스트라
 * in-memory ref 불가 — `readBgLastPositionUploadAt`와 동일 패턴).
 */
export const BG_POSITION_TRAIN_POLL_MIN_INTERVAL_MS = 25_000;

async function readCachedPositions(): Promise<LinePositions | null> {
  try {
    const raw = await AsyncStorage.getItem(BG_POSITION_TRAIN_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as LinePositions;
  } catch {
    return null;
  }
}

/**
 * lock.boardingLine 전체 열차 위치(`LinePositions`)를 조건부 폴링한다.
 * - 최소 간격 미경과: 네트워크 호출 없이 직전 캐시 반환(quota 보호).
 * - fetch 성공(mock 아님): 캐시 갱신 + 결과 반환.
 * - fetch 성공(mock) 또는 실패: 캐시 fallback(graceful).
 * - 폴링 시각은 fetch 시도 직전에 먼저 기록한다 — 실패해도 쿨다운이 적용돼 연속 실패 tick마다
 *   재시도로 quota를 소진하지 않는다.
 */
export async function pollTrainPositionsIfDue(
  line: LineNumber,
  now: number = Date.now(),
): Promise<LinePositions | null> {
  const lastPolledRaw = await AsyncStorage.getItem(BG_POSITION_TRAIN_POLLED_AT_KEY).catch(
    () => null,
  );
  const lastPolled = lastPolledRaw ? Number(lastPolledRaw) : null;
  const isDue =
    lastPolled === null || !Number.isFinite(lastPolled) ||
    now - lastPolled >= BG_POSITION_TRAIN_POLL_MIN_INTERVAL_MS;
  if (!isDue) return readCachedPositions();

  try {
    await AsyncStorage.setItem(BG_POSITION_TRAIN_POLLED_AT_KEY, String(now));
  } catch (e) {
    logger.warn('position-train 폴링 타임스탬프 저장 실패 (graceful)', e);
  }

  try {
    const data = await fetchTrainPositions(line);
    if (data.isMock) return readCachedPositions();
    await AsyncStorage.setItem(BG_POSITION_TRAIN_CACHE_KEY, JSON.stringify(data));
    return data;
  } catch (e) {
    logger.warn('position-train 폴링 실패 (graceful, 캐시 fallback)', e);
    return readCachedPositions();
  }
}
