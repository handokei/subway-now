import { renderHook } from '@testing-library/react-native';
import { act } from 'react';
import { AppState } from 'react-native';
import { useScheduledAlarms } from '../useScheduledAlarms';
import {
  scheduleAlarmsForRoute,
  cancelScheduledAlarms,
} from '../../utils/alarmScheduler';
import type { DirectRoute } from '../../utils/stationRoute';
import type { Station } from '../../types/station';
import type { StationArrival } from '../../api/arrivalApi';

jest.mock('../../utils/alarmScheduler');
jest.mock('../../utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const mockedSchedule = scheduleAlarmsForRoute as jest.MockedFunction<
  typeof scheduleAlarmsForRoute
>;
const mockedCancel = cancelScheduledAlarms as jest.MockedFunction<
  typeof cancelScheduledAlarms
>;

const mockRemove = jest.fn();
let appStateCallback: ((state: string) => void) | null = null;
jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
  appStateCallback = listener as (state: string) => void;
  return { remove: mockRemove } as unknown as ReturnType<typeof AppState.addEventListener>;
});

const ROUTE: DirectRoute = { type: 'direct', stops: 10, line: '1' };
const DESTINATION: Station = {
  id: 'dest-1',
  name: '강남',
  line: '2',
  lat: 37.5,
  lng: 127.0,
  lineColor: '#000',
};
const ARRIVAL: StationArrival = {
  up: [
    {
      destination: '상행',
      arrivalMinutes: 5,
      arrivalSeconds: 300,
      statusMessage: '',
      trainCode: 'U1',
      receivedAtMs: 0,
      arrivalCode: -1,
      isLastTrain: false,
      trainType: 'normal',
    },
  ],
  down: [
    {
      destination: '하행',
      arrivalMinutes: 7,
      arrivalSeconds: 420,
      statusMessage: '',
      trainCode: 'D1',
      receivedAtMs: 0,
      arrivalCode: -1,
      isLastTrain: false,
      trainType: 'normal',
    },
  ],
};

