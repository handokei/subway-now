import { HOP_TIME_MS } from '../constants/boardingLock';
import { isBoardingLockExpired, type BoardingLock } from '../types/boardingLock';
import type { Station } from '../types/station';

export interface BoardingLockInterpolationResult {
  station: Station;
  /** arcStations 내 위치 (0 = 탑승역). */
  index: number;
}

/**
 * 종착역 고정 회귀 방지(#621 review P1-2). 종점 도달 후 추가로 흐른 hop이
 * 이 값을 넘으면 interp를 무효화 — release/만료 처리 책임을 호출자에게 돌려준다.
 * 안전 마진: 종점에서 lock release까지의 일반적 지연(통보, 사용자 인지)을 흡수.
 */
const OVER_TERMINAL_GRACE_HOPS = 2;

/**
 * BoardingLock 활성 시 경과 시간 기반으로 현재역을 추정한다 (#621).
 *
 * 지하 GPS dead zone에서 실제 신호(GPS/realtimePosition API)가 stale일 때 fusion이
 * "용마산 5분 고정" 같은 회귀를 일으키는 것을 막는 floor 신호.
 *
 * idx = boardingIdx + floor((now - boardedAt) / HOP_TIME_MS)
 * stations 끝을 넘으면 마지막 역으로 cap. OVER_TERMINAL_GRACE_HOPS 초과면 null.
 *
 * 반환 null 케이스:
 *  - lock null
 *  - lock 만료 (isBoardingLockExpired)
 *  - boardingStationId가 arcStations에 없음 (route 변경 등)
 *  - 경과 시간이 음수 (시계 후진)
 *  - 종착역 cap 후 OVER_TERMINAL_GRACE_HOPS 추가 경과 (영구 고정 회피)
 */
export function interpolateBoardingLockStation(input: {
  lock: BoardingLock | null;
  arcStations: Station[];
  now: number;
}): BoardingLockInterpolationResult | null {
  const { lock, arcStations, now } = input;
  if (!lock) return null;
  if (isBoardingLockExpired(lock, now)) return null;
  if (arcStations.length === 0) return null;

  const elapsed = now - lock.boardedAt;
  if (elapsed < 0) return null;

  const boardingIdx = arcStations.findIndex((s) => s.id === lock.boardingStationId);
  if (boardingIdx === -1) return null;

  const hopsElapsed = Math.floor(elapsed / HOP_TIME_MS);
  const lastIdx = arcStations.length - 1;
  // 종착역을 OVER_TERMINAL_GRACE_HOPS 이상 초과한 경과 시간이면 interp 자체를 무효.
  if (boardingIdx + hopsElapsed > lastIdx + OVER_TERMINAL_GRACE_HOPS) return null;
  const idx = Math.min(boardingIdx + hopsElapsed, lastIdx);
  return { station: arcStations[idx], index: idx };
}

/**
 * arcStations에서 station.id 기준 인덱스. 미발견은 -1.
 * fusion에서 GPS/position-train 결과가 경로상 어느 위치인지 비교용.
 */
export function arcIndexOfStation(
  arcStations: Station[],
  station: Station | null | undefined,
): number {
  if (!station) return -1;
  return arcStations.findIndex((s) => s.id === station.id);
}
