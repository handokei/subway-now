import { renderHook } from '@testing-library/react-native';
import type { Station } from '../../../../shared/types/station';

const mockSave = jest.fn().mockResolvedValue(undefined);
const mockClear = jest.fn().mockResolvedValue(undefined);

jest.mock('../../api/widgetStorage', () => ({
  saveStationToWidget: (...args: unknown[]) => mockSave(...args),
  clearWidgetStation: () => mockClear(),
}));

const mockLoggerError = jest.fn();
jest.mock('../../../../shared/utils/logger', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: (...args: unknown[]) => mockLoggerError(...args),
    debug: jest.fn(),
  };
  return { createLogger: () => logger };
});

import { useWidgetMirror } from '../useWidgetMirror';

const station: Station = {
  id: '2-001',
  name: '강남',
  line: '2',
  lineColor: '#009933',
  lat: 37.497,
  lng: 127.027,
};

beforeEach(() => {
  mockSave.mockClear();
  mockClear.mockClear();
  mockLoggerError.mockClear();
});

describe('useWidgetMirror', () => {
  it('station 감지 시 saveStationToWidget을 호출한다', () => {
    renderHook(() => useWidgetMirror(station, 0.1));
    expect(mockSave).toHaveBeenCalledWith(station, 0.1);
    expect(mockClear).not.toHaveBeenCalled();
  });

  it('station이 null이면 clearWidgetStation을 호출한다', () => {
    renderHook(() => useWidgetMirror(null, null));
    expect(mockClear).toHaveBeenCalledTimes(1);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('distanceKm이 null이면 station이 있어도 clear', () => {
    renderHook(() => useWidgetMirror(station, null));
    expect(mockClear).toHaveBeenCalledTimes(1);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('같은 50m bucket 내 미세 변경엔 effect가 재실행되지 않는다', () => {
    // 100m → 120m → 149m 는 전부 bucket 2 (100~149m)
    const { rerender } = renderHook(({ d }: { d: number }) => useWidgetMirror(station, d), {
      initialProps: { d: 0.1 },
    });
    rerender({ d: 0.12 });
    rerender({ d: 0.149 });
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it('bucket이 바뀌면 다시 save', () => {
    const { rerender } = renderHook(({ d }: { d: number }) => useWidgetMirror(station, d), {
      initialProps: { d: 0.5 }, // bucket 10
    });
    rerender({ d: 0.45 }); // bucket 9
    rerender({ d: 0.03 }); // bucket 0
    expect(mockSave).toHaveBeenCalledTimes(3);
  });

  it('station이 바뀌면 다시 save', () => {
    const other: Station = { ...station, id: '2-002', name: '역삼' };
    const { rerender } = renderHook(
      ({ s }: { s: Station }) => useWidgetMirror(s, 0.1),
      { initialProps: { s: station } },
    );
    rerender({ s: other });
    expect(mockSave).toHaveBeenCalledTimes(2);
    expect(mockSave).toHaveBeenLastCalledWith(other, 0.1);
  });

  it('station → null 전환 시 clear', () => {
    const { rerender } = renderHook(
      ({ s, d }: { s: Station | null; d: number | null }) => useWidgetMirror(s, d),
      { initialProps: { s: station as Station | null, d: 0.1 as number | null } },
    );
    expect(mockSave).toHaveBeenCalledTimes(1);
    rerender({ s: null, d: null });
    expect(mockClear).toHaveBeenCalledTimes(1);
  });

  it('save 실패 시 logger.error만 호출 (throw 안 함)', async () => {
    mockSave.mockRejectedValueOnce(new Error('group missing'));
    renderHook(() => useWidgetMirror(station, 0.1));
    await new Promise((r) => setImmediate(r));
    expect(mockLoggerError).toHaveBeenCalledWith('save 실패:', expect.any(Error));
  });

  it('clear 실패 시 logger.error만 호출 (throw 안 함)', async () => {
    mockClear.mockRejectedValueOnce(new Error('group missing'));
    renderHook(() => useWidgetMirror(null, null));
    await new Promise((r) => setImmediate(r));
    expect(mockLoggerError).toHaveBeenCalledWith('clear 실패:', expect.any(Error));
  });
});
