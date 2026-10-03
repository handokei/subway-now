/**
 * #1308 — iOS 저전력 모드(Low Power Mode) 관찰 훅 (텔레메트리 전용).
 *
 * mount 시 현재 상태를 1회 조회하고, 이후 변화를 구독한다. unmount 시 구독 해제.
 * 미지원/throw는 lowPowerState 모듈이 false로 흡수한다 (graceful).
 *
 * 본 훅은 동작을 바꾸지 않는다 — DebugModal 노출/측정용. LPM 기반 분기(예: prescheduled
 * 선호)는 아키텍처 결정 이후 별도 sub-issue.
 */

import { useEffect, useState } from 'react';
import {
  readLowPowerMode,
  subscribeLowPowerMode,
} from '../utils/lowPowerState';

/**
 * 현재 저전력 모드 활성 여부. 초기값 false(보수적), 조회/구독으로 갱신.
 */
export function useLowPowerMode(): boolean {
  const [enabled, setEnabled] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;

    void readLowPowerMode().then((value) => {
      if (!cancelled) setEnabled(value);
    });

    const unsubscribe = subscribeLowPowerMode((value) => {
      if (!cancelled) setEnabled(value);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return enabled;
}
