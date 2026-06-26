import { useEffect, useRef } from 'react';
import { addDomainBreadcrumb } from '../infra/monitoring/breadcrumb';
import { createLogger } from '../utils/logger';

const log = createLogger('useDeferredNavigate');

/**
 * #1910 — cold-start navigate gate.
 *
 * `addNotificationResponseReceivedListener`는 cold-start 시 동기적으로 fire된다.
 * hydrated=false 시점에 router.navigate를 호출하면 "Attempted to navigate before mounting
 * the Root Layout" 예외가 발생하고 try/catch swallow → navigation lost.
 *
 * 이 hook은 navigate 요청을 hydrated=false 시점에 ref에 queue하고 hydrated=true 후 flush한다.
 * boolean ref로 충분 — 같은 trip 내 2회 요청도 1회만 navigate (dedup 자동).
 *
 * 사용 패턴:
 *   const requestNavigate = useDeferredNavigate(hydrated, () => router.navigate('/'));
 *   // onBannerTap에 requestNavigate 주입
 *
 * @param hydrated - Stack mount 완료 여부. false일 때 요청을 queue, true로 전환 시 flush.
 * @param navigate - 실제 navigation 실행 함수 (caller 주입 — 테스트 격리를 위해 DI).
 * @returns requestNavigate — onBannerTap 등 trigger callback에 할당.
 */
export function useDeferredNavigate(hydrated: boolean, navigate: () => void): () => void {
  const pendingRef = useRef(false);
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // hydrated=true 전환 시 pending flush.
  useEffect(() => {
    if (!hydrated) return;
    if (!pendingRef.current) return;
    pendingRef.current = false;
    addDomainBreadcrumb('lifecycle', 'cold_start_navigate_deferred_flushed');
    try {
      navigateRef.current();
    } catch (e) {
      log.warn('cold-start deferred navigate 실패(#1910):', e);
    }
  }, [hydrated]);

  return () => {
    if (!hydrated) {
      addDomainBreadcrumb('lifecycle', 'cold_start_navigate_deferred');
      pendingRef.current = true;
      return;
    }
    try {
      navigateRef.current();
    } catch (e) {
      log.warn('navigate 실패(#1910):', e);
    }
  };
}
