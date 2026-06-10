import { renderHook } from '@testing-library/react-native';
import type { Station } from '../../../../shared/types/station';

const mockSave = jest.fn().mockResolvedValue(undefined);
const mockClear = jest.fn().mockResolvedValue(undefined);

jest.mock('../../api/widgetStorage', () => ({
  saveStationToWidget: (...args: unknown[]) => mockSave(...args),
  clearWidgetStation: () => mockClear(),
}));

const mockLoggerError = jest.fn();
jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({ error: (...args: unknown[]) => mockLoggerError(...args), info: jest.fn() }),
}));

import { useWidgetSync } from '../useWidgetSync';

const station: Station = {
  id: '2-001',
  name: '강남',
  line: '2',
  lineColor: '#009933',
  lat: 37.4979,
  lng: 127.0276,
};

const otherStation: Station = { ...station, id: '2-002', name: '역삼' };

describe('useWidgetSync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('station + distance가 있으면 saveStationToWidget을 호출한다', () => {
    renderHook(() => useWidgetSync(station, 0.25));
    expect(mockSave).toHaveBeenCalledWith(station, 0.25);
    expect(mockClear).not.toHaveBeenCalled();
  });

  it('station이 null이면 clearWidgetStation을 호출한다', () => {
    renderHook(() => useWidgetSync(null, null));
    expect(mockClear).toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('distanceKm이 null이면 clearWidgetStation을 호출한다', () => {
    renderHook(() => useWidgetSync(station, null));
    expect(mockClear).toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('station이 바뀌면 다시 save를 호출한다', () => {
    const { rerender } = renderHook(
      ({ s, d }: { s: Station | null; d: number | null }) => useWidgetSync(s, d),
      { initialProps: { s: station, d: 0.1 } },
    );
    expect(mockSave).toHaveBeenCalledTimes(1);
    rerender({ s: otherStation, d: 0.2 });
    expect(mockSave).toHaveBeenCalledTimes(2);
    expect(mockSave).toHaveBeenLastCalledWith(otherStation, 0.2);
  });

  it('station → null 전환 시 clear를 호출한다', () => {
    const { rerender } = renderHook(
      ({ s, d }: { s: Station | null; d: number | null }) => useWidgetSync(s, d),
      { initialProps: { s: station as Station | null, d: 0.1 as number | null } },
    );
    expect(mockSave).toHaveBeenCalledTimes(1);
    rerender({ s: null, d: null });
    expect(mockClear).toHaveBeenCalledTimes(1);
  });

  it('save가 실패해도 throw하지 않고 logger.error로 기록한다', async () => {
    mockSave.mockRejectedValueOnce(new Error('group missing'));
    renderHook(() => useWidgetSync(station, 0.3));
    // microtask flush
    await Promise.resolve();
    await Promise.resolve();
    expect(mockLoggerError).toHaveBeenCalled();
  });

  it('clear가 실패해도 throw하지 않고 logger.error로 기록한다', async () => {
    mockClear.mockRejectedValueOnce(new Error('group missing'));
    renderHook(() => useWidgetSync(null, null));
    await Promise.resolve();
    await Promise.resolve();
    expect(mockLoggerError).toHaveBeenCalled();
  });
});
