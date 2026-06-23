import type { BoardingLock } from '../../../shared/types/boardingLock';
import { BOARDING_LOCK_EXPIRY_FACTOR } from '../../../shared/types/boardingLock';
import type { Route } from '../../../shared/utils/stationRoute';
import { getStationsOnLine, findStationByNameAndLine } from '../../../shared/utils/stationRoute';
import { shortestLinePathIndices } from '../../../shared/utils/lineLoopPath';
import { lineToSubwayId } from '../../../shared/constants/lineApiNames';
import type { Station } from '../../../shared/types/station';
import type { LineNumber } from '../../../shared/types/station';
import type { AlarmBoardingLock } from '../api/alarmBackend';
import { isScheduleFallbackTrainCode } from './scheduleFallback';
import { createLogger } from '../../../shared/utils/logger';

const logger = createLogger('buildBoardingLockMeta');

/**
 * 현재 BoardingLock leg의 끝 역(다음 환승역 또는 최종 도착역) 이름을 결정한다.
 * - direct: 도착역
 * - transfer: boardingLine == fromLine이면 transferName, toLine이면 도착역
 * - multi-transfer: transfers 배열에서 boardingLine==fromLine인 segment의 transferName.
 *   마지막 segment의 toLine이면 도착역.
 * 매칭 실패 시 null (lock 노선이 route segment 어느 것에도 일치 안 함 — 비정상).
 */
export function findSegmentEndStationName(
  route: NonNullable<Route>,
  boardingLine: LineNumber,
  destinationName: string,
): string | null {
  if (route.type === 'direct') return destinationName;
  if (route.type === 'transfer') {
    if (boardingLine === route.fromLine) return route.transferName;
    if (boardingLine === route.toLine) return destinationName;
    return null;
  }
  // multi-transfer
  for (const t of route.transfers) {
    if (t.fromLine === boardingLine) return t.transferName;
  }
  const last = route.transfers[route.transfers.length - 1];
  if (last && last.toLine === boardingLine) return destinationName;
  return null;
}

/**
 * 현재 leg의 정차역 시퀀스(출발역 → 구간 끝, 양끝 포함)를 line 순서대로 추출한다.
 * backend가 `lock.segmentStations.indexOf(stationName)`로 위치/목표 인덱스를 계산하므로
 * 사용자가 통과하는 모든 역이 포함되어야 한다.
 */
function buildSegmentStations(
  route: NonNullable<Route>,
  boardingStationName: string,
  boardingLine: LineNumber,
  destinationName: string,
): string[] | null {
  const endName = findSegmentEndStationName(route, boardingLine, destinationName);
  if (!endName) return null;

  const boardingStation = findStationByNameAndLine(boardingStationName, boardingLine);
  const endStation = findStationByNameAndLine(endName, boardingLine);
  if (!boardingStation || !endStation) return null;

  const lineStations: Station[] = getStationsOnLine(boardingLine);
  const startIdx = lineStations.findIndex((s) => s.id === boardingStation.id);
  const endIdx = lineStations.findIndex((s) => s.id === endStation.id);
  /* istanbul ignore next -- findStationByNameAndLine이 찾은 station은 같은 line의 lineStations에
     반드시 포함된다는 invariant. 방어 가드만 남기고 unreachable. */
  if (startIdx === -1 || endIdx === -1) return null;

  if (startIdx === endIdx) return [lineStations[startIdx].name];
  // backend `estimateArrivalFromPosition`은 `segmentStations.indexOf(currentStation) >= indexOf(target)`
  // 이면 "이미 도착"으로 판정 — boarding이 [0], destination이 [length-1] 순서여야 한다.
  // #1722 (#622 후속): 2호선 본선 closed loop은 shortestLinePathIndices가 짧은 쪽 path를
  // 진행 방향대로 정렬해 반환 — 직선 slice는 wraparound 시 잘못된 구간을 생성한다.
  const path = shortestLinePathIndices(lineStations, startIdx, endIdx, boardingLine);
  return path.map((i) => lineStations[i].name);
}

/**
 * client BoardingLock → backend AlarmBoardingLock 변환 (#622).
 * 한 필드라도 추론 실패 시 null — backend로 보낼 만큼 정합한 schema가 안 만들어졌다는 뜻.
 * 호출자는 null을 받으면 payload.boardingLock 자체를 생략하면 된다(backend는 기존 anchor 폴링).
 *
 * destination station은 caller가 별도 제공 — boardingStation은 lock에 id만 있어 lookup이 필요한
 * 반면 destination은 이미 Station 객체로 들어와 있어 lookup 비용 절약.
 */
export function buildBoardingLockMeta({
  lock,
  route,
  destinationName,
  boardingStationName,
}: {
  lock: BoardingLock;
  route: NonNullable<Route>;
  destinationName: string;
  boardingStationName: string;
}): AlarmBoardingLock | null {
  // #865 — 시간표 fallback이 만든 가상 trainCode(SCHED-*)는 backend 실시간 API에서
  // 절대 찾을 수 없어 `consecutiveEtaMissing exceeded`로 4분 만에 trip auto-end된다.
  // 등록 자체를 보류해 backend가 anchor waypoint 폴링으로 fallback하게 한다 — 실시간
  // trainCode가 잡히면 다음 effect cycle에서 정상 등록된다. (UI 측 필터는 #648.)
  if (isScheduleFallbackTrainCode(lock.trainCode)) {
    logger.warn(
      `skip backend register — schedule fallback trainCode=${lock.trainCode} (line=${lock.boardingLine})`,
    );
    return null;
  }

  const subwayId = lineToSubwayId(lock.boardingLine);
  if (!subwayId) return null;

  const segmentStations = buildSegmentStations(
    route,
    boardingStationName,
    lock.boardingLine,
    destinationName,
  );
  if (!segmentStations || segmentStations.length === 0) return null;

  const expiresAt = lock.boardedAt + lock.expectedDurationMs * BOARDING_LOCK_EXPIRY_FACTOR;

  return {
    trainCode: lock.trainCode,
    line: lock.boardingLine,
    subwayId,
    selectedDepartureTime: lock.boardedAt,
    segmentStations,
    expiresAt,
  };
}
