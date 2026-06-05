import { renderHook } from '@testing-library/react-native';
import { act } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useScheduledAlarms } from '../useScheduledAlarms';
import {
  scheduleAlarmsForRoute,
  cancelScheduledAlarms,
} from '../../utils/alarmScheduler';
import { TRIP_TRAIN_CODE_KEY } from '../../../../shared/constants/storageKeys';
import type { Station } from '../../../../shared/types/station';
import type { StationArrival } from '../../../../shared/types/arrival';
import { makeDirectRoute } from '../../../../testUtils/routeFixtures';

jest.mock('../../utils/alarmScheduler');
jest.mock('../../../../shared/utils/logger', () => ({
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

const ROUTE = makeDirectRoute(10, '1');
const DESTINATION: Station = {
  id: 'dest-1',
  name: '강남',
  line: '2',
  lat: 37.5,
  lng: 127.0,
  lineColor: '#000',
};

// Line 1 fixtures — 방향 판정 테스트 공유. 같은 stations.json ordinal 위에서 up/down을 모두 표현.
const LINE_1_ROUTE = makeDirectRoute(10, '1');
const SEOUL_STATION: Station = {
  id: '1-034', name: '서울역', line: '1', lat: 37.55, lng: 126.97, lineColor: '#0052A4',
};
const SOYOSAN: Station = {
  id: '1-001', name: '소요산', line: '1', lat: 37.95, lng: 127.06, lineColor: '#0052A4',
};
const ARRIVAL: StationArrival = {
  up: [
    {
      destination: '상행',
      arrivalMinutes: 5,
      arrivalSeconds: 300,
      statusMessage: '',
      trainCode: 'U1',
      line: '1',
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
      line: '1',
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
  beforeEach(async () => {
    jest.clearAllMocks();
    appStateCallback = null;
    mockedSchedule.mockResolvedValue([]);
    mockedCancel.mockResolvedValue();
    // 초기 AppState는 active로 가정 — RN 기본값.
    (AppState as { currentState: string }).currentState = 'active';
    // trainCode lock-in 잔여 상태가 다음 테스트로 누수되지 않도록 정리.
    await AsyncStorage.removeItem(TRIP_TRAIN_CODE_KEY);
  });

  it('마운트 시 active 상태에서도 schedule을 호출한다 (#383)', async () => {
    // #383: AppState='active'에서 schedule을 skip하던 정책 제거.
    // FG에서도 사전 예약을 등록해 BG 진입 race를 차단한다.
    renderHook(() =>
      useScheduledAlarms({ route: ROUTE, destination: DESTINATION, currentStation: null, arrival: ARRIVAL }),
    );
    await flush();

    expect(mockedCancel).toHaveBeenCalled();
    expect(mockedSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ currentStationApproachEtaSeconds: 300 }),
    );
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
      currentStationApproachEtaSeconds: 300, // min(300, 420), currentStation=null → 양방향 fallback
      // stamp.direction은 route-resolved intent — currentStation=null이므로 null로 기록.
      // trainCode는 fallback에서 pick된 up arrival(300 < 420)의 'U1'.
      stamp: { direction: null, usedTrainCode: 'U1' },
    });
  });

  it('active 복귀 전환은 schedule/cancel을 트리거하지 않는다 (#383)', async () => {
    // #383: 'active' 진입 시 cancel하던 정책 제거. 이미 예약된 알람은 FG에서도 유지되며,
    // FG GPS firing과의 중복은 scheduledAlarmReceiver의 FIRED_ALARMS dedup으로 처리.
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

    expect(mockedCancel).not.toHaveBeenCalled();
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

  it('trainCode가 빈 문자열이면 stamp.usedTrainCode는 null로 위임한다', async () => {
    const noTrainCode: StationArrival = {
      ...ARRIVAL,
      up: [{ ...ARRIVAL.up[0], trainCode: '' }],
      down: [],
    };
    renderHook(() =>
      useScheduledAlarms({ route: ROUTE, destination: DESTINATION, currentStation: null, arrival: noTrainCode }),
    );
    await flush();
    await act(async () => {
      appStateCallback?.('background');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockedSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        // currentStation=null → route-resolved direction=null. trainCode=''는 null로 정규화.
        stamp: { direction: null, usedTrainCode: null },
      }),
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

  it('진행 방향이 "down"으로 판정되면 arrival.down ETA만 schedule에 전달한다 (반대방향 ETA 폐기)', async () => {
    // 회귀: 반대방향 열차가 빨라도 사용자 방향 ETA를 채택해야 한다.
    const WRONG_FAST_RIGHT_SLOW: StationArrival = {
      up: [{ ...ARRIVAL.up[0], arrivalSeconds: 30 }], // 반대방향(서쪽), 30초 후
      down: [{ ...ARRIVAL.down[0], arrivalSeconds: 240 }], // 진행방향(동쪽), 240초 후
    };
    const ROUTE_L1 = makeDirectRoute(10, '1');
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
    const ROUTE_L1 = makeDirectRoute(10, '1');
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
    const ROUTE_L1 = makeDirectRoute(10, '1');
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

  it('lock-in: 첫 reschedule에서 destinationId + 사용자 방향 첫 trainCode를 저장한다', async () => {
    renderHook(() =>
      useScheduledAlarms({
        route: LINE_1_ROUTE,
        destination: SEOUL_STATION,
        currentStation: SOYOSAN,
        arrival: ARRIVAL,
      }),
    );
    await flush();
    await act(async () => {
      appStateCallback?.('background');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await AsyncStorage.getItem(TRIP_TRAIN_CODE_KEY)).toBe('1-034:D1');
  });

  it('lock-in: FG(active) 상태에서도 lock-in 캡처 + schedule을 함께 수행한다 (#383)', async () => {
    // 초기 AppState = active. #383 이후로 FG에서도 schedule이 호출된다.
    renderHook(() =>
      useScheduledAlarms({
        route: LINE_1_ROUTE,
        destination: SEOUL_STATION,
        currentStation: SOYOSAN,
        arrival: ARRIVAL,
      }),
    );
    await flush();

    expect(await AsyncStorage.getItem(TRIP_TRAIN_CODE_KEY)).toBe('1-034:D1');
    expect(mockedSchedule).toHaveBeenCalled();
  });

  it('lock-in: 다음 reschedule은 저장된 trainCode를 사용해 결정론적 ETA 채택', async () => {
    // 미리 lock-in된 trainCode가 있는 상태에서 시작 (같은 destinationId)
    await AsyncStorage.setItem(TRIP_TRAIN_CODE_KEY, '1-034:D1');

    // 새 arrival에서 D1은 99초, 같은 방향에 더 빠른 D2(50초) 등장 — D1을 채택해야 함
    const NEXT: StationArrival = {
      up: [{ ...ARRIVAL.up[0], trainCode: 'U2', arrivalSeconds: 30 }],
      down: [
        { ...ARRIVAL.down[0], trainCode: 'D1', arrivalSeconds: 99 },
        { ...ARRIVAL.down[0], trainCode: 'D2', arrivalSeconds: 50 },
      ],
    };

    renderHook(() =>
      useScheduledAlarms({
        route: LINE_1_ROUTE,
        destination: SEOUL_STATION,
        currentStation: SOYOSAN,
        arrival: NEXT,
      }),
    );
    await flush();
    await act(async () => {
      appStateCallback?.('background');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockedSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ currentStationApproachEtaSeconds: 99 }),
    );
  });

  it('destination이 변하면 trainCode lock을 클리어한다', async () => {
    await AsyncStorage.setItem(TRIP_TRAIN_CODE_KEY, 'dest-1:OLD');
    const OTHER_DEST: Station = { ...DESTINATION, id: 'dest-2', name: '잠실' };

    const { rerender } = renderHook(
      (props: { destination: Station }) =>
        useScheduledAlarms({
          route: ROUTE,
          destination: props.destination,
          currentStation: null,
          arrival: ARRIVAL,
        }),
      { initialProps: { destination: DESTINATION } },
    );
    await flush();

    // 처음 마운트에서 prevDest === initial dest 이므로 클리어되지 않음 — OLD 유지
    expect(await AsyncStorage.getItem(TRIP_TRAIN_CODE_KEY)).toBe('dest-1:OLD');

    // destination 변경 → 다음 reschedule에서 OLD 클리어. 이어서 새 트립의 lock-in 캡처가
    // 같은 사이클에서 일어날 수 있으므로 raw 값을 null로 단정하지 말고, OLD 코드가
    // 더 이상 dest-1로 접근되지 않는지를 검증한다.
    rerender({ destination: OTHER_DEST });
    await flush();

    const raw = await AsyncStorage.getItem(TRIP_TRAIN_CODE_KEY);
    expect(raw?.startsWith('dest-1:')).not.toBe(true);
  });

  it('scheduleAlarmsForRoute 실패는 background 전환 경로에서 throw하지 않는다', async () => {
    // 마운트 시 input-change effect의 schedule 호출(첫 1회)은 성공시키고,
    // 그 다음의 background 전환 schedule 호출만 실패시켜 background catch를 검증한다.
    renderHook(() =>
      useScheduledAlarms({ route: ROUTE, destination: DESTINATION, currentStation: null, arrival: ARRIVAL }),
    );
    await flush();
    mockedSchedule.mockRejectedValueOnce(new Error('schedule fail'));
    await act(async () => {
      appStateCallback?.('background');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(true).toBe(true);
  });
});
