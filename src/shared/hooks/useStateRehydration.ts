/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: 본 hook은 trip 상태가 살고 있는 모든 zustand store를
 * 한 곳에서 재수화·동기화하는 orchestrator. 여러 feature(route/alarm)의 store를 직접
 * 참조하는 것이 본질이므로 file-level disable로 옵트인 처리.
 *
 * ADR Roadmap "Feature-based + Ports & Adapters 디렉토리 재정비" Phase 5 (#890).
 */
import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useDestinationStore } from '../../features/route/store/useDestinationStore';
import { useBoardingLockStore } from '../../features/alarm/store/useBoardingLockStore';
import {
  clearTripEndedSentinel,
  getTripEndedSentinel,
} from '../../features/alarm/utils/tripEndedSentinel';
import { runTripBoundCleanups } from '../../features/alarm/store/tripBoundCleanups';
import { createLogger } from '../utils/logger';
import { addDomainBreadcrumb } from '../infra/monitoring/breadcrumb';

const logger = createLogger('useStateRehydration');

/**
 * FG 복귀 시 상태 hydration seam (#899 Seam C).
 *
 * 책임:
 *  1) 마운트 + AppState 'active' 진입마다 trip-bound store(destination/customOrigin/
 *     tripOrigin/lock)를 storage에서 재수화 — BG 동안 다른 채널(silent push 등)이 storage를
 *     갱신했을 수 있으므로 zustand snapshot을 항상 최신화.
 *  2) trip-ended sentinel(`TRIP_ENDED_BY_BACKEND_AT_KEY`)이 있으면 destination/lock store를
 *     명시적으로 reset — BG에서 storage cleanup만 수행한 trip-ended가 in-memory zustand에
 *     stale state로 잠시 노출되는 회귀(#899)를 차단. 처리 후 sentinel 즉시 삭제.
 *
 * 호출 시점: app/_layout.tsx에서 1회 마운트. 마운트 자체가 첫 hydrate를 트리거.
 *
 * runAt 인자: 테스트에서 시각 주입용. 기본 Date.now.
 *
 * 멱등성: 동일 active 진입에서 여러 번 호출되어도 storage 키 부재 시 graceful no-op.
 */
export function useStateRehydration(): void {
  useEffect(() => {
    void runRehydration('mount');
    const handler = (state: AppStateStatus): void => {
      // BG/FG transition은 background↔active 양쪽 모두 의미 있음 — 디버그 시
      // crash가 active 진입 직후인지 BG로 내려간 직후인지 식별에 사용.
      if (state === 'active' || state === 'background') {
        addDomainBreadcrumb('lifecycle', state);
      }
      if (state === 'active') void runRehydration('active');
    };
    const sub = AppState.addEventListener('change', handler);
    return () => sub.remove();
  }, []);
}

/** 한 번의 재수화 사이클. mount/active 모두 동일 로직. */
async function runRehydration(trigger: 'mount' | 'active'): Promise<void> {
  // sentinel 우선 — store reset이 hydrate된 stale state를 덮지 않도록 순서 보장.
  const sentinel = await getTripEndedSentinel();
  if (sentinel !== null) {
    logger.info(`trigger=${trigger} trip-ended sentinel=${sentinel} → store reset`);
    // #1351 R2 — 과거에는 setDestination(null)을 trigger로 사용했지만, prev=null인 경우
    // isSwitch=false로 평가되어 cleanup chain이 실행되지 않는 버그가 있었다.
    // isSwitch 의존 없이 storage cleanup을 직접 호출. 멱등이므로 Fix 1 / silent push handler와
    // 중복 호출 안전. 메모리 store도 setState로 즉시 reset해 stale state가 노출되지 않게 한다.
    await runTripBoundCleanups();
    useDestinationStore.setState({
      destination: null,
      customOrigin: null,
      tripOrigin: null,
    });
    addDomainBreadcrumb('trip', 'end', { reason: 'sentinel-rehydration' });
    await useBoardingLockStore.getState().releaseLock();
    await clearTripEndedSentinel();
  }

  // 항상 storage → memory hydrate (sentinel 분기에서 reset된 store는 빈 storage 그대로 유지).
  const destStore = useDestinationStore.getState();
  await Promise.allSettled([
    destStore.loadDestination(),
    destStore.loadCustomOrigin(),
    destStore.loadTripOrigin(),
    useBoardingLockStore.getState().loadLock(),
  ]);
}
