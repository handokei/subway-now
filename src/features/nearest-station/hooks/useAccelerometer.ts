/**
 * #823 — 가속도 센서 수집 훅 (Phase 3 E1).
 *
 * 동작:
 *   1. mount 시 `Accelerometer.isAvailableAsync()` → 권한 prompt → setUpdateInterval(SAMPLE_INTERVAL_MS)
 *   2. 100Hz callback이 들어오면 in-memory 버퍼에 push
 *   3. WINDOW_FLUSH_MS(=1s) 인터벌마다 버퍼를 닫고 `summarizeWindow`로 압축
 *   4. 결과 `AccelSummary`를 `setLatestAccelSummary`로 ambient state에 노출 (BG task가 사용)
 *   5. unmount 시 subscription remove + ambient state null로 리셋
 *
 * 범위 (CLAUDE.md §2 simplicity):
 *   - **포그라운드 + WhileInUse 시나리오만** (백그라운드 수집 X — iOS limitation 회피).
 *   - 송신은 backgroundLocationTask가 position upload 시점에 latest snapshot 첨부 (E1 범위 외 송신 채널 X).
 *   - Kalman/phase 감지는 E2/E3 몫이라 여기서 처리하지 않음.
 *
 * 미지원/권한 거절:
 *   - `isAvailableAsync` false → no-op (대부분 시뮬레이터/web)
 *   - 권한 거절 → no-op + ambient state 그대로 null
 *   - graceful fallback (CLAUDE.md user memory feedback_whileinuse_must_work.md): WhileInUse만으로
 *     모든 핵심 기능이 동작해야 하므로 가속도 부재가 알람 흐름을 차단해선 안 된다.
 */

import { useEffect } from 'react';
import { Accelerometer, type AccelerometerMeasurement } from 'expo-sensors';
import { summarizeWindow } from '../utils/accelMotion';
import { setLatestAccelSummary } from '../utils/accelMotionState';

/** raw sample interval — 100Hz. 1초 window에서 100 sample → summary count 충족. */
export const SAMPLE_INTERVAL_MS = 10;
/** 윈도우 flush 주기 — 1Hz. backend는 1s 단위 요약으로 누적. */
export const WINDOW_FLUSH_MS = 1_000;

interface RawSample {
  t: number;
  x: number;
  y: number;
  z: number;
}

/**
 * 가속도 수집을 활성화한다. 반환값 없음 — 외부에서는 `getLatestAccelSummary()`로 조회.
 */
export function useAccelerometer(): void {
  useEffect(() => {
    let cancelled = false;
    let subscription: { remove(): void } | null = null;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let buffer: RawSample[] = [];

    const init = async (): Promise<void> => {
      const available = await safeIsAvailable();
      if (cancelled || !available) return;
      const granted = await safeRequestPermission();
      if (cancelled || !granted) return;

      Accelerometer.setUpdateInterval(SAMPLE_INTERVAL_MS);
      subscription = Accelerometer.addListener((m: AccelerometerMeasurement) => {
        // m.timestamp는 iOS CMAccelerometerData.timestamp — seconds since boot (monotonic, not epoch).
        // backend는 epoch ms 윈도우(`Date.now() - endTs`)로 평가하므로 wall-clock으로 직접 stamp한다.
        // 100Hz 호출 빈도 대비 sub-ms drift는 무시 가능.
        buffer.push({ t: Date.now(), x: m.x, y: m.y, z: m.z });
      });

      intervalId = setInterval(() => {
        const window = buffer;
        buffer = [];
        if (window.length === 0) return;
        const summary = summarizeWindow(window);
        if (summary !== null) setLatestAccelSummary(summary);
      }, WINDOW_FLUSH_MS);
    };

    void init();

    return () => {
      cancelled = true;
      if (intervalId !== null) clearInterval(intervalId);
      if (subscription !== null) subscription.remove();
      setLatestAccelSummary(null);
    };
  }, []);
}

/** isAvailableAsync 예외를 false로 폴백 — 일부 시뮬레이터에서 throw. */
async function safeIsAvailable(): Promise<boolean> {
  try {
    return await Accelerometer.isAvailableAsync();
  } catch {
    return false;
  }
}

/** requestPermissionsAsync 예외를 거절로 폴백 — graceful WhileInUse 보장. */
async function safeRequestPermission(): Promise<boolean> {
  try {
    const { granted } = await Accelerometer.requestPermissionsAsync();
    return granted;
  } catch {
    return false;
  }
}
