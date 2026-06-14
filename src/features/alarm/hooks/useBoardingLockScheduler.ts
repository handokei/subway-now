/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 이 파일은 의도적으로 여러 features의 hook/util을 조합하는
 * orchestrator 역할이라 직접 import가 본질적이다. Phase 5 enforce 모드에서 file-level disable로
 * 옵트인 처리. 후속 PR(별도 이슈)에서 orchestration 슬라이스(예: features/fusion/, app shell)로
 * 추출하여 disable을 제거할 예정.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import { useEffect, useRef } from 'react';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import type { Route } from '../../../shared/utils/stationRoute';
import {
  cancelAllHopsForLock,
  routeSignature,
  scheduleHopsForLock,
  setRegisteredBlRouteSig,
} from '../utils/boardingLockScheduler';
import { clearFiredAlarms } from '../utils/notificationState';
import { createLogger } from '../../../shared/utils/logger';
import { useSleepModeRef } from '../../settings/hooks/useSleepModeRef';

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
        // #1282: route-sig가 바뀐 경우 firedAlarms를 초기화해 이전 route 기반 dedup이
        // 새 route의 phase 알람 발사를 억제하지 않도록 한다 (feedback #8 re-fire 방지).
        if (needsRouteChangeReschedule) {
          await clearFiredAlarms();
        }
        await scheduleHopsForLock({
          lock,
          route,
          destinationName,
          sleepMode: sleepModeRef.current,
        });
        // #1282: 예약 성공 직후 sig를 영속화 — receiver gate가 stale `bl:` 발사를 억제하는 데 사용.
        // canSchedule=true 조건(route/destinationName 모두 non-null)에서만 진입하므로
        // nextSig는 non-null이 보장된다.
        await setRegisteredBlRouteSig(nextSig!);
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
