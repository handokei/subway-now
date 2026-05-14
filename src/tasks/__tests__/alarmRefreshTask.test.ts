// jest.mock 팩토리는 변수 호이스팅보다 먼저 실행되므로, 팩토리 외부 변수를 참조하면
// undefined가 된다. global 객체는 항상 접근 가능하므로 여기에 콜백을 저장한다.
jest.mock('expo-task-manager', () => ({
  defineTask: (name: string, callback: Function) => {
    (global as any).__bgRefreshCallback = callback;
    (global as any).__bgRefreshTaskName = name;
  },
  isTaskRegisteredAsync: jest.fn(),
}));

jest.mock('expo-background-task', () => ({
  registerTaskAsync: jest.fn(),
  unregisterTaskAsync: jest.fn(),
  BackgroundTaskResult: { Success: 1, Failed: 2 },
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

const mockScheduleAlarmsForRoute = jest.fn();
jest.mock('../../utils/alarmScheduler', () => ({
  scheduleAlarmsForRoute: (...args: unknown[]) => mockScheduleAlarmsForRoute(...args),
}));

const mockFetchArrivalInfo = jest.fn();
jest.mock('../../api/arrivalApi', () => ({
  fetchArrivalInfo: (...args: unknown[]) => mockFetchArrivalInfo(...args),
}));

const mockGetLastFiredAlarmStationName = jest.fn();
jest.mock('../../utils/notificationState', () => ({
  getLastFiredAlarmStationName: (...args: unknown[]) => mockGetLastFiredAlarmStationName(...args),
}));

jest.mock('../../data/stations.json', () => [
  { id: 'station-1', name: '강남', line: '2', lineColor: '#009246', lat: 0, lng: 0 },
  { id: 'station-2', name: '시청', line: '1', lineColor: '#0052A4', lat: 0, lng: 0 },
  // 방향 판정용 line '1' 추가 stations (id 정렬상 station-2 < station-3 < station-4)
  { id: 'station-3', name: '종각', line: '1', lineColor: '#0052A4', lat: 0, lng: 0 },
  { id: 'station-4', name: '종로3가', line: '1', lineColor: '#0052A4', lat: 0, lng: 0 },
]);

jest.mock('../../utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as TaskManager from 'expo-task-manager';
import * as BackgroundTask from 'expo-background-task';
import {
  ALARM_REFRESH_TASK,
  registerAlarmRefreshTask,
  unregisterAlarmRefreshTask,
} from '../alarmRefreshTask';

const route = { type: 'direct', stops: 10, line: '1' } as const;
const destination = {
  id: 'station-2',
  name: '시청',
  line: '1',
  lineColor: '#0052A4',
  lat: 0,
  lng: 0,
};

function getCallback(): () => Promise<number> {
  return (global as any).__bgRefreshCallback;
}

function mockStorage(values: {
  destination?: unknown;
  route?: unknown;
  lastStation?: string | null;
  tripTrainCode?: string | null;
}) {
  const destId =
    typeof values.destination === 'object' && values.destination && 'id' in values.destination
      ? (values.destination as { id: string }).id
      : 'station-2';
  const map: Record<string, string | null> = {
    'subway-now:destination':
      values.destination === undefined
        ? null
        : typeof values.destination === 'string'
          ? values.destination
          : JSON.stringify(values.destination),
    'subway-now:route':
      values.route === undefined ? null : JSON.stringify(values.route),
    'subway-now:last-notified-station': values.lastStation ?? null,
    // tripTrainCode는 destinationId:code 형식으로 저장됨
    'subway-now:trip-train-code': values.tripTrainCode
      ? `${destId}:${values.tripTrainCode}`
      : null,
  };
  (AsyncStorage.getItem as jest.Mock).mockImplementation((key: string) =>
    Promise.resolve(key in map ? map[key] : null),
  );
  (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);
  (AsyncStorage.removeItem as jest.Mock).mockResolvedValue(undefined);
}

const EMPTY_STAMP = {
  direction: null,
  usedTrainCode: null,
} as const;

function expectSchedulerCalledWith(
  currentStationApproachEtaSeconds: number | null,
  stamp: { direction: 'up' | 'down' | null; usedTrainCode: string | null } = EMPTY_STAMP,
) {
  expect(mockScheduleAlarmsForRoute).toHaveBeenCalledWith({
    route,
    destinationName: '시청',
    currentStationApproachEtaSeconds,
    stamp,
  });
}

describe('alarmRefreshTask', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLastFiredAlarmStationName.mockResolvedValue(null);
  });

  it('defineTask가 ALARM_REFRESH_TASK 이름으로 호출된다', () => {
    expect((global as any).__bgRefreshTaskName).toBe(ALARM_REFRESH_TASK);
    expect((global as any).__bgRefreshCallback).toBeDefined();
  });

  describe('태스크 콜백', () => {
    it('destination이 없으면 Success를 반환하고 스케줄러를 호출하지 않는다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
      const result = await getCallback()();
      expect(result).toBe(BackgroundTask.BackgroundTaskResult.Success);
      expect(mockScheduleAlarmsForRoute).not.toHaveBeenCalled();
      expect(mockFetchArrivalInfo).not.toHaveBeenCalled();
    });

    it('route가 없으면 스케줄러를 호출하지 않는다', async () => {
      mockStorage({ destination });
      const result = await getCallback()();
      expect(result).toBe(BackgroundTask.BackgroundTaskResult.Success);
      expect(mockScheduleAlarmsForRoute).not.toHaveBeenCalled();
    });

    it('destination JSON 파싱 실패 시 Success(no-op) 반환', async () => {
      mockStorage({ destination: 'not-json{', route });
      const result = await getCallback()();
      expect(result).toBe(BackgroundTask.BackgroundTaskResult.Success);
      expect(mockScheduleAlarmsForRoute).not.toHaveBeenCalled();
    });

    it('destination.name이 비어 있으면 스킵한다', async () => {
      mockStorage({ destination: { id: 'x' }, route });
      const result = await getCallback()();
      expect(result).toBe(BackgroundTask.BackgroundTaskResult.Success);
      expect(mockScheduleAlarmsForRoute).not.toHaveBeenCalled();
    });

    it('활성 트립이 있고 현재역이 없으면 currentStationApproachEtaSeconds=null로 스케줄러 호출', async () => {
      mockStorage({ destination, route, lastStation: null });
      const result = await getCallback()();
      expect(result).toBe(BackgroundTask.BackgroundTaskResult.Success);
      expect(mockFetchArrivalInfo).not.toHaveBeenCalled();
      expectSchedulerCalledWith(null);
    });

    it('현재역이 다른 노선(line 2)이면 direction null로 양방향 fallback ETA를 사용한다', async () => {
      // station-1(강남, line 2)은 route(line 1)에 없음 → resolveTripDirection=null → 양방향 합산.
      mockStorage({ destination, route, lastStation: 'station-1' });
      mockFetchArrivalInfo.mockResolvedValue({
        up: [{ arrivalSeconds: 600 }, { arrivalSeconds: 1200 }],
        down: [{ arrivalSeconds: 300 }],
      });
      await getCallback()();
      expect(mockFetchArrivalInfo).toHaveBeenCalledWith('강남');
      // direction=null filter → up/down 합산 best-effort. stamp.direction은 의도(null) 그대로.
      expectSchedulerCalledWith(300, { direction: null, usedTrainCode: null });
    });

    it('Arrival API가 모두 0/음수면 currentStationApproachEtaSeconds=null', async () => {
      mockStorage({ destination, route, lastStation: 'station-1' });
      mockFetchArrivalInfo.mockResolvedValue({
        up: [{ arrivalSeconds: 0 }],
        down: [{ arrivalSeconds: -1 }],
      });
      await getCallback()();
      expectSchedulerCalledWith(null);
    });

    it('LAST_NOTIFIED_STATION id가 stations.json에 없으면 currentStation은 null', async () => {
      mockStorage({ destination, route, lastStation: 'unknown-id' });
      await getCallback()();
      expect(mockFetchArrivalInfo).not.toHaveBeenCalled();
      expectSchedulerCalledWith(null);
    });

    it('Arrival API 호출이 실패해도 static fallback으로 스케줄러를 호출한다', async () => {
      mockStorage({ destination, route, lastStation: 'station-1' });
      mockFetchArrivalInfo.mockRejectedValue(new Error('network'));
      const result = await getCallback()();
      expect(result).toBe(BackgroundTask.BackgroundTaskResult.Success);
      expectSchedulerCalledWith(null);
    });

    it('진행 방향이 판정되면 해당 방향의 ETA만 사용한다 (반대방향 ETA 폐기)', async () => {
      // 현재역 종로3가(station-4, idx 2) → 시청(station-2, idx 0): up 방향
      mockStorage({ destination, route, lastStation: 'station-4' });
      mockFetchArrivalInfo.mockResolvedValue({
        up: [{ arrivalSeconds: 240 }], // 진행 방향
        down: [{ arrivalSeconds: 30 }], // 반대 방향 — 더 빠르지만 무시되어야 함
      });
      await getCallback()();
      expect(mockFetchArrivalInfo).toHaveBeenCalledWith('종로3가');
      expectSchedulerCalledWith(240, { direction: 'up', usedTrainCode: null });
    });

    it('진행 방향이 "down"이면 arrival.down ETA만 사용한다', async () => {
      // destination 종로3가(station-4, idx 2) 사용 — 현재 시청(idx 0) → 종로3가 = down 방향
      const destDown = { ...destination, id: 'station-4', name: '종로3가' };
      mockStorage({
        destination: destDown,
        route,
        lastStation: 'station-2',
      });
      mockFetchArrivalInfo.mockResolvedValue({
        up: [{ arrivalSeconds: 30 }], // 반대 방향
        down: [{ arrivalSeconds: 180 }], // 진행 방향
      });
      await getCallback()();
      expect(mockScheduleAlarmsForRoute).toHaveBeenCalledWith({
        route,
        destinationName: '종로3가',
        currentStationApproachEtaSeconds: 180,
        stamp: { direction: 'down', usedTrainCode: null },
      });
    });

    it('fired name이 stations.json에 없으면 GPS id 폴백 경로로 진입한다', async () => {
      mockStorage({ destination, route, lastStation: 'station-2' });
      mockGetLastFiredAlarmStationName.mockResolvedValueOnce('존재하지않는역');
      mockFetchArrivalInfo.mockResolvedValue({ up: [{ arrivalSeconds: 700 }], down: [] });
      await getCallback()();
      // fired name → no match → GPS station-2(시청) 사용
      expect(mockFetchArrivalInfo).toHaveBeenCalledWith('시청');
      expectSchedulerCalledWith(700);
    });

    it('사전 예약 알람 발화 이름이 있으면 GPS id를 무시하고 그 이름으로 Arrival API를 호출한다', async () => {
      // firedName='시청' → station-2(line 1) 매칭. resolveTripDirection: route line 1,
      // destination 시청, currIdx=nextIdx=0 → direction=null → 양방향 fallback ETA 사용.
      mockStorage({ destination, route, lastStation: 'station-1' });
      mockGetLastFiredAlarmStationName.mockResolvedValueOnce('시청');
      mockFetchArrivalInfo.mockResolvedValue({ up: [{ arrivalSeconds: 500 }], down: [] });
      await getCallback()();
      expect(mockFetchArrivalInfo).toHaveBeenCalledWith('시청');
      expectSchedulerCalledWith(500);
    });

    it('lock-in: trainCode가 저장되어 있지 않으면 첫 arrival의 방향-필터 trainCode를 저장한다', async () => {
      // 종로3가(idx 2) → 시청(idx 0): up 방향
      mockStorage({ destination, route, lastStation: 'station-4', tripTrainCode: null });
      mockFetchArrivalInfo.mockResolvedValue({
        up: [{ arrivalSeconds: 240, trainCode: 'T-UP-1' }],
        down: [{ arrivalSeconds: 30, trainCode: 'T-DN-1' }],
      });
      await getCallback()();
      // destination(station-2)의 id를 prefix로 저장. up 방향 min ETA의 trainCode 채택.
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        'subway-now:trip-train-code',
        'station-2:T-UP-1',
      );
    });

    it('lock-in: 저장된 trainCode가 있으면 같은 코드의 ETA를 결정론적으로 채택한다', async () => {
      mockStorage({
        destination,
        route,
        lastStation: 'station-4',
        tripTrainCode: 'T-UP-1',
      });
      // 새 응답: T-UP-1은 180초, 같은 방향에 더 빠른 T-UP-2(50초) 도착 — T-UP-1 채택
      mockFetchArrivalInfo.mockResolvedValue({
        up: [
          { arrivalSeconds: 180, trainCode: 'T-UP-1' },
          { arrivalSeconds: 50, trainCode: 'T-UP-2' },
        ],
        down: [{ arrivalSeconds: 30, trainCode: 'T-DN-1' }],
      });
      await getCallback()();
      expectSchedulerCalledWith(180, { direction: 'up', usedTrainCode: 'T-UP-1' });
      // 이미 저장된 코드라 trip-train-code key로 다시 setItem 호출하지 않는다
      expect(AsyncStorage.setItem).not.toHaveBeenCalledWith(
        'subway-now:trip-train-code',
        expect.anything(),
      );
    });

    it('lock-in: 저장된 trainCode가 응답에 없으면 방향 fallback ETA 사용', async () => {
      mockStorage({
        destination,
        route,
        lastStation: 'station-4',
        tripTrainCode: 'T-MISSING',
      });
      mockFetchArrivalInfo.mockResolvedValue({
        up: [{ arrivalSeconds: 240, trainCode: 'T-UP-1' }],
        down: [{ arrivalSeconds: 30, trainCode: 'T-DN-1' }],
      });
      await getCallback()();
      // T-MISSING은 매치 실패 → up 방향 min = 240, trainCode=T-UP-1로 stamp
      expectSchedulerCalledWith(240, { direction: 'up', usedTrainCode: 'T-UP-1' });
    });

    it('활성 트립이 없으면 저장된 trainCode를 클리어한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
      (AsyncStorage.removeItem as jest.Mock).mockResolvedValue(undefined);
      await getCallback()();
      expect(AsyncStorage.removeItem).toHaveBeenCalledWith('subway-now:trip-train-code');
    });

    it('스케줄러가 throw 하면 Failed를 반환한다', async () => {
      mockStorage({ destination, route });
      mockScheduleAlarmsForRoute.mockRejectedValueOnce(new Error('boom'));
      const result = await getCallback()();
      expect(result).toBe(BackgroundTask.BackgroundTaskResult.Failed);
    });
  });

  describe('registerAlarmRefreshTask', () => {
    it('이미 등록되어 있으면 재등록하지 않는다', async () => {
      (TaskManager.isTaskRegisteredAsync as jest.Mock).mockResolvedValueOnce(true);
      await registerAlarmRefreshTask();
      expect(BackgroundTask.registerTaskAsync).not.toHaveBeenCalled();
    });

    it('등록되어 있지 않으면 minimumInterval=15로 등록한다', async () => {
      (TaskManager.isTaskRegisteredAsync as jest.Mock).mockResolvedValueOnce(false);
      await registerAlarmRefreshTask();
      expect(BackgroundTask.registerTaskAsync).toHaveBeenCalledWith(
        ALARM_REFRESH_TASK,
        { minimumInterval: 15 },
      );
    });
  });

  describe('unregisterAlarmRefreshTask', () => {
    it('등록되어 있지 않으면 unregister를 호출하지 않는다', async () => {
      (TaskManager.isTaskRegisteredAsync as jest.Mock).mockResolvedValueOnce(false);
      await unregisterAlarmRefreshTask();
      expect(BackgroundTask.unregisterTaskAsync).not.toHaveBeenCalled();
    });

    it('등록되어 있으면 unregister를 호출한다', async () => {
      (TaskManager.isTaskRegisteredAsync as jest.Mock).mockResolvedValueOnce(true);
      await unregisterAlarmRefreshTask();
      expect(BackgroundTask.unregisterTaskAsync).toHaveBeenCalledWith(ALARM_REFRESH_TASK);
    });
  });
});
