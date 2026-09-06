import type { BoardingLock } from '../../../shared/types/boardingLock';
import type { LinePositions, TrainPosition } from '../../../shared/types/position';
import type { Route } from '../../../shared/utils/stationRoute';
import { getStationById, findStationByNameAndLine } from '../../../shared/utils/stationRoute';
import { isPendingTrainCode } from '../../../shared/constants/boardingLock';
import { resolveTripDirection } from './tripDirection';
import { directionOnLine } from './directionOnLine';

/**
 * BoardingLock의 trainCode가 lock.boardingLine의 위치 데이터에서 관측되는지 검사 (#584 PR D3).
 *
 * - lock 또는 positions 없음 → 'no-signal' (탐지 보류 — 호출자가 카운터 미증가)
 * - positions.line이 lock.boardingLine과 다름 → 'no-signal' (관측 불가)
 * - lock.trainCode가 #2407 pending sentinel(train 미확정) → 'no-signal' (오탐 금지 — pending을
 *   실 trainCode처럼 매칭에 넣으면 항상 'absent'로 잘못 확정된다)
 * - positions에 trainNo == lock.trainCode 존재 → 'present' (단, 아래 방향 검사에서 반대방향이면 'wrong-direction')
 * - positions는 있고 trainNo 부재 → 'absent'
 *
 * mock 데이터(isMock=true)는 'no-signal' — 실측이 아니므로 잘못 탑승 판단 근거가 될 수 없다.
 *
 * 잘못된 방향 tapping 감지 (Phase B, foreground). #584 mis-boarding subsystem 확장:
 * lock.trainCode가 present여도 그 열차가 route와 반대 방향으로 진행 중이면(=반대편 승강장에서
 * 잘못 탄 경우) trainCode 매칭만으로는 놓친다. route(현재 leg)와 destinationName이 주어지면
 * 아래 로직으로 방향까지 확인한다:
 *   - route/destinationName 미전달 → 방향 검사 skip (기존 동작, 항상 'present')
 *   - 관측된 열차의 statnNm이 lock.boardingStationId(=현재 leg 시작역)와 같음 → 아직 출발 전,
 *     이동 방향을 알 수 없어 'present' (indeterminate를 wrong으로 오판하지 않는다)
 *   - resolveTripDirection(현재 leg의 기대 방향)과 실제 이동 방향 중 하나라도 null이면
 *     'present' (판정 불가)
 *   - 두 방향이 서로 다르면 'wrong-direction', 같으면 'present'
 *
 * 실제 이동 방향은 공유 primitive `directionOnLine`(station-id 두 개 → 방향, #2455)으로
 * 계산한다. `resolveTravelDirection`/`inferLoopDirection`을 별도로 조합하지 않는 이유:
 * 2호선 순환선 seam(시청↔충정로)에서 그 두 유틸의 wraparound 판정 알고리즘이 어긋나(#1922 step
 * 비교 vs #1063 forward/backward 호 길이 비교) 정반대 라벨을 낼 수 있음을 직접 확인했다
 * (리버스 엔지니어링, 두 유틸 자체는 미수정). `directionOnLine`은 `resolveTripDirection`이
 * leg 선택 뒤 내부적으로 쓰는 것과 동일한 `shortestLinePathIndices` 알고리즘이라 기대/실제
 * 양쪽이 이 알고리즘 하나로 self-consistent하다 — seam 부근에서는 최악의 경우 미탐
 * (false negative)만 발생하고 오탐은 나지 않는다.
 */
export type MisBoardingObservation = 'present' | 'absent' | 'no-signal' | 'wrong-direction';

/**
 * lock의 현재 leg 시작역 대비 관측된 열차의 실제 진행 방향이 route가 기대하는 방향과
 * 반대인지 판정한다. 판정 불가(데이터 부족, 아직 출발 전 등)한 모든 경우는 false — 'present'로
 * 남겨 오탐(false positive)을 차단한다.
 */
function isWrongDirection(
  lock: BoardingLock,
  observedTrain: TrainPosition,
  route: Route,
  destinationName: string | null,
): boolean {
  if (!route || !destinationName) return false;
  const originStation = getStationById(lock.boardingStationId);
  if (!originStation) return false;
  // 아직 탑승역에 머물러 있으면(=1역도 이동 전) 방향 판정 불가 — 오탐 금지.
  if (observedTrain.statnNm === originStation.name) return false;

  const expectedDirection = resolveTripDirection(route, destinationName, lock.boardingStationId);
  if (!expectedDirection) return false;

  // positions는 statnNm(역명)만 준다 — Seoul API statnId는 stations.json id와 포맷이 달라
  // 직접 비교 불가(useFusedNearestStation.ts의 동일 제약과 같은 이유). 역명으로 id를 역조회한다.
  const observedStation = findStationByNameAndLine(observedTrain.statnNm, lock.boardingLine);
  if (!observedStation) return false;

  const actualDirection = directionOnLine(lock.boardingLine, lock.boardingStationId, observedStation.id);
  if (!actualDirection) return false;

  return actualDirection !== expectedDirection;
}

export function detectMisBoarding(
  lock: BoardingLock | null,
  positions: LinePositions | null,
  route: Route = null,
  destinationName: string | null = null,
): MisBoardingObservation {
  if (!lock || !positions) return 'no-signal';
  if (positions.isMock) return 'no-signal';
  if (positions.line !== lock.boardingLine) return 'no-signal';
  if (isPendingTrainCode(lock.trainCode)) return 'no-signal';
  const found = positions.trains.find((t) => t.trainNo === lock.trainCode);
  if (!found) return 'absent';
  if (isWrongDirection(lock, found, route, destinationName)) return 'wrong-direction';
  return 'present';
}
