import type { Route } from './stationRoute';

export type AlarmType = 'destination' | 'transfer' | 'approaching';

export interface AlarmEvent {
  type: AlarmType;
  stationName: string;
  timeBased?: boolean;
}

const DEFAULT_THRESHOLD = 1;
const SECONDS_PER_STOP = 120;
const TIME_BASED_THRESHOLD_SECONDS = 30;

export function alarmKey(event: AlarmEvent): string {
  const prefix = event.timeBased ? 'time-' : '';
  return `${prefix}${event.type}:${event.stationName}`;
}

export function estimateRemainingSeconds(stops: number): number {
  return stops * SECONDS_PER_STOP;
}

export interface CurrentTarget {
  name: string;
  stops: number;
  alarmType: 'transfer' | 'destination';
}

/**
 * 경로의 모든 웨이포인트(환승역 + 도착역)를 경로 순서대로 반환한다.
 * checkAlarm이 이 목록을 순회하며, 이미 발생한 알람은 건너뛰고 다음 타겟을 평가한다.
 * 환승 횟수에 의존하지 않고 transfers 배열을 순회하므로 N번 환승까지 확장 가능하다.
 */
export function resolveAllTargets(
  route: NonNullable<Route>,
  destinationName: string,
): CurrentTarget[] {
  if (route.type === 'direct') {
    return [{ name: destinationName, stops: route.stops, alarmType: 'destination' }];
  }

  if (route.type === 'transfer') {
    if (route.transferName === destinationName) {
      return [{ name: destinationName, stops: route.stopsToTransfer, alarmType: 'destination' }];
    }
    return [
      { name: route.transferName, stops: route.stopsToTransfer, alarmType: 'transfer' },
      { name: destinationName, stops: route.stopsFromTransfer, alarmType: 'destination' },
    ];
  }

  // multi-transfer: 모든 웨이포인트를 순서대로 반환
  const targets: CurrentTarget[] = route.transfers.map((t) => {
    const alarmType = t.transferName === destinationName ? 'destination' as const : 'transfer' as const;
    return { name: t.transferName === destinationName ? destinationName : t.transferName, stops: t.stopsToTransfer, alarmType };
  });
  targets.push({ name: destinationName, stops: route.stopsAfterLastTransfer, alarmType: 'destination' });
  return targets;
}


export function checkAlarm(
  route: Route,
  destinationName: string,
  firedAlarms: Set<string>,
  threshold: number = DEFAULT_THRESHOLD,
): AlarmEvent | null {
  if (!route) return null;

  const targets = resolveAllTargets(route, destinationName);
  for (const target of targets) {
    const event: AlarmEvent = { type: target.alarmType, stationName: target.name };
    const key = alarmKey(event);
    if (firedAlarms.has(key)) continue;
    if (target.stops > threshold) return null;
    return event;
  }
  return null;
}

function resolveStationType(
  nextStationName: string,
  destinationName: string,
  route: NonNullable<Route>,
): AlarmType {
  if (nextStationName === destinationName) return 'destination';

  if (route.type === 'transfer') {
    if (nextStationName === route.transferName) return 'transfer';
  }

  if (route.type === 'multi-transfer') {
    for (const t of route.transfers) {
      if (nextStationName === t.transferName) return 'transfer';
    }
  }

  return 'approaching';
}

export function checkTimeBasedAlarm(
  nextStationName: string | null,
  stopsToNextStation: number,
  destinationName: string,
  route: Route,
  firedAlarms: Set<string>,
  thresholdSeconds: number = TIME_BASED_THRESHOLD_SECONDS,
): AlarmEvent | null {
  if (!nextStationName || !route) return null;

  if (estimateRemainingSeconds(stopsToNextStation) > thresholdSeconds) return null;

  const type = resolveStationType(nextStationName, destinationName, route);
  const event: AlarmEvent = { type, stationName: nextStationName, timeBased: true };

  const key = alarmKey(event);
  if (firedAlarms.has(key)) return null;

  return event;
}
