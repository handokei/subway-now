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
      (AsyncStorage.getItem as jest.Mock).mockImplementation((key) => {
        if (key === 'subway-now:destination') return Promise.resolve(JSON.stringify(destination));
        return Promise.resolve(null);
      });
      const result = await getCallback()();
      expect(result).toBe(BackgroundTask.BackgroundTaskResult.Success);
      expect(mockScheduleAlarmsForRoute).not.toHaveBeenCalled();
    });

    it('destination JSON 파싱 실패 시 Success(no-op) 반환', async () => {
      (AsyncStorage.getItem as jest.Mock).mockImplementation((key) => {
        if (key === 'subway-now:destination') return Promise.resolve('not-json{');
        if (key === 'subway-now:route') return Promise.resolve(JSON.stringify(route));
        return Promise.resolve(null);
      });
      const result = await getCallback()();
      expect(result).toBe(BackgroundTask.BackgroundTaskResult.Success);
      expect(mockScheduleAlarmsForRoute).not.toHaveBeenCalled();
    });

    it('destination.name이 비어 있으면 스킵한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockImplementation((key) => {
        if (key === 'subway-now:destination') return Promise.resolve(JSON.stringify({ id: 'x' }));
        if (key === 'subway-now:route') return Promise.resolve(JSON.stringify(route));
        return Promise.resolve(null);
      });
      const result = await getCallback()();
      expect(result).toBe(BackgroundTask.BackgroundTaskResult.Success);
      expect(mockScheduleAlarmsForRoute).not.toHaveBeenCalled();
    });

    it('활성 트립이 있고 현재역이 없으면 nextStationEtaSeconds=null로 스케줄러 호출', async () => {
      (AsyncStorage.getItem as jest.Mock).mockImplementation((key) => {
        if (key === 'subway-now:destination') return Promise.resolve(JSON.stringify(destination));
        if (key === 'subway-now:route') return Promise.resolve(JSON.stringify(route));
        if (key === 'subway-now:last-notified-station') return Promise.resolve(null);
        return Promise.resolve(null);
      });
      const result = await getCallback()();
      expect(result).toBe(BackgroundTask.BackgroundTaskResult.Success);
      expect(mockFetchArrivalInfo).not.toHaveBeenCalled();
      expect(mockScheduleAlarmsForRoute).toHaveBeenCalledWith({
        route,
        destinationName: '시청',
        nextStationEtaSeconds: null,
      });
    });

    it('현재역이 있으면 Arrival API의 up/down 중 가장 짧은 양수 ETA를 사용한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockImplementation((key) => {
        if (key === 'subway-now:destination') return Promise.resolve(JSON.stringify(destination));
        if (key === 'subway-now:route') return Promise.resolve(JSON.stringify(route));
        if (key === 'subway-now:last-notified-station') return Promise.resolve('station-1');
        return Promise.resolve(null);
      });
      mockFetchArrivalInfo.mockResolvedValue({
        up: [{ arrivalSeconds: 600 }, { arrivalSeconds: 1200 }],
        down: [{ arrivalSeconds: 300 }],
      });
      await getCallback()();
      expect(mockFetchArrivalInfo).toHaveBeenCalledWith('강남');
      expect(mockScheduleAlarmsForRoute).toHaveBeenCalledWith({
        route,
        destinationName: '시청',
        nextStationEtaSeconds: 300,
      });
    });

    it('Arrival API가 모두 0/음수면 nextStationEtaSeconds=null', async () => {
      (AsyncStorage.getItem as jest.Mock).mockImplementation((key) => {
        if (key === 'subway-now:destination') return Promise.resolve(JSON.stringify(destination));
        if (key === 'subway-now:route') return Promise.resolve(JSON.stringify(route));
        if (key === 'subway-now:last-notified-station') return Promise.resolve('station-1');
        return Promise.resolve(null);
      });
      mockFetchArrivalInfo.mockResolvedValue({
        up: [{ arrivalSeconds: 0 }],
        down: [{ arrivalSeconds: -1 }],
      });
      await getCallback()();
      expect(mockScheduleAlarmsForRoute).toHaveBeenCalledWith({
        route,
        destinationName: '시청',
        nextStationEtaSeconds: null,
      });
    });

    it('LAST_NOTIFIED_STATION id가 stations.json에 없으면 currentStation은 null', async () => {
      (AsyncStorage.getItem as jest.Mock).mockImplementation((key) => {
        if (key === 'subway-now:destination') return Promise.resolve(JSON.stringify(destination));
        if (key === 'subway-now:route') return Promise.resolve(JSON.stringify(route));
        if (key === 'subway-now:last-notified-station') return Promise.resolve('unknown-id');
        return Promise.resolve(null);
      });
      await getCallback()();
      expect(mockFetchArrivalInfo).not.toHaveBeenCalled();
      expect(mockScheduleAlarmsForRoute).toHaveBeenCalledWith({
        route,
        destinationName: '시청',
        nextStationEtaSeconds: null,
      });
    });

    it('Arrival API 호출이 실패해도 static fallback으로 스케줄러를 호출한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockImplementation((key) => {
        if (key === 'subway-now:destination') return Promise.resolve(JSON.stringify(destination));
        if (key === 'subway-now:route') return Promise.resolve(JSON.stringify(route));
        if (key === 'subway-now:last-notified-station') return Promise.resolve('station-1');
        return Promise.resolve(null);
      });
      mockFetchArrivalInfo.mockRejectedValue(new Error('network'));
      const result = await getCallback()();
      expect(result).toBe(BackgroundTask.BackgroundTaskResult.Success);
      expect(mockScheduleAlarmsForRoute).toHaveBeenCalledWith({
        route,
        destinationName: '시청',
        nextStationEtaSeconds: null,
      });
    });

    it('스케줄러가 throw 하면 Failed를 반환한다', async () => {
      (AsyncStorage.getItem as jest.Mock).mockImplementation((key) => {
        if (key === 'subway-now:destination') return Promise.resolve(JSON.stringify(destination));
        if (key === 'subway-now:route') return Promise.resolve(JSON.stringify(route));
        return Promise.resolve(null);
      });
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
