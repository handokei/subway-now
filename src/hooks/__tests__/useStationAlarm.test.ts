import { renderHook } from '@testing-library/react-native';
import { useStationAlarm, type UseStationAlarmInputs } from '../useStationAlarm';
import { useAppStore } from '../../store/useAppStore';
import type { DirectRoute, TransferRoute, MultiTransferRoute } from '../../utils/stationRoute';
import type { Station } from '../../types/station';
import type { AlarmEvent } from '../../utils/stationAlarm';

const mockSendAlarmNotification = jest.fn().mockResolvedValue(undefined);
const mockSendStationPassedNotification = jest.fn().mockResolvedValue(undefined);

jest.mock('../../utils/stationNotification', () => ({
  sendAlarmNotification: (...args: unknown[]) => mockSendAlarmNotification(...args),
  sendStationPassedNotification: (...args: unknown[]) => mockSendStationPassedNotification(...args),
}));

const mockEvaluateAlarmPhase = jest.fn();
jest.mock('../../utils/stationAlarm', () => {
  const actual = jest.requireActual('../../utils/stationAlarm');
  return {
    ...actual,
    evaluateAlarmPhase: (...args: unknown[]) => mockEvaluateAlarmPhase(...args),
  };
});

const mockResolveNextTarget = jest.fn();
jest.mock('../../utils/stationPipeline', () => ({
  resolveNextTarget: (...args: unknown[]) => mockResolveNextTarget(...args),
}));

jest.mock('../../utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const makeStation = (id: string, name: string, lat = 37.5, lng = 127.0): Station => ({
  id,
  name,
  line: '2',
  lineColor: '#33A23D',
  lat,
  lng,
});

const destination = makeStation('D1', '강남', 37.498, 127.028);
const altDestination = makeStation('D2', '잠실', 37.513, 127.100);

const earlyDest: AlarmEvent = { phaseId: 'early', type: 'destination', stationName: '강남' };
const earlyTransfer: AlarmEvent = { phaseId: 'early', type: 'transfer', stationName: '시청' };
const imminentDest: AlarmEvent = { phaseId: 'imminent', type: 'destination', stationName: '강남' };

function defaultInputs(overrides: Partial<UseStationAlarmInputs> = {}): UseStationAlarmInputs {
  return {
    route: null,
    destination: null,
    nearestStation: null,
    userLocation: null,
    speedMps: null,
    ...overrides,
  };
}

