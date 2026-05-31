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
  // #709 cold restart 보장: lock이 storage에서 먼저 hydrate되고 route/destination이
  // 늦게 로드되는 케이스에서, 같은 trainCode라도 schedule이 아직 안 일어났다면 한 번은 보장.
  // trainCode를 기록해 release 후 같은 trainCode 재진입 시 다시 schedule할 수 있게 한다.
  const scheduledTrainCodeRef = useRef<string | null>(null);
  // 이미 예약된 알람은 sleep 토글에 영향받지 않는 trade-off — 토글 기반 재예약이 요구되면 별도 이슈.
  const sleepModeRef = useSleepModeRef();

  useEffect(() => {
    const prev = prevLockRef.current;
    const prevTrain = prev?.trainCode ?? null;
    const nextTrain = lock?.trainCode ?? null;
    const canSchedule = lock !== null && route !== null && destinationName !== null;
    // 같은 trainCode인데도 schedule을 보장해야 하는 cold-restart 케이스:
    // 직전 effect에서 route/destination이 미완비라 schedule을 건너뛰었고, 지금은 ready.
    const needsColdRestartSchedule =
      canSchedule && scheduledTrainCodeRef.current !== nextTrain;

    if (prevTrain === nextTrain && !needsColdRestartSchedule) {
      // 같은 trainCode(또는 둘 다 null)이고 이미 해당 trainCode로 schedule 완료 — 재예약 없음.
      prevLockRef.current = lock;
      return;
    }

    const handleTransition = async (): Promise<void> => {
      // prev가 있고 trainCode가 실제로 바뀐 경우에만 cancel (cold-restart 보강 시엔 cancel 불필요).
      if (prev && prevTrain !== nextTrain) {
        await cancelAllHopsForLock(prev);
      }
      if (canSchedule) {
        await scheduleHopsForLock({
          lock,
          route,
          destinationName,
          sleepMode: sleepModeRef.current,
        });
        scheduledTrainCodeRef.current = nextTrain;
      } else if (nextTrain === null) {
        // lock release — 다음 lock 진입 시 같은 trainCode라도 다시 schedule 가능하도록 reset.
        scheduledTrainCodeRef.current = null;
      }
    };
    handleTransition().catch((e: unknown) => {
      logger.error('scheduler 전환 실패:', e);
    });
    prevLockRef.current = lock;
  }, [lock, route, destinationName]);
}
