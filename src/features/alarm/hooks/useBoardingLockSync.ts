/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: alarm hook이 nearest-station feature의 API client
 * `syncBoardingLock`을 직접 호출한다. positionUpload와 동형(BG task가 nearest-station API
 * 호출)이라 file-level disable 패턴을 따른다. ADR Phase 5 (#890).
 */
/**
 * Seam E (#901) — BoardingLock 정정 신호 송신 훅.
 *
 * 사용자의 좋은 GPS fix(accuracy ≤ GOOD_FIX_ACCURACY_MAX_M)로 확정된 현재역을 backend에 통보해
 * cron의 stale lock currentWaypoint를 사용자 위치와 정렬한다. silent push 누락 회귀(#622) 흡수.
 *
 * 트리거:
 *   1) currentStationName 변경 + accuracy 게이트 통과 → debounce SYNC_DEBOUNCE_MS 후 발사
 *   2) `forceTriggerKey` 변경 — trip 등록 직후 / 지하→지상 경계(Seam G) 등 호출자 선택 트리거
 *      (key는 식별용 문자열; 호출자가 동일 key를 재전달하면 재발사 안 함)
 *
 * APNs token / trip token 모두 없는 상태(트립 미시작)는 자연 no-op. 송신 결과는 무시 —
 * backend의 정정 결과는 cron 사이클이 client에 silent push로 별도 전달한다.
 */

import { useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { APNS_TOKEN_KEY, ACTIVE_TRIP_KEY } from '../../../shared/constants/storageKeys';
import { syncBoardingLock } from '../../nearest-station/api/boardingLockSync';
import { createLogger } from '../../../shared/utils/logger';

const logger = createLogger('useBoardingLockSync');

/** sync 발사 직전 debounce — 사용자가 짧게 역 사이를 GPS jitter로 왕복해도 1회로 묶는다. */
export const SYNC_DEBOUNCE_MS = 5000;

/** 좋은 fix 임계 — Seam E 정정은 GPS-확신 신호만 받는다. positionUpload의 ≥ 50m drop과 정합. */
export const GOOD_FIX_ACCURACY_MAX_M = 50;

export interface UseBoardingLockSyncOptions {
  /** 클라가 좋은 fix로 확정한 현재역명. null이면 no-op. */
  currentStationName: string | null;
  /** 직전 fix accuracy meters. null/임계 초과면 no-op. */
  accuracyMeters: number | null;
  /**
   * 트립 활성 여부 — 호출자가 trip + lock 활성 게이트를 결정해 전달한다.
   * false면 본 훅은 sync를 발사하지 않는다 (lock 없는 fix에 backend가 trip_not_found로 응답할 뿐이라
   * 트래픽만 발생). 게이트는 호출자 책임 — alarm 슬라이스가 lock 존재로 판단.
   */
  tripActive: boolean;
  /**
   * 명시 트리거 키 — 값이 바뀔 때마다 1회 즉시 sync 발사 (debounce 우회).
   *   - 트립 등록 직후: 새 trip token을 key로 전달
   *   - 지하→지상 경계: barometer 신호 timestamp 또는 sequence 번호 전달
   * 같은 key 재전달은 no-op (재발사 방지). null → effect skip.
   */
  forceTriggerKey?: string | null;
  /** Seam G subsurface 신호 (옵션) — backend 로그에 진단 라벨로 첨부. */
  subsurface?: boolean;
}

/**
 * Effect-only 훅 — 외부 상태를 mutate하지 않고 backend POST만 발사한다 (return 없음).
 * 정정 결과는 cron sync silent push로 client에 별도 전달.
 */
export function useBoardingLockSync({
  currentStationName,
  accuracyMeters,
  tripActive,
  forceTriggerKey,
  subsurface,
}: UseBoardingLockSyncOptions): void {
  // 이미 보낸 currentStation을 기억해 debounce 안의 중복 발사를 방지.
  const lastSentStationRef = useRef<string | null>(null);
  // forceTriggerKey 이전 값 — 같은 key 재전달 시 no-op 판정용.
  const lastForceKeyRef = useRef<string | null>(null);

  // 1) currentStationName 변경 debounce 트리거.
  useEffect(() => {
    if (!tripActive) return;
    if (!currentStationName) return;
    if (accuracyMeters === null) return;
    if (accuracyMeters > GOOD_FIX_ACCURACY_MAX_M) return;
    if (lastSentStationRef.current === currentStationName) return;

    const timer = setTimeout(() => {
      // race: force-trigger 경로가 같은 station을 이미 발사했을 수 있음. setTimeout 내부에서
      // 한 번 더 lastSentStation 체크해 중복 발사 차단.
      if (lastSentStationRef.current === currentStationName) return;
      lastSentStationRef.current = currentStationName;
      void fireSync({
        observedStationName: currentStationName,
        accuracy: accuracyMeters,
        subsurface,
        reason: 'station-change',
      });
    }, SYNC_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [tripActive, currentStationName, accuracyMeters, subsurface]);

  // 2) 명시 트리거 (forceTriggerKey) — debounce 우회.
  useEffect(() => {
    if (!tripActive) return;
    if (!forceTriggerKey) return;
    if (lastForceKeyRef.current === forceTriggerKey) return;
    if (!currentStationName) return;
    if (accuracyMeters === null) return;
    if (accuracyMeters > GOOD_FIX_ACCURACY_MAX_M) return;

    lastForceKeyRef.current = forceTriggerKey;
    // lastSentStation을 즉시 동기로 set — effect 1의 debounce timer가 같은 station을 따라
    // 발사하지 않도록 차단. fire 실패해도 force 트리거는 forceTriggerKey 변경으로만 재시도되므로
    // false-positive 무발사는 발생하지 않음.
    lastSentStationRef.current = currentStationName;
    void fireSync({
      observedStationName: currentStationName,
      accuracy: accuracyMeters,
      subsurface,
      reason: 'force-trigger',
    });
  }, [tripActive, forceTriggerKey, currentStationName, accuracyMeters, subsurface]);
}

interface FireSyncInput {
  observedStationName: string;
  accuracy: number;
  subsurface?: boolean;
  reason: 'station-change' | 'force-trigger';
}

/**
 * AsyncStorage에서 token을 읽어 syncBoardingLock 호출. token/trip 부재는 graceful no-op.
 * 호출 결과는 무시(throw하지 않음) — 정정 응답은 호출자 store를 mutate하지 않는다.
 */
async function fireSync(input: FireSyncInput): Promise<void> {
  const token = await AsyncStorage.getItem(APNS_TOKEN_KEY);
  const activeTrip = await AsyncStorage.getItem(ACTIVE_TRIP_KEY);
  if (!token || !activeTrip) {
    logger.info('skip — apns or trip token missing', { reason: input.reason });
    return;
  }
  const payload = {
    token,
    observedStationName: input.observedStationName,
    observedAtMs: Date.now(),
    accuracy: input.accuracy,
    ...(input.subsurface !== undefined ? { subsurface: input.subsurface } : {}),
  };
  const res = await syncBoardingLock(payload);
  logger.info('boarding-lock sync sent', {
    reason: input.reason,
    advanced: res.advanced ?? false,
    currentWaypoint: res.currentWaypoint ?? null,
    ok: res.ok,
  });
}
