/**
 * Live Activity 사용자 dismiss → sentinel write 브리지 (#967, #926 follow-up).
 *
 * native(`modules/live-activity`)는 사용자가 LA를 swipe-to-dismiss 한 시점에
 * `onActivityDismissed` 이벤트를 emit한다(reason: 'user'). 이 hook은 해당 이벤트를
 * 구독해 `markLaDismissed(dismissedAt)`를 호출한다.
 *
 * 결과: silent push 핸들러(`refreshLiveActivityFromBackgroundContext`)가 sentinel을
 * 보고 LA refresh를 30분간 skip → 사용자 dismiss 의도 존중. destination 재설정 시
 * `TRIP_BOUND_CLEANUPS` 경로(`clearLaDismissSentinel`)가 즉시 reset 한다.
 *
 * 마운트 위치: HomeScreen — 앱 활성 전체 lifecycle 동안 구독 유지.
 */
import { useEffect } from 'react';
import { addActivityDismissedListener } from '../../../../modules/live-activity';
import { markLaDismissed } from '../utils/laDismissSentinel';
import { createLogger } from '../../../shared/utils/logger';

const log = createLogger('useLiveActivityDismissBridge');

export function useLiveActivityDismissBridge(): void {
  useEffect(() => {
    const subscription = addActivityDismissedListener((event) => {
      // reason은 현재 항상 'user'지만 향후 분기 추가 시 안전망을 둔다.
      if (event.reason !== 'user') return;
      void markLaDismissed(event.dismissedAt).catch((e) => {
        log.warn('markLaDismissed threw', e);
      });
    });
    return () => {
      subscription.remove();
    };
  }, []);
}
