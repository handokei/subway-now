/**
 * 탑승 이벤트 primitive (ADR-032 #B).
 *
 * route = (역S, 노선L, 방향→목적지) 탑승 이벤트의 시퀀스라는 설계를 순수 함수로 구현한다.
 * 처음 탑승 + 환승마다 하나씩 이벤트를 만든다. 순수 함수 — side effect/store 접근 없음.
 * 소비자(device emitter 루프, #C~#E)는 이 파일이 아니라 별도 이슈에서 배선한다.
 */

import type { LineNumber, Station } from '../../../shared/types/station';
import type { Route } from '../../../shared/utils/stationRoute';
import { findStationByNameAndLine, getNextStationOnLine } from '../../../shared/utils/stationRoute';

export interface BoardingEvent {
  /** 0부터 시작하는 순서. */
  index: number;
  kind: 'initial' | 'transfer';
  /** 타는 역. */
  boardingStationId: string;
  boardingStationName: string;
  /** 타는 노선. */
  line: LineNumber;
  /** 이 leg에서 목적지 방향 "다음 역"(arvlCd 방향필터용). */
  directionStationId: string;
  directionStationName: string;
}

// leg = 한 번의 탑승(초행 or 환승 직후)부터 다음 waypoint(다음 환승역 또는 최종 목적지)까지의 구간.
interface Leg {
  kind: BoardingEvent['kind'];
  boardingStationId: string;
  boardingStationName: string;
  line: LineNumber;
  /** 이 leg의 종점(다음 환승역 이름 또는 최종 목적지 이름). */
  targetName: string;
}

function legToEvent(leg: Leg, index: number): BoardingEvent {
  const { kind, boardingStationId, boardingStationName, line, targetName } = leg;
  // 같은 역(0정거장 leg, 예: 환승역=목적지)이면 다음 역이 없으므로 targetName 자체를 방향으로 사용.
  const directionStationName = getNextStationOnLine(line, boardingStationName, targetName) ?? targetName;
  const directionStation = findStationByNameAndLine(directionStationName, line);
  return {
    index,
    kind,
    boardingStationId,
    boardingStationName,
    line,
    directionStationId: directionStation?.id ?? boardingStationId,
    directionStationName,
  };
}

function transferLeg(transferName: string, boardingLine: LineNumber, targetName: string): Leg {
  const boardingStation = findStationByNameAndLine(transferName, boardingLine);
  return {
    kind: 'transfer',
    boardingStationId: boardingStation?.id ?? '',
    boardingStationName: transferName,
    line: boardingLine,
    targetName,
  };
}

/**
 * route를 탑승 이벤트 시퀀스로 분해한다.
 *
 * - direct → initial 1개(출발역, route.line, 목적지 방향)
 * - transfer → initial(출발역, fromLine) + transfer(환승역, toLine)
 * - multi-transfer → initial + transfers[] 순회로 transfer 이벤트 N개(환승 횟수 하드코딩 없음)
 */
export function computeBoardingEvents(
  route: NonNullable<Route>,
  originStation: Station,
  destinationName: string,
): BoardingEvent[] {
  const initialLeg: Leg = {
    kind: 'initial',
    boardingStationId: originStation.id,
    boardingStationName: originStation.name,
    line: route.type === 'direct' ? route.line : route.type === 'transfer' ? route.fromLine : route.transfers[0].fromLine,
    targetName:
      route.type === 'direct'
        ? destinationName
        : route.type === 'transfer'
          ? route.transferName
          : route.transfers[0].transferName,
  };

  if (route.type === 'direct') {
    return [legToEvent(initialLeg, 0)];
  }

  if (route.type === 'transfer') {
    const legs: Leg[] = [initialLeg, transferLeg(route.transferName, route.toLine, destinationName)];
    return legs.map(legToEvent);
  }

  // multi-transfer: transfers 배열을 순회해 환승 이벤트를 만든다.
  const { transfers } = route;
  const transferLegs = transfers.map((segment, i) => {
    const nextTargetName = i + 1 < transfers.length ? transfers[i + 1].transferName : destinationName;
    return transferLeg(segment.transferName, segment.toLine, nextTargetName);
  });

  return [initialLeg, ...transferLegs].map(legToEvent);
}
