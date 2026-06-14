/* eslint-disable import/no-restricted-paths --
 * Cross-feature orchestration: alarm hook이 nearest-station feature의 API client
 * `uploadPosition`을 직접 호출한다. useBoardingLockSync(같은 슬라이스, syncBoardingLock 호출)와
 * 동형이라 file-level disable 패턴을 따른다. ADR Phase 5 (#890).
 */
/**
 * #1280 — foreground(WhileInUse) 위치 업로드 훅.
 *
 * `uploadPosition`(POST /position)은 그동안 BG task(backgroundLocationTask) 한 곳에서만 호출됐다.
 * WhileInUse 권한 사용자는 BG task가 fire되지 않아 POST /position이 영구 0건 → backend 위치
 * 지능(lock advance / boarding-prompt window)이 굶는다. 1시간 실기기 trip에서 POST /position = 0건
 * 으로 확인된 회귀(#1280)다.
 *
 * 사용자가 앱을 FG에서 보고 있는 동안 fix-watch가 좋은 fix를 흘리므로, 그 fix를 throttle 간격
 * (FG_POSITION_UPLOAD_THROTTLE_MS, ~10s)마다 backend로 송신해 위치 채널을 점등한다.
 *
 * 게이트(useBoardingLockSync와 동형):
 *   - tripActive=false → no-op (lock 없는 좌표는 backend trip series에 의미 없음)
 *   - accuracy null / GOOD_FIX_ACCURACY_MAX_M 초과 → skip (positionUpload의 ≥50m drop과 정합)
 *   - userLocation null → skip
 *
 * APNs token / trip token 부재(트립 미시작)는 자연 no-op. 송신은 fire-and-forget —
 * URL 미설정 / 네트워크 실패는 uploadPosition 내부에서 graceful 처리(throw 없음).
 */

import { useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { APNS_TOKEN_KEY, ACTIVE_TRIP_KEY } from '../../../shared/constants/storageKeys';
import { FG_POSITION_UPLOAD_THROTTLE_MS } from '../../../shared/constants/location';
import { uploadPosition, type PositionMotion } from '../../nearest-station/api/positionUpload';
import { GOOD_FIX_ACCURACY_MAX_M } from './useBoardingLockSync';
import { createLogger } from '../../../shared/utils/logger';

const logger = createLogger('useFgPositionUpload');

export interface UseFgPositionUploadOptions {
  /** 클라가 표시용 게이트를 통과한 현재 좌표. null이면 no-op. */
  userLocation: { lat: number; lng: number } | null;
  /** 직전 fix accuracy meters. null/임계 초과면 no-op. */
  accuracyMeters: number | null;
  /**
   * 트립 활성 여부 — 호출자가 trip 활성 게이트를 결정해 전달한다(useBoardingLockSync와 동형).
   * false면 업로드하지 않는다 (lock 없는 fix는 backend trip series에 의미 없어 트래픽만 발생).
   */
  tripActive: boolean;
  /** 모션 stationary 확정 여부(graceful false). payload.motion 산출용. */
  motionStationary?: boolean;
}

/**
 * Effect-only 훅 — 외부 상태를 mutate하지 않고 backend POST만 발사한다(return 없음).
 *
 * userLocation/accuracy가 바뀔 때마다 effect가 재실행되지만, 마지막 발사 시각을 ref로 들고
 * throttle 간격 이내의 연속 fix는 1회로 묶는다(BG보다 촘촘하되 과송신 방지).
 */
export function useFgPositionUpload({
  userLocation,
  accuracyMeters,
  tripActive,
  motionStationary,
}: UseFgPositionUploadOptions): void {
  // 마지막 업로드 시각(epoch ms). throttle 판정용. null = 미발사(첫 fix 즉시 발사).
  const lastUploadedAtRef = useRef<number | null>(null);

  // tripActive false → true 전환 시 throttle ref를 리셋해 새 trip 첫 fix가 즉시 발사되도록 한다.
  useEffect(() => {
    if (!tripActive) {
      lastUploadedAtRef.current = null;
    }
  }, [tripActive]);

  useEffect(() => {
    if (!tripActive) return;
    if (!userLocation) return;
    if (accuracyMeters === null) return;
    if (accuracyMeters > GOOD_FIX_ACCURACY_MAX_M) return;

    const now = Date.now();
    const lastUploadedAt = lastUploadedAtRef.current;
    if (lastUploadedAt !== null && now - lastUploadedAt < FG_POSITION_UPLOAD_THROTTLE_MS) return;
    lastUploadedAtRef.current = now;

    void fireUpload({
      lat: userLocation.lat,
      lng: userLocation.lng,
      accuracy: accuracyMeters,
      ts: now,
      motionStationary: motionStationary === true,
    });
  }, [tripActive, userLocation, accuracyMeters, motionStationary]);
}

interface FireUploadInput {
  lat: number;
  lng: number;
  accuracy: number;
  ts: number;
  motionStationary: boolean;
}

/**
 * AsyncStorage에서 token을 읽어 uploadPosition 호출. token/trip 부재는 graceful no-op.
 * mapMatched / nearestStationDistance enrich는 uploadPosition 내부가 BG 호출자와 동일하게 처리.
 */
async function fireUpload(input: FireUploadInput): Promise<void> {
  const token = await AsyncStorage.getItem(APNS_TOKEN_KEY);
  const activeTrip = await AsyncStorage.getItem(ACTIVE_TRIP_KEY);
  if (!token || !activeTrip) {
    logger.info('skip — apns or trip token missing');
    return;
  }
  const motion: PositionMotion = input.motionStationary ? 'stationary' : 'unknown';
  void uploadPosition({
    token,
    lat: input.lat,
    lng: input.lng,
    accuracy: input.accuracy,
    ts: input.ts,
    motion,
  });
}
