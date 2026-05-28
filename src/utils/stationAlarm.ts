import type { Route } from './stationRoute';
import { isSameStationName } from './stationRoute';
import type { TravelDirection } from '../types/exitSide';
import type { LineNumber } from '../types/station';
import { ALARM_PHASES, type AlarmContext, type AlarmPhase, type AlarmPhaseId } from './alarmPhases';

export type AlarmType = 'destination' | 'transfer';

export interface AlarmEvent {
  phaseId: AlarmPhaseId;
  type: AlarmType;
  stationName: string;
  // 알람 대상역에 진입하는 진행방향(상행/하행). 좌/우 하차 방향을 결정하는 데 쓰인다.
  // 노선/탑승역/목적역 중 하나라도 불명이면 undefined — 알람 본문에서 좌/우 라인을 생략한다.
  direction?: TravelDirection;
}

export function alarmKey(event: Pick<AlarmEvent, 'phaseId' | 'stationName'>): string {
  return `${event.phaseId}:${event.stationName}`;
}

export interface CurrentTarget {
  name: string;
  stops: number;
  alarmType: AlarmType;
  // 이 웨이포인트를 향해 사용자가 타고 가는 구간의 노선(approach line).
  // 환승 1회 경로의 destination은 toLine, 환승 0회(direct)는 route.line이다.
  // currentLine 게이트(#579)에서 이 값이 사용자가 실제로 탑승 중인 노선과 일치할 때만
  // phase가 평가된다 — 환승 전 도착역 stops가 작더라도 다른 노선에서 발사되지 않는다.
  approachLine: LineNumber;
}

/**
 * 경로의 모든 웨이포인트(환승역 + 도착역)를 경로 순서대로 반환한다.
 * transfers 배열을 순회하므로 N번 환승까지 확장 가능하다.
 */
export function resolveAllTargets(
  route: NonNullable<Route>,
  destinationName: string,
): CurrentTarget[] {
  if (route.type === 'direct') {
    return [{ name: destinationName, stops: route.stops, alarmType: 'destination', approachLine: route.line }];
  }

  if (route.type === 'transfer') {
    if (isSameStationName(route.transferName, destinationName)) {
      return [{ name: destinationName, stops: route.stopsToTransfer, alarmType: 'destination', approachLine: route.fromLine }];
    }
    return [
      { name: route.transferName, stops: route.stopsToTransfer, alarmType: 'transfer', approachLine: route.fromLine },
      { name: destinationName, stops: route.stopsFromTransfer, alarmType: 'destination', approachLine: route.toLine },
    ];
  }

  const targets: CurrentTarget[] = route.transfers.map((t) => {
    const isDestination = isSameStationName(t.transferName, destinationName);
    return {
      name: isDestination ? destinationName : t.transferName,
      stops: t.stopsToTransfer,
      alarmType: isDestination ? ('destination' as const) : ('transfer' as const),
      approachLine: t.fromLine,
    };
  });
  // MultiTransferRoute는 최소 2개 transfer로 구성되므로 targets는 항상 비어있지 않음.
  const lastTransfer = route.transfers[route.transfers.length - 1];
  const lastName = targets[targets.length - 1].name;
  const lastTransferIsDestination = isSameStationName(lastName, destinationName);
  if (!lastTransferIsDestination) {
    targets.push({
      name: destinationName,
      stops: route.stopsAfterLastTransfer,
      alarmType: 'destination',
      approachLine: lastTransfer.toLine,
    });
  }
  return targets;
}

export interface AlarmSource {
  route: Route;
  destinationName: string;
  etaSeconds: number | null;
  // 사용자가 실제로 탑승 중인 노선 (nearestStation.line). #579 회귀 방지:
  // approachLine이 일치하는 웨이포인트만 phase 평가 대상이 된다.
  // GPS 미확정 등으로 노선을 알 수 없을 때만 명시적으로 null을 전달 — 모든 leg 평가가 skip된다.
  currentLine: LineNumber | null;
}

/**
 * 경로상 웨이포인트를 순회하며 phase 조건을 평가한다.
 *
 * - etaSeconds는 최종 목적지 웨이포인트에만 적용된다 (GPS 거리 산출이 도착역 기준이므로).
 *   환승역은 정거장 수 기반(early) 으로만 평가된다.
 * - currentLine(#579) approachLine이 일치하는 웨이포인트만 평가한다.
 *   환승 전인데 다음 leg의 stopsFromTransfer가 작아서 도착역 알람이 먼저 울리는 회귀(#579)와
 *   환승 전 도착역 알람이 먼저 울리는 회귀(#152)를 동시에 차단한다.
 * - currentLine이 null이거나 어느 leg와도 일치하지 않으면 알람을 발사하지 않는다 (silent skip).
 *   다음 GPS fix에서 leg가 일치하면 그때 발사된다.
 */
export function evaluateAlarmPhase(
  source: AlarmSource,
  firedAlarms: Set<string>,
  phases: AlarmPhase[] = ALARM_PHASES,
): AlarmEvent | null {
  if (!source.route) return null;
  const { currentLine } = source;
  if (currentLine == null) return null;

  const targets = resolveAllTargets(source.route, source.destinationName);

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    if (target.approachLine !== currentLine) continue;

    const isFinal = i === targets.length - 1;
    const context: AlarmContext = {
      remainingStops: target.stops,
      etaSeconds: isFinal ? source.etaSeconds : null,
    };

    for (const phase of phases) {
      const key = `${phase.id}:${target.name}`;
      if (firedAlarms.has(key)) continue;
      if (!phase.evaluate(context)) continue;
      return { phaseId: phase.id, type: target.alarmType, stationName: target.name };
    }
    // 매칭된 leg는 현재 사용자가 탑승 중인 구간 — 발사 조건 미달이면 다음 leg를 평가하지 않는다.
    // 다음 leg는 user가 그 leg의 approachLine으로 이동한 다음 tick에 평가된다.
    return null;
  }

  return null;
}
