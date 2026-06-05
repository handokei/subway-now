/**
 * #728 — CMMotionActivity 신호 React hook.
 *
 * 동작:
 *   1. mount 시 isMotionActivitySupported 확인 → true면 권한 요청
 *   2. 권한 부여되면 startMotionActivityUpdates + 폴링으로 stationary 상태 sync
 *   3. 미지원/거절 케이스는 false 유지 — 호출자(useStationAlarm 등)는 motion 가드 비활성화로 인식
 *   4. unmount 시 stopMotionActivityUpdates로 cleanup
 *
 * 폴링 간격(POLL_INTERVAL_MS): 5초 — 알람 평가 주기(30초)보다 짧아 stale 우려 적음.
 *   너무 짧으면 native 부하, 너무 길면 motion 변화 누락. 5초가 절충점.
 *
 * 반환값: stationary boolean. true면 사용자 정적 확정.
 */

import { useEffect, useRef, useState } from 'react';
import {
  isMotionActivitySupported,
  requestMotionActivityPermission,
  startMotionActivityUpdates,
  stopMotionActivityUpdates,
  getCurrentMotionStationary,
} from '../features/nearest-station/utils/motionActivity';

/** 폴링 주기 — 너무 짧으면 native 부하, 너무 길면 motion 변화 누락. 5s는 절충점. */
const POLL_INTERVAL_MS = 5_000;

export function useMotionActivity(): boolean {
  const [stationary, setStationary] = useState<boolean>(false);
  const startedRef = useRef<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const init = async () => {
      if (!isMotionActivitySupported()) return;
      const granted = await requestMotionActivityPermission();
      if (cancelled || !granted) return;

      startMotionActivityUpdates();
      startedRef.current = true;

      // 초기 1회 + 인터벌 폴링. native가 cache한 최신 activity를 sync.
      setStationary(getCurrentMotionStationary());
      intervalId = setInterval(() => {
        setStationary(getCurrentMotionStationary());
      }, POLL_INTERVAL_MS);
    };

    void init();

    return () => {
      cancelled = true;
      if (intervalId !== null) clearInterval(intervalId);
      if (startedRef.current) {
        stopMotionActivityUpdates();
        startedRef.current = false;
      }
    };
  }, []);

  return stationary;
}
