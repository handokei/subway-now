/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: launch reconciliation은 alarm 슬라이스의 client(fetchTripStatus)와
 * sentinel(tripEndedSentinel) + route 슬라이스의 destination/lock store를 한 곳에서 묶어 처리하는
 * 본질적 orchestrator. useStateRehydration과 동형이라 file-level disable 패턴을 따른다 (ADR Phase 5).
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
 *   3) #2045 (Signal 4) — backend-timeout self-end 판정. 마지막 silent push 수신 후
 *      SIGNAL_4_SILENT_PUSH_TIMEOUT_MS(30분) 초과 + trip 시작 후 SIGNAL_4_KTX_ETA_UPPER_BOUND_MS
 *      (10h) 미만이면 backend가 실질적으로 이 trip을 놓친 것으로 간주 → 즉시 self-end.
 *      status=ended 분기와 동일한 cleanup 시퀀스 (notification 미발사 — backend 무음 상태에서
 *      "trip 종료" 알림은 사용자에게 잘못된 신호). 관찰 22 BG kill 6h+ 방치 후 launch 시나리오 커버.
 *   4) `fetchTripStatus` 호출.
 *      - status='ended' → trip-end recall + storage cleanup + sentinel 기록 + active trip clear.
 *        silent push handler와 같은 cleanup 시퀀스를 그대로 따라 사전예약/route/destination
 *        잔존을 차단한다 (#1351 R1). #2069 (Phase 3) — D11(로컬 알림 재생성)은 제거, B12
 *        원격 alert push 단일 채널.
 *      - null(404/410) → active trip clear만 (이미 정리됨).
 *      - status='active' → 변경 없음.
 *   5) 네트워크 에러 → silent fail. 다음 launch에서 재시도.
 *
 * 멱등성: sentinel이 기록되면 step 2에서 skip. triggerTripEndRecall/runTripBoundCleanups 자체도
 * 멱등이라 silent push handler와 중복 호출 안전.
 *
 * 호출 순서: triggerTripEndRecall → runTripBoundCleanups → setTripEndedSentinel →
 * removeItem(ACTIVE_TRIP_KEY). recall이 cleanup보다 먼저여야 한다 —
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
  SIGNAL_4_KTX_ETA_UPPER_BOUND_MS,
  SIGNAL_4_SILENT_PUSH_TIMEOUT_MS,
} from '../../../shared/constants/realtime';
import {
  clearTripEndedSentinel,
  getTripEndedSentinel,
  resolveTripEndedSentinelVerdict,
  setTripEndedSentinel,
} from '../utils/tripEndedSentinel';
import { getLastSilentPushReceivedAt } from '../utils/lastSilentPushReceivedAt';
import { getTripStartedAt } from '../utils/tripStartStorage';
import { fetchTripStatus } from '../api/tripStatus';
import { triggerTripEndRecall } from '../utils/triggerTripEndRecall';
import { runTripBoundCleanups } from '../store/tripBoundCleanups';
import { cleanupBackendConfirmedEndedTrip } from '../utils/tripEndedCleanupSequence';
import { flushSignalDumpOutbox } from '../api/signalDumpBackend';
import { getCurrentTripCorrIdSync } from '../../observability/utils/tripCorrId';
import { triggerTripGroundTruthPrompt } from '../../debug/utils/triggerTripGroundTruthPrompt';
import { clearBackendSsotMirror } from '../utils/backendSsotMirror';
import { logCrossTripMirrorSkip } from '../utils/alarmLog';
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
      // R11-c (#1612): active trip 없으면 stale backend SSoT mirror clear.
      // 180s freshness 윈도우 내에 mirror가 남아 있으면 다음 cascade cycle이 `backend-ssot`
      // tier로 stale stationId를 채택해 cross-trip 잔재(2026-06-20 12:30 어대 → 용마산 도착) 회귀.
      // cleanup은 멱등 — 키 부재 시 graceful no-op.
      await clearBackendSsotMirror();
      // #1628 — R11-c 차단 1건 측정.
      logCrossTripMirrorSkip('launch');
      return;
    }

    const sentinel = await getTripEndedSentinel();
    if (sentinel !== null) {
      // #2114 — sentinel이 현재 활성 trip과 다른 trip의 것이면(stale) skip하지 않고
      // clear 후 reconciliation을 계속 진행한다. stale sentinel이 정상 launch reconciliation을
      // 영구히 막는 부수 결함(밤샘 trip force-end sentinel이 그 직후 등록된 새 trip을 계속
      // "이미 처리됨"으로 오판)을 함께 수리. 판정은 corrId 1순위 + timestamp fallback
      // (resolveTripEndedSentinelVerdict, 방안 C′).
      const tripStartedAtForSentinel = await getTripStartedAt();
      const currentCorrIdForSentinel = getCurrentTripCorrIdSync();
      const sentinelVerdict = resolveTripEndedSentinelVerdict(
        sentinel,
        tripStartedAtForSentinel,
        currentCorrIdForSentinel,
      );
      if (sentinelVerdict !== 'stale') {
        logger.info('skip — sentinel already recorded');
        return;
      }
      logger.info(
        `sentinel=${JSON.stringify(sentinel)} stale (tripStartedAt=${tripStartedAtForSentinel}, currentCorrId=${currentCorrIdForSentinel}) → clear + continue`,
      );
      await clearTripEndedSentinel();
    }

    // #2045 (Signal 4, Issue #2043 β 후속) — backend-timeout self-end 판정.
    //
    // 마지막 silent push 수신 후 30분+ 무음 AND trip 시작 후 10h 미만이면 backend가
    // 실질적으로 이 trip을 놓친 것으로 판단해 device가 자체 종료. 관찰 22 시나리오
    // (BG 6h+ 방치 or 앱 kill 후 launch) 커버 — #2044 FG 3-signal과 상호 보완.
    //
    // 두 임계 모두 만족 필요:
    //   - lastReceivedAt !== null: silent push 한 번도 없으면 (첫 launch or 새 trip 직후)
    //     판정 skip. 정상 silent push wire 확인 후에만 무음 판정.
    //   - startedAt !== null: trip 시작 시각 없으면 판정 skip (기존 recall 처리에 위임).
    //   - now - lastReceivedAt > 30분: backend 무음 확정 (cron ~30s cycle × 60).
    //   - now - startedAt < 10h: KTX/장거리 실 trip 보호. 10h 이상은 force-end backstop(9h)에 위임.
    //
    // Sentinel 이후 배치: 위에서 sentinel !== null 이미 skip. 여기 도달 = sentinel 부재 상태.
    // Self-end 성공 시 setTripEndedSentinel(now)로 다음 launch에서는 sentinel skip로 즉시 return.
    //
    // Notification 미발사: sendTripEndedNotification 호출 안 함. Backend가 무음 상태에서
    // "trip 종료" 알림은 사용자에게 잘못된 신호(백엔드 outage인지 정상 종료인지 모름).
    // status=ended 분기와 다른 점: cleanup + sentinel만 수행. UI는 다음 FG mount 시
    // useStateRehydration이 sentinel 감지해 destination/lock reset하는 기존 chain에 위임.
    const now = Date.now();
    const [lastReceivedAt, startedAt] = await Promise.all([
      getLastSilentPushReceivedAt(),
      getTripStartedAt(),
    ]);
    if (
      lastReceivedAt !== null &&
      startedAt !== null &&
      now - lastReceivedAt > SIGNAL_4_SILENT_PUSH_TIMEOUT_MS &&
      now - startedAt < SIGNAL_4_KTX_ETA_UPPER_BOUND_MS
    ) {
      logger.info(
        `Signal 4 backend-timeout self-end: silentPushGap=${now - lastReceivedAt}ms tripAge=${now - startedAt}ms`,
      );
      // 기존 status=ended 분기와 동일한 순서 — recall이 cleanup 이전이어야 storage 입력 유지.
      await triggerTripEndRecall();
      const endedCorrIdSnapshot = getCurrentTripCorrIdSync();
      await runTripBoundCleanups();
      await triggerTripGroundTruthPrompt(endedCorrIdSnapshot);
      // #2114 (방안 C′) — sentinel에 corrId 동봉.
      await setTripEndedSentinel(now, endedCorrIdSnapshot);
      await AsyncStorage.removeItem(ACTIVE_TRIP_KEY);
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
    logger.info(`trip ended on backend — reconcile state reason=${reason} endedAt=${endedAt}`);
    // #2069 (Phase 3) — D11(`sendTripEndedNotification`) 제거. B12가 원격 alert push 단일
    // 채널이라 로컬 알림 재생성은 하지 않는다. state cleanup(recall/cleanups/sentinel)만 유지.
    // #1351 R1 — silent push handler와 동일한 cleanup 시퀀스. alert payload trip-ended가
    // BG handler를 호출하지 않아 cleanup이 누락된 경우 launch backstop으로 복구.
    // recall은 cleanup이 storage를 비우기 전에 호출되어야 입력을 읽을 수 있다.
    // 두 호출 모두 멱등 — silent push handler와 중복 호출 안전.
    // #2178 — 5단 시퀀스(recall → cleanup → prompt → sentinel → active clear)를
    // tripEndedCleanupSequence로 추출해 pull death backstop과 공유(중복 구현 금지).
    await cleanupBackendConfirmedEndedTrip(endedAt);
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
