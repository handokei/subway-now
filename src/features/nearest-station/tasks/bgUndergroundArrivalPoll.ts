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
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createArrivalProvider } from '../../arrival/providers/factory';
import type { ArrivalProvider } from '../../arrival/providers/types';
import type { StationArrival } from '../../../shared/types/arrival';
import type { LineNumber } from '../../../shared/types/station';
import {
  BG_UNDERGROUND_ARRIVAL_POLLED_AT_KEY,
  BG_UNDERGROUND_ARRIVAL_CACHE_KEY,
} from '../../../shared/constants/storageKeys';
import { createLogger } from '../../../shared/utils/logger';

const logger = createLogger('BgUndergroundArrivalPoll');

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

async function readCachedArrival(): Promise<StationArrival | null> {
  try {
    const raw = await AsyncStorage.getItem(BG_UNDERGROUND_ARRIVAL_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StationArrival;
  } catch {
    return null;
  }
}

/**
 * 지하 candidate station(WiFi 매칭 대상)의 arvlCd를 조건부 폴링한다.
 * - 최소 간격 미경과: 네트워크 호출 없이 직전 캐시 반환(quota 보호).
 * - fetch 성공(mock 아님): 캐시 갱신 + 결과 반환.
 * - fetch 성공(mock) 또는 실패: 캐시 fallback(graceful) — undergroundSSOTConsensus는 arrival이
 *   null이어도 다른 신호(cellular/accel)로 계속 평가 가능하므로 실패가 전체 파이프라인을 막지 않는다.
 * - 폴링 시각은 fetch 시도 직전에 먼저 기록한다 — 실패해도 쿨다운이 적용돼 연속 실패 tick마다
 *   재시도로 quota를 소진하지 않는다.
 */
export async function pollUndergroundArrivalIfDue(
  stationName: string,
  lineHint: LineNumber,
  now: number = Date.now(),
): Promise<StationArrival | null> {
  const lastPolledRaw = await AsyncStorage.getItem(BG_UNDERGROUND_ARRIVAL_POLLED_AT_KEY).catch(
    () => null,
  );
  const lastPolled = lastPolledRaw ? Number(lastPolledRaw) : null;
  const isDue =
    lastPolled === null || !Number.isFinite(lastPolled) ||
    now - lastPolled >= BG_UNDERGROUND_ARRIVAL_POLL_MIN_INTERVAL_MS;
  if (!isDue) return readCachedArrival();

  try {
    await AsyncStorage.setItem(BG_UNDERGROUND_ARRIVAL_POLLED_AT_KEY, String(now));
  } catch (e) {
    logger.warn('지하 arrival 폴링 타임스탬프 저장 실패 (graceful)', e);
  }

  try {
    const data = await getProvider().getArrival(stationName, { lineHint });
    if (data.isMock) return readCachedArrival();
    await AsyncStorage.setItem(BG_UNDERGROUND_ARRIVAL_CACHE_KEY, JSON.stringify(data));
    return data;
  } catch (e) {
    logger.warn('지하 arrival 폴링 실패 (graceful, 캐시 fallback)', e);
    return readCachedArrival();
  }
}
