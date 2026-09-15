/**
 * #875 — 기압계(Barometer) 보조 신호 수집 훅 (Spike).
 *
 * 동작:
 *   1. mount 시 `Barometer.isAvailableAsync()` → 권한 prompt → `setUpdateInterval(BAROMETER_SAMPLE_INTERVAL_MS)`
 *      호출(단, #2619 — iOS `CMAltimeter`는 update interval을 지원하지 않아 이 호출은
 *      expo-sensors 네이티브 측에서 실질적으로 no-op이다. 실제 콜백 빈도는 OS가 결정하는
 *      uncontrolled rate — 실측 14~21Hz).
 *   2. native listener 콜백마다 `appendBarometerReading`으로 ring buffer에만 push(React state
 *      미호출 — #2619 이전에는 콜백마다 setState해 렌더가 콜백 빈도(14~21Hz) 그대로 폭주했다).
 *      (60s TTL 자동 prune은 ring buffer 모듈이 처리)
 *   3. 별도 1Hz interval(`evaluateAndFlush`)이 ring buffer를 읽어 hysteresis 평가 + setState를
 *      전담 — state 반영 주기를 1Hz로 고정한다(신호 산출 로직 자체는 무변경).
 *   4. unmount 시 subscription + interval 정리 + ring buffer reset
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
  recordBarometerCallback,
  recordBarometerListenerRegistered,
  recordBarometerListenerRegistrationFailed,
  resetBarometerState,
} from '../utils/barometerState';
import { setSubsurfaceState } from '../utils/subsurfaceState';
import {
  BAROMETER_MISMATCH_QUORUM_READINGS,
  BAROMETER_SAMPLE_INTERVAL_MS,
  BAROMETER_STOP_CONFIRM_SAMPLES,
  BAROMETER_SUBSURFACE_CONFIRM_SAMPLES,
} from '../constants/barometer';
import { isSimpleArchEnabled } from '../config/archFlag';

/**
 * #1398 — 기압계 unavailable 원인 분해.
 *
 * `stop=undefined`(평가 불가) 원인을 device dump에 노출하기 위한 진단 필드.
 * 원인을 모르면 SPOF 회피 방향(WiFi 분리 / fusion verdict 결합) 튜닝이 불가능하다.
 *
 * - 'sensor'          : `Barometer.isAvailableAsync()` false (iPhone 6 이하 등 기기 미지원)
 * - 'permission'      : NSMotionUsageDescription 권한 거절
 * - 'readings'        : 센서 활성이지만 30s 윈도우를 채울 reading 부족 (warm-up 초기)
 * - 'flag-on-dormant' : #2006 — arrival-api-ssot-v1 flag ON. 기압계 SPOF 배터리 절약.
 * - undefined         : 정상 (stop이 true|false로 결정됨)
 */
