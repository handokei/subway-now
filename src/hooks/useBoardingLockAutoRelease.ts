import { useEffect, useRef } from 'react';
import type { BoardingLock } from '../types/boardingLock';
import type { Station } from '../types/station';
import {
  ARRIVAL_PROXIMITY_THRESHOLD_M,
  AUTO_RELEASE_GRACE_MS,
} from '../constants/boardingLock';
import { createLogger } from '../utils/logger';

const logger = createLogger('useBoardingLockAutoRelease');

export interface UseBoardingLockAutoReleaseInputs {
  /** 활성 BoardingLock. null이면 평가하지 않음. */
  lock: BoardingLock | null;
  /** 목적지 id. lock.destinationId와 비교는 store/controller가 이미 수행하므로 본 hook은 매칭 판정용. */
  destinationId: string | null;
  /** Fusion으로 결정된 현재역. */
  currentStation: Station | null;
  /** Fusion 현재역까지 거리(km). useFusedNearestStation의 result.distanceKm. */
  distanceKm: number | null;
  /** Lock 해제 액션. useBoardingLockController.releaseLock 또는 store releaseLock 위임. */
  releaseLock: () => void;
}

/**
 * 도착 자동 release hook (#759).
 *
 * 활성 BoardingLock + 도착 신호 지속 시 lock을 자동 해제한다.
 *
 * 트리거 조건:
 *  - lock active
 *  - fusion currentStation.id == destination
 *  - distance < ARRIVAL_PROXIMITY_THRESHOLD_M
 *  - 위 셋이 AUTO_RELEASE_GRACE_MS 이상 지속
 *
 * 동작:
 *  - 진입 시 첫 ts ref 기록.
 *  - 매 fusion update에서 (a) 조건 지속 + 경과시간 ≥ grace → releaseLock + ref 리셋.
 *    (b) 조건 미충족 → ref 리셋 (다음 진입에서 새로 카운트 시작).
 *  - lock.trainCode 변경(새 trip/leg) 시 ref 리셋 — 이전 trip의 진입 ts가 새 trip에 흘러가지 않음.
 *
 * 환승 trip의 마지막 hop도 동일 처리 — destinationId 기준으로 매칭하므로 환승 시점 leg의 도착이
 * 아닌 trip 최종 도착에서만 발화한다.
 *
 * sleep mode와 무관: release는 알람 발화가 아니라 lock 라이프사이클 정리.
 *
 * useArrivalAutoClear와의 책임 분리:
 *  - useArrivalAutoClear — 도착 banner UX + setDestination(null) (UI 도착 처리)
 *  - 본 hook — lock 자동 release (라이프사이클 정리)
 *  - 임계값/grace가 다른 이유: 자동 release는 lock 해제까지 가는 강한 effect라 300m/45s로 보수적.
 *    UI banner는 500m/2s로 빠른 시각 피드백.
 */
export function useBoardingLockAutoRelease({
  lock,
  destinationId,
  currentStation,
  distanceKm,
  releaseLock,
}: UseBoardingLockAutoReleaseInputs): void {
  const firstArrivedAtRef = useRef<number | null>(null);
  const lastTrainCodeRef = useRef<string | null>(null);

  useEffect(() => {
    const trainCode = lock?.trainCode ?? null;
    if (lastTrainCodeRef.current !== trainCode) {
      lastTrainCodeRef.current = trainCode;
      firstArrivedAtRef.current = null;
    }

    if (!lock || !destinationId || !currentStation || distanceKm == null) {
      firstArrivedAtRef.current = null;
      return;
    }

    const stationMatched = currentStation.id === destinationId;
    const proximityOk = distanceKm * 1000 < ARRIVAL_PROXIMITY_THRESHOLD_M;
    if (!stationMatched || !proximityOk) {
      firstArrivedAtRef.current = null;
      return;
    }

    const now = Date.now();
    if (firstArrivedAtRef.current === null) {
      firstArrivedAtRef.current = now;
      return;
    }

    if (now - firstArrivedAtRef.current >= AUTO_RELEASE_GRACE_MS) {
      firstArrivedAtRef.current = null;
      logger.info('도착 grace 충족 → lock 자동 release');
      releaseLock();
    }
  }, [lock, destinationId, currentStation, distanceKm, releaseLock]);
}
