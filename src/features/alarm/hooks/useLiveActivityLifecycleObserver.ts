/**
 * LA 라이프사이클 관측 브리지 (#3107, 관측 전용 — 동작 변경 없음).
 *
 * native `onActivityEndObserved`(모든 .ended/.dismissed 관측)와 `onActivityAdopted`(채택 시점의
 * pushToken 유무)를 alarmLog `live-activity-lifecycle`로 적재해 다음 share dump에서
 * "sentinel을 누가 썼는가 / 토큰이 왜 없는가"를 판별하게 한다.
 *
 * 한계: JS 리스너가 붙기 전에 native가 emit한 이벤트(콜드 BG 재기동 직후 adopt 등)는 유실된다.
 * 마운트 위치: HomeScreen (useLiveActivityDismissBridge와 동일).
 */
import { useEffect } from 'react';
import {
  addActivityAdoptedListener,
  addActivityEndObservedListener,
} from '../../../../modules/live-activity';
import { logLiveActivityLifecycle } from '../utils/alarmLog';

export function useLiveActivityLifecycleObserver(): void {
  useEffect(() => {
    const endSubscription = addActivityEndObservedListener(
      ({ state, expectingSystemEnd, activityId, observedAt }) => {
        logLiveActivityLifecycle(
          'la-end-observed',
          `state=${state};expected=${expectingSystemEnd};id=${activityId};at=${observedAt}`,
        );
      },
    );
    const adoptSubscription = addActivityAdoptedListener(
      ({ activityId, state, hasPushToken }) => {
        logLiveActivityLifecycle(
          'la-adopt-token-state',
          `id=${activityId};state=${state};hasPushToken=${hasPushToken}`,
        );
      },
    );
    return () => {
      endSubscription.remove();
      adoptSubscription.remove();
    };
  }, []);
}
