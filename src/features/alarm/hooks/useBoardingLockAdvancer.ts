import { useEffect, useRef } from 'react';
import type { BoardingLock } from '../types/boardingLock';
import type { Route } from '../../../utils/stationRoute';
import { isSameStationName } from '../../../utils/stationRoute';
import { resolveAllTargets } from '../utils/stationAlarm';
import { advanceHopWindow } from '../utils/boardingLockScheduler';
import { createLogger } from '../../../utils/logger';
import { useSleepModeRef } from '../../../hooks/useSleepModeRef';

const logger = createLogger('useBoardingLockAdvancer');

export interface UseBoardingLockAdvancerInputs {
  lock: BoardingLock | null;
  route: Route;
  destinationName: string | null;
  /** Fusion으로 결정된 현재역 이름. null이면 평가하지 않는다. */
  currentStationName: string | null;
}

/**
 * Fusion 현재역이 경로 waypoint에 도달하면 advanceHopWindow를 호출해 hop 윈도우를 전진시킨다 (#584 PR D).
 *
 * - lock/route/destinationName/currentStationName 중 하나라도 없으면 no-op.
 * - resolveAllTargets와 동일한 waypoint 정의를 사용하므로 환승역/도착역이 자동 포함된다.
 * - 같은 waypoint를 여러 번 통과 보고하지 않도록 마지막 advance된 waypoint name을 ref로 추적한다.
 *   trainCode가 바뀌면(새 trip) ref를 초기화한다.
 */
export function useBoardingLockAdvancer({
  lock,
  route,
  destinationName,
  currentStationName,
}: UseBoardingLockAdvancerInputs): void {
  const lastAdvancedRef = useRef<string | null>(null);
  const lastTrainCodeRef = useRef<string | null>(null);
  // 역 통과 신호에만 effect가 반응하도록 sleepMode는 ref로 캡처(#632).
  const sleepModeRef = useSleepModeRef();

  useEffect(() => {
    const trainCode = lock?.trainCode ?? null;
    if (lastTrainCodeRef.current !== trainCode) {
      lastTrainCodeRef.current = trainCode;
      lastAdvancedRef.current = null;
    }

    if (!lock || !route || !destinationName || !currentStationName) return;

    const targets = resolveAllTargets(route, destinationName);
    const matched = targets.find((t) => isSameStationName(t.name, currentStationName));
    if (!matched) return;
    if (lastAdvancedRef.current === matched.name) return;

    lastAdvancedRef.current = matched.name;
    advanceHopWindow({
      lock,
      route,
      destinationName,
      passedStationName: matched.name,
      sleepMode: sleepModeRef.current,
    }).catch((e: unknown) => {
      logger.error('advanceHopWindow 실패:', e);
    });
  }, [lock, route, destinationName, currentStationName]);
}
