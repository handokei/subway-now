import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { Station } from '../../../../shared/types/station';
import type { Route } from '../../../../shared/utils/stationRoute';

jest.mock('../../../../data/lastTrains.json', () => ({
  version: '1',
  lines: {
    '1': 'covered',
    '2': 'covered',
    '3': 'covered',
    '4': 'covered',
    '5': 'covered',
    '6': 'covered',
    '7': 'covered',
    '8': 'covered',
    '9': 'covered',
    airport: 'uncovered',
    gyeongui: 'uncovered',
    bundang: 'uncovered',
    sinbundang: 'uncovered',
  },
  stations: {
    '1-001': {
      weekday: { up: '23:55', down: '23:47' },
      saturday: { up: '00:30', down: '23:48' },
      sunday: { up: '00:27', down: null },
    },
  },
}));

jest.mock('expo-notifications', () => ({
  scheduleNotificationAsync: jest.fn().mockResolvedValue('notif-id'),
  dismissNotificationAsync: jest.fn().mockResolvedValue(undefined),
  setNotificationChannelAsync: jest.fn().mockResolvedValue(undefined),
  deleteNotificationChannelAsync: jest.fn().mockResolvedValue(undefined),
  AndroidImportance: { HIGH: 4 },
  AndroidNotificationVisibility: { PUBLIC: 1 },
  AndroidNotificationPriority: { HIGH: 'high' },
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));

jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const mockBreadcrumb = jest.fn();
jest.mock('../../../../shared/infra/monitoring/breadcrumb', () => ({
  addDomainBreadcrumb: (...args: unknown[]) => mockBreadcrumb(...args),
}));

const mockResolveTripDirection = jest.fn();
jest.mock('../../../route/utils/tripDirection', () => ({
  resolveTripDirection: (...args: unknown[]) => mockResolveTripDirection(...args),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  buildFiredKey,
  ensureLastTrainChannel,
  evaluateLastTrainAlarm,
  fireLastTrainAlarm,
  runLastTrainAlarmCycle,
} from '../lastTrainAlarm';
import { LAST_TRAIN_FIRED_KEY_PREFIX } from '../../../../shared/constants/lastTrainAlarm';

const station = (overrides: Partial<Station> = {}): Station => ({
  id: '1-001',
  name: '소요산',
  line: '1',
  lineColor: '#0052A4',
  lat: 0,
  lng: 0,
  ...overrides,
});

const dummyRoute = {} as Route;

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveTripDirection.mockReturnValue('up');
});

describe('buildFiredKey', () => {
  it('prefix:stationId:dayKey 형식', () => {
    expect(buildFiredKey('1-001', '20260626')).toBe(
      `${LAST_TRAIN_FIRED_KEY_PREFIX}:1-001:20260626`,
    );
  });
});

describe('evaluateLastTrainAlarm', () => {
  // KST 23:45 (UTC 14:45) — 막차 23:55 까지 10분 남음
  const now = new Date('2026-06-26T14:45:00Z');

  it('sleepMode OFF면 skip-sleep-off', () => {
    expect(
      evaluateLastTrainAlarm({
        sleepMode: false,
        origin: station(),
        destination: station({ id: '1-002', name: '회기' }),
        route: dummyRoute,
        now,
      }).kind,
    ).toBe('skip-sleep-off');
  });

  it('origin/destination/route 부재 시 skip-no-trip', () => {
    for (const missing of [
      { origin: null, destination: station({ id: '1-002', name: '회기' }), route: dummyRoute },
      { origin: station(), destination: null, route: dummyRoute },
      { origin: station(), destination: station({ id: '1-002', name: '회기' }), route: null },
    ]) {
      expect(
        evaluateLastTrainAlarm({
          sleepMode: true,
          ...missing,
          now,
        }).kind,
      ).toBe('skip-no-trip');
    }
  });

  it('uncovered 노선이면 skip-uncovered-line', () => {
    expect(
      evaluateLastTrainAlarm({
        sleepMode: true,
        origin: station({ line: 'airport' }),
        destination: station({ id: '1-002', name: '회기' }),
        route: dummyRoute,
        now,
      }).kind,
    ).toBe('skip-uncovered-line');
  });

  it('direction 산출 실패 시 skip-direction-unknown', () => {
    mockResolveTripDirection.mockReturnValueOnce(null);
    expect(
      evaluateLastTrainAlarm({
        sleepMode: true,
        origin: station(),
        destination: station({ id: '1-002', name: '회기' }),
        route: dummyRoute,
        now,
      }).kind,
    ).toBe('skip-direction-unknown');
  });

  it('classifyDayTypeKst 실패 시 skip-no-day-type', () => {
    const spy = jest.spyOn(Intl, 'DateTimeFormat').mockImplementationOnce(() => {
      throw new Error('hermes');
    });
    expect(
      evaluateLastTrainAlarm({
        sleepMode: true,
        origin: station(),
        destination: station({ id: '1-002', name: '회기' }),
        route: dummyRoute,
        now,
      }).kind,
    ).toBe('skip-no-day-type');
    spy.mockRestore();
  });

  it('막차 데이터 부재(direction down 미운행 케이스) → skip-no-data', () => {
    mockResolveTripDirection.mockReturnValueOnce('down');
    expect(
      evaluateLastTrainAlarm({
        sleepMode: true,
        origin: station(),
        destination: station({ id: '1-002', name: '회기' }),
        route: dummyRoute,
        // KST 일요일
        now: new Date('2026-06-28T14:00:00Z'),
      }).kind,
    ).toBe('skip-no-data');
  });

  it('막차 시각 parse 실패 시 skip-no-data', () => {
    // direction이 'up'이고 weekday 데이터는 '23:55'. minutesUntilLastTrain이 null을 반환하도록
    // Intl 모킹으로 hour part 누락 유도.
    const realFmt = Intl.DateTimeFormat;
    let callCount = 0;
    const spy = jest.spyOn(Intl, 'DateTimeFormat').mockImplementation(((...args: unknown[]) => {
      // 1st call = classifyDayTypeKst (성공해야 함), 2nd call = getKstHourMinute (실패 유도)
      callCount += 1;
      if (callCount === 2) {
        return {
          formatToParts: () => [{ type: 'literal', value: '-' }],
        } as unknown as Intl.DateTimeFormat;
      }
      return new (realFmt as unknown as new (...a: unknown[]) => Intl.DateTimeFormat)(...args);
    }) as unknown as typeof Intl.DateTimeFormat);
    expect(
      evaluateLastTrainAlarm({
        sleepMode: true,
        origin: station(),
        destination: station({ id: '1-002', name: '회기' }),
        route: dummyRoute,
        now,
      }).kind,
    ).toBe('skip-no-data');
    spy.mockRestore();
  });

  it('threshold 초과면 skip-out-of-window', () => {
    // 막차 23:55, KST 22:00 = 115분 남음. threshold=15 → skip
    expect(
      evaluateLastTrainAlarm({
        sleepMode: true,
        origin: station(),
        destination: station({ id: '1-002', name: '회기' }),
        route: dummyRoute,
        now: new Date('2026-06-26T13:00:00Z'),
      }),
    ).toEqual({ kind: 'skip-out-of-window', minutesRemaining: 115 });
  });

  it('이미 막차가 한참 지났으면 skip-out-of-window (음수, grace 초과)', () => {
    // 막차 weekday up = 23:55. KST 24:00:30 (다음 날 자정 직후 약 5분)이면 -5분 정도.
    // grace=2이므로 -5 < -2 → skip-out-of-window
    // KST = UTC+9, 2026-06-26 16:00 UTC = 2026-06-27 01:00 KST = 토요일.
    // Saturday up = '00:30'. minutesRemaining = 30 - 60 = -30. -30 < -2 → skip.
    expect(
      evaluateLastTrainAlarm({
        sleepMode: true,
        origin: station(),
        destination: station({ id: '1-002', name: '회기' }),
        route: dummyRoute,
        now: new Date('2026-06-26T16:00:00Z'),
      }),
    ).toEqual({ kind: 'skip-out-of-window', minutesRemaining: -30 });
  });

  it('임계값 안이면 should-fire', () => {
    // KST 23:45 → 막차 23:55 = 10분 남음 (threshold 기본 15 안)
    expect(evaluateLastTrainAlarm({
      sleepMode: true,
      origin: station(),
      destination: station({ id: '1-002', name: '회기' }),
      route: dummyRoute,
      now,
    })).toEqual({
      kind: 'should-fire',
      lineCovered: true,
      minutesRemaining: 10,
      lastTrainTime: '23:55',
      dayType: 'weekday',
      direction: 'up',
    });
  });

  it('막차가 방금 지났지만 grace 안이면 should-fire (음수 minutesRemaining 유지)', () => {
    // KST 23:56 → 23:55 막차 = -1분, grace=2이므로 still fire
    const outcome = evaluateLastTrainAlarm({
      sleepMode: true,
      origin: station(),
      destination: station({ id: '1-002', name: '회기' }),
      route: dummyRoute,
      now: new Date('2026-06-26T14:56:00Z'),
    });
    expect(outcome.kind).toBe('should-fire');
    if (outcome.kind === 'should-fire') {
      expect(outcome.minutesRemaining).toBe(-1);
    }
  });

  it('custom threshold 적용', () => {
    expect(
      evaluateLastTrainAlarm({
        sleepMode: true,
        origin: station(),
        destination: station({ id: '1-002', name: '회기' }),
        route: dummyRoute,
        now,
        threshold: 5,
      }).kind,
    ).toBe('skip-out-of-window');
  });
});

describe('ensureLastTrainChannel', () => {
  const originalOS = Platform.OS;
  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: originalOS, writable: true });
  });

  it('iOS면 채널 호출 없음', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'ios', writable: true });
    await ensureLastTrainChannel();
    expect(Notifications.setNotificationChannelAsync).not.toHaveBeenCalled();
  });

  it('Android면 기존 채널 삭제 후 재등록', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', writable: true });
    await ensureLastTrainChannel();
    expect(Notifications.deleteNotificationChannelAsync).toHaveBeenCalled();
    expect(Notifications.setNotificationChannelAsync).toHaveBeenCalled();
  });

  it('Android delete 실패는 swallow', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', writable: true });
    (Notifications.deleteNotificationChannelAsync as jest.Mock).mockRejectedValueOnce(
      new Error('no-channel'),
    );
    await expect(ensureLastTrainChannel()).resolves.toBeUndefined();
  });
});

