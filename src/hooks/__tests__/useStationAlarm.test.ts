import { renderHook } from '@testing-library/react-native';
import { useStationAlarm } from '../useStationAlarm';
import { useAppStore } from '../../store/useAppStore';
import type { DirectRoute, TransferRoute, MultiTransferRoute } from '../../utils/stationRoute';
import type { Station } from '../../types/station';

const mockSendAlarmNotification = jest.fn().mockResolvedValue(undefined);
const mockSendStationPassedNotification = jest.fn().mockResolvedValue(undefined);

jest.mock('../../utils/stationNotification', () => ({
  sendAlarmNotification: (...args: unknown[]) => mockSendAlarmNotification(...args),
  sendStationPassedNotification: (...args: unknown[]) => mockSendStationPassedNotification(...args),
}));

const mockEvaluateAllAlarms = jest.fn();
const mockResolveNextTarget = jest.fn();

jest.mock('../../utils/stationPipeline', () => ({
  evaluateAllAlarms: (...args: unknown[]) => mockEvaluateAllAlarms(...args),
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
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const makeStation = (id: string, name: string): Station => ({
  id,
  name,
  line: '2',
  lineColor: '#33A23D',
  lat: 37.5,
  lng: 127.0,
});

describe('useStationAlarm', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAppStore.setState({ sleepMode: false, allowSpeaker: true, alarmEvent: null });
    mockEvaluateAllAlarms.mockReturnValue(null);
    mockResolveNextTarget.mockReturnValue(null);
  });

  it('should not send alarm when route is null', () => {
    renderHook(() => useStationAlarm(null, '강남', null));
    expect(mockEvaluateAllAlarms).not.toHaveBeenCalled();
    expect(mockSendAlarmNotification).not.toHaveBeenCalled();
  });

  it('should not send alarm when destinationName is null', () => {
    const route: DirectRoute = { type: 'direct', stops: 1 };
    renderHook(() => useStationAlarm(route, null, null));
    expect(mockEvaluateAllAlarms).not.toHaveBeenCalled();
    expect(mockSendAlarmNotification).not.toHaveBeenCalled();
  });

  it('should not send alarm when evaluateAllAlarms returns null', () => {
    const route: DirectRoute = { type: 'direct', stops: 3 };
    mockEvaluateAllAlarms.mockReturnValue(null);
    renderHook(() => useStationAlarm(route, '강남', null));
    expect(mockEvaluateAllAlarms).toHaveBeenCalledWith(route, '강남', expect.any(Set));
    expect(mockSendAlarmNotification).not.toHaveBeenCalled();
  });

  it('should send destination alarm for direct route', () => {
    const route: DirectRoute = { type: 'direct', stops: 1 };
    mockEvaluateAllAlarms.mockReturnValue({ type: 'destination', stationName: '강남' });
    renderHook(() => useStationAlarm(route, '강남', null));
    expect(mockSendAlarmNotification).toHaveBeenCalledWith('destination', '강남', false, false, true);
  });

  it('should send transfer alarm for transfer route', () => {
    const route: TransferRoute = {
      type: 'transfer',
      transferName: '시청',
      fromLine: '1',
      toLine: '2',
      stopsToTransfer: 1,
      stopsFromTransfer: 5,
    };
    mockEvaluateAllAlarms.mockReturnValue({ type: 'transfer', stationName: '시청' });
    renderHook(() => useStationAlarm(route, '강남', null));
    expect(mockSendAlarmNotification).toHaveBeenCalledWith('transfer', '시청', false, false, true);
  });

  it('should send destination alarm for transfer route stopsFromTransfer', () => {
    const route: TransferRoute = {
      type: 'transfer',
      transferName: '시청',
      fromLine: '1',
      toLine: '2',
      stopsToTransfer: 5,
      stopsFromTransfer: 1,
    };
    mockEvaluateAllAlarms.mockReturnValue({ type: 'destination', stationName: '강남' });
    renderHook(() => useStationAlarm(route, '강남', null));
    expect(mockSendAlarmNotification).toHaveBeenCalledWith('destination', '강남', false, false, true);
  });

  it('should send transfer alarm for multi-transfer route', () => {
    const route: MultiTransferRoute = {
      type: 'multi-transfer',
      transfers: [
        { transferName: '시청', fromLine: '1', toLine: '3', stopsToTransfer: 1 },
        { transferName: '충무로', fromLine: '3', toLine: '4', stopsToTransfer: 5 },
      ],
      stopsAfterLastTransfer: 3,
    };
    mockEvaluateAllAlarms.mockReturnValue({ type: 'transfer', stationName: '시청' });
    renderHook(() => useStationAlarm(route, '강남', null));
    expect(mockSendAlarmNotification).toHaveBeenCalledWith('transfer', '시청', false, false, true);
  });

  it('should not fire same alarm twice', () => {
    const route: DirectRoute = { type: 'direct', stops: 1 };
    mockEvaluateAllAlarms.mockReturnValue({ type: 'destination', stationName: '강남' });
    const { rerender } = renderHook(() => useStationAlarm(route, '강남', null));
    expect(mockSendAlarmNotification).toHaveBeenCalledTimes(1);

    rerender({});
    expect(mockSendAlarmNotification).toHaveBeenCalledTimes(1);
  });

  it('should reset fired alarms when destination changes', () => {
    const route: DirectRoute = { type: 'direct', stops: 1 };
    mockEvaluateAllAlarms.mockReturnValue({ type: 'destination', stationName: '강남' });
    const { rerender } = renderHook(
      ({ dest }: { dest: string }) => useStationAlarm(route, dest, null),
      { initialProps: { dest: '강남' } },
    );
    expect(mockSendAlarmNotification).toHaveBeenCalledTimes(1);

    mockEvaluateAllAlarms.mockReturnValue({ type: 'destination', stationName: '잠실' });
    rerender({ dest: '잠실' });
    expect(mockSendAlarmNotification).toHaveBeenCalledTimes(2);
    expect(mockSendAlarmNotification).toHaveBeenLastCalledWith('destination', '잠실', false, false, true);
  });

  it('should pass sleepMode to sendAlarmNotification', () => {
    useAppStore.setState({ sleepMode: true });
    const route: DirectRoute = { type: 'direct', stops: 1 };
    mockEvaluateAllAlarms.mockReturnValue({ type: 'destination', stationName: '강남' });
    renderHook(() => useStationAlarm(route, '강남', null));
    expect(mockSendAlarmNotification).toHaveBeenCalledWith('destination', '강남', true, false, true);
  });

  it('취침 모드일 때 alarmEvent를 설정한다', () => {
    useAppStore.setState({ sleepMode: true });
    const route: DirectRoute = { type: 'direct', stops: 1 };
    mockEvaluateAllAlarms.mockReturnValue({ type: 'destination', stationName: '강남' });
    renderHook(() => useStationAlarm(route, '강남', null));
    expect(useAppStore.getState().alarmEvent).toEqual({ type: 'destination', stationName: '강남' });
  });

  it('취침 모드가 아닐 때 alarmEvent를 설정하지 않는다', () => {
    useAppStore.setState({ sleepMode: false });
    const route: DirectRoute = { type: 'direct', stops: 1 };
    mockEvaluateAllAlarms.mockReturnValue({ type: 'destination', stationName: '강남' });
    renderHook(() => useStationAlarm(route, '강남', null));
    expect(useAppStore.getState().alarmEvent).toBeNull();
  });

  it('should pass allowSpeaker=false to sendAlarmNotification when store has allowSpeaker=false', () => {
    useAppStore.setState({ allowSpeaker: false });
    const route: DirectRoute = { type: 'direct', stops: 1 };
    mockEvaluateAllAlarms.mockReturnValue({ type: 'destination', stationName: '강남' });
    renderHook(() => useStationAlarm(route, '강남', null));
    expect(mockSendAlarmNotification).toHaveBeenCalledWith('destination', '강남', false, false, false);
  });

  it('should not re-fire alarm when sleepMode changes', () => {
    const route: DirectRoute = { type: 'direct', stops: 1 };
    mockEvaluateAllAlarms.mockReturnValue({ type: 'destination', stationName: '강남' });
    const { rerender } = renderHook(() => useStationAlarm(route, '강남', null));
    expect(mockSendAlarmNotification).toHaveBeenCalledTimes(1);

    useAppStore.setState({ sleepMode: true });
    rerender({});
    expect(mockSendAlarmNotification).toHaveBeenCalledTimes(1);
  });

  it('should handle sendAlarmNotification failure gracefully', () => {
    mockSendAlarmNotification.mockRejectedValueOnce(new Error('알림 실패'));
    const route: DirectRoute = { type: 'direct', stops: 1 };
    mockEvaluateAllAlarms.mockReturnValue({ type: 'destination', stationName: '강남' });
    expect(() => renderHook(() => useStationAlarm(route, '강남', null))).not.toThrow();
  });

  describe('time-based alarm', () => {
    it('should send time-based alarm with timeBased flag', () => {
      const route: DirectRoute = { type: 'direct', stops: 5 };
      mockEvaluateAllAlarms.mockReturnValue({ type: 'approaching', stationName: '역삼', timeBased: true });
      renderHook(() => useStationAlarm(route, '강남', null));
      expect(mockSendAlarmNotification).toHaveBeenCalledWith('approaching', '역삼', false, true, true);
    });

    it('should send time-based transfer alarm', () => {
      const route: TransferRoute = {
        type: 'transfer',
        transferName: '시청',
        fromLine: '1',
        toLine: '2',
        stopsToTransfer: 1,
        stopsFromTransfer: 5,
      };
      mockEvaluateAllAlarms.mockReturnValue({ type: 'transfer', stationName: '시청', timeBased: true });
      renderHook(() => useStationAlarm(route, '강남', null));
      expect(mockSendAlarmNotification).toHaveBeenCalledWith('transfer', '시청', false, true, true);
    });

    it('should set alarmEvent in sleep mode for destination time-based alarm', () => {
      useAppStore.setState({ sleepMode: true });
      const route: DirectRoute = { type: 'direct', stops: 1 };
      mockEvaluateAllAlarms.mockReturnValue({ type: 'destination', stationName: '강남', timeBased: true });
      renderHook(() => useStationAlarm(route, '강남', null));
      expect(useAppStore.getState().alarmEvent).toEqual({ type: 'destination', stationName: '강남' });
    });

    it('should not set alarmEvent in sleep mode for approaching time-based alarm', () => {
      useAppStore.setState({ sleepMode: true });
      const route: DirectRoute = { type: 'direct', stops: 5 };
      mockEvaluateAllAlarms.mockReturnValue({ type: 'approaching', stationName: '역삼', timeBased: true });
      renderHook(() => useStationAlarm(route, '강남', null));
      expect(useAppStore.getState().alarmEvent).toBeNull();
    });

    it('should handle time-based alarm notification failure gracefully', () => {
      mockSendAlarmNotification.mockRejectedValueOnce(new Error('시간 기반 알림 실패'));
      const route: DirectRoute = { type: 'direct', stops: 5 };
      mockEvaluateAllAlarms.mockReturnValue({ type: 'approaching', stationName: '역삼', timeBased: true });
      expect(() => renderHook(() => useStationAlarm(route, '강남', null))).not.toThrow();
    });

    it('should set alarmEvent in sleep mode for transfer time-based alarm', () => {
      useAppStore.setState({ sleepMode: true });
      const route: TransferRoute = {
        type: 'transfer',
        transferName: '시청',
        fromLine: '1',
        toLine: '2',
        stopsToTransfer: 1,
        stopsFromTransfer: 5,
      };
      mockEvaluateAllAlarms.mockReturnValue({ type: 'transfer', stationName: '시청', timeBased: true });
      renderHook(() => useStationAlarm(route, '강남', null));
      expect(useAppStore.getState().alarmEvent).toEqual({ type: 'transfer', stationName: '시청' });
    });
  });

  describe('station-passed notification', () => {
    it('역이 변경되면 per-station 알림을 발송한다', () => {
      const route: DirectRoute = { type: 'direct', stops: 3 };
      const station = makeStation('S1', '역삼');
      mockResolveNextTarget.mockReturnValue({ nextStationName: '강남', stopsToNextStation: 3 });
      renderHook(() => useStationAlarm(route, '강남', station));
      expect(mockSendStationPassedNotification).toHaveBeenCalledWith('역삼', '강남', 3);
    });

    it('같은 역이면 per-station 알림을 발송하지 않는다', () => {
      const route: DirectRoute = { type: 'direct', stops: 3 };
      const station = makeStation('S1', '역삼');
      mockResolveNextTarget.mockReturnValue({ nextStationName: '강남', stopsToNextStation: 3 });
      const { rerender } = renderHook(
        ({ s }: { s: Station }) => useStationAlarm(route, '강남', s),
        { initialProps: { s: station } },
      );
      expect(mockSendStationPassedNotification).toHaveBeenCalledTimes(1);

      rerender({ s: station });
      expect(mockSendStationPassedNotification).toHaveBeenCalledTimes(1);
    });

    it('역이 다른 역으로 변경되면 다시 발송한다', () => {
      const route: DirectRoute = { type: 'direct', stops: 3 };
      const station1 = makeStation('S1', '역삼');
      const station2 = makeStation('S2', '선릉');
      mockResolveNextTarget.mockReturnValue({ nextStationName: '강남', stopsToNextStation: 3 });
      const { rerender } = renderHook(
        ({ s }: { s: Station }) => useStationAlarm(route, '강남', s),
        { initialProps: { s: station1 } },
      );
      expect(mockSendStationPassedNotification).toHaveBeenCalledTimes(1);

      mockResolveNextTarget.mockReturnValue({ nextStationName: '강남', stopsToNextStation: 2 });
      rerender({ s: station2 });
      expect(mockSendStationPassedNotification).toHaveBeenCalledTimes(2);
      expect(mockSendStationPassedNotification).toHaveBeenLastCalledWith('선릉', '강남', 2);
    });

    it('nearestStation이 null이면 per-station 알림을 발송하지 않는다', () => {
      const route: DirectRoute = { type: 'direct', stops: 3 };
      renderHook(() => useStationAlarm(route, '강남', null));
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('route가 없으면 per-station 알림을 발송하지 않는다', () => {
      const station = makeStation('S1', '역삼');
      renderHook(() => useStationAlarm(null, '강남', station));
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('destinationName이 없으면 per-station 알림을 발송하지 않는다', () => {
      const route: DirectRoute = { type: 'direct', stops: 3 };
      const station = makeStation('S1', '역삼');
      renderHook(() => useStationAlarm(route, null, station));
      expect(mockSendStationPassedNotification).not.toHaveBeenCalled();
    });

    it('resolveNextTarget이 null을 반환하면 stopsRemaining을 null로 전달한다', () => {
      const route: DirectRoute = { type: 'direct', stops: 3 };
      const station = makeStation('S1', '역삼');
      mockResolveNextTarget.mockReturnValue(null);
      renderHook(() => useStationAlarm(route, '강남', station));
      expect(mockSendStationPassedNotification).toHaveBeenCalledWith('역삼', '강남', null);
    });

    it('sendStationPassedNotification 실패 시 에러를 던지지 않는다', () => {
      mockSendStationPassedNotification.mockRejectedValueOnce(new Error('알림 실패'));
      const route: DirectRoute = { type: 'direct', stops: 3 };
      const station = makeStation('S1', '역삼');
      mockResolveNextTarget.mockReturnValue({ nextStationName: '강남', stopsToNextStation: 3 });
      expect(() => renderHook(() => useStationAlarm(route, '강남', station))).not.toThrow();
    });
  });
});
