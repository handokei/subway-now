// defineTask 콜백을 캡처해 직접 호출(다른 task 테스트와 동일 패턴).
jest.mock('expo-task-manager', () => ({
  defineTask: (name: string, callback: Function) => {
    (global as any).__regionPocTaskCallback = callback;
    (global as any).__regionPocTaskName = name;
  },
}));

const mockStartGeofencing = jest.fn();
const mockStopGeofencing = jest.fn();
const mockHasStarted = jest.fn();

jest.mock('expo-location', () => ({
  GeofencingEventType: { Enter: 1, Exit: 2 },
  startGeofencingAsync: (...args: unknown[]) => mockStartGeofencing(...args),
  stopGeofencingAsync: (...args: unknown[]) => mockStopGeofencing(...args),
  hasStartedGeofencingAsync: (...args: unknown[]) => mockHasStarted(...args),
}));

const mockLogRegionEntryFired = jest.fn();
jest.mock('../../utils/alarmLog', () => ({
  logRegionEntryFired: (...args: unknown[]) => mockLogRegionEntryFired(...args),
}));

jest.mock('../../utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import {
  REGION_POC_TASK,
  startRegionMonitoringPoc,
  stopRegionMonitoringPoc,
  getRegionPocStatus,
  __resetRegionPocStatusForTest,
  type PocRegion,
} from '../regionMonitoringPocTask';

const region: PocRegion = {
  identifier: '강남',
  latitude: 37.498,
  longitude: 127.028,
  radius: 150,
};

function getTaskCallback(): (body: unknown) => Promise<void> {
  return (global as any).__regionPocTaskCallback;
}

describe('regionMonitoringPocTask (#563 PoC)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetRegionPocStatusForTest();
  });

  it('defineTask가 REGION_POC_TASK 이름으로 등록된다', () => {
    expect((global as any).__regionPocTaskName).toBe(REGION_POC_TASK);
    expect(typeof getTaskCallback()).toBe('function');
  });

  it('초기 status는 unknown / error null / monitoredCount 0', () => {
    expect(getRegionPocStatus()).toEqual({
      state: 'unknown',
      error: null,
      monitoredCount: 0,
    });
  });

  it('__resetRegionPocStatusForTest가 success 상태를 unknown으로 되돌린다', async () => {
    mockStartGeofencing.mockResolvedValueOnce(undefined);
    await startRegionMonitoringPoc([region]);
    expect(getRegionPocStatus().state).toBe('success');
    __resetRegionPocStatusForTest();
    expect(getRegionPocStatus()).toEqual({
      state: 'unknown',
      error: null,
      monitoredCount: 0,
    });
  });

  describe('task callback', () => {
    it('error 페이로드면 조기 종료(throw 없음)', async () => {
      await expect(
        getTaskCallback()({ error: { message: 'boom' }, data: null }),
      ).resolves.toBeUndefined();
      expect(mockLogRegionEntryFired).not.toHaveBeenCalled();
    });

    it('data 없으면 조기 종료', async () => {
      await getTaskCallback()({ data: null });
      expect(mockLogRegionEntryFired).not.toHaveBeenCalled();
    });

    it('Enter 이벤트면 logRegionEntryFired를 호출한다', async () => {
      await getTaskCallback()({
        data: { eventType: 1, region: { identifier: '강남' } },
      });
      expect(mockLogRegionEntryFired).toHaveBeenCalledWith({
        stationName: '강남',
        kind: 'station-passed',
        phaseId: 'imminent',
      });
    });

    it('Enter 이벤트인데 region.identifier가 없으면 (unknown)으로 적재한다', async () => {
      await getTaskCallback()({
        data: { eventType: 1, region: {} },
      });
      expect(mockLogRegionEntryFired).toHaveBeenCalledWith({
        stationName: '(unknown)',
        kind: 'station-passed',
        phaseId: 'imminent',
      });
    });

    it('Exit 이벤트는 alarmLog에 적재하지 않는다(source 없음)', async () => {
      await getTaskCallback()({
        data: { eventType: 2, region: { identifier: '강남' } },
      });
      expect(mockLogRegionEntryFired).not.toHaveBeenCalled();
    });

    it('알 수 없는 eventType은 무시한다', async () => {
      await getTaskCallback()({
        data: { eventType: 99, region: { identifier: '강남' } },
      });
      expect(mockLogRegionEntryFired).not.toHaveBeenCalled();
    });
  });

  describe('startRegionMonitoringPoc', () => {
    it('startGeofencingAsync로 region 목록을 전달하고 status=success로 갱신', async () => {
      mockStartGeofencing.mockResolvedValueOnce(undefined);
      await startRegionMonitoringPoc([region]);
      expect(mockStartGeofencing).toHaveBeenCalledWith(REGION_POC_TASK, [
        {
          identifier: '강남',
          latitude: 37.498,
          longitude: 127.028,
          radius: 150,
          notifyOnEnter: true,
          notifyOnExit: true,
        },
      ]);
      expect(getRegionPocStatus()).toEqual({
        state: 'success',
        error: null,
        monitoredCount: 1,
      });
    });

    it('startGeofencingAsync 실패 시 Error 메시지를 status.error에 담는다', async () => {
      mockStartGeofencing.mockRejectedValueOnce(new Error('denied'));
      await startRegionMonitoringPoc([region]);
      expect(getRegionPocStatus()).toEqual({
        state: 'failed',
        error: 'denied',
        monitoredCount: 0,
      });
    });

    it('startGeofencingAsync 실패 시 Error가 아닌 값도 문자열로 포착', async () => {
      mockStartGeofencing.mockRejectedValueOnce('plain-string-error');
      await startRegionMonitoringPoc([region]);
      expect(getRegionPocStatus().error).toBe('plain-string-error');
    });
  });

  describe('stopRegionMonitoringPoc', () => {
    it('running=true면 stopGeofencingAsync를 호출하고 status를 reset', async () => {
      mockHasStarted.mockResolvedValueOnce(true);
      mockStopGeofencing.mockResolvedValueOnce(undefined);
      await stopRegionMonitoringPoc();
      expect(mockStopGeofencing).toHaveBeenCalledWith(REGION_POC_TASK);
      expect(getRegionPocStatus()).toEqual({
        state: 'unknown',
        error: null,
        monitoredCount: 0,
      });
    });

    it('running=false면 stop을 호출하지 않는다', async () => {
      mockHasStarted.mockResolvedValueOnce(false);
      await stopRegionMonitoringPoc();
      expect(mockStopGeofencing).not.toHaveBeenCalled();
    });

    it('stop 중 실패 시 status.error에 담는다', async () => {
      mockHasStarted.mockResolvedValueOnce(true);
      mockStopGeofencing.mockRejectedValueOnce(new Error('stop-boom'));
      await stopRegionMonitoringPoc();
      expect(getRegionPocStatus()).toEqual({
        state: 'failed',
        error: 'stop-boom',
        monitoredCount: 0,
      });
    });

    it('hasStartedGeofencingAsync 실패도 동일 경로로 처리', async () => {
      mockHasStarted.mockRejectedValueOnce('check-fail');
      await stopRegionMonitoringPoc();
      expect(getRegionPocStatus().error).toBe('check-fail');
    });
  });
});
