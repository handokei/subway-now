import type { Station, NearestStationResult } from '../../types/station';
import type { Route, DirectRoute, TransferRoute, MultiTransferRoute } from '../stationRoute';
import type { AlarmEvent } from '../stationAlarm';

const mockFindNearestStation = jest.fn();
jest.mock('../findNearestStation', () => ({
  findNearestStation: (...args: unknown[]) => mockFindNearestStation(...args),
}));

const mockFindRoute = jest.fn();
const mockCalculateStaticETA = jest.fn();
const mockUpdateRouteFromPosition = jest.fn();
jest.mock('../stationRoute', () => ({
  findRoute: (...args: unknown[]) => mockFindRoute(...args),
  calculateStaticETA: (...args: unknown[]) => mockCalculateStaticETA(...args),
  updateRouteFromPosition: (...args: unknown[]) => mockUpdateRouteFromPosition(...args),
}));

const mockEvaluateAlarmPhase = jest.fn();
const mockAlarmKey = jest.fn();
jest.mock('../stationAlarm', () => ({
  evaluateAlarmPhase: (...args: unknown[]) => mockEvaluateAlarmPhase(...args),
  alarmKey: (...args: unknown[]) => mockAlarmKey(...args),
}));

const mockSendAlarmNotification = jest.fn();
const mockUpdateStationNotification = jest.fn();
const mockSendStationPassedNotification = jest.fn();
jest.mock('../stationNotification', () => ({
  sendAlarmNotification: (...args: unknown[]) => mockSendAlarmNotification(...args),
  updateStationNotification: (...args: unknown[]) => mockUpdateStationNotification(...args),
  sendStationPassedNotification: (...args: unknown[]) => mockSendStationPassedNotification(...args),
}));

import { processLocationUpdate, resolveNextTarget } from '../stationPipeline';

const mockStation: Station = {
  id: 'station-1',
  name: '강남',
  line: '2',
  lineColor: '#009246',
  lat: 37.498,
  lng: 127.028,
};

const mockDestination: Station = {
  id: 'station-2',
  name: '시청',
  line: '1',
  lineColor: '#0052A4',
  lat: 37.565,
  lng: 126.977,
};

const mockNearestResult: NearestStationResult = {
  station: mockStation,
  distanceKm: 0.15,
};

const mockRoute: DirectRoute = { type: 'direct', stops: 3 };
const mockAlarmEvent: AlarmEvent = { phaseId: 'early', type: 'destination', stationName: '시청' };

function call(overrides: Partial<Parameters<typeof processLocationUpdate>[0]> = {}) {
  return processLocationUpdate({
    lat: 37.498,
    lng: 127.028,
    destination: mockDestination,
    firedAlarms: new Set(),
    sleepMode: false,
    ...overrides,
  });
}

