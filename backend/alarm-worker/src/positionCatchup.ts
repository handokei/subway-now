/**
 * #2629 PR-3 — lock 열차 위치 따라잡기 계획(순수 함수).
 *
 * 서버 head(trip.waypoints[0])가 lock 열차의 실제 위치보다 뒤처졌을 때(Seoul 결측·cron 건너뜀·전파 지연 등)
 * 열차가 이미 지나친 선두 intermediate waypoint를 돌려준다. 호출자(`runTrainCodeTracking` 진입부)가 같은 tick에
 * 그 역들을 소비해 head를 열차 위치까지 끌어올린다 — 한 tick에 한 waypoint씩만 전진하던 현행의 추가 안전망이다.
 *
 * 게이트(전부 충족해야 실행, 하나라도 실패하면 [] = 현행 동작) — 위치만 쓴다. 시간 기반 판정 금지(ADR-015):
 *   G1 신원  p.trainCode === lock.trainCode 정확 일치
 *   G2 방향  inferLegDirection(lock.line, seg[0], seg[last]) — null이면 fail-closed, (dir==='up') !== p.isUp이면 거부
 *   G3 신선  recptn이 POSITION_FRESHNESS_MS 이내 (누락=0은 신뢰 불가)
 *   G4 경로  열차 역·지나친 waypoint 모두 lock.segmentStations 안, 지나친 역의 segment 인덱스 < 열차 인덱스
 *   G6 종류  지나친 구간은 intermediate만. 첫 transfer/destination에서 멈춘다(환승·도착은 정규 경로 소관)
 * (G5 lock 활성은 호출자 상류 보장.)
 */
import { POSITION_FRESHNESS_MS } from './boardingAnchorResolver';
import { inferLegDirection } from './legDirection';
import type { PositionEntry } from './seoul';
import type { BoardingLockMeta, Trip, Waypoint } from './types';

export interface PositionCatchupInputs {
  trip: Pick<Trip, 'waypoints'>;
  lock: BoardingLockMeta;
  positions: readonly PositionEntry[];
  now: number;
}

/** 열차가 이미 지나친 선두 intermediate waypoint(오래된 순). 따라잡기 불가면 []. */
export function planPositionCatchup({ trip, lock, positions, now }: PositionCatchupInputs): Waypoint[] {
  const { segmentStations, trainCode, line } = lock;
  const train = positions.find((p) => p.trainCode === trainCode);
  if (train === undefined) return [];
  if (!(train.recptnMs > 0 && now - train.recptnMs <= POSITION_FRESHNESS_MS)) return [];
  if (segmentStations.length < 2) return [];
  const direction = inferLegDirection(line, segmentStations[0], segmentStations[segmentStations.length - 1]);
  if (direction === null || (direction === 'up') !== train.isUp) return [];

  // 열차 역이 segment 밖이면 -1 — 아래 `index >= trainIndex`가 모든 waypoint에서 참이 되어 [] (G4).
  const trainIndex = segmentStations.indexOf(train.stationName);

  const passed: Waypoint[] = [];
  for (const waypoint of trip.waypoints) {
    if (waypoint.kind !== 'intermediate') break;
    const index = segmentStations.indexOf(waypoint.stationName);
    if (index < 0 || index >= trainIndex) break;
    passed.push(waypoint);
  }
  return passed;
}