async function flush(): Promise<void> {
  // 비동기 reschedule 체인을 한 틱 흘려보낸다.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useScheduledAlarms', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    appStateCallback = null;
    mockedSchedule.mockResolvedValue([]);
    mockedCancel.mockResolvedValue();
    // 초기 AppState는 active로 가정 — RN 기본값.
    (AppState as { currentState: string }).currentState = 'active';
  });

  it('마운트 시 active 상태면 cancel만 호출되고 schedule은 호출되지 않는다', async () => {
    renderHook(() =>
      useScheduledAlarms({ route: ROUTE, destination: DESTINATION, arrival: ARRIVAL }),
    );
    await flush();

    expect(mockedCancel).toHaveBeenCalled();
    expect(mockedSchedule).not.toHaveBeenCalled();
  });

  it('background 전환 시 마지막 ETA로 재예약한다', async () => {
    renderHook(() =>
      useScheduledAlarms({ route: ROUTE, destination: DESTINATION, arrival: ARRIVAL }),
    );
    await flush();
    mockedCancel.mockClear();

    await act(async () => {
      appStateCallback?.('background');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockedCancel).toHaveBeenCalledTimes(1);
    expect(mockedSchedule).toHaveBeenCalledWith({
      route: ROUTE,
      destinationName: '강남',
      nextStationEtaSeconds: 300, // min(300, 420)
      stamp: { direction: 'up', usedTrainCode: 'U1' },
    });
  });

  it('active 복귀 시 예약을 모두 취소하고 재예약하지 않는다', async () => {
    renderHook(() =>
      useScheduledAlarms({ route: ROUTE, destination: DESTINATION, arrival: ARRIVAL }),
    );
    await flush();

    await act(async () => {
      appStateCallback?.('background');
      await Promise.resolve();
      await Promise.resolve();
    });
    mockedCancel.mockClear();
    mockedSchedule.mockClear();

    await act(async () => {
      appStateCallback?.('active');
      await Promise.resolve();
    });

    expect(mockedCancel).toHaveBeenCalledTimes(1);
    expect(mockedSchedule).not.toHaveBeenCalled();
  });

  it('동일 AppState 이벤트가 연속되면 무시한다', async () => {
    renderHook(() =>
      useScheduledAlarms({ route: ROUTE, destination: DESTINATION, arrival: ARRIVAL }),
    );
    await flush();

    await act(async () => {
      appStateCallback?.('background');
      await Promise.resolve();
      await Promise.resolve();
    });
    mockedSchedule.mockClear();
    mockedCancel.mockClear();

    await act(async () => {
      appStateCallback?.('background');
      await Promise.resolve();
    });

    expect(mockedSchedule).not.toHaveBeenCalled();
    expect(mockedCancel).not.toHaveBeenCalled();
  });

  it('inactive 전환은 schedule/cancel을 트리거하지 않는다', async () => {
    renderHook(() =>
      useScheduledAlarms({ route: ROUTE, destination: DESTINATION, arrival: ARRIVAL }),
    );
    await flush();
    mockedSchedule.mockClear();
    mockedCancel.mockClear();

    await act(async () => {
      appStateCallback?.('inactive');
      await Promise.resolve();
    });

    expect(mockedSchedule).not.toHaveBeenCalled();
    expect(mockedCancel).not.toHaveBeenCalled();
  });

  it('background에서 arrival이 변하면 재예약한다', async () => {
    const { rerender } = renderHook(
      (props: { arrival: StationArrival | null }) =>
        useScheduledAlarms({
          route: ROUTE,
          destination: DESTINATION,
          arrival: props.arrival,
        }),
      { initialProps: { arrival: ARRIVAL } },
    );
    await flush();
    await act(async () => {
      appStateCallback?.('background');
      await Promise.resolve();
      await Promise.resolve();
    });
    mockedSchedule.mockClear();
    mockedCancel.mockClear();

    const NEXT: StationArrival = {
      ...ARRIVAL,
      up: [{ ...ARRIVAL.up[0], arrivalSeconds: 150 }],
    };
    rerender({ arrival: NEXT });
    await flush();

    expect(mockedCancel).toHaveBeenCalled();
    expect(mockedSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ nextStationEtaSeconds: 150 }),
    );
  });

  it('background에서 destination이 null이 되면 schedule 없이 cancel만 호출한다', async () => {
    const { rerender } = renderHook(
      (props: { destination: Station | null }) =>
        useScheduledAlarms({
          route: ROUTE,
          destination: props.destination,
          arrival: ARRIVAL,
        }),
      { initialProps: { destination: DESTINATION as Station | null } },
    );
    await flush();
    await act(async () => {
      appStateCallback?.('background');
      await Promise.resolve();
      await Promise.resolve();
    });
    mockedSchedule.mockClear();
    mockedCancel.mockClear();

    rerender({ destination: null });
    await flush();

    expect(mockedCancel).toHaveBeenCalled();
    expect(mockedSchedule).not.toHaveBeenCalled();
  });

  it('arrival이 null이면 nextStationEtaSeconds=null로 위임한다', async () => {
    renderHook(() =>
      useScheduledAlarms({ route: ROUTE, destination: DESTINATION, arrival: null }),
    );
    await flush();
    await act(async () => {
      appStateCallback?.('background');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockedSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ nextStationEtaSeconds: null }),
    );
  });

  it('arrival이 mock이면 nextStationEtaSeconds=null로 위임한다', async () => {
    const mockArrival: StationArrival = { ...ARRIVAL, isMock: true };
    renderHook(() =>
      useScheduledAlarms({ route: ROUTE, destination: DESTINATION, arrival: mockArrival }),
    );
    await flush();
    await act(async () => {
      appStateCallback?.('background');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockedSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ nextStationEtaSeconds: null }),
    );
  });

  it('trainCode가 빈 문자열이면 stamp.usedTrainCode는 null로 위임한다', async () => {
    const noTrainCode: StationArrival = {
      ...ARRIVAL,
      up: [{ ...ARRIVAL.up[0], trainCode: '' }],
      down: [],
    };
    renderHook(() =>
      useScheduledAlarms({ route: ROUTE, destination: DESTINATION, arrival: noTrainCode }),
    );
    await flush();
    await act(async () => {
      appStateCallback?.('background');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockedSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        stamp: { direction: 'up', usedTrainCode: null },
      }),
    );
  });

  it('arrival의 모든 arrivalSeconds가 0 이하면 null로 위임한다', async () => {
    const stale: StationArrival = {
      up: [{ ...ARRIVAL.up[0], arrivalSeconds: 0 }],
      down: [{ ...ARRIVAL.down[0], arrivalSeconds: -10 }],
    };
    renderHook(() =>
      useScheduledAlarms({ route: ROUTE, destination: DESTINATION, arrival: stale }),
    );
    await flush();
    await act(async () => {
      appStateCallback?.('background');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockedSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ nextStationEtaSeconds: null }),
    );
  });

  it('언마운트 시 예약을 모두 취소하고 AppState listener를 제거한다', async () => {
    const { unmount } = renderHook(() =>
      useScheduledAlarms({ route: ROUTE, destination: DESTINATION, arrival: ARRIVAL }),
    );
    await flush();
    mockedCancel.mockClear();

    unmount();

    expect(mockedCancel).toHaveBeenCalled();
    expect(mockRemove).toHaveBeenCalled();
  });

  it('route가 null이면 background에서도 schedule을 호출하지 않는다', async () => {
    renderHook(() =>
      useScheduledAlarms({ route: null, destination: DESTINATION, arrival: ARRIVAL }),
    );
    await flush();
    mockedCancel.mockClear();

    await act(async () => {
      appStateCallback?.('background');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockedCancel).toHaveBeenCalled();
    expect(mockedSchedule).not.toHaveBeenCalled();
  });

  it('cancelScheduledAlarms 실패는 hook을 throw시키지 않는다 (입력 변동/언마운트 경로)', async () => {
    mockedCancel.mockRejectedValue(new Error('cancel fail'));
    const { unmount } = renderHook(() =>
      useScheduledAlarms({ route: ROUTE, destination: DESTINATION, arrival: ARRIVAL }),
    );
    await flush();
    unmount();
    await flush();
    expect(true).toBe(true);
  });

  it('cancelScheduledAlarms 실패는 active 전환 경로에서도 throw하지 않는다', async () => {
    renderHook(() =>
      useScheduledAlarms({ route: ROUTE, destination: DESTINATION, arrival: ARRIVAL }),
    );
    await flush();
    await act(async () => {
      appStateCallback?.('background');
      await Promise.resolve();
      await Promise.resolve();
    });

    // 다음 cancel 호출(=active 전환)만 실패시킨다.
    mockedCancel.mockRejectedValueOnce(new Error('active cancel fail'));
    await act(async () => {
      appStateCallback?.('active');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(true).toBe(true);
  });

  it('scheduleAlarmsForRoute 실패는 background 전환 경로에서 throw하지 않는다', async () => {
    mockedSchedule.mockRejectedValueOnce(new Error('schedule fail'));
    renderHook(() =>
      useScheduledAlarms({ route: ROUTE, destination: DESTINATION, arrival: ARRIVAL }),
    );
    await flush();
    await act(async () => {
      appStateCallback?.('background');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(true).toBe(true);
  });
});
