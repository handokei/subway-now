/**
 * #1308 — iOS 저전력 모드(Low Power Mode, LPM) 감지 thin wrapper (텔레메트리 전용).
 *
 * 배경: iOS LPM은 silent(content-available) push를 강하게 throttle/drop 한다. 현재 앱의
 * BG 매역 알림은 silent push에 의존하므로 LPM에서 알림이 누락될 수 있다. 본 모듈은
 * 감지 + 노출(진단)만 제공하며 동작을 바꾸지 않는다 — 실기기 evidence 측정용.
 *
 * graceful (CLAUDE.md §2, `feedback_whileinuse_must_work.md` 정책):
 *   - 미지원 플랫폼 / 네이티브 throw → false 폴백. LPM 감지 실패가 핵심 기능을 막지 않는다.
 *
 * Android: expo-battery는 power-save mode를 동일 API로 노출한다 — 별도 분기 불필요
 * (CLAUDE.md §3 데이터/플랫폼 주도, 하드코딩 분기 금지).
 */

import * as Battery from 'expo-battery';

/**
 * 현재 저전력 모드 상태를 1회 조회한다. 미지원/throw 시 false.
 */
export async function readLowPowerMode(): Promise<boolean> {
  try {
    return await Battery.isLowPowerModeEnabledAsync();
  } catch {
    return false;
  }
}

/**
 * 저전력 모드 변화 구독. listener는 boolean 한 값만 받는다.
 * 반환된 함수를 호출하면 구독 해제(graceful — remove throw도 무시).
 */
export function subscribeLowPowerMode(
  listener: (enabled: boolean) => void,
): () => void {
  let subscription: { remove(): void } | null = null;
  try {
    subscription = Battery.addLowPowerModeListener(({ lowPowerMode }) => {
      listener(lowPowerMode);
    });
  } catch {
    subscription = null;
  }

  return () => {
    try {
      subscription?.remove();
    } catch {
      // 구독 해제 실패는 무시 — 텔레메트리 cleanup이 앱을 막아선 안 된다.
    }
  };
}
