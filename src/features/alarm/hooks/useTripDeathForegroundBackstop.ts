/**
 * #2832 — pull 기반 trip 死 backstop을 FG(foreground)에 배선.
 *
 * 배경: `checkTripDeathByPull`(tripDeathPullBackstop.ts)은 이미 BG 두 진입점
 * (silentPushTask / backgroundLocationTask)에서 호출된다. 하지만 backend가
 * 'user-delete'로 트립을 삭제해도 FG station-passed 발사 경로(useStationAlarm.ts)엔
 * trip-ended lifecycle 게이트가 없어, FG에서는 backend 트립 삭제를 감지할 수단이 없다.
 * 그 결과 destination이 지워지지 않고 매 poll마다 zombie station-passed 알림이 발사된다.
 *
 * 이 훅은 신규 판정/cleanup 로직 없이 기존 backstop을 FG poll 주기에 편승시킬 뿐이다 —
 * `checkTripDeathByPull` 자체 throttle(TRIP_DEATH_PULL_BACKSTOP_THRESHOLD_MS)이 backend
 * 호출 빈도를 제어하므로 매 tick 호출해도 안전. 'ended' 명시 응답에서만 cleanup되고
 * 그 외(404/410/active/네트워크 에러)는 전부 무동작(ADR-010) — 살아있는 트립엔 무영향.
 *
 * AppState 'active'가 아니거나 활성 트립(ACTIVE_TRIP_KEY)이 없으면 호출하지 않는다.
 *
 * caller: HomeScreen.
 */

import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ACTIVE_TRIP_KEY } from '../../../shared/constants/storageKeys';
import { checkTripDeathByPull, getBackendUrl } from '../utils/tripDeathPullBackstop';
import { createLogger } from '../../../shared/utils/logger';

const logger = createLogger('useTripDeathForegroundBackstop');

/** FG tick 주기 — 기존 30s poll 사이클과 동일 카덴스(신규 polling 인프라 도입 없음). */
export const TRIP_DEATH_FG_BACKSTOP_POLL_INTERVAL_MS = 30_000;

async function tick(): Promise<void> {
  if (AppState.currentState !== 'active') return;

  const activeTripToken = await AsyncStorage.getItem(ACTIVE_TRIP_KEY);
  if (activeTripToken === null) return;

  const baseUrl = getBackendUrl();
  if (baseUrl === null) return;

  try {
    await checkTripDeathByPull(baseUrl, 'fg-tick');
  } catch (e) {
    logger.warn('checkTripDeathByPull 실패 (site=fg-tick) — graceful skip', e);
  }
}

export function useTripDeathForegroundBackstop(): void {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    void tick();

    intervalRef.current = setInterval(() => {
      void tick();
    }, TRIP_DEATH_FG_BACKSTOP_POLL_INTERVAL_MS);

    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void tick();
    });

    return () => {
      clearInterval(intervalRef.current ?? undefined);
      intervalRef.current = null;
      sub.remove();
    };
  }, []);
}
