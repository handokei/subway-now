/**
 * #2383 (SonarCloud dup-density fix) — `bgUndergroundArrivalPoll.ts`(#2381 Gap A)와
 * `bgPositionTrainPoll.ts`가 거의 동일한 쿨다운-폴링 스켈레톤(타임스탬프 due 판정 + 캐시
 * read/write + isMock 가드 + graceful fetch fallback)을 각자 구현해 중복이 발생했다. 두 소스
 * (arrival API / realtimePosition API)가 다를 뿐 정책은 동일 — 이 제네릭 헬퍼로 흡수한다.
 *
 * BG task는 TaskManager invocation마다 새 컨텍스트라 in-memory ref로 폴링 간격을 기억할 수
 * 없다(`readBgLastPositionUploadAt`와 동일 제약) — AsyncStorage 타임스탬프로 invocation 간
 * 쿨다운 상태를 공유한다.
 *
 * 호출자(각 도메인별 thin wrapper)가 게이트(플래그/lock/profile 등)를 이미 통과한 tick에서만
 * 호출한다 — 본 헬퍼 자체는 그 게이트를 걸지 않는다(단일 책임: 폴링 주기 관리 + graceful
 * fetch/캐시만).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createLogger } from '../../../shared/utils/logger';

const logger = createLogger('PollWithCooldown');

export interface PollWithCooldownParams<T extends { isMock?: boolean }> {
  /** 마지막 폴링 시각(epoch ms) 저장 키. */
  polledAtKey: string;
  /** 폴링 결과 캐시 저장 키. */
  cacheKey: string;
  /** 최소 폴링 간격(ms) — 이 간격 미경과 tick은 네트워크 호출 없이 캐시 반환(quota 보호). */
  minIntervalMs: number;
  now: number;
  /** 실제 fetch 수행 — 도메인별(arrival API / realtimePosition API 등) 순수 fetch 함수. */
  fetcher: () => Promise<T>;
  /** 로그 메시지 prefix — 어느 도메인의 폴링인지 구분(예: "지하 arrival", "position-train"). */
  logLabel: string;
}

async function readCache<T>(cacheKey: string): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(cacheKey);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * 조건부 폴링 — 정책:
 * - 최소 간격 미경과: 네트워크 호출 없이 직전 캐시 반환(quota 보호).
 * - fetch 성공(mock 아님): 캐시 갱신 + 결과 반환.
 * - fetch 성공(mock) 또는 실패: 캐시 fallback(graceful) — 호출자는 결과가 null이어도 다른
 *   신호로 계속 평가할 수 있으므로 실패가 전체 파이프라인을 막지 않는다.
 * - 폴링 시각은 fetch 시도 직전에 먼저 기록한다 — 실패해도 쿨다운이 적용돼 연속 실패 tick마다
 *   재시도로 quota를 소진하지 않는다.
 */
export async function pollWithCooldown<T extends { isMock?: boolean }>(
  params: PollWithCooldownParams<T>,
): Promise<T | null> {
  const { polledAtKey, cacheKey, minIntervalMs, now, fetcher, logLabel } = params;

  const lastPolledRaw = await AsyncStorage.getItem(polledAtKey).catch(() => null);
  const lastPolled = lastPolledRaw ? Number(lastPolledRaw) : null;
  const isDue =
    lastPolled === null || !Number.isFinite(lastPolled) || now - lastPolled >= minIntervalMs;
  if (!isDue) return readCache<T>(cacheKey);

  try {
    await AsyncStorage.setItem(polledAtKey, String(now));
  } catch (e) {
    logger.warn(`${logLabel} 폴링 타임스탬프 저장 실패 (graceful)`, e);
  }

  try {
    const data = await fetcher();
    if (data.isMock) return readCache<T>(cacheKey);
    await AsyncStorage.setItem(cacheKey, JSON.stringify(data));
    return data;
  } catch (e) {
    logger.warn(`${logLabel} 폴링 실패 (graceful, 캐시 fallback)`, e);
    return readCache<T>(cacheKey);
  }
}
