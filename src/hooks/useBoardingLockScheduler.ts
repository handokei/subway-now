import { useEffect, useRef } from 'react';
import type { BoardingLock } from '../types/boardingLock';
import type { Route } from '../utils/stationRoute';
import {
  cancelAllHopsForLock,
  scheduleHopsForLock,
} from '../utils/boardingLockScheduler';
import { createLogger } from '../utils/logger';
import { useSleepModeRef } from './useSleepModeRef';

const logger = createLogger('useBoardingLockScheduler');

export interface UseBoardingLockSchedulerInputs {
  lock: BoardingLock | null;
  route: Route;
  destinationName: string | null;
}

/**
 * Lock 변화에 반응해 boardingLockScheduler를 호출한다 (#584 PR C).
 *
 * - 신규 Lock(또는 trainCode 변경) → 이전 Lock 알람 일괄 cancel + 새 Lock으로 사전 예약
 * - Lock 해제(null) → 이전 Lock 알람 일괄 cancel
 * - route/destination만 바뀐 경우는 재예약하지 않는다 — 동일 trip의 route 변동은 PR D에서
 *   advanceHopWindow로 처리하는 것이 정확하기 때문이다.
 *
 * 호출 측은 1회만 마운트한다 (홈 탭). 다른 화면에서도 BoardingLockStore를 읽지만,
 * scheduler 호출 책임은 단일 owner인 이 hook이 진다.
 */
export function useBoardingLockScheduler({
  lock,
  route,
  destinationName,
}: UseBoardingLockSchedulerInputs): void {
  const prevLockRef = useRef<BoardingLock | null>(null);
  // 이미 예약된 알람은 sleep 토글에 영향받지 않는 trade-off — 토글 기반 재예약이 요구되면 별도 이슈.
  const sleepModeRef = useSleepModeRef();

  useEffect(() => {
    const prev = prevLockRef.current;
    const prevTrain = prev?.trainCode ?? null;
    const nextTrain = lock?.trainCode ?? null;

    if (prevTrain === nextTrain) {
      // 같은 trainCode(또는 둘 다 null) — 재예약 없음. ref만 최신화하여 다음 비교 정확성 유지.
      prevLockRef.current = lock;
      return;
    }

    const handleTransition = async (): Promise<void> => {
      if (prev) {
        await cancelAllHopsForLock(prev);
      }
      if (lock && route && destinationName) {
        await scheduleHopsForLock({
          lock,
          route,
          destinationName,
          sleepMode: sleepModeRef.current,
        });
      }
    };
    handleTransition().catch((e: unknown) => {
      logger.error('scheduler 전환 실패:', e);
    });
    prevLockRef.current = lock;
  }, [lock, route, destinationName]);
}
