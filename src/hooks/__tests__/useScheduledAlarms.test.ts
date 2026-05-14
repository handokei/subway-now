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
      useScheduledAlarms({ route: ROUTE, destination: DESTINATION, currentStation: null, arrival: ARRIVAL }),
    );
    await flush();

    expect(mockedCancel).toHaveBeenCalled();
    expect(mockedSchedule).not.toHaveBeenCalled();
  });

  it('background 전환 시 마지막 ETA로 재예약한다', async () => {
    renderHook(() =>
      useScheduledAlarms({ route: ROUTE, destination: DESTINATION, currentStation: null, arrival: ARRIVAL }),
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
      currentStationApproachEtaSeconds: 300, // min(300, 420)
    });
  });

  it('active 복귀 시 예약을 모두 취소하고 재예약하지 않는다', async () => {
    renderHook(() =>
      useScheduledAlarms({ route: ROUTE, destination: DESTINATION, currentStation: null, arrival: ARRIVAL }),
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
      useScheduledAlarms({ route: ROUTE, destination: DESTINATION, currentStation: null, arrival: ARRIVAL }),
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
      useScheduledAlarms({ route: ROUTE, destination: DESTINATION, currentStation: null, arrival: ARRIVAL }),
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
          currentStation: null,
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
      expect.objectContaining({ currentStationApproachEtaSeconds: 150 }),
    );
  });

  it('background에서 destination이 null이 되면 schedule 없이 cancel만 호출한다', async () => {
    const { rerender } = renderHook(
      (props: { destination: Station | null }) =>
        useScheduledAlarms({
          route: ROUTE,
          destination: props.destination,
          currentStation: null,
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

  it('arrival이 null이면 currentStationApproachEtaSeconds=null로 위임한다', async () => {
    renderHook(() =>
      useScheduledAlarms({ route: ROUTE, destination: DESTINATION, currentStation: null, arrival: null }),
    );
    await flush();
    await act(async () => {
      appStateCallback?.('background');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockedSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ currentStationApproachEtaSeconds: null }),
    );
  });

  it('arrival이 mock이면 currentStationApproachEtaSeconds=null로 위임한다', async () => {
    const mockArrival: StationArrival = { ...ARRIVAL, isMock: true };
    renderHook(() =>
      useScheduledAlarms({ route: ROUTE, destination: DESTINATION, currentStation: null, arrival: mockArrival }),
    );
    await flush();
    await act(async () => {
      appStateCallback?.('background');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockedSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ currentStationApproachEtaSeconds: null }),
    );
  });

  it('arrival의 모든 arrivalSeconds가 0 이하면 null로 위임한다', async () => {
    const stale: StationArrival = {
      up: [{ ...ARRIVAL.up[0], arrivalSeconds: 0 }],
      down: [{ ...ARRIVAL.down[0], arrivalSeconds: -10 }],
    };
    renderHook(() =>
      useScheduledAlarms({ route: ROUTE, destination: DESTINATION, currentStation: null, arrival: stale }),
    );
    await flush();
    await act(async () => {
      appStateCallback?.('background');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockedSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ currentStationApproachEtaSeconds: null }),
    );
  });

  it('언마운트 시 예약을 모두 취소하고 AppState listener를 제거한다', async () => {
    const { unmount } = renderHook(() =>
      useScheduledAlarms({ route: ROUTE, destination: DESTINATION, currentStation: null, arrival: ARRIVAL }),
    );
    await flush();
    mockedCancel.mockClear();

    unmount();

    expect(mockedCancel).toHaveBeenCalled();
    expect(mockRemove).toHaveBeenCalled();
  });

  it('route가 null이면 background에서도 schedule을 호출하지 않는다', async () => {
    renderHook(() =>
      useScheduledAlarms({ route: null, destination: DESTINATION, currentStation: null, arrival: ARRIVAL }),
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
      useScheduledAlarms({ route: ROUTE, destination: DESTINATION, currentStation: null, arrival: ARRIVAL }),
    );
    await flush();
    unmount();
    await flush();
    expect(true).toBe(true);
  });

  it('cancelScheduledAlarms 실패는 active 전환 경로에서도 throw하지 않는다', async () => {
    renderHook(() =>
      useScheduledAlarms({ route: ROUTE, destination: DESTINATION, currentStation: null, arrival: ARRIVAL }),
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

  it('진행 방향이 "down"으로 판정되면 arrival.down ETA만 schedule에 전달한다 (반대방향 ETA 폐기)', async () => {
    // 회귀: 반대방향 열차가 빨라도 사용자 방향 ETA를 채택해야 한다.
    const WRONG_FAST_RIGHT_SLOW: StationArrival = {
      up: [{ ...ARRIVAL.up[0], arrivalSeconds: 30 }], // 반대방향(서쪽), 30초 후
      down: [{ ...ARRIVAL.down[0], arrivalSeconds: 240 }], // 진행방향(동쪽), 240초 후
    };
    const ROUTE_L1: DirectRoute = { type: 'direct', stops: 10, line: '1' };
    const DEST_L1: Station = {
      id: '1-034', name: '서울역', line: '1', lat: 37.55, lng: 126.97, lineColor: '#0052A4',
    };
    const CURRENT_L1: Station = {
      id: '1-001', name: '소요산', line: '1', lat: 37.95, lng: 127.06, lineColor: '#0052A4',
    };
    renderHook(() =>
      useScheduledAlarms({
        route: ROUTE_L1,
        destination: DEST_L1,
        currentStation: CURRENT_L1,
        arrival: WRONG_FAST_RIGHT_SLOW,
      }),
    );
    await flush();
    await act(async () => {
      appStateCallback?.('background');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockedSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ currentStationApproachEtaSeconds: 240 }),
    );
  });

  it('진행 방향이 "up"이면 arrival.up ETA만 schedule에 전달한다', async () => {
    const RIGHT_UP: StationArrival = {
      up: [{ ...ARRIVAL.up[0], arrivalSeconds: 180 }],
      down: [{ ...ARRIVAL.down[0], arrivalSeconds: 60 }],
    };
    const ROUTE_L1: DirectRoute = { type: 'direct', stops: 10, line: '1' };
    const DEST_L1: Station = {
      id: '1-001', name: '소요산', line: '1', lat: 37.95, lng: 127.06, lineColor: '#0052A4',
    };
    const CURRENT_L1: Station = {
      id: '1-034', name: '서울역', line: '1', lat: 37.55, lng: 126.97, lineColor: '#0052A4',
    };
    renderHook(() =>
      useScheduledAlarms({
        route: ROUTE_L1,
        destination: DEST_L1,
        currentStation: CURRENT_L1,
        arrival: RIGHT_UP,
      }),
    );
    await flush();
    await act(async () => {
      appStateCallback?.('background');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockedSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ currentStationApproachEtaSeconds: 180 }),
    );
  });

  it('currentStation이 노선 외(direction null)면 양방향 합산 fallback으로 위임한다', async () => {
    const ROUTE_L1: DirectRoute = { type: 'direct', stops: 10, line: '1' };
    const DEST_L1: Station = {
      id: '1-034', name: '서울역', line: '1', lat: 37.55, lng: 126.97, lineColor: '#0052A4',
    };
    // 다른 노선 station을 current로 → direction null
    const OFF_LINE: Station = {
      id: '7-015', name: '용마산', line: '7', lat: 37.57, lng: 127.08, lineColor: '#747F00',
    };
    renderHook(() =>
      useScheduledAlarms({
        route: ROUTE_L1,
        destination: DEST_L1,
        currentStation: OFF_LINE,
        arrival: ARRIVAL, // up=300, down=420
      }),
    );
    await flush();
    await act(async () => {
      appStateCallback?.('background');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockedSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ currentStationApproachEtaSeconds: 300 }),
    );
  });

  it('scheduleAlarmsForRoute 실패는 background 전환 경로에서 throw하지 않는다', async () => {
    mockedSchedule.mockRejectedValueOnce(new Error('schedule fail'));
    renderHook(() =>
      useScheduledAlarms({ route: ROUTE, destination: DESTINATION, currentStation: null, arrival: ARRIVAL }),
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
