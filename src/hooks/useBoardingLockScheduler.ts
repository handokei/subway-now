import { useEffect, useRef } from 'react';
import type { BoardingLock } from '../types/boardingLock';
import type { Route } from '../utils/stationRoute';
import {
  cancelAllHopsForLock,
  routeSignature,
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
  // #708 같은 trainCode 안에서도 route/destination이 바뀌면 사전 예약된 hop이 stale이 되어
  // 잘못된 역에서 알람이 발사된다. scheduled 시점의 signature를 기억해 차이가 생기면
  // cancel → reschedule 한다.
  const scheduledRouteSigRef = useRef<string | null>(null);
  // 이미 예약된 알람은 sleep 토글에 영향받지 않는 trade-off — 토글 기반 재예약이 요구되면 별도 이슈.
  const sleepModeRef = useSleepModeRef();

  useEffect(() => {
    const prev = prevLockRef.current;
    const prevTrain = prev?.trainCode ?? null;
    const nextTrain = lock?.trainCode ?? null;
    const canSchedule = lock !== null && route !== null && destinationName !== null;
    const nextSig = routeSignature(route, destinationName);
    // 같은 trainCode인데도 schedule을 보장해야 하는 cold-restart 케이스:
    // 직전 effect에서 route/destination이 미완비라 schedule을 건너뛰었고, 지금은 ready.
    const needsColdRestartSchedule =
      canSchedule && scheduledTrainCodeRef.current !== nextTrain;
    // #708 trainCode는 동일하지만 route/destination 구조가 변해 hop 시퀀스가 달라졌다.
    // 사전 예약을 한 번 비우고 새 signature로 다시 예약한다.
    const needsRouteChangeReschedule =
      canSchedule &&
      scheduledTrainCodeRef.current === nextTrain &&
      scheduledRouteSigRef.current !== null &&
      scheduledRouteSigRef.current !== nextSig;

    // #756 transition trace — stale `bl:` 알람 누수 진단용.
    //
    // logger.warn으로 출력하는 이유: production TestFlight 빌드는 `app/_layout.tsx:48`에서
    // `setMinLevel('warn')`이 적용돼 `info`가 출력 자체 차단된다. 진단 표적은 실기기 production
    // 회귀이므로 warn으로 승격해 USB Console.app에서도 보이게 한다. trip 전환은 분당 0~1회 빈도라
    // noise 영향 미미.
    //
    // 노출 키:
    //  - prevTrain  : 직전 effect cycle의 lock.trainCode
    //  - nextTrain  : 이번 cycle의 lock.trainCode
    //  - scheduledTrain : 마지막 성공한 schedule의 trainCode (`scheduledTrainCodeRef.current`)
    //                   prev와 다르면 H1 race(직전 cycle scheduling 실패) 신호.
    //  - sigPrev/sigNext : 마지막 성공한 schedule의 routeSig vs 이번 cycle 계산값.
    //  - canSchedule / coldRestart / routeChange : 이 cycle의 결정 flag.
    logger.warn(
      `transition prevTrain=${prevTrain ?? 'null'} nextTrain=${nextTrain ?? 'null'} scheduledTrain=${
        scheduledTrainCodeRef.current ?? 'null'
      } sigPrev=${scheduledRouteSigRef.current ?? 'null'} sigNext=${
        nextSig ?? 'null'
      } canSchedule=${canSchedule} coldRestart=${needsColdRestartSchedule} routeChange=${needsRouteChangeReschedule}`,
    );

    if (
      prevTrain === nextTrain &&
      !needsColdRestartSchedule &&
      !needsRouteChangeReschedule
    ) {
      // 같은 trainCode이고 schedule도 최신 — 재예약 없음.
      prevLockRef.current = lock;
      return;
    }

    const handleTransition = async (): Promise<void> => {
      // prev가 있고 (trainCode 변경 OR route signature 변경)인 경우에만 cancel.
      // cold-restart(같은 trainCode + 이전엔 미예약)는 cancel할 게 없으므로 skip.
      const shouldCancelPrev =
        prev !== null && (prevTrain !== nextTrain || needsRouteChangeReschedule);
      if (shouldCancelPrev && prev) {
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
        scheduledRouteSigRef.current = nextSig;
      } else if (nextTrain === null) {
        // lock release — 다음 lock 진입 시 같은 trainCode라도 다시 schedule 가능하도록 reset.
        scheduledTrainCodeRef.current = null;
        scheduledRouteSigRef.current = null;
      }
    };
    handleTransition().catch((e: unknown) => {
      logger.error('scheduler 전환 실패:', e);
    });
    prevLockRef.current = lock;
  }, [lock, route, destinationName]);
}
