/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: launch reconciliation은 alarm 슬라이스의 client(fetchTripStatus)와
 * notification(sendTripEndedNotification)·sentinel(tripEndedSentinel) + route 슬라이스의
 * destination/lock store를 한 곳에서 묶어 처리하는 본질적 orchestrator. useStateRehydration과
 * 동형이라 file-level disable 패턴을 따른다 (ADR Phase 5).
 */
/**
 * Launch reconciliation hook (#1339 PR2 device).
 *
 * Backstop for PR1(#1340) trip-ended alert push. backend trip-ended push가 어떤 이유로든
 * 디바이스에 도달하지 못한 경우(killed-app + push 누락, 권한 변경 등) 다음 cold-launch
 * 시점에 디바이스가 backend `GET /trips/:tripToken/status`로 명시적으로 확인하고 정리한다.
 *
 * 흐름:
 *   1) ACTIVE_TRIP_KEY 조회. 없으면 미트립 — skip.
 *   2) tripEndedSentinel 확인. 이미 기록 있음 = silent push가 잘 도달한 케이스 — skip.
 *   3) `fetchTripStatus` 호출.
 *      - status='ended' → notification 발사 + sentinel 기록 + active trip clear.
 *        useStateRehydration이 sentinel을 보고 destination/lock store reset을 수행한다.
 *      - null(404/410) → active trip clear만. notification은 발사하지 않는다 (이미 정리됨,
 *        과거 notification은 다른 채널로 도달했을 가능성 또는 retention 만료).
 *      - status='active' → 변경 없음.
 *   4) 네트워크 에러 → silent fail. 다음 launch에서 재시도.
 *
 * 멱등성: sentinel이 기록되면 step 2에서 skip되므로 같은 trip에 대해 notification은 최대 1회.
 *
 * 호출 시점: app/_layout.tsx에서 마운트 1회. cold-launch backstop이라 AppState 'active'
 * 재진입 시 반복 fetch는 불필요 (silent push가 살아있다면 그쪽이 우선).
 */

import { useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ACTIVE_TRIP_KEY } from '../../../shared/constants/storageKeys';
import {
  getTripEndedSentinel,
  setTripEndedSentinel,
} from '../utils/tripEndedSentinel';
import { sendTripEndedNotification } from '../utils/stationNotification';
import { fetchTripStatus } from '../api/tripStatus';
import { createLogger } from '../../../shared/utils/logger';

const logger = createLogger('useLaunchTripReconciliation');

function getBackendUrl(): string | null {
  const url = process.env.EXPO_PUBLIC_ALARM_BACKEND_URL;
  if (!url) return null;
  return url;
}

/**
 * 한 번의 reconciliation 사이클. 마운트 시 1회 호출.
 *
 * 모든 분기에서 throw하지 않는다 — launch path를 차단하지 않기 위함. 실패는 로그로만 남고
 * 다음 launch에서 재시도된다.
 */
export async function runLaunchTripReconciliation(): Promise<void> {
  try {
    const baseUrl = getBackendUrl();
    if (!baseUrl) {
      logger.info('skip — ALARM_BACKEND_URL not set');
      return;
    }

    const tripToken = await AsyncStorage.getItem(ACTIVE_TRIP_KEY);
    if (!tripToken) {
      return;
    }

    const sentinel = await getTripEndedSentinel();
    if (sentinel !== null) {
      logger.info('skip — sentinel already recorded');
      return;
    }

    let result;
    try {
      result = await fetchTripStatus(tripToken, baseUrl);
    } catch (e) {
      // 네트워크 에러는 silent fail — 다음 launch에서 재시도.
      logger.warn('fetchTripStatus 실패 — 다음 launch에서 재시도', e);
      return;
    }

    if (result === null) {
      // 404/410 — trip이 backend에 이미 없다. active trip 키만 정리.
      logger.info('trip missing on backend — clear active trip key');
      await AsyncStorage.removeItem(ACTIVE_TRIP_KEY);
      return;
    }

    if (result.status === 'active') {
      // backend 기준 살아있음 — 디바이스 상태도 그대로 유지.
      return;
    }

    // status === 'ended'. silent push miss를 backstop으로 복구.
    const endedAt = result.endedAt ?? Date.now();
    const reason = result.endReason ?? 'unknown';
    logger.info(
      `trip ended on backend — surface notification reason=${reason} endedAt=${endedAt}`,
    );
    await sendTripEndedNotification(reason);
    await setTripEndedSentinel(endedAt);
    await AsyncStorage.removeItem(ACTIVE_TRIP_KEY);
  } catch (e) {
    logger.warn('reconciliation 실패 (graceful)', e);
  }
}

/**
 * 마운트 시 1회 reconciliation 실행. cold-launch trip-ended backstop.
 */
export function useLaunchTripReconciliation(): void {
  useEffect(() => {
    void runLaunchTripReconciliation();
  }, []);
}
