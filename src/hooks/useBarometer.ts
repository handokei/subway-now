/**
 * #875 — 기압계(Barometer) 보조 신호 수집 훅 (Spike).
 *
 * 동작:
 *   1. mount 시 `Barometer.isAvailableAsync()` → 권한 prompt → setUpdateInterval(BAROMETER_SAMPLE_INTERVAL_MS)
 *   2. 1Hz callback이 들어오면 `appendBarometerReading`으로 ring buffer에 push
 *      (60s TTL 자동 prune은 ring buffer 모듈이 처리)
 *   3. unmount 시 subscription remove + ring buffer reset
 *
 * 권한:
 *   - iOS: Apple은 motion 카테고리 통합 — `NSMotionUsageDescription` 1개 키로 충분.
 *     이미 app.config.js에 `#728`(motion activity)로 등록되어 있어 재사용.
 *   - Android: Barometer는 dangerous permission 아님. expo-sensors가 자동 처리.
 *
 * 미지원/권한 거절 (graceful — `feedback_whileinuse_must_work.md` 정책 준수):
 *   - `isAvailableAsync` false → no-op (iPhone 6 이하, 일부 안드로이드 저가 기기)
 *   - 권한 거절 → no-op + ambient state 비움
 *   - ADR-010 게이트는 verdict null 시 그대로 기존 신호로 평가 (회귀 가드)
 *
 * 범위 (CLAUDE.md §2):
 *   - 포그라운드 + WhileInUse 시나리오. iOS Barometer는 BG에서도 동작하지만 본 spike에서는
 *     수집·평가 자체만. 송신/게이트 통합은 후속 sub-issue.
 */

import { useEffect } from 'react';
import { Barometer, type BarometerMeasurement } from 'expo-sensors';
import {
  appendBarometerReading,
  resetBarometerState,
} from '../utils/barometerState';
import { BAROMETER_SAMPLE_INTERVAL_MS } from '../shared/constants/barometer';

/**
 * 기압계 수집을 활성화한다. 반환값 없음 — 외부에서는 `evaluateLatestSubsurface()`로 조회.
 */
export function useBarometer(): void {
  useEffect(() => {
    let cancelled = false;
    let subscription: { remove(): void } | null = null;

    const init = async (): Promise<void> => {
      const available = await safeIsAvailable();
      if (cancelled || !available) return;
      const granted = await safeRequestPermission();
      if (cancelled || !granted) return;

      Barometer.setUpdateInterval(BAROMETER_SAMPLE_INTERVAL_MS);
      subscription = Barometer.addListener((m: BarometerMeasurement) => {
        // m.timestamp는 boot 이후 초 — wall-clock과 직접 비교 불가.
        // ring buffer는 epoch ms 윈도우로 평가하므로 Date.now()로 직접 stamp.
        appendBarometerReading({ t: Date.now(), pressureHpa: m.pressure });
      });
    };

    void init();

    return () => {
      cancelled = true;
      if (subscription !== null) subscription.remove();
      resetBarometerState();
    };
  }, []);
}

/** isAvailableAsync 예외를 false로 폴백 — 일부 시뮬레이터에서 throw. */
async function safeIsAvailable(): Promise<boolean> {
  try {
    return await Barometer.isAvailableAsync();
  } catch {
    return false;
  }
}

/** requestPermissionsAsync 예외를 거절로 폴백 — graceful WhileInUse 보장. */
async function safeRequestPermission(): Promise<boolean> {
  try {
    const { granted } = await Barometer.requestPermissionsAsync();
    return granted;
  } catch {
    return false;
  }
}
