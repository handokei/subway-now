/**
 * #1542 (ADR-016 S9) — CMMotionManager accelerometer fingerprint React hook.
 *
 * 동작:
 *   1. mount 시 `isAccelerometerFingerprintSupported` 확인 → true면 `startAccelerometerFingerprint`
 *   2. 폴링(5s)으로 native가 캐시한 최신 60s window snapshot을 sync → pattern 분류
 *   3. 미지원/예외 케이스는 'unknown'으로 확정 — 호출자는 vote 미투표로 인식
 *   4. unmount 시 `stopAccelerometerFingerprint`로 cleanup
 *
 * 폴링 간격(5s): native는 5Hz raw sample을 60s window에 누적 → 60s window가 첫 수렴까지 ~60초
 *   걸린다. 5s 폴링이면 첫 자동 분류 시점 이후 매 cycle마다 freshness 충분 (useMotionActivity /
 *   useCellularTech와 같은 주기 — 알람 평가 30s보다 짧다).
 *
 * BG 호환:
 *   - 본 FG hook은 mount/unmount lifecycle 동안만 active. expo-sensors `useAccelerometer`(#823)와
 *     별 lifecycle — 본 hook은 native CMMotionManager 기반이라 Background Location piggyback과
 *     호환된다 (BG task가 `startAccelerometerFingerprint`를 별 호출해 BG 동안 유지).
 *
 * 반환:
 *   - 'unknown' (default / 미지원 / 60s window 미수렴)
 *   - 'stationary' (정적 사용자, RMS < 0.3 m/s²)
 *   - 'walking' (도보, 0.3 ≤ RMS < 2.0 m/s²)
 *   - 'automotive' (train 진동, RMS ≥ 2.0 m/s²) — undergroundSSotConsensus env vote 1표
 */

import { useEffect, useState } from 'react';
import {
  classifyAccelerometerPattern,
  getLatestAccelerometerSnapshot,
  isAccelerometerFingerprintSupported,
  startAccelerometerFingerprint,
  stopAccelerometerFingerprint,
  type AccelerometerPattern,
} from '../utils/accelerometerFingerprint';

/** 폴링 주기 — `useCellularTech` / `useMotionActivity`와 동일 (5s). 알람 평가 30s보다 짧다. */
const POLL_INTERVAL_MS = 5_000;

export function useAccelerometerFingerprint(): AccelerometerPattern {
  const [pattern, setPattern] = useState<AccelerometerPattern>('unknown');

  useEffect(() => {
    if (!isAccelerometerFingerprintSupported()) {
      // 미지원(Android/jest/web/iOS 시뮬레이터 일부) — vote 미투표 확정.
      setPattern('unknown');
      return;
    }
    startAccelerometerFingerprint();

    // 초기 1회 + 인터벌 폴링. native가 cache한 최신 snapshot을 sync.
    setPattern(classifyAccelerometerPattern(getLatestAccelerometerSnapshot()));
    const intervalId = setInterval(() => {
      setPattern(classifyAccelerometerPattern(getLatestAccelerometerSnapshot()));
    }, POLL_INTERVAL_MS);

    return () => {
      clearInterval(intervalId);
      stopAccelerometerFingerprint();
    };
  }, []);

  return pattern;
}
