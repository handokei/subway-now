/**
 * #876 — Sticky Station 게이트 순수 함수.
 *
 * `useStickyStation` 훅이 lock/unlock 의사결정을 내릴 때 사용하는 평가 함수들.
 * 순수 함수로 분리해 테스트가 쉽고, 동일 로직을 BG/FG 어디서나 재사용할 수 있게 한다.
 */

import type { Station } from '../../../shared/types/station';
import { haversine } from '../../../shared/utils/haversine';
import {
  STICKY_DEGRADED_UNLOCK_ACCURACY_M,
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
  /**
   * D6 (#1212) — 기압계가 지하 진입을 시사하는지. trip 활성 + 지하면 GPS 거리 게이트도
   * 신뢰할 수 없다 — dead-zone에서 부정확한 좌표가 1km+ 점프해 sticky가 잘못 풀리는 케이스 차단.
   */
  subsurface?: boolean;
  /**
   * D6 (#1212) — trip(목적지/경로) 활성 여부. 사용자가 trip 중이면 sticky를 풀어도
   * 의미가 없고(현재역은 trip context로 확정), 지하 dead-zone GPS로 풀리면 회귀를 유발한다.
   */
  tripActive?: boolean;
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
  // D6 (#1212) — trip 활성 + 지하면 GPS 1km+ 점프는 dead-zone 부정확 좌표 가능성이 높다.
  // 지상 trip은 그대로 평가(차로 1km 이동 가능).
  if (fix.tripActive === true && fix.subsurface === true) return false;
  const distanceKm = haversine(locked.lat, locked.lng, fix.lat, fix.lng);
  return distanceKm > STICKY_UNLOCK_DISTANCE_KM;
}

/**
 * #1317 — 저품질 GPS 내성 "멀어짐" 증거 판정 (한 fix 단위).
 *
 * shouldUnlockByDistance는 accuracy ≤ 50m를 요구해 지하·도심 협곡(50~250m)에서 발동하지
 * 못하고 출발역 lock이 고착된다. 이 함수는 "한 fix가 lock된 역에서 멀어짐(>1km)의 증거인가"만
 * 판정한다 — 즉시 unlock하지 않는다. 호출자(useStickyStation)가 이런 fix를 N회 연속 누적해야
 * unlock한다(단발성 부정확 fix로 풀리는 반대 회귀 방지).
 *
 * 조건:
 *   - accuracy non-null이고 ≤ STICKY_DEGRADED_UNLOCK_ACCURACY_M(250m) — 쓰레기 좌표는 거부.
 *   - 후보 역이 lock된 역과 다른 역 — 같은 역이면 "멀어짐"이 아니다.
 *   - lock된 역에서 STICKY_UNLOCK_DISTANCE_KM(1km) 초과로 떨어짐.
 *   - D6(#1212) — trip 활성 + 지하 조합에서는 보류(strict distance 게이트와 동일 hold).
 *     지하 dead-zone GPS의 1km+ 점프는 부정확 좌표 가능성이 높다.
 */
export function shouldCountAsMovedAway(
  locked: Station,
  fix: StickyPositionInput & { candidateId: string | null },
): boolean {
  const { accuracyMeters, candidateId } = fix;
  if (accuracyMeters == null || accuracyMeters > STICKY_DEGRADED_UNLOCK_ACCURACY_M) return false;
  if (candidateId == null || candidateId === locked.id) return false;
  if (fix.tripActive === true && fix.subsurface === true) return false;
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
  /**
   * D6 (#1212) — 기압계가 지하 진입을 시사하는지. 지하 + trip 활성 시 automotive=true는
   * 지하철 탑승이라는 정상 신호 — 이 조합에서는 sticky를 풀지 않는다.
   */
  subsurface?: boolean;
  /**
   * D6 (#1212) — trip(목적지/경로) 활성 여부. ADR-010 첫 줄(false positive / miss 동급)에 따라
   * 사용자 명시 의향 trip은 lock 활성과 동급으로 정확도를 보장한다.
   */
  tripActive?: boolean;
}

export function shouldUnlockByMotion(motion: StickyMotionInput): boolean {
  if (motion.automotive !== true) return false;
  // D6 (#1212) — 지하 + trip 활성 시 automotive는 지하철 탑승의 정상 신호.
  // 지상 trip은 차/도보 환승 가능성이 있어 그대로 unlock 허용.
  if (motion.subsurface === true && motion.tripActive === true) return false;
  return true;
}