export type BarometerUnavailableReason =
  | 'sensor'
  | 'permission'
  | 'readings'
  | 'flag-on-dormant';

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
  unavailableReason?: BarometerUnavailableReason;
  /**
   * #1398 — 현재 ring buffer에 누적된 reading 수. 다운스트림(HomeScreen
   * `barometerWarmupReady`)의 quorum(`BAROMETER_MISMATCH_QUORUM_READINGS`, 30) 게이트 입력.
   *
   * 0이면 sensor/permission 게이트에서 차단됐거나 listener가 시작되지 않은 상태.
   * #2619 review (F3) — native listener는 uncontrolled rate(실측 14~21Hz, `setUpdateInterval`이
   * iOS에서 no-op)로 발화해 60s 안정 시 실제로는 약 840~1260까지 쌓인다(1Hz 가정의 "약 60"은
   * 오기). 렌더 최소화를 위해 이 값은 quorum 경계(30)를 넘나들 때만 갱신되므로, 경계 미달 구간
   * (`readingCount < 30`)에서는 최신 정확한 수치가 아니라 마지막 경계 이전 값(주로 초기값 0)을
   * 반환할 수 있다 — quorum boolean 판정 외 정밀한 실시간 카운트가 필요하면
   * `getBarometerReadings().length`를 직접 pull할 것(DebugModal 패턴).
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
  // #2006 (ADR-022 Phase 4-4) — arrival-api-ssot-v1 flag ON 시 dormant.
  // mount time 판정 — flag toggle 은 재빌드/remount 이 트리거. hook 반환값 자체를 flag ON
  // 시 dormant 상수 객체로 굳혀 useEffect / useState / useRef 오버헤드도 skip 한다.
  // subsurface=false, stop=undefined, readingCount=0, unavailableReason='flag-on-dormant'.
  const flagDormant = isSimpleArchEnabled();

  const [subsurface, setSubsurface] = useState<boolean>(false);
  // #921 — readings 부족 또는 unmount 직후는 undefined. fusion 입력 unavailable로 흘러간다.
  const [stop, setStop] = useState<boolean | undefined>(undefined);
  // #1398 — stop=undefined일 때의 원인. 초기값 'sensor'(아직 게이트 미통과). 게이트 단계별로
  // 'sensor' → 'permission' → 'readings' → undefined(정상)로 좁혀진다.
  // #2006 — flag ON 시 초기값은 'flag-on-dormant' — listener 미등록이라 이후 갱신 없음.
  const [unavailableReason, setUnavailableReason] = useState<
    BarometerUnavailableReason | undefined
  >(flagDormant ? 'flag-on-dormant' : 'sensor');
  // #1398 — ring buffer 누적 reading 수. #2619 review (F3) — quorum 경계 crossing 시에만 갱신.
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
  // #2619 review (F2) — 직전 flush에서 처리한 최신 reading의 epoch ms. 다음 flush에서 이
  // 값과 동일(또는 reading 없음)하면 "마지막 flush 이후 신규 reading 0" = native listener
  // stall로 간주해 평가 자체를 skip한다.
  const lastLatestReadingTsRef = useRef<number | null>(null);
  // #2619 review (F3) — readingCount의 quorum(BAROMETER_MISMATCH_QUORUM_READINGS) 경계
  // 충족 여부. 이 값이 바뀔 때만 setReadingCount를 호출해 매 tick 렌더를 방지한다.
  const readingCountQuorumMetRef = useRef<boolean>(false);

  useEffect(() => {
    // #2006 — flag ON 시 native listener 등록 skip. 배터리 · 권한 prompt · ring buffer 비용 0.
    // 초기 state 가 이미 dormant 조합이라 별도 setState 호출 불필요.
    if (flagDormant) {
      return;
    }
    let cancelled = false;
    let subscription: { remove(): void } | null = null;
    let flushIntervalId: ReturnType<typeof setInterval> | null = null;

    // #2619 (#2594 후속) — 1Hz 집계 evaluate. native `Barometer.setUpdateInterval`은 iOS
    // CMAltimeter에서 사실상 no-op("Nothing we can do", expo-sensors BarometerModule.swift)이라
    // 실측 콜백 빈도는 uncontrolled(데스크 dump: 초당 14~21회) — listener 콜백마다 setState하면
    // 그 빈도 그대로 렌더/fusion 재평가가 폭주한다(#2619). 신호 산출 로직(hysteresis/threshold)은
    // 그대로 두고, ring buffer read + verdict 평가 + setState 적용만 이 1Hz interval로 옮긴다.
    const evaluateAndFlush = (): void => {
      const now = Date.now();
      // #1398 — ring buffer read. native listener가 uncontrolled rate(실측 14~21Hz)로 발화하므로
      // 안정 시 60s window에는 약 60이 아니라 약 840~1260 정도가 쌓인다(readingCount doc 참조 —
      // 1Hz 가정 하 작성된 옛 "약 60" 주석은 RCA와 모순돼 정정).
      const readings = getBarometerReadings();
      const latestTs = readings.length > 0 ? readings[readings.length - 1].t : null;

      // #2619 review (F2) — 마지막 flush 이후 신규 reading이 없으면 평가 자체를 skip하고
      // 상태를 그대로 유지한다. native listener가 stall(예: 지하 한복판에서 BG throttle/센서
      // 일시 중단)되면 ring buffer는 그대로인데 `evaluateLatestSubsurface/Stop`은 `now`
      // 기준 최근 window에 유효한 reading이 없다고 판단해 null verdict를 반환 —
      // subDetected=false로 붕괴해 hysteresis가 confirm 3회(≈3s, 1Hz)만에 subsurface를
      // false로 떨어뜨리는 회귀가 있었다(#1950 게이트 오염 — 지하 주행 중인데 지상으로
      // 오판정). trade-off: 이 skip은 "listener stall"과 "진짜 신규 verdict 변화"를 구분하지
      // 않고 둘 다 hold하지만, listener가 살아있는 한 다음 tick에 새 reading이 들어와 바로
      // 재평가된다 — 신호 즉시성보다 stall 오염 차단을 우선한 결정.
      if (latestTs === null || latestTs === lastLatestReadingTsRef.current) {
        return;
      }
      lastLatestReadingTsRef.current = latestTs;

      // #2619 review (F3) — readingCount는 quorum 경계(BAROMETER_MISMATCH_QUORUM_READINGS)를
      // 넘나들 때만 setState. 유일한 다운스트림 소비자(HomeScreen → useStationMismatchDetector의
      // barometerWarmupReady)는 `readingCount >= 임계` boolean만 사용하므로, 그 경계가 안
      // 바뀌면 매 tick 값이 미세 변동해도 렌더가 불필요하다. DebugModal 표시는
      // `getBarometerReadings()` 직접 pull로 충당(이 state에 의존하지 않음).
      const quorumMet = readings.length >= BAROMETER_MISMATCH_QUORUM_READINGS;
      if (quorumMet !== readingCountQuorumMetRef.current) {
        readingCountQuorumMetRef.current = quorumMet;
        setReadingCount(readings.length);
      }

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
    };

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
      // #2626 — addListener() 자체가 던지는 실패(예: 네이티브 등록 거부)를 명시적으로 포착해
      // 계측한다. 9/15 실기기 세션(reason='readings'까지 게이트 통과했는데 콜백 0회)처럼
      // addListener는 성공(예외 없음)했지만 콜백이 안 오는 케이스와, addListener 자체가
      // 실패하는 케이스를 dump에서 구분하기 위함.
      try {
        subscription = Barometer.addListener((m: BarometerMeasurement) => {
          // m.timestamp는 boot 이후 초 — wall-clock과 직접 비교 불가.
          // ring buffer는 epoch ms 윈도우로 평가하므로 Date.now()로 직접 stamp.
          // #2619 — 여기서는 ring buffer append만 한다(React state 미호출). native 콜백이
          // uncontrolled rate로 발화해도 렌더에는 영향 없음 — evaluate/setState는 아래 1Hz
          // interval(evaluateAndFlush)이 전담.
          const now = Date.now();
          // #2626 — 콜백 도달 자체를 ring buffer append와 별개로 계측(prune 영향 없음).
          recordBarometerCallback(now);
          appendBarometerReading({ t: now, pressureHpa: m.pressure });
        });
        recordBarometerListenerRegistered();
      } catch {
        recordBarometerListenerRegistrationFailed();
        return;
      }

      // #2619 — state 반영 주기를 1Hz(BAROMETER_SAMPLE_INTERVAL_MS)로 고정.
      flushIntervalId = setInterval(evaluateAndFlush, BAROMETER_SAMPLE_INTERVAL_MS);
    };

    void init();

    return () => {
      cancelled = true;
      if (flushIntervalId !== null) clearInterval(flushIntervalId);
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