describe('useStationAlarm', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAppStore.setState({ sleepMode: false, allowSpeaker: true, alarmEvent: null });
    mockEvaluateAlarmPhase.mockReturnValue(null);
    mockResolveNextTarget.mockReturnValue(null);
  });

  it('does not evaluate when route is null', () => {
    renderHook(() => useStationAlarm(defaultInputs({ destination })));
    expect(mockEvaluateAlarmPhase).not.toHaveBeenCalled();
  });

  it('does not evaluate when destination is null', () => {
    const route: DirectRoute = { type: 'direct', stops: 1 };
    renderHook(() => useStationAlarm(defaultInputs({ route })));
    expect(mockEvaluateAlarmPhase).not.toHaveBeenCalled();
  });

  it('builds AlarmSource and calls evaluator', () => {
    const route: DirectRoute = { type: 'direct', stops: 3 };
    renderHook(() =>
      useStationAlarm(
        defaultInputs({
          route,
          destination,
          userLocation: { lat: 37.4, lng: 127.0 },
          speedMps: 10,
        }),
      ),
    );
    expect(mockEvaluateAlarmPhase).toHaveBeenCalledWith(
      expect.objectContaining({
        route,
        destinationName: '강남',
        etaSeconds: expect.any(Number),
      }),
      expect.any(Set),
    );
  });

  it('passes null etaSeconds when speed is null', () => {
    const route: DirectRoute = { type: 'direct', stops: 3 };
    renderHook(() =>
      useStationAlarm(
        defaultInputs({ route, destination, userLocation: { lat: 37.4, lng: 127.0 }, speedMps: null }),
      ),
    );
    expect(mockEvaluateAlarmPhase).toHaveBeenCalledWith(
      expect.objectContaining({ etaSeconds: null }),
      expect.any(Set),
    );
  });

  it('passes null etaSeconds when userLocation is null', () => {
    const route: DirectRoute = { type: 'direct', stops: 3 };
    renderHook(() => useStationAlarm(defaultInputs({ route, destination, speedMps: 10 })));
    expect(mockEvaluateAlarmPhase).toHaveBeenCalledWith(
      expect.objectContaining({ etaSeconds: null }),
      expect.any(Set),
    );
  });

  it('sends alarm notification with the full event', () => {
    const route: DirectRoute = { type: 'direct', stops: 1 };
    mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
    renderHook(() => useStationAlarm(defaultInputs({ route, destination })));
    expect(mockSendAlarmNotification).toHaveBeenCalledWith(earlyDest, false, true);
  });

  it('sends transfer alarm for transfer route', () => {
    const route: TransferRoute = {
      type: 'transfer',
      transferName: '시청',
      fromLine: '1',
      toLine: '2',
      stopsToTransfer: 1,
      stopsFromTransfer: 5,
    };
    mockEvaluateAlarmPhase.mockReturnValue(earlyTransfer);
    renderHook(() => useStationAlarm(defaultInputs({ route, destination })));
    expect(mockSendAlarmNotification).toHaveBeenCalledWith(earlyTransfer, false, true);
  });

  it('sends transfer alarm for multi-transfer route', () => {
    const route: MultiTransferRoute = {
      type: 'multi-transfer',
      transfers: [
        { transferName: '시청', fromLine: '1', toLine: '3', stopsToTransfer: 1 },
        { transferName: '충무로', fromLine: '3', toLine: '4', stopsToTransfer: 5 },
      ],
      stopsAfterLastTransfer: 3,
    };
    mockEvaluateAlarmPhase.mockReturnValue(earlyTransfer);
    renderHook(() => useStationAlarm(defaultInputs({ route, destination })));
    expect(mockSendAlarmNotification).toHaveBeenCalledWith(earlyTransfer, false, true);
  });

  it('does not fire the same alarm twice', () => {
    const route: DirectRoute = { type: 'direct', stops: 1 };
    mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
    const { rerender } = renderHook(() => useStationAlarm(defaultInputs({ route, destination })));
    expect(mockSendAlarmNotification).toHaveBeenCalledTimes(1);
    rerender({});
    expect(mockSendAlarmNotification).toHaveBeenCalledTimes(1);
  });

  it('fires imminent after early for the same waypoint', () => {
    const route: DirectRoute = { type: 'direct', stops: 1 };
    mockEvaluateAlarmPhase.mockReturnValueOnce(earlyDest);
    const { rerender } = renderHook(
      ({ inputs }: { inputs: UseStationAlarmInputs }) => useStationAlarm(inputs),
      {
        initialProps: {
          inputs: defaultInputs({ route, destination, userLocation: { lat: 37.4, lng: 127.0 }, speedMps: 5 }),
        },
      },
    );
    expect(mockSendAlarmNotification).toHaveBeenLastCalledWith(earlyDest, false, true);

    mockEvaluateAlarmPhase.mockReturnValueOnce(imminentDest);
    rerender({
      inputs: defaultInputs({ route, destination, userLocation: { lat: 37.49, lng: 127.025 }, speedMps: 20 }),
    });
    expect(mockSendAlarmNotification).toHaveBeenLastCalledWith(imminentDest, false, true);
    expect(mockSendAlarmNotification).toHaveBeenCalledTimes(2);
  });

  it('resets fired alarms when destination changes', () => {
    const route: DirectRoute = { type: 'direct', stops: 1 };
    mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
    const { rerender } = renderHook(
      ({ dest }: { dest: Station }) => useStationAlarm(defaultInputs({ route, destination: dest })),
      { initialProps: { dest: destination } },
    );
    expect(mockSendAlarmNotification).toHaveBeenCalledTimes(1);

    const altEvent: AlarmEvent = { phaseId: 'early', type: 'destination', stationName: '잠실' };
    mockEvaluateAlarmPhase.mockReturnValue(altEvent);
    rerender({ dest: altDestination });
    expect(mockSendAlarmNotification).toHaveBeenCalledTimes(2);
    expect(mockSendAlarmNotification).toHaveBeenLastCalledWith(altEvent, false, true);
  });

  it('passes sleepMode to sendAlarmNotification', () => {
    useAppStore.setState({ sleepMode: true });
    const route: DirectRoute = { type: 'direct', stops: 1 };
    mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
    renderHook(() => useStationAlarm(defaultInputs({ route, destination })));
    expect(mockSendAlarmNotification).toHaveBeenCalledWith(earlyDest, true, true);
  });

  it('sets alarmEvent in store when sleepMode is on', () => {
    useAppStore.setState({ sleepMode: true });
    const route: DirectRoute = { type: 'direct', stops: 1 };
    mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
    renderHook(() => useStationAlarm(defaultInputs({ route, destination })));
    expect(useAppStore.getState().alarmEvent).toEqual(earlyDest);
  });

  it('does not set alarmEvent when sleepMode is off', () => {
    useAppStore.setState({ sleepMode: false });
    const route: DirectRoute = { type: 'direct', stops: 1 };
    mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
    renderHook(() => useStationAlarm(defaultInputs({ route, destination })));
    expect(useAppStore.getState().alarmEvent).toBeNull();
  });

  it('passes allowSpeaker=false from store', () => {
    useAppStore.setState({ allowSpeaker: false });
    const route: DirectRoute = { type: 'direct', stops: 1 };
    mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
    renderHook(() => useStationAlarm(defaultInputs({ route, destination })));
    expect(mockSendAlarmNotification).toHaveBeenCalledWith(earlyDest, false, false);
  });

  it('does not re-fire when sleepMode toggles after first fire', () => {
    const route: DirectRoute = { type: 'direct', stops: 1 };
    mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
    const { rerender } = renderHook(() => useStationAlarm(defaultInputs({ route, destination })));
    expect(mockSendAlarmNotification).toHaveBeenCalledTimes(1);

    useAppStore.setState({ sleepMode: true });
    rerender({});
    expect(mockSendAlarmNotification).toHaveBeenCalledTimes(1);
  });

  it('handles sendAlarmNotification rejection gracefully', () => {
    mockSendAlarmNotification.mockRejectedValueOnce(new Error('알림 실패'));
    const route: DirectRoute = { type: 'direct', stops: 1 };
    mockEvaluateAlarmPhase.mockReturnValue(earlyDest);
    expect(() => renderHook(() => useStationAlarm(defaultInputs({ route, destination })))).not.toThrow();
  });

  describe('station-passed notification', () => {
    it('fires when nearest station changes', () => {
      const route: DirectRoute = { type: 'direct', stops: 3 };
      const station = makeStation('S1', '역삼');
      mockResolveNextTarget.mockReturnValue({ nextStationName: '강남', stopsToNextStation: 3 });
      renderHook(() => useStationAlarm(defaultInputs({ route, destination, nearestStation: station })));
      expect(mockSendStationPassedNotification).toHaveBeenCalledWith('역삼', '강남', 3);
    });

    it('does not fire when nearest station is unchanged', () => {
      const route: DirectRoute = { type: 'direct', stops: 3 };
      const station = makeStation('S1', '역삼');
      mockResolveNextTarget.mockReturnValue({ nextStationName: '강남', stopsToNextStation: 3 });
      const { rerender } = renderHook(
        ({ s }: { s: Station }) =>
          useStationAlarm(defaultInputs({ route, destination, nearestStation: s })),
        { initialProps: { s: station } },
      );
      expect(mockSendStationPassedNotification).toHaveBeenCalledTimes(1);

      rerender({ s: station });
      expect(mockSendStationPassedNotification).toHaveBeenCalledTimes(1);
    });

    it('fires again when nearest station changes to a different one', () => {
      const route: DirectRoute = { type: 'direct', stops: 3 };
      const station1 = makeStation('S1', '역삼');
      const station2 = makeStation('S2', '선릉');
      mockResolveNextTarget.mockReturnValue({ nextStationName: '강남', stopsToNextStation: 3 });
      const { rerender } = renderHook(
        ({ s }: { s: Station }) =>
          useStationAlarm(defaultInputs({ route, destination, nearestStation: s })),
        { initialProps: { s: station1 } },
      );
      expect(mockSendStationPassedNotification).toHaveBeenCalledTimes(1);

      mockResolveNextTarget.mockReturnValue({ nextStationName: '강남', stopsToNextStation: 2 });
      rerender({ s: station2 });
      expect(mockSendStationPassedNotification).toHaveBeenCalledTimes(2);
      expect(mockSendStationPassedNotification).toHaveBeenLastCalledWith('선릉', '강남', 2);
    });

    it('does not fire when nearestStation is null', () => {
      const route: DirectRoute = { type: 'direct', stops: 3 };
      renderHook(() => useStationAlarm(defaultInputs({ route, destination })));
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('does not fire when route is null', () => {
      const station = makeStation('S1', '역삼');
      renderHook(() => useStationAlarm(defaultInputs({ destination, nearestStation: station })));
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('does not fire when destination is null', () => {
      const route: DirectRoute = { type: 'direct', stops: 3 };
      const station = makeStation('S1', '역삼');
      renderHook(() => useStationAlarm(defaultInputs({ route, nearestStation: station })));
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('passes null stopsRemaining when resolveNextTarget returns null', () => {
      const route: DirectRoute = { type: 'direct', stops: 3 };
      const station = makeStation('S1', '역삼');
      mockResolveNextTarget.mockReturnValue(null);
      renderHook(() => useStationAlarm(defaultInputs({ route, destination, nearestStation: station })));
      expect(mockSendStationPassedNotification).toHaveBeenCalledWith('역삼', '강남', null);
    });

    it('handles sendStationPassedNotification rejection gracefully', () => {
      mockSendStationPassedNotification.mockRejectedValueOnce(new Error('알림 실패'));
      const route: DirectRoute = { type: 'direct', stops: 3 };
      const station = makeStation('S1', '역삼');
      mockResolveNextTarget.mockReturnValue({ nextStationName: '강남', stopsToNextStation: 3 });
      expect(() =>
        renderHook(() => useStationAlarm(defaultInputs({ route, destination, nearestStation: station }))),
      ).not.toThrow();
    });
  });
});
