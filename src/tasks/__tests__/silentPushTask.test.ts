jest.mock('expo-task-manager', () => ({
  defineTask: (name: string, callback: Function) => {
    (global as any).__silentPushTaskName = name;
    (global as any).__silentPushTaskCb = callback;
  },
}));

const mockRegisterTaskAsync = jest.fn();
jest.mock('expo-notifications', () => ({
  registerTaskAsync: (...args: unknown[]) => mockRegisterTaskAsync(...args),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

const mockSchedule = jest.fn();
const mockCancel = jest.fn();
jest.mock('../../utils/alarmScheduler', () => ({
  scheduleAlarmsForRoute: (...args: unknown[]) => mockSchedule(...args),
  cancelScheduledAlarms: (...args: unknown[]) => mockCancel(...args),
}));

jest.mock('../../utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  extractPayload,
  handleSilentPush,
  registerSilentPushTask,
  SILENT_PUSH_TASK,
} from '../silentPushTask';
import { DESTINATION_KEY, ROUTE_KEY } from '../../constants/storageKeys';

const destStation = { id: '0228', name: '강남', line: '2', lat: 37.5, lng: 127.0 };
const route = { type: 'direct', stops: 5, line: '2' };

function reschedulePayload(extra: Record<string, unknown> = {}) {
  return {
    data: {
      notification: {
        data: {
          nextWaypoint: '강남',
          etaSeconds: 300,
          phase: 'early',
          ...extra,
        },
      },
    },
  };
}

describe('silentPushTask', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSchedule.mockResolvedValue([{ identifier: 'alarm:early:강남' }]);
    mockCancel.mockResolvedValue(undefined);
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
      if (key === DESTINATION_KEY) return JSON.stringify(destStation);
      if (key === ROUTE_KEY) return JSON.stringify(route);
      return null;
    });
  });

  it('defineTask가 SILENT_PUSH_TASK 이름으로 콜백을 등록한다', () => {
    expect((global as any).__silentPushTaskName).toBe(SILENT_PUSH_TASK);
    expect(typeof (global as any).__silentPushTaskCb).toBe('function');
  });

  describe('extractPayload', () => {
    it('data 자체가 falsy면 null', () => {
      expect(extractPayload(undefined)).toBeNull();
    });

    it('notification 없으면 null', () => {
      expect(extractPayload({})).toBeNull();
    });

    it('data 위치(notification.data) 우선', () => {
      expect(
        extractPayload({
          notification: {
            data: { nextWaypoint: 'A', etaSeconds: 1, phase: 'early' },
          },
        }),
      ).toEqual({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early' });
    });

    it('data 없을 때 request.content.data 폴백', () => {
      expect(
        extractPayload({
          notification: {
            request: {
              content: { data: { nextWaypoint: 'B', etaSeconds: 2, phase: 'imminent' } },
            },
          },
        }),
      ).toEqual({ nextWaypoint: 'B', etaSeconds: 2, phase: 'imminent' });
    });

    it('raw가 객체가 아니면 null', () => {
      expect(
        extractPayload({ notification: { data: 'string' as unknown as Record<string, unknown> } }),
      ).toBeNull();
    });

    it('nextWaypoint 누락/비문자열/빈문자열이면 null', () => {
      expect(
        extractPayload({
          notification: { data: { nextWaypoint: '', etaSeconds: 1, phase: 'early' } },
        }),
      ).toBeNull();
      expect(
        extractPayload({
          notification: { data: { nextWaypoint: 123, etaSeconds: 1, phase: 'early' } },
        }),
      ).toBeNull();
    });

    it('etaSeconds 비숫자/Infinity이면 null', () => {
      expect(
        extractPayload({
          notification: { data: { nextWaypoint: 'A', etaSeconds: '1', phase: 'early' } },
        }),
      ).toBeNull();
      expect(
        extractPayload({
          notification: {
            data: { nextWaypoint: 'A', etaSeconds: Infinity, phase: 'early' },
          },
        }),
      ).toBeNull();
    });

    it('phase가 early/imminent가 아니면 null', () => {
      expect(
        extractPayload({
          notification: { data: { nextWaypoint: 'A', etaSeconds: 1, phase: 'late' } },
        }),
      ).toBeNull();
    });
  });

  describe('handleSilentPush', () => {
    it('error 있으면 즉시 종료', async () => {
      await handleSilentPush({ error: { message: 'boom' } });
      expect(mockSchedule).not.toHaveBeenCalled();
      expect(mockCancel).not.toHaveBeenCalled();
    });

    it('payload 없으면 skip', async () => {
      await handleSilentPush({ data: undefined });
      expect(mockSchedule).not.toHaveBeenCalled();
    });

    it('invalid payload면 skip', async () => {
      await handleSilentPush({
        data: { notification: { data: { trigger: 'other' } } },
      });
      expect(mockSchedule).not.toHaveBeenCalled();
    });

    it('destination/route AsyncStorage에 없으면 skip', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
      await handleSilentPush(reschedulePayload());
      expect(mockCancel).not.toHaveBeenCalled();
      expect(mockSchedule).not.toHaveBeenCalled();
    });

    it('정상: cancel 후 etaSeconds 로 reschedule', async () => {
      await handleSilentPush(reschedulePayload({ etaSeconds: 420 }));
      expect(mockCancel).toHaveBeenCalledTimes(1);
      expect(mockSchedule).toHaveBeenCalledWith({
        route,
        destinationName: '강남',
        nextStationEtaSeconds: 420,
      });
    });

    it('AsyncStorage 손상된 JSON이면 skip', async () => {
      (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
        if (key === DESTINATION_KEY) return 'not-json{';
        if (key === ROUTE_KEY) return JSON.stringify(route);
        return null;
      });
      await handleSilentPush(reschedulePayload());
      expect(mockSchedule).not.toHaveBeenCalled();
    });

    it('parse 결과 falsy(null)면 schedule 호출 안 함', async () => {
      (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
        if (key === DESTINATION_KEY) return JSON.stringify(destStation);
        if (key === ROUTE_KEY) return 'null';
        return null;
      });
      await handleSilentPush(reschedulePayload());
      expect(mockSchedule).not.toHaveBeenCalled();
    });

    it('schedule 내부 throw 시 graceful (throw 안 함)', async () => {
      mockSchedule.mockRejectedValue(new Error('boom'));
      await expect(handleSilentPush(reschedulePayload())).resolves.toBeUndefined();
    });
  });

  describe('registerSilentPushTask', () => {
    it('Notifications.registerTaskAsync 호출', async () => {
      mockRegisterTaskAsync.mockResolvedValue(undefined);
      await registerSilentPushTask();
      expect(mockRegisterTaskAsync).toHaveBeenCalledWith(SILENT_PUSH_TASK);
    });

    it('register 실패 시 throw 안 함', async () => {
      mockRegisterTaskAsync.mockRejectedValue(new Error('not supported'));
      await expect(registerSilentPushTask()).resolves.toBeUndefined();
    });
  });
});
