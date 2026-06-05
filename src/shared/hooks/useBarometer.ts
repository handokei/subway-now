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

import { useEffect, useRef, useState } from 'react';
import { Barometer, type BarometerMeasurement } from 'expo-sensors';
import {
  appendBarometerReading,
  evaluateLatestSubsurface,
  resetBarometerState,
} from '../utils/barometerState';
import {
  BAROMETER_SAMPLE_INTERVAL_MS,
  BAROMETER_SUBSURFACE_CONFIRM_SAMPLES,
} from '../constants/barometer';

/**
 * #903 — 외부 소비자에 노출되는 보조 신호 스냅샷.
 *
 * `subsurface`만 노출 — UI/sticky/alarm은 boolean 한 값으로 충분. 디버그용 raw delta는
 * `getBarometerReadings()` / `evaluateLatestSubsurface()`로 직접 조회.
 */
export interface BarometerSignal {
  /** 30s 윈도우 dP가 임계 이상 상승했는가 (지하 진입 후보). */
  subsurface: boolean;
}

/**
 * 기압계 수집을 활성화하고 최신 dP/dt 평가 결과를 반환한다.
 *
 * 미지원/권한 거절/reading 부족: subsurface=false (보수적 fallback).
 * Seam G(#903) — 호출자(useNearestStation / useFusedNearestStation)는 반환값의 subsurface로
 * sticky automotive · fusion confidence · backend payload를 한 신호로 일관되게 분기한다.
 */
export function useBarometer(): BarometerSignal {
  const [subsurface, setSubsurface] = useState<boolean>(false);
  // #903 — hysteresis: 임계 부근 노이즈 진동 흡수. lastEmitted와 다른 verdict가 N회 연속
  // 들어와야 state flip. lastEmitted과 같은 verdict가 들어오면 카운터 리셋.
  const lastEmittedRef = useRef<boolean>(false);
  const pendingCountRef = useRef<number>(0);

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
        const now = Date.now();
        appendBarometerReading({ t: now, pressureHpa: m.pressure });
        const verdict = evaluateLatestSubsurface(now);
        const detected = verdict?.detected === true;
        if (detected === lastEmittedRef.current) {
          pendingCountRef.current = 0;
          return;
        }
        pendingCountRef.current += 1;
        if (pendingCountRef.current >= BAROMETER_SUBSURFACE_CONFIRM_SAMPLES) {
          lastEmittedRef.current = detected;
          pendingCountRef.current = 0;
          setSubsurface(detected);
        }
      });
    };

    void init();

    return () => {
      cancelled = true;
      if (subscription !== null) subscription.remove();
      resetBarometerState();
      // 주의: unmount 후 setSubsurface 호출은 React가 무시(unmounted state warning). state는
      // remount 시 useState 초기값으로 자연 리셋되므로 명시적 reset 불필요.
    };
  }, []);

  return { subsurface };
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
