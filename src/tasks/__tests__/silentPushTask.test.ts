jest.mock('expo-task-manager', () => ({
  defineTask: (name: string, callback: Function) => {
    (global as any).__silentPushTaskName = name;
    (global as any).__silentPushTaskCb = callback;
  },
}));

const mockRegisterTaskAsync = jest.fn();
const mockScheduleNotificationAsync = jest.fn();
jest.mock('expo-notifications', () => ({
  registerTaskAsync: (...args: unknown[]) => mockRegisterTaskAsync(...args),
  scheduleNotificationAsync: (...args: unknown[]) => mockScheduleNotificationAsync(...args),
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

const mockLogSilentPushReceived = jest.fn();
jest.mock('../../utils/alarmLog', () => ({
  logSilentPushReceived: (...args: unknown[]) => mockLogSilentPushReceived(...args),
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

    it('kind=transfer/destination/intermediate면 그대로 전달', () => {
      const variants: ReadonlyArray<'transfer' | 'destination' | 'intermediate'> = [
        'transfer',
        'destination',
        'intermediate',
      ];
      for (const kind of variants) {
        expect(
          extractPayload({
            notification: { data: { nextWaypoint: 'A', etaSeconds: 1, phase: 'early', kind } },
          }),
        ).toEqual({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early', kind });
      }
    });

    it('kind가 알 수 없는 값이면 undefined로 정리 (legacy 호환)', () => {
      expect(
        extractPayload({
          notification: { data: { nextWaypoint: 'A', etaSeconds: 1, phase: 'early', kind: 'foo' } },
        }),
      ).toEqual({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early', kind: undefined });
    });

    it('sentAt이 number면 그대로 전달 (#478)', () => {
      expect(
        extractPayload({
          notification: {
            data: { nextWaypoint: 'A', etaSeconds: 1, phase: 'early', sentAt: 1_700_000_000_000 },
          },
        }),
      ).toEqual({
        nextWaypoint: 'A',
        etaSeconds: 1,
        phase: 'early',
        kind: undefined,
        sentAt: 1_700_000_000_000,
      });
    });

    it('sentAt이 비숫자/Infinity이면 undefined (구 백엔드 호환)', () => {
      expect(
        extractPayload({
          notification: {
            data: { nextWaypoint: 'A', etaSeconds: 1, phase: 'early', sentAt: 'now' },
          },
        }),
      ).toEqual({
        nextWaypoint: 'A',
        etaSeconds: 1,
        phase: 'early',
        kind: undefined,
        sentAt: undefined,
      });
      expect(
        extractPayload({
          notification: {
            data: { nextWaypoint: 'A', etaSeconds: 1, phase: 'early', sentAt: Infinity },
          },
        }),
      ).toEqual({
        nextWaypoint: 'A',
        etaSeconds: 1,
        phase: 'early',
        kind: undefined,
        sentAt: undefined,
      });
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
        currentStationApproachEtaSeconds: 420,
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

    it('kind=intermediate + phase=imminent → 즉시 알림 + reschedule 둘 다 호출 (#416)', async () => {
      mockScheduleNotificationAsync.mockResolvedValue('id');
      await handleSilentPush(
        reschedulePayload({ kind: 'intermediate', phase: 'imminent', nextWaypoint: '중곡' }),
      );
      expect(mockScheduleNotificationAsync).toHaveBeenCalledTimes(1);
      const call = mockScheduleNotificationAsync.mock.calls[0][0];
      // i18next mock가 기본 fallback으로 key 반환 또는 ko 로드 — 어느 쪽이든 station name이 body에 포함되어야 한다.
      expect(JSON.stringify(call.content.body)).toContain('중곡');
      expect(call.trigger).toBeNull();
      expect(mockSchedule).toHaveBeenCalled();
    });

    it('kind=intermediate + phase=early → 즉시 알림 안 함, reschedule만', async () => {
      await handleSilentPush(reschedulePayload({ kind: 'intermediate', phase: 'early' }));
      expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
      expect(mockSchedule).toHaveBeenCalled();
    });

    it('kind=destination + phase=imminent → 즉시 알림 안 함 (intermediate만 발사)', async () => {
      await handleSilentPush(reschedulePayload({ kind: 'destination', phase: 'imminent' }));
      expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
      expect(mockSchedule).toHaveBeenCalled();
    });

    it('수신 시 logSilentPushReceived 호출 — sentAt 포함 (#478)', async () => {
      await handleSilentPush(
        reschedulePayload({
          kind: 'transfer',
          phase: 'early',
          nextWaypoint: '건대입구',
          sentAt: 1_700_000_000_000,
        }),
      );
      expect(mockLogSilentPushReceived).toHaveBeenCalledTimes(1);
      const arg = mockLogSilentPushReceived.mock.calls[0][0];
      expect(arg.stationName).toBe('건대입구');
      expect(arg.kind).toBe('transfer');
      expect(arg.phaseId).toBe('early');
      expect(arg.sentAt).toBe(1_700_000_000_000);
      expect(typeof arg.receivedAt).toBe('number');
    });

    it('수신 시 logSilentPushReceived — 구 백엔드(sentAt 없음)도 호출, sentAt undefined', async () => {
      await handleSilentPush(reschedulePayload({ kind: 'destination', phase: 'imminent' }));
      expect(mockLogSilentPushReceived).toHaveBeenCalledTimes(1);
      const arg = mockLogSilentPushReceived.mock.calls[0][0];
      expect(arg.sentAt).toBeUndefined();
      expect(typeof arg.receivedAt).toBe('number');
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
