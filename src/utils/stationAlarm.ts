import type { Route } from './stationRoute';
import { isSameStationName } from './stationRoute';
import { ALARM_PHASES, type AlarmContext, type AlarmPhase, type AlarmPhaseId } from './alarmPhases';

export type AlarmType = 'destination' | 'transfer';

export interface AlarmEvent {
  phaseId: AlarmPhaseId;
  type: AlarmType;
  stationName: string;
}

export function alarmKey(event: Pick<AlarmEvent, 'phaseId' | 'stationName'>): string {
  return `${event.phaseId}:${event.stationName}`;
}

export interface CurrentTarget {
  name: string;
  stops: number;
  alarmType: AlarmType;
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
    return [{ name: destinationName, stops: route.stops, alarmType: 'destination' }];
  }

  if (route.type === 'transfer') {
    if (isSameStationName(route.transferName, destinationName)) {
      return [{ name: destinationName, stops: route.stopsToTransfer, alarmType: 'destination' }];
    }
    return [
      { name: route.transferName, stops: route.stopsToTransfer, alarmType: 'transfer' },
      { name: destinationName, stops: route.stopsFromTransfer, alarmType: 'destination' },
    ];
  }

  const targets: CurrentTarget[] = route.transfers.map((t) => {
    const isDestination = isSameStationName(t.transferName, destinationName);
    return {
      name: isDestination ? destinationName : t.transferName,
      stops: t.stopsToTransfer,
      alarmType: isDestination ? 'destination' : 'transfer',
    };
  });
  // MultiTransferRoute는 최소 2개 transfer로 구성되므로 targets는 항상 비어있지 않음.
  const lastName = targets[targets.length - 1].name;
  const lastTransferIsDestination = isSameStationName(lastName, destinationName);
  if (!lastTransferIsDestination) {
    targets.push({ name: destinationName, stops: route.stopsAfterLastTransfer, alarmType: 'destination' });
  }
  return targets;
}

export interface AlarmSource {
  route: Route;
  destinationName: string;
  etaSeconds: number | null;
}

/**
 * 경로상 웨이포인트를 순회하며 phase 조건을 평가한다.
 *
 * - etaSeconds는 최종 목적지 웨이포인트에만 적용된다 (GPS 거리 산출이 도착역 기준이므로).
 *   환승역은 정거장 수 기반(early) 으로만 평가된다.
 * - 어느 phase도 발사되지 않은 fresh 웨이포인트에서 트리거가 없으면 null을 반환한다.
 *   이미 한 번이라도 발사된 웨이포인트는 통과한 것으로 간주하고 다음으로 진행한다.
 *   환승 전 도착역 알람이 먼저 울리는 것을 막는다 (#152 회귀 방지).
 */
export function evaluateAlarmPhase(
  source: AlarmSource,
  firedAlarms: Set<string>,
  phases: AlarmPhase[] = ALARM_PHASES,
): AlarmEvent | null {
  if (!source.route) return null;

  const targets = resolveAllTargets(source.route, source.destinationName);

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
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

    const anyFired = phases.some((p) => firedAlarms.has(`${p.id}:${target.name}`));
    if (!anyFired) return null;
  }

  return null;
}
