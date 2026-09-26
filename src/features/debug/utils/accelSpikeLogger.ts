/**
 * SPIKE (throwaway, dev 미머지) — 가속도계 train-fingerprint 검증용 raw 데이터 로거.
 *
 * 목적: 실기기 실탑승 중 DeviceMotion raw 신호 + 보조 신호(fingerprint rms/pattern,
 * CMMotionActivity, 기압, GPS) + 사용자 ground-truth(MARK 도착/출발)를 20Hz로 기록해
 * JSONL로 export → 오프라인 분석. 프로덕션 로직에는 관여하지 않는다(순수 계측).
 *
 * 재사용:
 *   - `getLatestAccelerometerSnapshot()` — 기존 native fingerprint 모듈 캐시(RC-12). 본 로거는
 *     start/stop을 직접 호출하지 않는다 — 이미 앱 다른 곳(useAccelerometerFingerprint)이
 *     lifecycle을 관리 중이면 충돌 없이 스냅샷만 읽고, 미실행 상태면 null(graceful)로 기록된다.
 *   - `getBarometerReadings()` — DebugModal이 이미 `useBarometer()`를 마운트해 채우는
 *     module-level ring buffer. 별도 기압계 구독 없이 최신 hPa만 읽는다.
 *   - `modules/motion-activity` — 이 스파이크가 유일한 소비자. confidence는 native 모듈이
 *     노출하지 않아(boolean stationary만) `cmc`는 항상 null로 기록한다(문서화된 한계).
 *
 * 로그 스키마 (JSONL, 분석 에이전트와 공유 — 임의 변경 금지):
 *   메타: {"meta":{"ride","placement","line","startedAt"}}
 *   샘플: {"t","ua":[x,y,z],"rr":[x,y,z],"g":[x,y,z],"rms","pat","cm","cmc","hpa","gps":{"lat","lng","accuracy"}|null}
 *   마크: {"t","mark":"arrive"|"depart"}
 */

import { DeviceMotion, type DeviceMotionMeasurement } from 'expo-sensors';
import * as Location from 'expo-location';
import { File, Paths } from 'expo-file-system';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { getLatestAccelerometerSnapshot } from '../../nearest-station/utils/accelerometerFingerprint';
import { getBarometerReadings } from '../../../shared/utils/barometerState';

/** DeviceMotion 20Hz 목표 샘플링 간격 (ms). */
const SAMPLE_INTERVAL_MS = 50;

/** ring buffer 상한 — cap 초과 시 배치로 앞부분을 잘라낸다(매 push O(n) shift 방지). */
const RING_CAP = 200_000;
const TRIM_BATCH = 5_000;

export type SpikePlacement = 'pocket' | 'hand' | 'bag';
export type SpikeMarkKind = 'arrive' | 'depart';

export interface SpikeMeta {
  ride: string;
  placement: SpikePlacement;
  line: string;
}

export interface SpikeSample {
  t: number;
  ua: [number, number, number];
  rr: [number, number, number];
  g: [number, number, number];
  rms: number | null;
  pat: 'stationary' | 'walking' | 'automotive' | 'unknown' | null;
  cm: string | null;
  cmc: number | null;
  hpa: number | null;
  gps: SpikeGpsFix | null;
}

/** GPS fix — horizontal accuracy(m) 포함, 지하 구간 coarse fix 판별용(#2311). */
export interface SpikeGpsFix {
  lat: number;
  lng: number;
  accuracy: number;
}

export interface SpikeMark {
  t: number;
  mark: SpikeMarkKind;
}

type SpikeEvent = SpikeSample | SpikeMark;

interface MotionActivityNative {
  isAvailable(): boolean;
  requestPermission(): Promise<boolean>;
  startUpdates(): void;
  stopUpdates(): void;
  getCurrentStationary(): boolean;
}

function getMotionActivityModule(): MotionActivityNative | null {
  return requireOptionalNativeModule<MotionActivityNative>('MotionActivity') ?? null;
}

let buffer: SpikeEvent[] = [];
let meta: (SpikeMeta & { startedAt: number }) | null = null;
let active = false;
let deviceMotionSub: { remove(): void } | null = null;
let locationSub: { remove(): void } | null = null;
let latestFix: SpikeGpsFix | null = null;
let motionActivityStarted = false;

function pushEvent(event: SpikeEvent): void {
  buffer.push(event);
  if (buffer.length > RING_CAP + TRIM_BATCH) {
    buffer = buffer.slice(buffer.length - RING_CAP);
  }
}

