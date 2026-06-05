/**
 * #728 — CMMotionActivity(iOS) wrapper.
 *
 * 목적: 가속도계 기반 motion=stationary 신호를 JS 레이어에 안전하게 노출.
 * movementGate(`evaluateMovement`, `shouldDowngradeFusion`)의 `motionStationary` 입력으로 사용.
 *
 * 모든 API는 graceful — native module 부재(jest/web/미지원 디바이스), 권한 거절, 예외 모두
 * `false` / no-op로 처리한다. "모르는 상태"는 알람 suppress 안 함 (false positive 차단 우선).
 *
 * Android: CMMotionActivity와 정확히 대응되는 무권한 API가 없어 native module은 stub(false 반환).
 *          향후 Activity Recognition API 통합 시 같은 인터페이스로 확장 가능.
 *
 * 인터페이스:
 *   - isMotionActivitySupported(): 디바이스 가속도계 + Motion 권한 지원 여부
 *   - requestMotionActivityPermission(): 사용자에게 권한 prompt (iOS NSMotionUsageDescription)
 *   - startMotionActivityUpdates(): activity 폴링 시작 — 앱 사용 중 한 번만 호출
 *   - stopMotionActivityUpdates(): 폴링 중지
 *   - getCurrentMotionStationary(): 마지막 보고된 stationary 상태 (boolean, default false)
 */

import { requireOptionalNativeModule } from 'expo-modules-core';

interface MotionActivityNative {
  isAvailable(): boolean;
  requestPermission(): Promise<boolean>;
  startUpdates(): void;
  stopUpdates(): void;
  getCurrentStationary(): boolean;
}

function getNativeModule(): MotionActivityNative | null {
  return requireOptionalNativeModule<MotionActivityNative>('MotionActivity') ?? null;
}

export function isMotionActivitySupported(): boolean {
  const module = getNativeModule();
  if (!module) return false;
  try {
    return module.isAvailable();
  } catch {
    return false;
  }
}

export async function requestMotionActivityPermission(): Promise<boolean> {
  const module = getNativeModule();
  if (!module) return false;
  try {
    return await module.requestPermission();
  } catch {
    return false;
  }
}

export function startMotionActivityUpdates(): void {
  const module = getNativeModule();
  if (!module) return;
  try {
    module.startUpdates();
  } catch {
    // graceful — 시작 실패는 후속 getCurrentMotionStationary가 false 반환으로 자연 fallback
  }
}

export function stopMotionActivityUpdates(): void {
  const module = getNativeModule();
  if (!module) return;
  try {
    module.stopUpdates();
  } catch {
    // graceful — 중지 실패는 lifecycle 관점에서 무해
  }
}

export function getCurrentMotionStationary(): boolean {
  const module = getNativeModule();
  if (!module) return false;
  try {
    return module.getCurrentStationary() === true;
  } catch {
    return false;
  }
}
