/**
 * Trip-ended sentinel storage (#899 Seam C).
 *
 * BG silent push trip-ended 핸들러가 작성하는 키. zustand store에 BG에서 접근할 수
 * 없어 storage cleanup만 수행하는데, FG 복귀 시 useStateRehydration이 이 키를 보고
 * destination/lock store를 reset해 stale UI를 차단한다.
 *
 * SSOT key: storageKeys.TRIP_ENDED_BY_BACKEND_AT_KEY.
 *
 * 모든 함수는 AsyncStorage 실패를 graceful하게 흡수 — sentinel은 보조 채널이므로
 * 실패해도 storage cleanup 자체의 효력은 유지된다.
 *
 * #2114 (2026-08-03 건대 RCA) — sentinel은 원래 timestamp만 갖고 있어 "어느 trip의
 * 종료인지" 스코프가 없었다. 밤샘 trip force-end sentinel이 그 직후 등록된 새 trip을
 * FG 재진입 시 통째로 reset해버리는 회귀의 root cause.
 *
 * 결정 evolve (2026-08-03, 방안 C′) — 당초 검토한 "tripToken 스코프"는 불가능하다:
 * 이 시스템의 tripToken은 APNs 디바이스 토큰이라 기기당 고정이고, 옛/새 trip을 구분할
 * 수 없다 (D1 trip_metrics에서 6~8월 전 trip이 동일 hash). 진짜 trip 인스턴스
 * 식별자는 per-trip corrId(#1597, `tripCorrId.ts`)다. 그래서 sentinel 저장값을
 * `{ endedAt, corrId }`로 확장하고, corrId 비교를 1순위 판정으로 추가한다.
 * timestamp 비교(`isTripEndedSentinelStale`, 방안 A)는 corrId 정보가 없는 legacy
 * sentinel/현재 corrId 미수화 케이스의 fallback으로 유지된다.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { TRIP_ENDED_BY_BACKEND_AT_KEY } from '../../../shared/constants/storageKeys';

/** sentinel 저장 스키마. corrId는 legacy(구버전 plain-number) sentinel에서는 null. */
export interface TripEndedSentinel {
  endedAt: number;
  corrId: string | null;
}

/**
 * sentinel 작성. trip-ended silent push 수신 / lifecycle force-end / self-end 시점에 호출.
 *
 * @param corrId cleanup 전에 캡처한 종료 trip의 corrId snapshot (`getCurrentTripCorrIdSync()`).
 *   미전달 시 null — legacy 호출부 하위호환.
 */
export async function setTripEndedSentinel(
  at: number = Date.now(),
  corrId: string | null = null,
): Promise<void> {
  try {
    const sentinel: TripEndedSentinel = { endedAt: at, corrId };
    await AsyncStorage.setItem(TRIP_ENDED_BY_BACKEND_AT_KEY, JSON.stringify(sentinel));
  } catch {
    // sentinel 실패는 graceful — storage cleanup은 이미 수행됨.
  }
}

/**
 * sentinel 파싱. 신규 JSON 스키마(`{endedAt, corrId}`) 우선, 실패 시 legacy plain-number
 * 문자열(corrId=null 취급)로 fallback. 값이 없거나 둘 다 유효하지 않으면 null.
 */
export async function getTripEndedSentinel(): Promise<TripEndedSentinel | null> {
  try {
    const raw = await AsyncStorage.getItem(TRIP_ENDED_BY_BACKEND_AT_KEY);
    if (raw === null) return null;

    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'endedAt' in parsed &&
        typeof (parsed as { endedAt: unknown }).endedAt === 'number' &&
        Number.isFinite((parsed as { endedAt: number }).endedAt)
      ) {
        const corrIdField = (parsed as { corrId?: unknown }).corrId;
        return {
          endedAt: (parsed as { endedAt: number }).endedAt,
          corrId: typeof corrIdField === 'string' ? corrIdField : null,
        };
      }
    } catch {
      // JSON.parse 실패 — legacy plain-number 문자열일 수 있으므로 아래에서 재시도.
    }

    // legacy — 순수 숫자 문자열(구버전 setTripEndedSentinel(at))만 저장했던 시절의 값.
    const legacyParsed = Number(raw);
    return Number.isFinite(legacyParsed) ? { endedAt: legacyParsed, corrId: null } : null;
  } catch {
    return null;
  }
}

/** sentinel 처리 완료 시 호출. 다음 trip-ended를 다시 감지할 수 있도록 키 삭제. */
export async function clearTripEndedSentinel(): Promise<void> {
  try {
    await AsyncStorage.removeItem(TRIP_ENDED_BY_BACKEND_AT_KEY);
  } catch {
    // graceful — 다음 reset 호출에서 재시도된다.
  }
}

/**
 * sentinel이 현재 활성 trip보다 오래된(=이전 trip의) 것인지 판정 (#2114 방안 A).
 *
 * sentinel timestamp만으로 판정하는 fallback 가드. tripStartedAt이 sentinelAt보다
 * 나중이면 그 sentinel은 이미 종료 처리된 이전 trip의 잔재이고, 현재 활성 trip은
 * sentinel이 기록된 시점 이후 새로 시작된 것이므로 소비(reset)하면 안 된다.
 *
 * tripStartedAt이 null이면(활성 trip 없음) stale 판정 대상이 아니다 — 기존 reset 동작 유지.
 */
export function isTripEndedSentinelStale(
  sentinelAt: number,
  tripStartedAt: number | null,
): boolean {
  return tripStartedAt !== null && tripStartedAt > sentinelAt;
}

/**
 * sentinel 소비 시점 최종 판정 (#2114 방안 C′ + A fallback).
 *
 * 판정 순서:
 *   1) sentinel.corrId ≠ null && currentCorrId ≠ null && 서로 다름 → 'stale' 확정
 *      (다른 trip의 종료 — corrId가 trip 인스턴스의 진짜 식별자이므로 timestamp 비교 불필요).
 *   2) 둘 중 하나라도 null(legacy sentinel 또는 corrId sync cache 미수화) → timestamp
 *      fallback(`isTripEndedSentinelStale`, 방안 A)로 판정.
 *   3) 그 외(둘 다 non-null && 일치) → 'fresh' — 같은 trip의 정상 종료, 기존 소비(reset) 대상.
 */
export function resolveTripEndedSentinelVerdict(
  sentinel: TripEndedSentinel,
  tripStartedAt: number | null,
  currentCorrId: string | null,
): 'fresh' | 'stale' {
  if (sentinel.corrId !== null && currentCorrId !== null) {
    return sentinel.corrId === currentCorrId ? 'fresh' : 'stale';
  }
  return isTripEndedSentinelStale(sentinel.endedAt, tripStartedAt) ? 'stale' : 'fresh';
}
