import type { Route, DirectRoute, TransferRoute, MultiTransferRoute } from './stationRoute';

export type AlarmType = 'destination' | 'transfer';

export interface AlarmEvent {
  type: AlarmType;
  stationName: string;
}

const DEFAULT_THRESHOLD = 1;

export function alarmKey(event: AlarmEvent): string {
  return `${event.type}:${event.stationName}`;
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
    const [t1, t2] = r.transfers;
    if (t1.stopsToTransfer <= threshold) {
      return { type: 'transfer', stationName: t1.transferName };
    }
    if (t2.stopsToTransfer <= threshold) {
      return { type: 'transfer', stationName: t2.transferName };
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
