/**
 * #2828 — LA START가 FG pre-lock 윈도우(`useLiveActivityPreBoardingLifecycle`)에서만 발생하고,
 * lock 이후/BG 재개 시점엔 아무도 LA를 생성하지 않아 트립 내내 LA가 안 뜨는 회귀 fix.
 *
 * `useLiveActivityPreBoardingLifecycle`은 lock이 생기면 관여를 멈추고(#2436), 이후 모든
 * writer(`stationNotification.ts`, `liveActivityMirrorSync.ts`, `refreshLiveActivityFromBackgroundContext.ts`)는
 * `hasActiveLiveActivity()` 가드로 "없으면 skip"만 한다 — FG pre-lock 좁은 윈도우를 놓치면
 * (예: BG서 목적지 설정, 설정 직후 탭) 그 뒤로 START를 시도하는 코드가 전혀 없다.
 *
 * 이 훅은 FG active 상태에서 "트립은 활성인데 LA가 없는" 상태를 주기적으로(deps 변화 + AppState
 * 복귀 시점) 관찰해 `LiveActivity.updateLiveActivity`를 호출한다 — native `update(data:)`는 활성
 * Activity가 없으면 내부적으로 `start`로 fall-through하는 멱등 API라(LiveActivityManager.swift:247),
 * `startLiveActivity`를 직접 호출하지 않고도 "없으면 생성, 있으면 갱신"이 보장된다.
 *
 * 회귀 안전:
 *   - 멱등 — `hasActiveLiveActivity()`가 true면 아무 것도 하지 않는다(중복 start 없음).
 *   - 설정 존중 — `isLiveActivityEnabled()`가 false면 아무 것도 하지 않는다.
 *   - BG start 절대 금지 — `AppState`가 'active'가 아니면 아무 것도 하지 않는다(iOS가 BG에서
 *     `Activity.request`를 거부하는 것과 별개로, 이 훅 자체가 BG에서 시도조차 하지 않는다).
 *   - additive — preboarding 훅/GPS·mirror writer/store/native는 이 훅이 건드리지 않는다. 이미
 *     LA가 떠 있는 정상 트립에서는 `hasActiveLiveActivity()` 가드로 완전히 no-op.
 */
import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import * as LiveActivity from 'live-activity';
import type { Station } from '../../../shared/types/station';
import type { Route } from '../../../shared/utils/stationRoute';
import type { BoardingLock } from '../../../shared/types/boardingLock';
import { buildLiveActivityData } from '../utils/stationNotification';
import { createLogger } from '../../../shared/utils/logger';

const log = createLogger('useEnsureLiveActivity');

export function useEnsureLiveActivity(
  currentStation: Station | null,
  distanceM: number,
  destination: Station | null,
  route: Route,
  etaMinutes: number | null,
  lock: BoardingLock | null,
): void {
  useEffect(() => {
    if (Platform.OS !== 'ios') return;

    const ensure = () => {
      if (AppState.currentState !== 'active') return;
      const tripActive = lock != null || destination != null;
      if (!tripActive) return;
      if (!currentStation) return;
      if (!LiveActivity.isLiveActivityEnabled()) return;
      if (LiveActivity.hasActiveLiveActivity()) return;

      const data = buildLiveActivityData(currentStation, distanceM, destination, route, etaMinutes);
      LiveActivity.updateLiveActivity(data).catch((e) => {
        log.warn('LA ensure 갱신 실패', e);
      });
    };

    ensure();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') ensure();
    });
    return () => subscription.remove();
  }, [currentStation, distanceM, destination, route, etaMinutes, lock]);
}
