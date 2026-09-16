/**
 * #1542 (ADR-016 S9) — CMMotionManager accelerometer fingerprint JS wrapper.
 *
 * 목적: native module(`modules/accelerometer-fingerprint/`)이 캐시한 60s window snapshot을 JS layer에
 * 노출. underground SSOT 합의 게이트(`undergroundSSotConsensus`)에 진동 fingerprint vote 1표 추가
 * + lockless 5단 fallback 4단계 (project_lockless_first_station_miss_zero).
 *
 * V1 BG 지하 천장 70 → 90% (Transit App 90% / SubwayPS 학술 85% baseline).
 *
 * 모든 API는 graceful — native module 부재(jest/web/Android/미지원 디바이스), 예외 모두
 * `null` / no-op로 처리한다. "모르는 상태"는 vote 미투표 (환경 판정 영향 0).
 *
 * 분류 정책 (Apple CMMotionManager raw accelerometer 기준):
 *   - `stationary` : RMS < 0.3 m/s² (정적 사용자)
 *   - `walking`    : 0.3 ≤ RMS < 2.0 m/s² (도보 cadence)
 *   - `automotive` : RMS ≥ 2.0 m/s² (train 가속/감속, env vote 1표 추가)
 *   - `unknown`    : window 미수렴 (60s × 1Hz=60 기대, 10개 미달, #2509 interim 발열 완화) — vote 미투표
 *
 * 호환:
 *   - 기존 `useAccelerometer` (#823, expo-sensors 기반)와 별 lifecycle. expo-sensors는 FG-only.
 *   - 본 모듈은 BG location piggyback으로 BG에서도 raw 가속도 수신 보장.
 */

import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * native가 반환하는 snapshot 구조 — Swift `computeLatestSnapshot()` dictionary와 1:1.
 *
 * `patternClass` 분류 임계는 native Swift 측 상수와 동일 — 둘 중 한 곳만 바꾸면 분류 일관성 깨짐.
 * JS는 raw rmsMagnitude까지 노출해 후속 PR에서 학습 데이터 기반 재분류 가능.
 */
export interface AccelerometerSnapshot {
  /** snapshot 생성 epoch ms. */
  timestamp: number;
  /** 중력 제거 후 linear acceleration RMS magnitude (m/s²). */
  rmsMagnitude: number;
  /** 분류 결과. 'unknown'은 vote 미투표. */
  patternClass: AccelerometerPattern;
  /** window 내 sample 수. MIN(=10, #2509) 미달 시 unknown 강제. */
  sampleCount: number;
}

/** 패턴 분류 결과. underground SSOT env vote는 'automotive'만 투표. */
export type AccelerometerPattern = 'stationary' | 'walking' | 'automotive' | 'unknown';

interface AccelerometerFingerprintNative {
  isAvailable(): boolean;
  start(): void;
  stop(): void;
  /** native가 캐시한 최신 60s window snapshot. 미수렴 시 sampleCount<10 + patternClass='unknown'. */
  getLatestSnapshot(): AccelerometerSnapshot | null;
}

function getNativeModule(): AccelerometerFingerprintNative | null {
  return requireOptionalNativeModule<AccelerometerFingerprintNative>(
    'AccelerometerFingerprint',
  ) ?? null;
}

export function isAccelerometerFingerprintSupported(): boolean {
  const module = getNativeModule();
  if (!module) return false;
  try {
    return module.isAvailable();
  } catch {
    return false;
  }
}

export function startAccelerometerFingerprint(): void {
  const module = getNativeModule();
  if (!module) return;
  try {
    module.start();
  } catch {
    // graceful — 시작 실패는 후속 getLatestSnapshot null로 자연 fallback.
  }
}

export function stopAccelerometerFingerprint(): void {
  const module = getNativeModule();
  if (!module) return;
  try {
    module.stop();
  } catch {
    // graceful — 중지 실패는 lifecycle 관점에서 무해.
  }
}

/**
 * native가 캐시한 최신 snapshot 조회. 미지원/예외/미수렴 시 null.
 *
 * 호출자는 snapshot.patternClass로 분류 결과를 사용하며, raw rmsMagnitude는 후속 학습 데이터 수집
 * (별 PR)에서 station-specific vibrationSignature 매칭에 사용한다.
 */
export function getLatestAccelerometerSnapshot(): AccelerometerSnapshot | null {
  const module = getNativeModule();
  if (!module) return null;
  try {
    const snapshot = module.getLatestSnapshot();
    return isValidSnapshot(snapshot) ? snapshot : null;
  } catch {
    return null;
  }
}

/**
 * snapshot.patternClass 분류 결과만 추출 — undergroundSSotConsensus 입력 변환.
 *
 * - null (미지원/예외/미수렴) → 'unknown' (vote 미투표)
 * - 정상 snapshot → patternClass 그대로 반환
 *
 * 데이터 주도 (CLAUDE.md 글로벌 룰 3번): 호출자는 항상 `'unknown' | 'stationary' | 'walking' | 'automotive'`
 * 4 case를 처리하며 분기 추가 없이 분류 변경 가능.
 */
export function classifyAccelerometerPattern(
  snapshot: AccelerometerSnapshot | null,
): AccelerometerPattern {
  if (!snapshot) return 'unknown';
  return snapshot.patternClass;
}

/**
 * native가 반환한 dictionary가 expected shape인지 런타임 검증.
 *
 * native가 정상 동작하면 항상 valid shape이지만, 미래 native 버전 mismatch (binary 호환성 깨짐) 시
 * undefined 필드로 인한 silent failure 방지 — invalid이면 null로 fallback.
 */
function isValidSnapshot(value: unknown): value is AccelerometerSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AccelerometerSnapshot>;
  if (typeof candidate.timestamp !== 'number') return false;
  if (typeof candidate.rmsMagnitude !== 'number') return false;
  if (typeof candidate.sampleCount !== 'number') return false;
  return isValidPatternClass(candidate.patternClass);
}

/** 분류 결과 string이 expected union case인지 확인. data-driven set 비교. */
const VALID_PATTERN_CLASSES: ReadonlySet<string> = new Set<string>([
  'stationary',
  'walking',
  'automotive',
  'unknown',
]);

function isValidPatternClass(value: unknown): value is AccelerometerPattern {
  return typeof value === 'string' && VALID_PATTERN_CLASSES.has(value);
}
