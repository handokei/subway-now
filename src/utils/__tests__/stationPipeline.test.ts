import type { Station, NearestStationResult } from '../../types/station';
import type { Route, DirectRoute, TransferRoute, MultiTransferRoute } from '../stationRoute';
import type { AlarmEvent } from '../stationAlarm';

// ── 모든 외부 의존성 모킹 ──

const mockFindNearestStation = jest.fn();
jest.mock('../findNearestStation', () => ({
  findNearestStation: (...args: unknown[]) => mockFindNearestStation(...args),
}));

const mockFindRoute = jest.fn();
const mockCalculateStaticETA = jest.fn();
jest.mock('../stationRoute', () => ({
  findRoute: (...args: unknown[]) => mockFindRoute(...args),
  calculateStaticETA: (...args: unknown[]) => mockCalculateStaticETA(...args),
}));

const mockCheckAlarm = jest.fn();
const mockCheckTimeBasedAlarm = jest.fn();
const mockAlarmKey = jest.fn();
jest.mock('../stationAlarm', () => ({
  checkAlarm: (...args: unknown[]) => mockCheckAlarm(...args),
  checkTimeBasedAlarm: (...args: unknown[]) => mockCheckTimeBasedAlarm(...args),
  alarmKey: (...args: unknown[]) => mockAlarmKey(...args),
}));

const mockSendAlarmNotification = jest.fn();
const mockUpdateStationNotification = jest.fn();
jest.mock('../stationNotification', () => ({
  sendAlarmNotification: (...args: unknown[]) => mockSendAlarmNotification(...args),
  updateStationNotification: (...args: unknown[]) => mockUpdateStationNotification(...args),
}));

import { evaluateAlarm, processLocationUpdate, resolveNextTarget } from '../stationPipeline';

// ── 테스트 픽스처 ──

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

const mockAlarmEvent: AlarmEvent = { type: 'destination', stationName: '시청' };

describe('evaluateAlarm', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should call findRoute with nearestStationId and destinationId', () => {
    mockFindRoute.mockReturnValue(mockRoute);
    mockCheckAlarm.mockReturnValue(null);

    evaluateAlarm({
      nearestStationId: 'station-1',
      destinationId: 'station-2',
      destinationName: '시청',
      firedAlarms: new Set(),
    });

    expect(mockFindRoute).toHaveBeenCalledWith('station-1', 'station-2');
  });

  it('should call checkAlarm with route, destinationName and firedAlarms', () => {
    mockFindRoute.mockReturnValue(mockRoute);
    mockCheckAlarm.mockReturnValue(null);
    const firedAlarms = new Set(['destination:강남']);

    evaluateAlarm({
      nearestStationId: 'station-1',
      destinationId: 'station-2',
      destinationName: '시청',
      firedAlarms,
    });

    expect(mockCheckAlarm).toHaveBeenCalledWith(mockRoute, '시청', firedAlarms);
  });

  it('should return route and alarmEvent from checkAlarm', () => {
    mockFindRoute.mockReturnValue(mockRoute);
    mockCheckAlarm.mockReturnValue(mockAlarmEvent);

    const result = evaluateAlarm({
      nearestStationId: 'station-1',
      destinationId: 'station-2',
      destinationName: '시청',
      firedAlarms: new Set(),
    });

    expect(result).toEqual({ route: mockRoute, alarmEvent: mockAlarmEvent });
  });

  it('should return null alarmEvent when checkAlarm returns null', () => {
    mockFindRoute.mockReturnValue(mockRoute);
    mockCheckAlarm.mockReturnValue(null);

    const result = evaluateAlarm({
      nearestStationId: 'station-1',
      destinationId: 'station-2',
      destinationName: '시청',
      firedAlarms: new Set(),
    });

    expect(result.alarmEvent).toBeNull();
    expect(result.route).toBe(mockRoute);
  });

  it('should handle null route from findRoute', () => {
    mockFindRoute.mockReturnValue(null);
    mockCheckAlarm.mockReturnValue(null);

    const result = evaluateAlarm({
      nearestStationId: 'unknown',
      destinationId: 'unknown2',
      destinationName: '없음',
      firedAlarms: new Set(),
    });

    expect(result).toEqual({ route: null, alarmEvent: null });
  });
});

