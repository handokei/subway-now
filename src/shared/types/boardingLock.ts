import type { LineNumber } from './station';

/**
 * BoardingLock — 사용자가 명시적으로 탑승한 열차/노선/시각을 확정 (#584).
 *
 * GPS 추정의 본질적 부정확성을 보완: 환승역에서 어느 노선/방향인지 불명확한 문제를
 * 사용자 의지로 lock한다. 이 Lock이 활성인 동안 Fusion은 GPS를 검증 채널로 격하하고,
 * 사전 예약 알람의 lead time 계산에 trainCode + boardingLine을 사용한다.
 *
 * Multi-transfer trip은 leg마다 새 Lock으로 교체 (transfer 시점에서 갱신, PR E).
 */
export interface BoardingLock {
  /** Trip 목적지 — Lock과 trip 1:1 매핑. destination 변경 시 Lock도 해제된다. */
  destinationId: string;
  /** 사용자가 탭한 열차의 trainCode. backend는 이 값으로 reschedule 정정을 보낸다. */
  trainCode: string;
  /** 탑승 역 id. trip 시작 시점 스냅샷. */
  boardingStationId: string;
  /** 탑승 시점 노선 — multi-transfer에서 현재 leg의 노선. */
  boardingLine: LineNumber;
  /** 탑승 시각 (ms epoch). 자동 만료 기준점. */
  boardedAt: number;
  /** 예상 trip(또는 현재 leg) 소요 시간(ms). 자동 만료 계산용. */
  expectedDurationMs: number;
  /**
   * 탑승 시점 train의 잔여 ETA(초) — Seam A (#897).
   *
   * 이 lock으로 잠긴 trip이 동일 trainCode 동안 머무는 동안, 새 폴링 응답의 동일 train
   * arrivalSeconds가 이 값보다 크게 늘었다면 그 차이가 지연(분) 단위 신호다.
   *
   * 레거시 영속화(이 필드 없이 저장된 lock)는 storage 가드가 그대로 통과시키되 값은 undefined.
   * 지연 라벨은 값이 존재할 때만 노출되므로 graceful — 잘못된 추측 없이 다음 createLock에서 채워진다.
   */
  initialEtaSeconds?: number;
  /**
   * Free-trip sentinel marker (#978, PR #955 follow-up).
   *
   * 사용자가 destination을 설정하지 않은 free trip에서 transfer auto-detect로 hydrate된
   * lock에만 stamp된다. 명시 destination이 있는 일반 lock에는 undefined.
   *
   * 용도:
   *   - 진단/텔레메트리: 이 lock이 sentinel-destination 기반인지 명시.
   *   - controller가 hydrate 시점을 sentinelAt에 기록 → 후속 free-trip 만료 정책에서 사용 가능.
   *
   * destination 변경 시 invalidate는 BoardingLock.destinationId가 sentinel 값 자체로 채워져
   * 있기 때문에 기존 destinationId mismatch effect로 자동 처리된다 (별도 분기 불필요).
   */
  hydratedFromSentinel?: {
    /** sentinel 상수 값 — 디버그/로그용. lock.destinationId와 동일해야 한다. */
    destinationId: string;
    /** sentinel-hydrate 시각(ms epoch). */
    sentinelAt: number;
  };
}

/** 자동 만료 안전 계수 — 예상 소요시간이 50% 초과되면 잘못된 Lock으로 보고 해제. */
export const BOARDING_LOCK_EXPIRY_FACTOR = 1.5;

export function isBoardingLockExpired(lock: BoardingLock, now: number): boolean {
  return now > lock.boardedAt + lock.expectedDurationMs * BOARDING_LOCK_EXPIRY_FACTOR;
}
