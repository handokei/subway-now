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
  evaluateLatestStop,
  evaluateLatestSubsurface,
  getBarometerReadings,
  resetBarometerState,
} from '../utils/barometerState';
import { setSubsurfaceState } from '../utils/subsurfaceState';
import {
  BAROMETER_SAMPLE_INTERVAL_MS,
  BAROMETER_STOP_CONFIRM_SAMPLES,
  BAROMETER_SUBSURFACE_CONFIRM_SAMPLES,
} from '../constants/barometer';

/**
 * #1398 — 기압계 unavailable 원인 분해.
 *
 * `stop=undefined`(평가 불가) 원인을 device dump에 노출하기 위한 진단 필드.
 * 원인을 모르면 SPOF 회피 방향(WiFi 분리 / fusion verdict 결합) 튜닝이 불가능하다.
 *
 * - 'sensor'      : `Barometer.isAvailableAsync()` false (iPhone 6 이하 등 기기 미지원)
 * - 'permission'  : NSMotionUsageDescription 권한 거절
 * - 'readings'    : 센서 활성이지만 30s 윈도우를 채울 reading 부족 (warm-up 초기)
 * - undefined     : 정상 (stop이 true|false로 결정됨)
 */
export type BarometerUnavailableReason = 'sensor' | 'permission' | 'readings';

/**
 * #903 — 외부 소비자에 노출되는 보조 신호 스냅샷.
 *
 * `subsurface`만 노출 — UI/sticky/alarm은 boolean 한 값으로 충분. 디버그용 raw delta는
 * `getBarometerReadings()` / `evaluateLatestSubsurface()`로 직접 조회.
 */
export interface BarometerSignal {
  /** 30s 윈도우 dP가 임계 이상 상승했는가 (지하 진입 후보). */
  subsurface: boolean;
  /**
   * #921 — 30s 윈도우 |dP|가 정차 임계 이하인가 (역 도착 후보).
   *
   * 평가 불가(reading 부족) → undefined. fuseStationDetectionSignals 입력으로
   * 그대로 전달되면 unavailable로 분류된다 — 다른 신호로 합의 가능.
   */
  stop: boolean | undefined;
  /**
   * #1398 — `stop=undefined`일 때의 원인. SPOF 분리 효과 측정용.
   *
   * stop이 boolean으로 결정되면 undefined. unavailable일 때만 셋. DebugModal이 GPS section
   * `subsurface=` 라인에 함께 노출해 사용자/측정자가 dump 한 줄로 원인 분해를 본다.
   *
   * optional: 기존 호출자/테스트 픽스처 호환. useBarometer가 반환하는 production 객체는
   * 항상 키를 채우지만, fusion 입력 mock에서는 stop만 주입해도 동작한다 (스키마 호환).
   */
  unavailableReason?: BarometerUnavailableReason | undefined;
  /**
   * #1398 — 현재 ring buffer에 누적된 reading 수. dump 진단용.
   *
   * 0이면 sensor/permission 게이트에서 차단됐거나 listener가 시작되지 않은 상태.
   * 0 < n < ~30이면 warm-up 초기. ≥30이면 30s 윈도우를 채울 만큼은 누적된 상태.
   * optional: 위와 동일한 호환성 이유.
   */
  readingCount?: number;
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
  // #921 — readings 부족 또는 unmount 직후는 undefined. fusion 입력 unavailable로 흘러간다.
  const [stop, setStop] = useState<boolean | undefined>(undefined);
  // #1398 — stop=undefined일 때의 원인. 초기값 'sensor'(아직 게이트 미통과). 게이트 단계별로
  // 'sensor' → 'permission' → 'readings' → undefined(정상)로 좁혀진다.
  const [unavailableReason, setUnavailableReason] = useState<
    BarometerUnavailableReason | undefined
  >('sensor');
  // #1398 — ring buffer 누적 reading 수. listener tick마다 갱신.
  const [readingCount, setReadingCount] = useState<number>(0);
  // #903 — hysteresis: 임계 부근 노이즈 진동 흡수. lastEmitted와 다른 verdict가 N회 연속
  // 들어와야 state flip. lastEmitted과 같은 verdict가 들어오면 카운터 리셋.
  const lastSubsurfaceRef = useRef<boolean>(false);
  const subsurfacePendingRef = useRef<number>(0);
  // #921 — stop 신호도 hysteresis 적용(독립 상수 BAROMETER_STOP_CONFIRM_SAMPLES, #966).
  // undefined(평가 불가)는 즉시 반영 — 신호 부재는 hysteresis로 흐리면 안 되고 즉시
  // unavailable로 표기되어야 fusion이 정확하다.
  const lastStopRef = useRef<boolean | undefined>(undefined);
  const stopPendingRef = useRef<number>(0);

