/**
 * #728 — CMMotionActivity 신호 React hook.
 *
 * 동작:
 *   1. mount 시 isMotionActivitySupported 확인 → true면 권한 요청
 *   2. 권한 부여되면 startMotionActivityUpdates + 폴링으로 stationary 상태 sync
 *   3. 미지원/거절 케이스는 false로 확정 — 호출자는 motion 가드 비활성화로 인식
 *   4. unmount 시 stopMotionActivityUpdates로 cleanup
 *
 * 폴링 간격(POLL_INTERVAL_MS): 5초 — 알람 평가 주기(30초)보다 짧아 stale 우려 적음.
 *   너무 짧으면 native 부하, 너무 길면 motion 변화 누락. 5초가 절충점.
 *
 * #1013 — 반환 타입을 `boolean | undefined`로 확장.
 *   - `undefined` : 초기화 중 warmup 상태. mount 직후 async init 완료 전 (~30s).
 *                   evaluateMovement가 'motion-warmup'으로 차단해 신호 부재 구간 게이트 우회 방지.
 *   - `false`     : 미지원/권한 거절로 motion 가드 영구 비활성화. speed/positionStability fallback으로.
 *   - `true/false`: 권한 부여 후 실시간 stationary 상태.
 */

import { useEffect, useRef, useState } from 'react';
import {
  isMotionActivitySupported,
  requestMotionActivityPermission,
  startMotionActivityUpdates,
  stopMotionActivityUpdates,
  getCurrentMotionStationary,
} from '../utils/motionActivity';

/** 폴링 주기 — 너무 짧으면 native 부하, 너무 길면 motion 변화 누락. 5s는 절충점. */
const POLL_INTERVAL_MS = 5_000;

export function useMotionActivity(): boolean | undefined {
  // undefined = warmup(초기화 중). 권한 결과 또는 첫 stationary 값을 받으면 boolean으로 확정.
  const [stationary, setStationary] = useState<boolean | undefined>(undefined);
  const startedRef = useRef<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const init = async () => {
      if (!isMotionActivitySupported()) {
        setStationary(false);
        return;
      }
      const granted = await requestMotionActivityPermission();
      if (cancelled) return;
      if (!granted) {
        setStationary(false);
        return;
      }

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
