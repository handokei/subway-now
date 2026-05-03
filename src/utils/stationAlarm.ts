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
 * 현재 경로에서 알람 대상(환승역 또는 도착역)과 남은 정거장 수를 반환한다.
 * 경로는 GPS 기반으로 매번 재계산되므로, 첫 번째 구간만이 사용자의 실제 거리를 반영한다.
 * 따라서 항상 현재 구간의 다음 웨이포인트(환승역 또는 도착역)만 반환한다.
 *
 * resolveNextTarget과의 차이: resolveNextTarget은 stopsToTransfer=0을 "환승 완료"로 간주하지만,
 * 여기서는 "사용자가 환승역에 있다"로 간주하여 환승 알람을 발생시킨다.
 */
export function resolveCurrentTarget(
  route: NonNullable<Route>,
  destinationName: string,
): CurrentTarget {
  if (route.type === 'direct') {
    return { name: destinationName, stops: route.stops, alarmType: 'destination' };
  }

  if (route.type === 'transfer') {
    if (route.transferName === destinationName) {
      return { name: destinationName, stops: route.stopsToTransfer, alarmType: 'destination' };
    }
    return { name: route.transferName, stops: route.stopsToTransfer, alarmType: 'transfer' };
  }

  // multi-transfer: 첫 번째 환승이 항상 현재 구간
  // (GPS 재계산으로 이전 환승은 경로에서 사라짐)
  const firstTransfer = route.transfers[0];
  if (firstTransfer.transferName === destinationName) {
    return { name: destinationName, stops: firstTransfer.stopsToTransfer, alarmType: 'destination' };
  }
  return { name: firstTransfer.transferName, stops: firstTransfer.stopsToTransfer, alarmType: 'transfer' };
}

export function checkAlarm(
  route: Route,
  destinationName: string,
  firedAlarms: Set<string>,
  threshold: number = DEFAULT_THRESHOLD,
): AlarmEvent | null {
  if (!route) return null;

  const target = resolveCurrentTarget(route, destinationName);
  if (target.stops > threshold) return null;

  const event: AlarmEvent = { type: target.alarmType, stationName: target.name };
  const key = alarmKey(event);
  if (firedAlarms.has(key)) return null;

  return event;
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