  useEffect(() => {
    let cancelled = false;
    let subscription: { remove(): void } | null = null;

    const init = async (): Promise<void> => {
      const available = await safeIsAvailable();
      if (cancelled) return;
      if (!available) {
        // #1398 — sensor 게이트 차단 (isAvailable=false 또는 throw). dump에 'sensor' 노출.
        setUnavailableReason('sensor');
        return;
      }
      const granted = await safeRequestPermission();
      if (cancelled) return;
      if (!granted) {
        // #1398 — permission 게이트 차단. dump에 'permission' 노출.
        setUnavailableReason('permission');
        return;
      }
      // 게이트 통과 — readings 부족 단계로 진입. 첫 tick까지 'readings'.
      setUnavailableReason('readings');

      Barometer.setUpdateInterval(BAROMETER_SAMPLE_INTERVAL_MS);
      subscription = Barometer.addListener((m: BarometerMeasurement) => {
        // m.timestamp는 boot 이후 초 — wall-clock과 직접 비교 불가.
        // ring buffer는 epoch ms 윈도우로 평가하므로 Date.now()로 직접 stamp.
        const now = Date.now();
        appendBarometerReading({ t: now, pressureHpa: m.pressure });
        // #1398 — reading 수 dump 노출. ring buffer는 60s TTL이라 안정 시 약 60.
        setReadingCount(getBarometerReadings().length);

        const subVerdict = evaluateLatestSubsurface(now);
        const subDetected = subVerdict?.detected === true;
        if (subDetected === lastSubsurfaceRef.current) {
          subsurfacePendingRef.current = 0;
        } else {
          subsurfacePendingRef.current += 1;
          if (subsurfacePendingRef.current >= BAROMETER_SUBSURFACE_CONFIRM_SAMPLES) {
            lastSubsurfaceRef.current = subDetected;
            subsurfacePendingRef.current = 0;
            setSubsurface(subDetected);
            void setSubsurfaceState(subDetected);
          }
        }

        const stopVerdict = evaluateLatestStop(now);
        const stopDetected: boolean | undefined =
          stopVerdict === null ? undefined : stopVerdict.detected;
        if (stopDetected === lastStopRef.current) {
          stopPendingRef.current = 0;
          // unavailable 상태가 유지될 때 reason도 'readings'로 유지.
          if (stopDetected === undefined) setUnavailableReason('readings');
          return;
        }
        if (stopDetected === undefined) {
          // 평가 불가(reading 부족)는 hysteresis 없이 즉시 반영 — fusion 입력 정확성 우선.
          lastStopRef.current = undefined;
          stopPendingRef.current = 0;
          setStop(undefined);
          // #1398 — readings 게이트 단계. sensor/permission이 통과한 후의 unavailable.
          setUnavailableReason('readings');
          return;
        }
        stopPendingRef.current += 1;
        if (stopPendingRef.current >= BAROMETER_STOP_CONFIRM_SAMPLES) {
          lastStopRef.current = stopDetected;
          stopPendingRef.current = 0;
          setStop(stopDetected);
          // #1398 — stop이 boolean으로 결정됨 → unavailable 해제.
          setUnavailableReason(undefined);
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

  return { subsurface, stop, unavailableReason, readingCount };
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