describe('processLocationUpdate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendAlarmNotification.mockResolvedValue(undefined);
    mockUpdateStationNotification.mockResolvedValue(undefined);
    mockCalculateStaticETA.mockReturnValue(10);
    mockCheckTimeBasedAlarm.mockReturnValue(null);
  });

  it('should return null nearest and null alarmEvent when findNearestStation returns null', async () => {
    mockFindNearestStation.mockReturnValue(null);

    const result = await processLocationUpdate(
      37.5, 127.0, mockDestination, new Set(), false,
    );

    expect(result).toEqual({ alarmEvent: null, nearest: null });
    expect(mockFindRoute).not.toHaveBeenCalled();
    expect(mockSendAlarmNotification).not.toHaveBeenCalled();
    expect(mockUpdateStationNotification).not.toHaveBeenCalled();
  });

  it('should call evaluateAlarm with correct arguments when nearest is found', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);
    mockCheckAlarm.mockReturnValue(null);

    await processLocationUpdate(
      37.498, 127.028, mockDestination, new Set(), false,
    );

    expect(mockFindRoute).toHaveBeenCalledWith('station-1', 'station-2');
    expect(mockCheckAlarm).toHaveBeenCalledWith(mockRoute, '시청', expect.any(Set));
  });

  it('should send alarm notification when alarmEvent is not null (without mutating firedAlarms)', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);
    mockCheckAlarm.mockReturnValue(mockAlarmEvent);

    const firedAlarms = new Set<string>();

    await processLocationUpdate(37.498, 127.028, mockDestination, firedAlarms, false);

    expect(mockSendAlarmNotification).toHaveBeenCalledWith('destination', '시청', false, false);
    expect(firedAlarms.size).toBe(0);
  });

  it('should pass sleepMode to sendAlarmNotification', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);
    mockCheckAlarm.mockReturnValue(mockAlarmEvent);
    mockAlarmKey.mockReturnValue('destination:시청');

    await processLocationUpdate(37.498, 127.028, mockDestination, new Set(), true);

    expect(mockSendAlarmNotification).toHaveBeenCalledWith('destination', '시청', true, false);
  });

  it('should not call sendAlarmNotification when alarmEvent is null', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);
    mockCheckAlarm.mockReturnValue(null);

    await processLocationUpdate(37.498, 127.028, mockDestination, new Set(), false);

    expect(mockSendAlarmNotification).not.toHaveBeenCalled();
  });

  it('should call updateStationNotification with correct arguments', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);
    mockCheckAlarm.mockReturnValue(null);
    mockCalculateStaticETA.mockReturnValue(12);

    await processLocationUpdate(37.498, 127.028, mockDestination, new Set(), false);

    // distanceKm 0.15 → Math.round(0.15 * 1000) = 150
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

  it('should pass alarmEvent to updateStationNotification only when sleepMode is true', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);
    mockCheckAlarm.mockReturnValue(mockAlarmEvent);
    mockCalculateStaticETA.mockReturnValue(10);

    await processLocationUpdate(37.498, 127.028, mockDestination, new Set(), true);

    expect(mockUpdateStationNotification).toHaveBeenCalledWith(
      mockStation, 150, mockDestination, mockRoute, 10,
      undefined, mockAlarmEvent,
    );
  });

  it('should not pass alarmEvent to updateStationNotification when sleepMode is false', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);
    mockCheckAlarm.mockReturnValue(mockAlarmEvent);
    mockCalculateStaticETA.mockReturnValue(10);

    await processLocationUpdate(37.498, 127.028, mockDestination, new Set(), false);

    expect(mockUpdateStationNotification).toHaveBeenCalledWith(
      mockStation, 150, mockDestination, mockRoute, 10,
      undefined, null,
    );
  });

  it('should call calculateStaticETA with route', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);
    mockCheckAlarm.mockReturnValue(null);

    await processLocationUpdate(37.498, 127.028, mockDestination, new Set(), false);

    expect(mockCalculateStaticETA).toHaveBeenCalledWith(mockRoute);
  });

  it('should return alarmEvent and nearest in result', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);
    mockCheckAlarm.mockReturnValue(mockAlarmEvent);
    mockAlarmKey.mockReturnValue('destination:시청');

    const result = await processLocationUpdate(
      37.498, 127.028, mockDestination, new Set(), false,
    );

    expect(result.alarmEvent).toBe(mockAlarmEvent);
    expect(result.nearest).toBe(mockNearestResult);
  });

  it('should return null alarmEvent and nearest result when no alarm', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);
    mockCheckAlarm.mockReturnValue(null);

    const result = await processLocationUpdate(
      37.498, 127.028, mockDestination, new Set(), false,
    );

    expect(result.alarmEvent).toBeNull();
    expect(result.nearest).toBe(mockNearestResult);
  });

  it('should round distanceKm to meters correctly', async () => {
    const nearestWithFraction: NearestStationResult = {
      station: mockStation,
      distanceKm: 0.4567,
    };
    mockFindNearestStation.mockReturnValue(nearestWithFraction);
    mockFindRoute.mockReturnValue(mockRoute);
    mockCheckAlarm.mockReturnValue(null);
    mockCalculateStaticETA.mockReturnValue(5);

    await processLocationUpdate(37.498, 127.028, mockDestination, new Set(), false);

    // Math.round(0.4567 * 1000) = 457
    expect(mockUpdateStationNotification).toHaveBeenCalledWith(
      mockStation, 457, mockDestination, mockRoute, 5,
      undefined, null,
    );
  });

  it('should not call alarmKey in processLocationUpdate (responsibility moved to caller)', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);
    mockCheckAlarm.mockReturnValue(mockAlarmEvent);

    await processLocationUpdate(37.498, 127.028, mockDestination, new Set(), false);

    expect(mockAlarmKey).not.toHaveBeenCalled();
  });

  it('should use null route correctly when findRoute returns null', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(null);
    mockCheckAlarm.mockReturnValue(null);
    mockCalculateStaticETA.mockReturnValue(null);

    const result = await processLocationUpdate(
      37.498, 127.028, mockDestination, new Set(), false,
    );

    expect(mockUpdateStationNotification).toHaveBeenCalledWith(
      mockStation, 150, mockDestination, null, null,
      undefined, null,
    );
    expect(result.nearest).toBe(mockNearestResult);
  });

  it('should check time-based alarm when stop-count alarm is null', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);
    mockCheckAlarm.mockReturnValue(null);
    const timeEvent: AlarmEvent = { type: 'destination', stationName: '시청', timeBased: true };
    mockCheckTimeBasedAlarm.mockReturnValue(timeEvent);

    const result = await processLocationUpdate(
      37.498, 127.028, mockDestination, new Set(), false,
    );

    expect(mockCheckTimeBasedAlarm).toHaveBeenCalledWith(
      '시청', 3, '시청', mockRoute, expect.any(Set),
    );
    expect(mockSendAlarmNotification).toHaveBeenCalledWith('destination', '시청', false, true);
    expect(result.alarmEvent).toBe(timeEvent);
  });

  it('should skip time-based alarm when stop-count alarm already exists', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);
    mockCheckAlarm.mockReturnValue(mockAlarmEvent);

    await processLocationUpdate(37.498, 127.028, mockDestination, new Set(), false);

    expect(mockCheckTimeBasedAlarm).not.toHaveBeenCalled();
  });

  it('should pass timeBased flag to sendAlarmNotification for time-based alarm with sleepMode', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(mockRoute);
    mockCheckAlarm.mockReturnValue(null);
    const timeEvent: AlarmEvent = { type: 'transfer', stationName: '동대문', timeBased: true };
    mockCheckTimeBasedAlarm.mockReturnValue(timeEvent);

    await processLocationUpdate(37.498, 127.028, mockDestination, new Set(), true);

    expect(mockSendAlarmNotification).toHaveBeenCalledWith('transfer', '동대문', true, true);
    expect(mockUpdateStationNotification).toHaveBeenCalledWith(
      mockStation, 150, mockDestination, mockRoute, 10, undefined, timeEvent,
    );
  });

  it('should not check time-based alarm when route is null', async () => {
    mockFindNearestStation.mockReturnValue(mockNearestResult);
    mockFindRoute.mockReturnValue(null);
    mockCheckAlarm.mockReturnValue(null);
    mockCalculateStaticETA.mockReturnValue(null);

    await processLocationUpdate(37.498, 127.028, mockDestination, new Set(), false);

    expect(mockCheckTimeBasedAlarm).not.toHaveBeenCalled();
  });
});