describe('processLocationUpdate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendAlarmNotification.mockResolvedValue(undefined);
    mockUpdateStationNotification.mockResolvedValue(undefined);
    mockSendStationPassedNotification.mockResolvedValue(undefined);
    mockCalculateStaticETA.mockReturnValue(10);
    mockEvaluateAlarmPhase.mockReturnValue(null);
  });

  it('returns null nearest and null alarm when findNearestStation returns null', async () => {
    mockFindNearestStation.mockReturnValue(null);
    const result = await call();
    expect(result).toEqual({ alarmEvent: null, nearest: null, lastNotifiedStationId: null });
    expect(mockFindRoute).not.toHaveBeenCalled();
    expect(mockSendAlarmNotification).not.toHaveBeenCalled();
  });

  it('calls findRoute and evaluator with full source', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);

    await call({ speedMps: 10 });

    expect(mockFindRoute).toHaveBeenCalledWith('station-1', 'station-2');
    expect(mockEvaluateAlarmPhase).toHaveBeenCalledWith(
      expect.objectContaining({
        route: mockRoute,
        destinationName: '시청',
        etaSeconds: expect.any(Number),
      }),
      expect.any(Set),
    );
  });

  it('passes null etaSeconds when speedMps is not provided', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);

    await call();

    expect(mockEvaluateAlarmPhase).toHaveBeenCalledWith(
      expect.objectContaining({ etaSeconds: null }),
      expect.any(Set),
    );
  });

  it('sends alarm notification with the full event when alarm fires', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);
    mockEvaluateAlarmPhase.mockReturnValue(mockAlarmEvent);

    await call();

    expect(mockSendAlarmNotification).toHaveBeenCalledWith(mockAlarmEvent, false, true);
  });

  it('passes sleepMode and allowSpeaker to sendAlarmNotification', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);
    mockEvaluateAlarmPhase.mockReturnValue(mockAlarmEvent);

    await call({ sleepMode: true, allowSpeaker: false });

    expect(mockSendAlarmNotification).toHaveBeenCalledWith(mockAlarmEvent, true, false);
  });

  it('does not call sendAlarmNotification when no alarm', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);
    await call();
    expect(mockSendAlarmNotification).not.toHaveBeenCalled();
  });

  it('calls updateStationNotification with computed args', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);
    mockCalculateStaticETA.mockReturnValue(12);

    await call();

    expect(mockUpdateStationNotification).toHaveBeenCalledWith(
      mockStation,
      150,
      mockDestination,
      mockRoute,
      12,
      undefined,
      null,
    );
  });

  it('passes alarmEvent to updateStationNotification only when sleepMode is true', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);
    mockEvaluateAlarmPhase.mockReturnValue(mockAlarmEvent);
    mockCalculateStaticETA.mockReturnValue(10);

    await call({ sleepMode: true });

    expect(mockUpdateStationNotification).toHaveBeenCalledWith(
      mockStation, 150, mockDestination, mockRoute, 10, undefined, mockAlarmEvent,
    );
  });

  it('does not pass alarmEvent to updateStationNotification when sleepMode is false', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);
    mockEvaluateAlarmPhase.mockReturnValue(mockAlarmEvent);

    await call();

    expect(mockUpdateStationNotification).toHaveBeenCalledWith(
      mockStation, 150, mockDestination, mockRoute, 10, undefined, null,
    );
  });

  it('returns alarmEvent and nearest in result', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);
    mockEvaluateAlarmPhase.mockReturnValue(mockAlarmEvent);

    const result = await call();

    expect(result.alarmEvent).toBe(mockAlarmEvent);
    expect(result.nearest).toBe(mockNearestResult);
  });

  it('returns null alarm when evaluator returns null', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);

    const result = await call();

    expect(result.alarmEvent).toBeNull();
    expect(result.nearest).toBe(mockNearestResult);
  });

  it('rounds distanceKm to meters correctly', async () => {
    mockFindNearestStation.mockReturnValue({ station: mockStation, distanceKm: 0.4567 });
    mockFindRoute.mockReturnValue(mockRoute);
    mockCalculateStaticETA.mockReturnValue(5);

    await call();

    expect(mockUpdateStationNotification).toHaveBeenCalledWith(
      mockStation, 457, mockDestination, mockRoute, 5, undefined, null,
    );
  });

  it('falls back to findRoute when storedRoute exists but updateRouteFromPosition returns null', async () => {
    const storedRoute: DirectRoute = { type: 'direct', stops: 5 };
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockUpdateRouteFromPosition.mockReturnValue(null);
    mockFindRoute.mockReturnValue(mockRoute);

    await call({ storedRoute });

    expect(mockUpdateRouteFromPosition).toHaveBeenCalledWith(storedRoute, mockStation, 'station-2');
    expect(mockFindRoute).toHaveBeenCalledWith('station-1', 'station-2');
  });

  it('uses updateRouteFromPosition result when storedRoute is provided and succeeds', async () => {
    const storedRoute: DirectRoute = { type: 'direct', stops: 5 };
    const updatedRoute: DirectRoute = { type: 'direct', stops: 3 };
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockUpdateRouteFromPosition.mockReturnValue(updatedRoute);
    mockCalculateStaticETA.mockReturnValue(6);

    await call({ storedRoute });

    expect(mockUpdateRouteFromPosition).toHaveBeenCalledWith(storedRoute, mockStation, 'station-2');
    expect(mockFindRoute).not.toHaveBeenCalled();
    expect(mockCalculateStaticETA).toHaveBeenCalledWith(updatedRoute);
  });

  it('calls findRoute when no storedRoute is provided', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);

    await call();

    expect(mockUpdateRouteFromPosition).not.toHaveBeenCalled();
    expect(mockFindRoute).toHaveBeenCalledWith('station-1', 'station-2');
  });

  it('sends station-passed notification when station changes', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);

    const result = await call({ lastNotifiedStationId: 'other-station' });

    expect(mockSendStationPassedNotification).toHaveBeenCalledWith('강남', '시청', 3);
    expect(result.lastNotifiedStationId).toBe('station-1');
  });

  it('does not send station-passed notification when station is the same', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);

    const result = await call({ lastNotifiedStationId: 'station-1' });

    expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    expect(result.lastNotifiedStationId).toBe('station-1');
  });

  it('sends station-passed notification when lastNotifiedStationId is null', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);

    const result = await call({ lastNotifiedStationId: null });

    expect(mockSendStationPassedNotification).toHaveBeenCalledWith('강남', '시청', 3);
    expect(result.lastNotifiedStationId).toBe('station-1');
  });

  it('does not mutate firedAlarms (responsibility moved to caller)', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);
    mockEvaluateAlarmPhase.mockReturnValue(mockAlarmEvent);

    const firedAlarms = new Set<string>();
    await call({ firedAlarms });

    expect(firedAlarms.size).toBe(0);
    expect(mockAlarmKey).not.toHaveBeenCalled();
  });

  it('handles null route gracefully', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(null);
    mockCalculateStaticETA.mockReturnValue(null);

    const result = await call();

    expect(mockUpdateStationNotification).toHaveBeenCalledWith(
      mockStation, 150, mockDestination, null, null, undefined, null,
    );
    expect(result.nearest).toBe(mockNearestResult);
  });
});

