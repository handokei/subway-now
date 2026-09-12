/**
 * #1543 (ADR-016 S10) — CTRadioAccessTechnology 신호 React hook.
 *
 * 동작:
 *   1. mount 시 `isCellularTechSupported` 확인 → true면 `startCellularTechUpdates`
 *   2. 폴링(5s)으로 native가 캐시한 최신 tech 코드를 sync → 환경 vote로 분류
 *   3. 미지원/예외 케이스는 `'unknown'`로 확정 — 호출자는 vote 미투표로 인식
 *   4. unmount 시 `stopCellularTechUpdates`로 cleanup
 *
 * 폴링 간격(5s): native는 `CTServiceRadioAccessTechnologyDidChange` 옵저버로 즉시 캐시 갱신
 *   하지만 JS는 폴링으로 sync. 환경 변화는 사용자 trip 분당 1~2회 수준이라 5s 충분.
 *   (useMotionActivity와 동일 주기 — 같은 알람 평가 사이클 30s보다 짧으면 stale 우려 적음.)
 *
 * 반환:
 *   - `'unknown'`             : 미지원 / 권한 거절 / native null — vote 미투표
 *   - `'surface'`             : NR (5G SA) — 지상 hard-reject
 *   - `'surface-weak'`        : LTE — 지하 DAS 중계 가능, soft downgrade (#1876)
 *   - `'surface-weak-nrnsa'`  : NRNSA (5G NSA) — LTE보다 약한 soft downgrade (#2099)
 *   - `'underground'`         : 2G/3G — 지하 vote
 */

import { useEffect, useState } from 'react';
import {
  classifyCellularEnvironment,
  getCurrentCellularTech,
  isCellularTechSupported,
  startCellularTechUpdates,
  stopCellularTechUpdates,
  type CellularEnvironmentVote,
} from '../utils/cellularTech';

/** 폴링 주기 — `useMotionActivity`와 동일 (5s). 환경 변화는 분당 1~2회라 충분. */
const POLL_INTERVAL_MS = 5_000;

export function useCellularTech(): CellularEnvironmentVote {
  const [vote, setVote] = useState<CellularEnvironmentVote>('unknown');

  useEffect(() => {
    if (!isCellularTechSupported()) {
      // 미지원(Android/jest/web) — vote 미투표로 확정.
      setVote('unknown');
      return;
    }
    startCellularTechUpdates();

    // 초기 1회 + 인터벌 폴링. native가 cache한 최신 tech를 sync.
    setVote(classifyCellularEnvironment(getCurrentCellularTech()));
    const intervalId = setInterval(() => {
      setVote(classifyCellularEnvironment(getCurrentCellularTech()));
    }, POLL_INTERVAL_MS);

    return () => {
      clearInterval(intervalId);
      stopCellularTechUpdates();
    };
  }, []);

  return vote;
}
