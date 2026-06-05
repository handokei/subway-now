/**
 * #876 — Sticky Station 게이트 순수 함수.
 *
 * `useStickyStation` 훅이 lock/unlock 의사결정을 내릴 때 사용하는 평가 함수들.
 * 순수 함수로 분리해 테스트가 쉽고, 동일 로직을 BG/FG 어디서나 재사용할 수 있게 한다.
 */

import type { Station } from '../../../shared/types/station';
import { haversine } from '../../../utils/haversine';
import {
  STICKY_GOOD_FIX_ACCURACY_M,
  STICKY_GOOD_FIX_SPEED_MAX_MPS,
  STICKY_TTL_MS,
  STICKY_UNLOCK_DISTANCE_KM,
} from '../../../shared/constants/stickyStation';

/** 평가 대상 좌표 + 동반 신호. accuracy null은 측정 불가, speed null은 정지로 간주(보수). */
export interface StickyFixInput {
  accuracyMeters: number | null;
  speedMps: number | null;
}

export interface StickyPositionInput {
  lat: number;
  lng: number;
  accuracyMeters: number | null;
}

/**
 * "좋은 fix" 판정.
 *
 * 조건:
 *   - accuracy ≤ STICKY_GOOD_FIX_ACCURACY_M (50m)
 *     · accuracy null은 측정 불가 → 신뢰하지 않음(false). 알람 게이트와 달리 sticky는
 *       false-lock 방지를 우선해 null을 거부한다.
 *   - speed < STICKY_GOOD_FIX_SPEED_MAX_MPS (1 m/s)
 *     · speed null은 stationary(iOS CoreLocation -1 → null 정규화)로 간주, 통과시킨다.
 *     · 지상에서 잠깐 서서 fix가 잡히는 시나리오가 sticky의 1차 사용 케이스.
 */
export function isGoodFix(fix: StickyFixInput): boolean {
  const { accuracyMeters, speedMps } = fix;
  if (accuracyMeters == null) return false;
  if (accuracyMeters > STICKY_GOOD_FIX_ACCURACY_M) return false;
  if (speedMps != null && speedMps >= STICKY_GOOD_FIX_SPEED_MAX_MPS) return false;
  return true;
}

/**
 * 거리 기반 unlock.
 *
 * 잠금된 역에서 STICKY_UNLOCK_DISTANCE_KM(1km) 초과로 떨어진 좌표가 동시에
 * 좋은 정확도(≤ STICKY_GOOD_FIX_ACCURACY_M)일 때만 unlock 트리거.
 * 정확도가 나쁜 좌표로 unlock하면 지하 dead-zone GPS가 잘못된 위치를 보고할 때
 * 잘못 풀릴 수 있어 차단.
 */
export function shouldUnlockByDistance(locked: Station, fix: StickyPositionInput): boolean {
  const { accuracyMeters } = fix;
  if (accuracyMeters == null || accuracyMeters > STICKY_GOOD_FIX_ACCURACY_M) return false;
  const distanceKm = haversine(locked.lat, locked.lng, fix.lat, fix.lng);
  return distanceKm > STICKY_UNLOCK_DISTANCE_KM;
}

/**
 * TTL 기반 unlock. lockedAt 이후 STICKY_TTL_MS(30분) 경과 시 stale lock 해제.
 * 사용자가 앱을 켜둔 채 이동한 후 복귀했을 때 잘못된 lock이 남는 것을 방지.
 */
export function shouldUnlockByTtl(lockedAt: number, now: number): boolean {
  return now - lockedAt >= STICKY_TTL_MS;
}

/**
 * Motion 기반 unlock. CMMotionActivity가 automotive로 보고하면 차/지하철 이동 확정.
 *
 * 옵셔널 입력 — motion 신호를 호출자가 갖고 있을 때만 평가. 신호 없으면 false(보수).
 * 호출자가 useMotionActivity 같은 훅을 통해 stationary/automotive를 받아 전달한다.
 */
export interface StickyMotionInput {
  automotive?: boolean;
}

export function shouldUnlockByMotion(motion: StickyMotionInput): boolean {
  return motion.automotive === true;
}
