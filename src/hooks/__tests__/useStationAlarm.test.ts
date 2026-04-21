import { renderHook } from '@testing-library/react-native';
import { useStationAlarm } from '../useStationAlarm';
import { useAppStore } from '../../store/useAppStore';
import type { DirectRoute, TransferRoute, MultiTransferRoute } from '../../utils/stationRoute';

const mockSendAlarmNotification = jest.fn().mockResolvedValue(undefined);

jest.mock('../../utils/stationNotification', () => ({
  sendAlarmNotification: (...args: unknown[]) => mockSendAlarmNotification(...args),
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

describe('useStationAlarm', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAppStore.setState({ sleepMode: false, alarmEvent: null });
  });

  it('should not send alarm when route is null', () => {
    renderHook(() => useStationAlarm(null, '강남'));
    expect(mockSendAlarmNotification).not.toHaveBeenCalled();
  });

  it('should not send alarm when destinationName is null', () => {
    const route: DirectRoute = { type: 'direct', stops: 1 };
    renderHook(() => useStationAlarm(route, null));
    expect(mockSendAlarmNotification).not.toHaveBeenCalled();
  });

  it('should not send alarm when stops is not 1', () => {
    const route: DirectRoute = { type: 'direct', stops: 3 };
    renderHook(() => useStationAlarm(route, '강남'));
    expect(mockSendAlarmNotification).not.toHaveBeenCalled();
  });

  it('should send destination alarm for direct route with stops === 1', () => {
    const route: DirectRoute = { type: 'direct', stops: 1 };
    renderHook(() => useStationAlarm(route, '강남'));
    expect(mockSendAlarmNotification).toHaveBeenCalledWith('destination', '강남', false);
  });

  it('should send transfer alarm for transfer route with stopsToTransfer === 1', () => {
    const route: TransferRoute = {
      type: 'transfer',
      transferName: '시청',
      fromLine: '1',
      toLine: '2',
      stopsToTransfer: 1,
      stopsFromTransfer: 5,
    };
    renderHook(() => useStationAlarm(route, '강남'));
    expect(mockSendAlarmNotification).toHaveBeenCalledWith('transfer', '시청', false);
  });

  it('should send destination alarm for transfer route with stopsFromTransfer === 1', () => {
    const route: TransferRoute = {
      type: 'transfer',
      transferName: '시청',
      fromLine: '1',
      toLine: '2',
      stopsToTransfer: 5,
      stopsFromTransfer: 1,
    };
    renderHook(() => useStationAlarm(route, '강남'));
    expect(mockSendAlarmNotification).toHaveBeenCalledWith('destination', '강남', false);
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
    renderHook(() => useStationAlarm(route, '강남'));
    expect(mockSendAlarmNotification).toHaveBeenCalledWith('transfer', '시청', false);
  });

  it('should not fire same alarm twice', () => {
    const route: DirectRoute = { type: 'direct', stops: 1 };
    const { rerender } = renderHook(() => useStationAlarm(route, '강남'));
    expect(mockSendAlarmNotification).toHaveBeenCalledTimes(1);

    rerender({});
    expect(mockSendAlarmNotification).toHaveBeenCalledTimes(1);
  });

  it('should reset fired alarms when destination changes', () => {
    const route: DirectRoute = { type: 'direct', stops: 1 };
    const { rerender } = renderHook(
      ({ dest }: { dest: string }) => useStationAlarm(route, dest),
      { initialProps: { dest: '강남' } },
    );
    expect(mockSendAlarmNotification).toHaveBeenCalledTimes(1);

    rerender({ dest: '잠실' });
    expect(mockSendAlarmNotification).toHaveBeenCalledTimes(2);
    expect(mockSendAlarmNotification).toHaveBeenLastCalledWith('destination', '잠실', false);
  });

  it('should pass sleepMode to sendAlarmNotification', () => {
    useAppStore.setState({ sleepMode: true });
    const route: DirectRoute = { type: 'direct', stops: 1 };
    renderHook(() => useStationAlarm(route, '강남'));
    expect(mockSendAlarmNotification).toHaveBeenCalledWith('destination', '강남', true);
  });

  it('취침 모드일 때 alarmEvent를 설정한다', () => {
    useAppStore.setState({ sleepMode: true });
    const route: DirectRoute = { type: 'direct', stops: 1 };
    renderHook(() => useStationAlarm(route, '강남'));
    expect(useAppStore.getState().alarmEvent).toEqual({ type: 'destination', stationName: '강남' });
  });

  it('취침 모드가 아닐 때 alarmEvent를 설정하지 않는다', () => {
    useAppStore.setState({ sleepMode: false });
    const route: DirectRoute = { type: 'direct', stops: 1 };
    renderHook(() => useStationAlarm(route, '강남'));
    expect(useAppStore.getState().alarmEvent).toBeNull();
  });

  it('should not re-fire alarm when sleepMode changes', () => {
    const route: DirectRoute = { type: 'direct', stops: 1 };
    const { rerender } = renderHook(() => useStationAlarm(route, '강남'));
    expect(mockSendAlarmNotification).toHaveBeenCalledTimes(1);

    useAppStore.setState({ sleepMode: true });
    rerender({});
    expect(mockSendAlarmNotification).toHaveBeenCalledTimes(1);
  });

  it('should send destination alarm (not transfer) when transferName equals destinationName', () => {
    const route: TransferRoute = {
      type: 'transfer',
      transferName: '옥수',
      fromLine: 'gyeongui',
      toLine: '3',
      stopsToTransfer: 0,
      stopsFromTransfer: 0,
    };
    renderHook(() => useStationAlarm(route, '옥수'));
    // 시간 기반 알람 (timeBased=true)과 정거장 기반 알람 둘 다 발생
    expect(mockSendAlarmNotification).toHaveBeenCalledWith('destination', '옥수', false, true);
    expect(mockSendAlarmNotification).toHaveBeenCalledWith('destination', '옥수', false);
  });

  it('should handle sendAlarmNotification failure gracefully', () => {
    mockSendAlarmNotification.mockRejectedValueOnce(new Error('알림 실패'));
    const route: DirectRoute = { type: 'direct', stops: 1 };
    expect(() => renderHook(() => useStationAlarm(route, '강남'))).not.toThrow();
  });

  // 시간 기반 알람 테스트
  describe('time-based alarm', () => {
    it('should send time-based alarm when estimated time <= 30s (0 stops)', () => {
      const route: DirectRoute = { type: 'direct', stops: 0 };
      renderHook(() => useStationAlarm(route, '강남'));
      expect(mockSendAlarmNotification).toHaveBeenCalledWith('destination', '강남', false, true);
      // 정거장 기반 알람도 발생 (stops === 0 <= 1)
      expect(mockSendAlarmNotification).toHaveBeenCalledWith('destination', '강남', false);
    });

    it('should not send time-based alarm when estimated time > 30s', () => {
      const route: DirectRoute = { type: 'direct', stops: 3 };
      renderHook(() => useStationAlarm(route, '강남'));
      expect(mockSendAlarmNotification).not.toHaveBeenCalledWith('destination', '강남', false, true);
    });

    it('should send time-based transfer alarm', () => {
      const route: TransferRoute = {
        type: 'transfer',
        transferName: '시청',
        fromLine: '1',
        toLine: '2',
        stopsToTransfer: 0,
        stopsFromTransfer: 5,
      };
      renderHook(() => useStationAlarm(route, '강남'));
      expect(mockSendAlarmNotification).toHaveBeenCalledWith('transfer', '시청', false, true);
    });

    it('should set alarmEvent in sleep mode for time-based alarm', () => {
      useAppStore.setState({ sleepMode: true });
      const route: DirectRoute = { type: 'direct', stops: 0 };
      renderHook(() => useStationAlarm(route, '강남'));
      expect(useAppStore.getState().alarmEvent).toEqual({ type: 'destination', stationName: '강남' });
    });

    it('should not fire same time-based alarm twice', () => {
      const route: DirectRoute = { type: 'direct', stops: 0 };
      const { rerender } = renderHook(() => useStationAlarm(route, '강남'));
      const timeBasedCalls = mockSendAlarmNotification.mock.calls.filter(
        (c: unknown[]) => c[3] === true,
      );
      expect(timeBasedCalls).toHaveLength(1);

      rerender({});
      const timeBasedCallsAfter = mockSendAlarmNotification.mock.calls.filter(
        (c: unknown[]) => c[3] === true,
      );
      expect(timeBasedCallsAfter).toHaveLength(1);
    });

    it('should handle time-based alarm notification failure gracefully', () => {
      mockSendAlarmNotification.mockRejectedValueOnce(new Error('시간 기반 알림 실패'));
      const route: DirectRoute = { type: 'direct', stops: 0 };
      expect(() => renderHook(() => useStationAlarm(route, '강남'))).not.toThrow();
    });
  });
});
