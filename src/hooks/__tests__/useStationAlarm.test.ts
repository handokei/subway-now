import { renderHook } from '@testing-library/react-native';
import { useStationAlarm } from '../useStationAlarm';
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

describe('useStationAlarm', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
    expect(mockSendAlarmNotification).toHaveBeenCalledWith('destination', '강남');
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
    expect(mockSendAlarmNotification).toHaveBeenCalledWith('transfer', '시청');
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
    expect(mockSendAlarmNotification).toHaveBeenCalledWith('destination', '강남');
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
    expect(mockSendAlarmNotification).toHaveBeenCalledWith('transfer', '시청');
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
    expect(mockSendAlarmNotification).toHaveBeenLastCalledWith('destination', '잠실');
  });

  it('should handle sendAlarmNotification failure gracefully', () => {
    mockSendAlarmNotification.mockRejectedValueOnce(new Error('알림 실패'));
    const route: DirectRoute = { type: 'direct', stops: 1 };
    expect(() => renderHook(() => useStationAlarm(route, '강남'))).not.toThrow();
  });
});
