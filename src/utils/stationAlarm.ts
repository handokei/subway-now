import type { Route, DirectRoute, TransferRoute, MultiTransferRoute } from './stationRoute';

export type AlarmType = 'destination' | 'transfer';

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

type AlarmChecker = (
  route: NonNullable<Route>,
  destinationName: string,
  threshold: number,
) => AlarmEvent | null;

const checkers: Record<string, AlarmChecker> = {
  direct(route, destinationName, threshold) {
    const r = route as DirectRoute;
    if (r.stops <= threshold) {
      return { type: 'destination', stationName: destinationName };
    }
    return null;
  },

  transfer(route, destinationName, threshold) {
    const r = route as TransferRoute;
    if (r.transferName === destinationName) {
      if (r.stopsToTransfer <= threshold) {
        return { type: 'destination', stationName: destinationName };
      }
      return null;
    }
    if (r.stopsToTransfer <= threshold) {
      return { type: 'transfer', stationName: r.transferName };
    }
    if (r.stopsFromTransfer <= threshold) {
      return { type: 'destination', stationName: destinationName };
    }
    return null;
  },

  'multi-transfer'(route, destinationName, threshold) {
    const r = route as MultiTransferRoute;
    for (const t of r.transfers) {
      if (t.transferName === destinationName) {
        if (t.stopsToTransfer <= threshold) {
          return { type: 'destination', stationName: destinationName };
        }
        return null;
      }
      if (t.stopsToTransfer <= threshold) {
        return { type: 'transfer', stationName: t.transferName };
      }
    }
    if (r.stopsAfterLastTransfer <= threshold) {
      return { type: 'destination', stationName: destinationName };
    }
    return null;
  },
};

export function checkAlarm(
  route: Route,
  destinationName: string,
  firedAlarms: Set<string>,
  threshold: number = DEFAULT_THRESHOLD,
): AlarmEvent | null {
  if (!route) return null;

  const checker = checkers[route.type];
  const event = checker(route, destinationName, threshold);

  if (!event) return null;

  const key = alarmKey(event);
  if (firedAlarms.has(key)) return null;

  return event;
}

type TimeBasedAlarmChecker = (
  route: NonNullable<Route>,
  destinationName: string,
  thresholdSeconds: number,
) => AlarmEvent | null;

const timeBasedCheckers: Record<string, TimeBasedAlarmChecker> = {
  direct(route, destinationName, thresholdSeconds) {
    const r = route as DirectRoute;
    if (estimateRemainingSeconds(r.stops) <= thresholdSeconds) {
      return { type: 'destination', stationName: destinationName, timeBased: true };
    }
    return null;
  },

  transfer(route, destinationName, thresholdSeconds) {
    const r = route as TransferRoute;
    if (r.transferName === destinationName) {
      if (estimateRemainingSeconds(r.stopsToTransfer) <= thresholdSeconds) {
        return { type: 'destination', stationName: destinationName, timeBased: true };
      }
      return null;
    }
    if (estimateRemainingSeconds(r.stopsToTransfer) <= thresholdSeconds) {
      return { type: 'transfer', stationName: r.transferName, timeBased: true };
    }
    if (estimateRemainingSeconds(r.stopsFromTransfer) <= thresholdSeconds) {
      return { type: 'destination', stationName: destinationName, timeBased: true };
    }
    return null;
  },

  'multi-transfer'(route, destinationName, thresholdSeconds) {
    const r = route as MultiTransferRoute;
    for (const t of r.transfers) {
      if (t.transferName === destinationName) {
        if (estimateRemainingSeconds(t.stopsToTransfer) <= thresholdSeconds) {
          return { type: 'destination', stationName: destinationName, timeBased: true };
        }
        return null;
      }
      if (estimateRemainingSeconds(t.stopsToTransfer) <= thresholdSeconds) {
        return { type: 'transfer', stationName: t.transferName, timeBased: true };
      }
    }
    if (estimateRemainingSeconds(r.stopsAfterLastTransfer) <= thresholdSeconds) {
      return { type: 'destination', stationName: destinationName, timeBased: true };
    }
    return null;
  },
};

export function checkTimeBasedAlarm(
  route: Route,
  destinationName: string,
  firedAlarms: Set<string>,
  thresholdSeconds: number = TIME_BASED_THRESHOLD_SECONDS,
): AlarmEvent | null {
  if (!route) return null;

  const checker = timeBasedCheckers[route.type];
  const event = checker(route, destinationName, thresholdSeconds);

  if (!event) return null;

  const key = alarmKey(event);
  if (firedAlarms.has(key)) return null;

  return event;
}