function buildSample(measurement: DeviceMotionMeasurement): SpikeSample {
  const accel = measurement.acceleration;
  const withGravity = measurement.accelerationIncludingGravity;
  // acceleration(중력 제거)이 없는 기기(구형/일부 Android)는 accelerationIncludingGravity로
  // 대체 — 완벽하지 않지만 "샘플 자체가 없는 것"보다 낫다(graceful, 스파이크 한정 근사).
  const ua: [number, number, number] = accel
    ? [accel.x, accel.y, accel.z]
    : [withGravity.x, withGravity.y, withGravity.z];
  const g: [number, number, number] = accel
    ? [withGravity.x - accel.x, withGravity.y - accel.y, withGravity.z - accel.z]
    : [0, 0, 0];
  const rotationRate = measurement.rotationRate;
  const rr: [number, number, number] = rotationRate
    ? [rotationRate.alpha, rotationRate.beta, rotationRate.gamma]
    : [0, 0, 0];

  const snapshot = getLatestAccelerometerSnapshot();
  const readings = getBarometerReadings();
  const lastReading = readings.length > 0 ? readings[readings.length - 1] : null;

  const motionModule = getMotionActivityModule();
  let cm: string | null = null;
  if (motionModule) {
    try {
      cm = motionModule.getCurrentStationary() ? 'stationary' : 'not-stationary';
    } catch {
      cm = null;
    }
  }

  return {
    t: Date.now(),
    ua,
    rr,
    g,
    rms: snapshot?.rmsMagnitude ?? null,
    pat: snapshot?.patternClass ?? null,
    cm,
    // native MotionActivity 모듈은 confidence(0..3)를 노출하지 않는다 — 문서화된 한계.
    cmc: null,
    hpa: lastReading?.pressureHpa ?? null,
    gps: latestFix,
  };
}

/** 로깅 시작 — DeviceMotion 20Hz 구독 + motion-activity + GPS watch. 이미 active면 no-op. */
export function startSpikeLogging(input: SpikeMeta): void {
  if (active) return;
  active = true;
  buffer = [];
  latestFix = null;
  meta = { ...input, startedAt: Date.now() };

  DeviceMotion.setUpdateInterval(SAMPLE_INTERVAL_MS);
  deviceMotionSub = DeviceMotion.addListener((measurement) => {
    pushEvent(buildSample(measurement));
  });

  const motionModule = getMotionActivityModule();
  if (motionModule) {
    try {
      if (motionModule.isAvailable()) {
        void motionModule.requestPermission().then((granted) => {
          if (granted && active) {
            motionModule.startUpdates();
            motionActivityStarted = true;
          }
        });
      }
    } catch {
      // graceful — motion-activity 미지원/예외는 cm=null로 자연 fallback.
    }
  }

  void (async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted' || !active) return;
      locationSub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0 },
        (loc) => {
          latestFix = {
            lat: loc.coords.latitude,
            lng: loc.coords.longitude,
            accuracy: loc.coords.accuracy ?? -1,
          };
        },
      );
    } catch {
      // graceful — GPS 권한 거절/실패는 gps=null로 계속 기록.
    }
  })();
}

/** MARK 이벤트 기록. 로깅 비활성 시 no-op. */
export function markSpikeEvent(mark: SpikeMarkKind): void {
  if (!active) return;
  pushEvent({ t: Date.now(), mark });
}

export function isSpikeLoggingActive(): boolean {
  return active;
}

export function getSpikeLoggingCounts(): { samples: number; marks: number } {
  let samples = 0;
  let marks = 0;
  for (const e of buffer) {
    if ('mark' in e) marks += 1;
    else samples += 1;
  }
  return { samples, marks };
}

function stopSubscriptions(): void {
  deviceMotionSub?.remove();
  deviceMotionSub = null;
  locationSub?.remove();
  locationSub = null;
  if (motionActivityStarted) {
    const motionModule = getMotionActivityModule();
    try {
      motionModule?.stopUpdates();
    } catch {
      // graceful — 중지 실패는 lifecycle 관점에서 무해.
    }
    motionActivityStarted = false;
  }
}

/**
 * 로깅 종료 + buffer를 JSONL로 직렬화해 문서 디렉토리에 파일 저장.
 * 반환된 uri는 호출자가 Share/Alert로 노출한다. 저장 후 buffer/meta는 reset.
 */
export async function stopSpikeLoggingAndExport(): Promise<string> {
  stopSubscriptions();
  active = false;
  const currentMeta = meta;
  const currentBuffer = buffer;
  buffer = [];
  meta = null;

  const lines: string[] = [];
  if (currentMeta) {
    lines.push(
      JSON.stringify({
        meta: {
          ride: currentMeta.ride,
          placement: currentMeta.placement,
          line: currentMeta.line,
          startedAt: currentMeta.startedAt,
        },
      }),
    );
  }
  for (const event of currentBuffer) {
    lines.push(JSON.stringify(event));
  }
  const content = lines.join('\n');

  const filename = `accel-spike-${Date.now()}.jsonl`;
  const file = new File(Paths.document, filename);
  if (!file.exists) file.create();
  file.write(content);
  return file.uri;
}