describe('resolveNextTarget', () => {
  it('should return null for null route', () => {
    expect(resolveNextTarget(null, '강남')).toBeNull();
  });

  it('should return destination and stops for direct route', () => {
    const route: DirectRoute = { type: 'direct', stops: 5 };
    expect(resolveNextTarget(route, '강남')).toEqual({
      nextStationName: '강남',
      stopsToNextStation: 5,
    });
  });

  it('should return transfer station for transfer route with stopsToTransfer > 0', () => {
    const route: TransferRoute = {
      type: 'transfer', transferName: '동대문', fromLine: '1', toLine: '4',
      stopsToTransfer: 3, stopsFromTransfer: 2,
    };
    expect(resolveNextTarget(route, '강남')).toEqual({
      nextStationName: '동대문',
      stopsToNextStation: 3,
    });
  });

  it('should return destination for transfer route with stopsToTransfer = 0', () => {
    const route: TransferRoute = {
      type: 'transfer', transferName: '동대문', fromLine: '1', toLine: '4',
      stopsToTransfer: 0, stopsFromTransfer: 2,
    };
    expect(resolveNextTarget(route, '강남')).toEqual({
      nextStationName: '강남',
      stopsToNextStation: 2,
    });
  });

  it('should return first transfer for multi-transfer route with stopsToTransfer > 0', () => {
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

  it('should return second transfer when first has stopsToTransfer = 0', () => {
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

  it('should return null for unknown route type', () => {
    const route = { type: 'unknown' } as unknown as Route;
    expect(resolveNextTarget(route, '강남')).toBeNull();
  });

  it('should return destination when all transfers have stopsToTransfer = 0', () => {
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
