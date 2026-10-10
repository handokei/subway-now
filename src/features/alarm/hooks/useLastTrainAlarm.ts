/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: HomeScreen에서 sleepMode(settings) + destination/route(route) +
 * currentStation(nearest-station)을 묶어 막차 알람을 발화. 후속 PR에서 orchestration 슬라이스로 분리 예정.
 */
import { useEffect, useRef } from 'react';
import type { Station } from '../../../shared/types/station';
import type { Route } from '../../../shared/utils/stationRoute';
import { runLastTrainAlarmCycle } from '../utils/lastTrainAlarm';

/**
 * #474 — 막차 알람 폴링 hook.
 *
 * - 매 interval(기본 60s)마다 evaluate → 임계값 안이면 알림 1회 발화 + idempotency stamp.
 * - sleepMode OFF / origin·destination·route 부재 시는 evaluate 단계에서 즉시 skip.
 * - 같은 station × 같은 KST 일자에 대해 단 1회만 발화 (AsyncStorage stamp).
 *
 * trip-bound 정책이 아니라 "오늘 이 origin 1회"라 같은 origin에서 destination을 바꿔도
 * 한 번 발화하면 그날은 더 안 운다 — 새벽 막차 1회만 안내하면 충분하므로 의도된 동작.
 */
export interface UseLastTrainAlarmInput {
  sleepMode: boolean;
  origin: Station | null;
  destination: Station | null;
  route: Route | null | undefined;
  /** 폴링 주기(ms). 기본 60_000. 0 또는 음수면 effect skip — 테스트에서 강제 OFF용. */
  intervalMs?: number;
}

export const DEFAULT_LAST_TRAIN_POLL_MS = 60 * 1000;

export function useLastTrainAlarm(input: UseLastTrainAlarmInput): void {
  const inputRef = useRef(input);
  inputRef.current = input;
  const intervalMs = input.intervalMs ?? DEFAULT_LAST_TRAIN_POLL_MS;

  useEffect(() => {
    if (intervalMs <= 0) return undefined;
    const tick = (): void => {
      const snapshot = inputRef.current;
      void runLastTrainAlarmCycle({
        sleepMode: snapshot.sleepMode,
        origin: snapshot.origin,
        destination: snapshot.destination,
        route: snapshot.route,
        now: new Date(),
      }).catch(() => {
        // 알람 게이트 실패는 한 사이클 손실 — 다음 polling에서 재시도.
      });
    };
    // 즉시 1회 + interval — sleep mode toggle 직후도 cold start cycle을 기다리지 않는다.
    tick();
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}