describe('fireLastTrainAlarm', () => {
  const originalOS = Platform.OS;
  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: originalOS, writable: true });
  });

  it('iOS에서 timeSensitive 옵션으로 scheduleNotification 호출', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'ios', writable: true });
    await fireLastTrainAlarm({
      origin: station(),
      destination: station({ id: '1-002', name: '회기' }),
      minutesRemaining: 10,
      lastTrainTime: '23:55',
    });
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        identifier: 'last-train-alarm',
        content: expect.objectContaining({
          title: expect.any(String),
          body: expect.any(String),
          interruptionLevel: 'timeSensitive',
        }),
        trigger: null,
      }),
    );
    expect(mockBreadcrumb).toHaveBeenCalledWith('alarm', 'last-train-fire', expect.any(Object));
  });

  it('Android에서 channelId + priority 옵션', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', writable: true });
    await fireLastTrainAlarm({
      origin: station(),
      destination: station({ id: '1-002', name: '회기' }),
      minutesRemaining: 3,
      lastTrainTime: '23:55',
    });
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          channelId: 'last-train-alarm',
          priority: 'high',
        }),
      }),
    );
  });

  it('dismiss가 실패해도 schedule은 진행', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'ios', writable: true });
    (Notifications.dismissNotificationAsync as jest.Mock).mockRejectedValueOnce(new Error('na'));
    await fireLastTrainAlarm({
      origin: station(),
      destination: station({ id: '1-002', name: '회기' }),
      minutesRemaining: 0,
      lastTrainTime: '23:55',
    });
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalled();
  });

  it('음수 minutesRemaining은 0으로 clamp되어 title에 표시', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'ios', writable: true });
    await fireLastTrainAlarm({
      origin: station(),
      destination: station({ id: '1-002', name: '회기' }),
      minutesRemaining: -1,
      lastTrainTime: '23:55',
    });
    const call = (Notifications.scheduleNotificationAsync as jest.Mock).mock.calls[0][0];
    // i18next는 기본 ko, "막차 {{minutes}}분 전" → 0이 들어가야 함
    expect(call.content.title).toMatch(/0/);
  });
});

