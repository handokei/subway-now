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
 *      - status='ended' → notification 발사 + trip-end recall + storage cleanup + sentinel 기록 +
 *        active trip clear. silent push handler와 같은 cleanup 시퀀스를 그대로 따라
 *        사전예약/route/destination 잔존을 차단한다 (#1351 R1).
 *      - null(404/410) → active trip clear만. notification은 발사하지 않는다 (이미 정리됨,
 *        과거 notification은 다른 채널로 도달했을 가능성 또는 retention 만료).
 *      - status='active' → 변경 없음.
 *   4) 네트워크 에러 → silent fail. 다음 launch에서 재시도.
 *
 * 멱등성: sentinel이 기록되면 step 2에서 skip되므로 같은 trip에 대해 notification은 최대 1회.
 * triggerTripEndRecall/runTripBoundCleanups 자체도 멱등이라 silent push handler와 중복 호출 안전.
 *
 * 호출 순서: sendTripEndedNotification → triggerTripEndRecall → runTripBoundCleanups →
 * setTripEndedSentinel → removeItem(ACTIVE_TRIP_KEY). recall이 cleanup보다 먼저여야 한다 —
 * cleanup이 ROUTE_KEY/DESTINATION_KEY/TRIP_ORIGIN_KEY/TRIP_STARTED_AT_KEY를 제거하므로
 * 그 뒤에 recall이 돌면 입력이 비어 'empty'/'no-trip-start'로 skip된다
 * (triggerTripEndRecall.ts 헤더 주석 명시).
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
import { triggerTripEndRecall } from '../utils/triggerTripEndRecall';
import { runTripBoundCleanups } from '../store/tripBoundCleanups';
import { flushSignalDumpOutbox } from '../api/signalDumpBackend';
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
    // #1520 (ADR-015 §10 P5 / PR-B) — outbox flush retry. trip-end 시 upload 실패해 outbox에
    // enqueue된 raw signal dump를 cold-launch 시점에 다시 시도. trip status reconciliation과
    // 독립 — backend URL이 없거나 outbox 비어있으면 즉시 graceful skip.
    await flushSignalDumpOutbox();

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
    // #1351 R1 — silent push handler와 동일한 cleanup 시퀀스. alert payload trip-ended가
    // BG handler를 호출하지 않아 cleanup이 누락된 경우 launch backstop으로 복구.
    // recall은 cleanup이 storage를 비우기 전에 호출되어야 입력을 읽을 수 있다.
    // 두 호출 모두 멱등 — silent push handler와 중복 호출 안전.
    await triggerTripEndRecall();
    await runTripBoundCleanups();
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