describe('resolveNextTarget', () => {
  it('returns null for null route', () => {
    expect(resolveNextTarget(null, '강남')).toBeNull();
  });

  it('returns destination and stops for direct route', () => {
    const route: DirectRoute = { type: 'direct', stops: 5 };
    expect(resolveNextTarget(route, '강남')).toEqual({
      nextStationName: '강남',
      stopsToNextStation: 5,
    });
  });

  it('returns transfer station for transfer route with stopsToTransfer > 0', () => {
    const route: TransferRoute = {
      type: 'transfer', transferName: '동대문', fromLine: '1', toLine: '4',
      stopsToTransfer: 3, stopsFromTransfer: 2,
    };
    expect(resolveNextTarget(route, '강남')).toEqual({
      nextStationName: '동대문',
      stopsToNextStation: 3,
    });
  });

  it('returns destination for transfer route with stopsToTransfer = 0', () => {
    const route: TransferRoute = {
      type: 'transfer', transferName: '동대문', fromLine: '1', toLine: '4',
      stopsToTransfer: 0, stopsFromTransfer: 2,
    };
    expect(resolveNextTarget(route, '강남')).toEqual({
      nextStationName: '강남',
      stopsToNextStation: 2,
    });
  });

  it('returns first transfer for multi-transfer route with stopsToTransfer > 0', () => {
    const route: MultiTransferRoute = {
      type: 'multi-transfer',
      transfers: [
        { transferName: '잠실', fromLine: '8', toLine: '2', stopsToTransfer: 3 },
        { transferName: '시청', fromLine: '2', toLine: '1', stopsToTransfer: 5 },
      ],
      stopsAfterLastTransfer: 4,
    };
    expect(resolveNextTarget(route, '강남')).toEqual({
      nextStationName: '잠실',
      stopsToNextStation: 3,
    });
  });

  it('returns second transfer when first has stopsToTransfer = 0', () => {
    const route: MultiTransferRoute = {
      type: 'multi-transfer',
      transfers: [
        { transferName: '잠실', fromLine: '8', toLine: '2', stopsToTransfer: 0 },
        { transferName: '시청', fromLine: '2', toLine: '1', stopsToTransfer: 5 },
      ],
      stopsAfterLastTransfer: 4,
    };
    expect(resolveNextTarget(route, '강남')).toEqual({
      nextStationName: '시청',
      stopsToNextStation: 5,
    });
  });

  it('returns null for unknown route type', () => {
    const route = { type: 'unknown' } as unknown as Route;
    expect(resolveNextTarget(route, '강남')).toBeNull();
  });

  it('returns destination when all transfers have stopsToTransfer = 0', () => {
    const route: MultiTransferRoute = {
      type: 'multi-transfer',
      transfers: [
        { transferName: '잠실', fromLine: '8', toLine: '2', stopsToTransfer: 0 },
        { transferName: '시청', fromLine: '2', toLine: '1', stopsToTransfer: 0 },
      ],
      stopsAfterLastTransfer: 4,
    };
    expect(resolveNextTarget(route, '강남')).toEqual({
      nextStationName: '강남',
      stopsToNextStation: 4,
    });
  });
});