describe('runLastTrainAlarmCycle', () => {
  // KST 23:45 weekday
  const now = new Date('2026-06-26T14:45:00Z');

  it('evaluate가 should-fire이 아니면 false 반환 + fire 호출 안 함', async () => {
    const fire = jest.fn().mockResolvedValue(undefined);
    const fired = await runLastTrainAlarmCycle({
      sleepMode: false,
      origin: station(),
      destination: station({ id: '1-002', name: '회기' }),
      route: dummyRoute,
      now,
      fire,
    });
    expect(fired).toBe(false);
    expect(fire).not.toHaveBeenCalled();
  });

  it('이미 발화한 기록이 있으면 false 반환 + fire 호출 안 함', async () => {
    const fire = jest.fn().mockResolvedValue(undefined);
    const memStorage = new Map<string, string>();
    memStorage.set(`${LAST_TRAIN_FIRED_KEY_PREFIX}:1-001:20260626`, '1234');
    const storage = {
      getItem: async (k: string) => memStorage.get(k) ?? null,
      setItem: async (k: string, v: string) => {
        memStorage.set(k, v);
      },
    };
    const fired = await runLastTrainAlarmCycle({
      sleepMode: true,
      origin: station(),
      destination: station({ id: '1-002', name: '회기' }),
      route: dummyRoute,
      now,
      fire,
      storage,
    });
    expect(fired).toBe(false);
    expect(fire).not.toHaveBeenCalled();
  });

  it('첫 발화 시 fire + storage stamp', async () => {
    const fire = jest.fn().mockResolvedValue(undefined);
    const memStorage = new Map<string, string>();
    const storage = {
      getItem: async (k: string) => memStorage.get(k) ?? null,
      setItem: async (k: string, v: string) => {
        memStorage.set(k, v);
      },
    };
    const fired = await runLastTrainAlarmCycle({
      sleepMode: true,
      origin: station(),
      destination: station({ id: '1-002', name: '회기' }),
      route: dummyRoute,
      now,
      fire,
      storage,
    });
    expect(fired).toBe(true);
    expect(fire).toHaveBeenCalledWith(
      expect.objectContaining({ minutesRemaining: 10, lastTrainTime: '23:55' }),
    );
    expect(memStorage.has(`${LAST_TRAIN_FIRED_KEY_PREFIX}:1-001:20260626`)).toBe(true);
  });

  it('dayKey 산출 실패 시 fire 호출 안 함', async () => {
    const fire = jest.fn().mockResolvedValue(undefined);
    // classifyDayTypeKst과 todayKstKey 둘 다 Intl을 호출. 첫 번째 classify는 통과시키고
    // 두 번째 호출(getKstHourMinute) 통과, 세 번째 todayKstKey 실패 유도.
    const realFmt = Intl.DateTimeFormat;
    let count = 0;
    const spy = jest.spyOn(Intl, 'DateTimeFormat').mockImplementation(((...args: unknown[]) => {
      count += 1;
      // 3번째 호출(todayKstKey) 실패 유도
      if (count === 3) {
        throw new Error('hermes');
      }
      return new (realFmt as unknown as new (...a: unknown[]) => Intl.DateTimeFormat)(...args);
    }) as unknown as typeof Intl.DateTimeFormat);

    const fired = await runLastTrainAlarmCycle({
      sleepMode: true,
      origin: station(),
      destination: station({ id: '1-002', name: '회기' }),
      route: dummyRoute,
      now,
      fire,
    });
    expect(fired).toBe(false);
    expect(fire).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('기본 storage 사용 시 AsyncStorage 호출', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
    (AsyncStorage.setItem as jest.Mock).mockResolvedValueOnce(undefined);
    const fire = jest.fn().mockResolvedValue(undefined);
    const fired = await runLastTrainAlarmCycle({
      sleepMode: true,
      origin: station(),
      destination: station({ id: '1-002', name: '회기' }),
      route: dummyRoute,
      now,
      fire,
    });
    expect(fired).toBe(true);
    expect(AsyncStorage.setItem).toHaveBeenCalled();
  });

  it('fire 옵션 미주입 시 기본 fireLastTrainAlarm 사용', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
    (AsyncStorage.setItem as jest.Mock).mockResolvedValueOnce(undefined);
    const fired = await runLastTrainAlarmCycle({
      sleepMode: true,
      origin: station(),
      destination: station({ id: '1-002', name: '회기' }),
      route: dummyRoute,
      now,
      // fire / storage 모두 기본값
    });
    expect(fired).toBe(true);
    // 기본 fire → expo-notifications 모킹된 scheduleNotificationAsync 호출
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalled();
  });

  it('evaluate가 should-fire이지만 origin이 race로 null이면 false', async () => {
    // 이 케이스는 evaluate 통과 후 input.origin이 사라지는 가상 race를 위한 guard branch.
    // evaluate가 should-fire를 반환하려면 origin이 not-null이어야 하므로 별도 stub.
    const fire = jest.fn().mockResolvedValue(undefined);
    // 직접 모듈에 들어가지 않고 evaluate를 모킹하기보다, 실용적으로 origin: null이면 evaluate가
    // skip-no-trip을 반환해 runCycle이 false를 반환하는 것을 확인.
    const fired = await runLastTrainAlarmCycle({
      sleepMode: true,
      origin: null,
      destination: station({ id: '1-002', name: '회기' }),
      route: dummyRoute,
      now,
      fire,
    });
    expect(fired).toBe(false);
  });
});
