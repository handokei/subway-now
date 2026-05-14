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
}));

const mockScheduleAlarmsForRoute = jest.fn();
jest.mock('../../utils/alarmScheduler', () => ({
  scheduleAlarmsForRoute: (...args: unknown[]) => mockScheduleAlarmsForRoute(...args),
}));

const mockFetchArrivalInfo = jest.fn();
jest.mock('../../api/arrivalApi', () => ({
  fetchArrivalInfo: (...args: unknown[]) => mockFetchArrivalInfo(...args),
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
}) {
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
  };
  (AsyncStorage.getItem as jest.Mock).mockImplementation((key: string) =>
    Promise.resolve(key in map ? map[key] : null),
  );
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
