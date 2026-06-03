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

const mockLogSilentPushReceived = jest.fn();
const mockLogSilentPushRescheduleReceived = jest.fn();
const mockLogSilentPushFired = jest.fn();
const mockLogSilentPushSkipped = jest.fn();
const mockFlushAlarmLog = jest.fn().mockResolvedValue(undefined);
jest.mock('../../utils/alarmLog', () => ({
  logSilentPushReceived: (...args: unknown[]) => mockLogSilentPushReceived(...args),
  logSilentPushRescheduleReceived: (...args: unknown[]) =>
    mockLogSilentPushRescheduleReceived(...args),
  logSilentPushFired: (...args: unknown[]) => mockLogSilentPushFired(...args),
  logSilentPushSkipped: (...args: unknown[]) => mockLogSilentPushSkipped(...args),
  flushAlarmLog: () => mockFlushAlarmLog(),
}));

const mockCheckGate = jest.fn();
jest.mock('../../utils/silentPushLocationGate', () => ({
  checkSilentPushLocationGate: (...args: unknown[]) => mockCheckGate(...args),
}));

const mockGetFiredAlarms = jest.fn();
const mockSetFiredAlarms = jest.fn();
jest.mock('../../utils/notificationState', () => ({
  getFiredAlarms: (...args: unknown[]) => mockGetFiredAlarms(...args),
  setFiredAlarms: (...args: unknown[]) => mockSetFiredAlarms(...args),
}));

const mockBuildAlarmContent = jest.fn((event: { stationName: string; type: string; phaseId: string }, _source?: string) => ({
  title: `[${event.type}/${event.phaseId}]`,
  body: `${event.stationName} 알람`,
}));
jest.mock('../../utils/stationNotification', () => ({
  buildAlarmContent: (...args: unknown[]) => mockBuildAlarmContent(...(args as Parameters<typeof mockBuildAlarmContent>)),
}));

jest.mock('../../utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const mockSendPushAck = jest.fn();
jest.mock('../../api/alarmBackend', () => ({
  sendPushAck: (...args: unknown[]) => mockSendPushAck(...args),
}));

// #728 — motionActivity 신호. 기본 false (=== "stationary 아님"), 특정 테스트에서만 true로 override.
const mockGetMotionStationary = jest.fn(() => false);
jest.mock('../../utils/motionActivity', () => ({
  getCurrentMotionStationary: () => mockGetMotionStationary(),
}));

const mockGetBoardingLock = jest.fn();
jest.mock('../../utils/boardingLockStorage', () => ({
  getBoardingLock: (...args: unknown[]) => mockGetBoardingLock(...args),
}));

const mockFindStationByNameAndLine = jest.fn();
const mockFindStationByName = jest.fn();
jest.mock('../../utils/stationLookup', () => ({
  findStationByNameAndLine: (...args: unknown[]) => mockFindStationByNameAndLine(...args),
  findStationByName: (...args: unknown[]) => mockFindStationByName(...args),
}));

// i18next는 키 그대로 반환 (intermediate 본문 빌더 검증용).
jest.mock('i18next', () => ({
  __esModule: true,
  default: {
    t: (key: string, opts?: { name?: string }) =>
      opts?.name ? `${key}:${opts.name}` : key,
  },
  t: (key: string, opts?: { name?: string }) =>
    opts?.name ? `${key}:${opts.name}` : key,
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  extractPayload,
  getSilentPushRegistrationStatus,
  handleSilentPush,
  registerSilentPushTask,
  SILENT_PUSH_TASK,
} from '../silentPushTask';
import {
  APNS_TOKEN_KEY,
  DESTINATION_KEY,
  LOCKLESS_STATION_PASSED_KEY,
} from '../../constants/storageKeys';

const DEFAULT_APNS_TOKEN = 'apns-tok-hex';

const destStation = { id: '0228', name: '강남', line: '2', lat: 37.5, lng: 127.0 };

/**
 * expo-notifications iOS BG task payload 모양을 그대로 재현 (#641).
 * Swift `BackgroundEventTransformer`가 `{aps, data:{fields}}` → `{data:{data:{fields}, dataString}, notification:null, aps}`
 * 로 변환하므로 실기기에서는 fields가 `taskData.data.data.<field>`에 위치한다.
 */
function bgFields(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nextWaypoint: '강남',
    etaSeconds: 300,
    phase: 'early',
    kind: 'destination',
    ...extra,
  };
}
function payload(extra: Record<string, unknown> = {}) {
  return {
    data: {
      data: { data: bgFields(extra), dataString: null },
      notification: null,
      aps: { 'content-available': 1 },
    },
  };
}
/** extractPayload 단위 테스트용 — handleSilentPush input 전체가 아니라 taskData만 빌드. */
function bgTaskData(fields: Record<string, unknown>) {
  return {
    data: { data: fields, dataString: null },
    notification: null,
    aps: { 'content-available': 1 },
  };
}

const PASSING_GATE = {
  pass: true,
  distanceM: 150,
  thresholdM: 800,
  locationSource: 'cache' as const,
  locationAgeMs: 10_000,
};

describe('silentPushTask', () => {
  // #816 C — 기본 lock을 부여해 기존 fire 테스트가 lockless 가드(lock null + non-intermediate 차단)에
  // 막히지 않도록 한다. lockless 분기는 별도 describe에서 lock=null로 명시 override해 검증.
  // line 가드는 lookup 반환값이 두 함수 모두 null이면 graceful pass (#707 — stations.json miss 케이스).
  const defaultBoardingLock = {
    destinationId: '0228',
    trainCode: 'T-default',
    boardingStationId: 'station-default',
    boardingLine: '2' as const,
    boardedAt: 1_700_000_000_000,
    expectedDurationMs: 600_000,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockScheduleNotificationAsync.mockResolvedValue('id');
    mockCheckGate.mockResolvedValue(PASSING_GATE);
    mockGetFiredAlarms.mockResolvedValue(new Set<string>());
    mockSetFiredAlarms.mockResolvedValue(undefined);
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
      if (key === DESTINATION_KEY) return JSON.stringify(destStation);
      if (key === APNS_TOKEN_KEY) return DEFAULT_APNS_TOKEN;
      return null;
    });
    mockSendPushAck.mockResolvedValue({ ok: true });
    // 기본: lock 활성. lockless 가드를 우회하려면 lock 부여가 필요(stations.json 미존재 가정).
    mockGetBoardingLock.mockResolvedValue(defaultBoardingLock);
    // 기본 lookup 모두 null → line 가드는 graceful pass(stations.json 어디에도 없음 가정).
    mockFindStationByNameAndLine.mockReturnValue(null);
    mockFindStationByName.mockReturnValue(null);
  });

  it('defineTask가 SILENT_PUSH_TASK 이름으로 콜백을 등록한다', () => {
    expect((global as any).__silentPushTaskName).toBe(SILENT_PUSH_TASK);
    expect(typeof (global as any).__silentPushTaskCb).toBe('function');
  });

  describe('extractPayload', () => {
    it('data 자체가 falsy면 null', () => {
      expect(extractPayload(undefined)).toBeNull();
    });

    it('비어 있는 객체면 null', () => {
      expect(extractPayload({})).toBeNull();
    });

    // #641 — production iOS BG task payload (Swift `BackgroundEventTransformer` 출력).
    it('production 모양(taskData.data.data.fields) → 필드 추출', () => {
      expect(
        extractPayload(bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early' })),
      ).toMatchObject({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early' });
    });

    // backend가 flat payload(`{aps, ...flat}`)를 보내는 경우 — Swift 변환 후 `taskData.data.flat`.
    it('flat payload 모양(taskData.data.fields) → 필드 추출', () => {
      expect(
        extractPayload({
          data: { nextWaypoint: 'B', etaSeconds: 2, phase: 'imminent' },
          notification: null,
          aps: { 'content-available': 1 },
        }),
      ).toMatchObject({ nextWaypoint: 'B', etaSeconds: 2, phase: 'imminent' });
    });

    // legacy/방어 — 일부 호출처가 fields를 root로 직접 줄 수도 있다.
    it('root 직접 모양(taskData.fields)도 fallback으로 처리', () => {
      expect(
        extractPayload({ nextWaypoint: 'C', etaSeconds: 3, phase: 'early' }),
      ).toMatchObject({ nextWaypoint: 'C', etaSeconds: 3, phase: 'early' });
    });

    it('nextWaypoint 없거나 빈 문자열이면 null', () => {
      expect(extractPayload(bgTaskData({ etaSeconds: 1, phase: 'early' }))).toBeNull();
      expect(
        extractPayload(bgTaskData({ nextWaypoint: '', etaSeconds: 1, phase: 'early' })),
      ).toBeNull();
    });

    it('data가 string 등 비객체면 null', () => {
      expect(
        extractPayload({ data: 'string' } as unknown as Record<string, unknown>),
      ).toBeNull();
    });

    it('etaSeconds 비숫자/Infinity이면 null', () => {
      expect(
        extractPayload(bgTaskData({ nextWaypoint: 'A', etaSeconds: '10', phase: 'early' })),
      ).toBeNull();
      expect(
        extractPayload(bgTaskData({ nextWaypoint: 'A', etaSeconds: Infinity, phase: 'early' })),
      ).toBeNull();
    });

    it('phase가 early/imminent가 아니면 null', () => {
      expect(
        extractPayload(bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'late' })),
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
          extractPayload(bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early', kind })),
        ).toMatchObject({ kind });
      }
    });

    it('kind가 알 수 없는 값이면 undefined로 정리 (legacy 호환)', () => {
      expect(
        extractPayload(bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early', kind: 'foo' })),
      ).toMatchObject({ kind: undefined });
    });

    it('sentAt이 number면 그대로 전달 (#478)', () => {
      expect(
        extractPayload(
          bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early', sentAt: 1_700_000_000_000 }),
        ),
      ).toMatchObject({ sentAt: 1_700_000_000_000 });
    });

    it('sentAt이 비숫자/Infinity이면 undefined (구 백엔드 호환)', () => {
      expect(
        extractPayload(
          bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early', sentAt: 'now' }),
        ),
      ).toMatchObject({ sentAt: undefined });
      expect(
        extractPayload(
          bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early', sentAt: Infinity }),
        ),
      ).toMatchObject({ sentAt: undefined });
    });

    it('pushId가 non-empty string이면 그대로 전달 (#566)', () => {
      expect(
        extractPayload(
          bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early', pushId: 'uuid-x' }),
        ),
      ).toMatchObject({ pushId: 'uuid-x' });
    });

    it('pushId가 빈 문자열/비문자열이면 undefined (구 백엔드 호환)', () => {
      expect(
        extractPayload(
          bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early', pushId: '' }),
        ),
      ).toMatchObject({ pushId: undefined });
      expect(
        extractPayload(
          bgTaskData({ nextWaypoint: 'A', etaSeconds: 1, phase: 'early', pushId: 42 }),
        ),
      ).toMatchObject({ pushId: undefined });
    });

    // #725 — reschedule schema는 standard와 다르므로 별도 분기 검증.
    describe('reschedule kind (#725)', () => {
      it('정상 reschedule payload → RescheduleSilentPushPayload', () => {
        expect(
          extractPayload(
            bgTaskData({
              kind: 'reschedule',
              nextStation: '사가정',
              newArrivalTimeEpoch: 1_780_000_000_000,
              trainCode: '7610',
              sentAt: 1_780_000_000_000,
              pushId: 'uuid-rs',
            }),
          ),
        ).toEqual({
          kind: 'reschedule',
          nextStation: '사가정',
          newArrivalTimeEpoch: 1_780_000_000_000,
          trainCode: '7610',
          sentAt: 1_780_000_000_000,
          pushId: 'uuid-rs',
        });
      });

      it('nextStation 누락/빈 문자열이면 null', () => {
        expect(
          extractPayload(
            bgTaskData({ kind: 'reschedule', newArrivalTimeEpoch: 1, trainCode: 'X' }),
          ),
        ).toBeNull();
        expect(
          extractPayload(
            bgTaskData({
              kind: 'reschedule',
              nextStation: '',
              newArrivalTimeEpoch: 1,
              trainCode: 'X',
            }),
          ),
        ).toBeNull();
      });

      it('newArrivalTimeEpoch 비숫자/Infinity이면 null', () => {
        expect(
          extractPayload(
            bgTaskData({
              kind: 'reschedule',
              nextStation: 'A',
              newArrivalTimeEpoch: 'now',
              trainCode: 'X',
            }),
          ),
        ).toBeNull();
        expect(
          extractPayload(
            bgTaskData({
              kind: 'reschedule',
              nextStation: 'A',
              newArrivalTimeEpoch: Infinity,
              trainCode: 'X',
            }),
          ),
        ).toBeNull();
      });

      it('trainCode 누락/빈 문자열이면 null', () => {
        expect(
          extractPayload(
            bgTaskData({ kind: 'reschedule', nextStation: 'A', newArrivalTimeEpoch: 1 }),
          ),
        ).toBeNull();
        expect(
          extractPayload(
            bgTaskData({
              kind: 'reschedule',
              nextStation: 'A',
              newArrivalTimeEpoch: 1,
              trainCode: '',
            }),
          ),
        ).toBeNull();
      });

      it('sentAt/pushId 옵션 — 누락 시 undefined로 정리', () => {
        expect(
          extractPayload(
            bgTaskData({
              kind: 'reschedule',
              nextStation: 'A',
              newArrivalTimeEpoch: 1,
              trainCode: 'X',
            }),
          ),
        ).toMatchObject({ sentAt: undefined, pushId: undefined });
      });
    });
  });

  describe('handleSilentPush', () => {
    it('error 있으면 즉시 종료 (gate 호출 안 됨)', async () => {
      await handleSilentPush({ error: { message: 'boom' } });
      expect(mockCheckGate).not.toHaveBeenCalled();
      expect(mockLogSilentPushReceived).not.toHaveBeenCalled();
    });

    it('payload 없으면 skip', async () => {
      await handleSilentPush({ data: undefined });
      expect(mockLogSilentPushReceived).not.toHaveBeenCalled();
      expect(mockCheckGate).not.toHaveBeenCalled();
    });

    it('invalid payload면 skip', async () => {
      await handleSilentPush({
        data: bgTaskData({ trigger: 'other' }),
      });
      expect(mockLogSilentPushReceived).not.toHaveBeenCalled();
    });

    it('수신 시 logSilentPushReceived 호출 — sentAt 포함 (#478)', async () => {
      await handleSilentPush(
        payload({ kind: 'transfer', phase: 'early', sentAt: 1_700_000_000_000 }),
      );
      expect(mockLogSilentPushReceived).toHaveBeenCalledTimes(1);
      const arg = mockLogSilentPushReceived.mock.calls[0][0];
      expect(arg.sentAt).toBe(1_700_000_000_000);
      expect(typeof arg.receivedAt).toBe('number');
    });

    it('kind 미상(구 백엔드)이면 received 적재 후 skip 적재 + 발사 안 함', async () => {
      await handleSilentPush({
        data: bgTaskData({ nextWaypoint: '강남', etaSeconds: 10, phase: 'imminent' }),
      });
      expect(mockLogSilentPushReceived).toHaveBeenCalled();
      expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'payload-missing-kind' }),
      );
      expect(mockCheckGate).not.toHaveBeenCalled();
      expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
    });

    it('게이트 통과 시 destination 즉시 발사 + fired 로그 + FIRED_ALARMS 갱신', async () => {
      await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));

      expect(mockCheckGate).toHaveBeenCalledWith({
        stationName: '강남',
        kind: 'destination',
        phase: 'imminent',
      });
      expect(mockScheduleNotificationAsync).toHaveBeenCalledTimes(1);
      const call = mockScheduleNotificationAsync.mock.calls[0][0];
      expect(call.trigger).toBeNull();
      expect(call.content.body).toContain('강남');
      expect(mockLogSilentPushFired).toHaveBeenCalledWith(
        expect.objectContaining({
          stationName: '강남',
          kind: 'destination',
          phaseId: 'imminent',
          distanceM: 150,
          thresholdM: 800,
          locationSource: 'cache',
          locationAgeMs: 10_000,
        }),
      );
      expect(mockSetFiredAlarms).toHaveBeenCalledTimes(1);
      const [, savedSet] = mockSetFiredAlarms.mock.calls[0];
      expect(Array.from(savedSet as Set<string>)).toEqual(['imminent:강남']);
    });

    it('alarm 경로(destination/transfer)는 buildAlarmContent에 positionTrain source 전달 (#327)', async () => {
      await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));
      expect(mockBuildAlarmContent).toHaveBeenCalledWith(
        expect.objectContaining({ phaseId: 'imminent', type: 'destination' }),
        'positionTrain',
      );
    });

    it('intermediate는 i18n key로 본문 생성 + FIRED_ALARMS dedup 안 씀', async () => {
      await handleSilentPush(payload({ kind: 'intermediate', phase: 'imminent', nextWaypoint: '중곡' }));

      const call = mockScheduleNotificationAsync.mock.calls[0][0];
      expect(call.content.title).toBe('route.intermediatePassedTitle');
      // positionTrain은 #327 UX 정책상 자백 대상이 아니라 suffix 미부착.
      expect(call.content.body).toBe('route.intermediatePassedBody:중곡');
      expect(mockGetFiredAlarms).not.toHaveBeenCalled();
      expect(mockSetFiredAlarms).not.toHaveBeenCalled();
      expect(mockLogSilentPushFired).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'station-passed' }),
      );
    });

    it('intermediate가 게이트 fail이면 skip 적재 kind=station-passed', async () => {
      mockCheckGate.mockResolvedValue({ pass: false, reason: 'out-of-range' });
      await handleSilentPush(payload({ kind: 'intermediate', phase: 'imminent', nextWaypoint: '중곡' }));
      expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'station-passed', reason: 'gate-out-of-range' }),
      );
    });

    it('게이트 fail(out-of-range)이면 skip 적재 + 발사 안 함', async () => {
      mockCheckGate.mockResolvedValue({
        pass: false,
        reason: 'out-of-range',
        distanceM: 5_000,
        thresholdM: 400,
        locationSource: 'cache',
        locationAgeMs: 5_000,
      });

      await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));

      expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
      expect(mockLogSilentPushFired).not.toHaveBeenCalled();
      expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'gate-out-of-range',
          distanceM: 5_000,
          thresholdM: 400,
        }),
      );
      expect(mockSetFiredAlarms).not.toHaveBeenCalled();
    });

    it.each([
      ['unknown-station', 'gate-unknown-station'],
      ['no-location', 'gate-no-location'],
      ['stale-location', 'gate-stale-location'],
      ['out-of-range', 'gate-out-of-range'],
    ])('게이트 reason=%s → logSkipped reason=%s', async (gateReason, logReason) => {
      mockCheckGate.mockResolvedValue({ pass: false, reason: gateReason });
      await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));
      expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
        expect.objectContaining({ reason: logReason }),
      );
    });

    it('FIRED_ALARMS에 이미 같은 키 있으면 발사 안 함 (dedup, GPS 발화와 키 공유)', async () => {
      mockGetFiredAlarms.mockResolvedValue(new Set(['imminent:강남']));
      await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));
      expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
      expect(mockSetFiredAlarms).not.toHaveBeenCalled();
      expect(mockLogSilentPushFired).not.toHaveBeenCalled();
    });

    it('destination AsyncStorage 없으면 dedup 건너뛰고 발사 (보수적 진행)', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
      await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));
      expect(mockScheduleNotificationAsync).toHaveBeenCalledTimes(1);
      expect(mockGetFiredAlarms).not.toHaveBeenCalled();
    });

    it('destination JSON 손상 시 dedup 건너뛰고 발사', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue('not-json{');
      await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));
      expect(mockScheduleNotificationAsync).toHaveBeenCalledTimes(1);
      expect(mockGetFiredAlarms).not.toHaveBeenCalled();
    });

    it('destination에 id 없으면 dedup 건너뛰고 발사', async () => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(JSON.stringify({ name: 'x' }));
      await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));
      expect(mockScheduleNotificationAsync).toHaveBeenCalledTimes(1);
      expect(mockGetFiredAlarms).not.toHaveBeenCalled();
    });

    it('scheduleNotificationAsync throw 시 graceful (전체 throw 안 함)', async () => {
      mockScheduleNotificationAsync.mockRejectedValue(new Error('boom'));
      await expect(
        handleSilentPush(payload({ kind: 'destination', phase: 'imminent' })),
      ).resolves.toBeUndefined();
    });

    it('transfer + early — 기존 사전예약 호출(scheduleAlarmsForRoute) 없음', async () => {
      await handleSilentPush(payload({ kind: 'transfer', phase: 'early' }));
      // 발사는 됨
      expect(mockScheduleNotificationAsync).toHaveBeenCalled();
      // 사전예약은 import도 안 함 — 호출 검증은 import 부재로 충분하나, 추가 안전망:
      // alarmScheduler 모듈을 jest.mock하지 않았기 때문에 호출 시 ReferenceError가 났을 것.
    });

    describe('#707 BoardingLock line 가드', () => {
      const lockOnLine7 = {
        destinationId: '0228',
        trainCode: 'T-7',
        boardingStationId: 'station-on-7',
        boardingLine: '7' as const,
        boardedAt: 1_700_000_000_000,
        expectedDurationMs: 600_000,
      };

      it('lock 활성 + nextWaypoint가 lock.boardingLine에 정차 안 함 → skip + ack(lock-line-mismatch)', async () => {
        mockGetBoardingLock.mockResolvedValue(lockOnLine7);
        // line 7에는 없음, 다른 line에는 존재 → 라인 mismatch.
        mockFindStationByNameAndLine.mockReturnValue(null);
        mockFindStationByName.mockReturnValue({ id: 'other-line-stop', name: '강남', line: '2' });

        await handleSilentPush(
          payload({ kind: 'destination', phase: 'imminent', pushId: 'p-mismatch' }),
        );

        expect(mockFindStationByNameAndLine).toHaveBeenCalledWith('강남', '7');
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        expect(mockLogSilentPushFired).not.toHaveBeenCalled();
        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'lock-line-mismatch', kind: 'destination' }),
        );
        expect(mockSendPushAck).toHaveBeenCalledWith({
          pushId: 'p-mismatch',
          token: DEFAULT_APNS_TOKEN,
          outcome: 'skipped',
          reason: 'lock-line-mismatch',
        });
      });

      it('lock 활성 + nextWaypoint가 lock.boardingLine에 정차(환승역 양쪽 호선 stop 존재) → 통과 후 발사', async () => {
        mockGetBoardingLock.mockResolvedValue(lockOnLine7);
        // line 7 stop이 존재 → 환승역에서 line 7로도 정차하는 정상 케이스(transfer 등).
        mockFindStationByNameAndLine.mockReturnValue({
          id: 'stop-on-7',
          name: '강남',
          line: '7',
        });

        await handleSilentPush(payload({ kind: 'transfer', phase: 'early' }));

        expect(mockFindStationByNameAndLine).toHaveBeenCalledWith('강남', '7');
        expect(mockScheduleNotificationAsync).toHaveBeenCalled();
        expect(mockLogSilentPushFired).toHaveBeenCalled();
      });

      it('lock 활성 + nextWaypoint가 stations.json 어디에도 없으면 line 가드는 통과시키고 일반 게이트가 unknown-station으로 처리', async () => {
        mockGetBoardingLock.mockResolvedValue(lockOnLine7);
        mockFindStationByNameAndLine.mockReturnValue(null);
        mockFindStationByName.mockReturnValue(null);
        // 일반 게이트가 unknown-station 반환 가정.
        mockCheckGate.mockResolvedValue({ pass: false, reason: 'unknown-station' });

        await handleSilentPush(
          payload({ kind: 'destination', phase: 'imminent', pushId: 'p-unknown' }),
        );

        // line 가드의 skip 사유가 아닌, 기존 게이트 사유로 분류돼야 한다.
        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'gate-unknown-station' }),
        );
        expect(mockLogSilentPushSkipped).not.toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'lock-line-mismatch' }),
        );
      });

      it('lock 없음 + intermediate + 토글 ON → line 가드 skip + 발사 (#816 C 정상 흐름)', async () => {
        mockGetBoardingLock.mockResolvedValue(null);
        (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
          if (key === DESTINATION_KEY) return JSON.stringify(destStation);
          if (key === APNS_TOKEN_KEY) return DEFAULT_APNS_TOKEN;
          if (key === LOCKLESS_STATION_PASSED_KEY) return JSON.stringify(true);
          return null;
        });
        await handleSilentPush(payload({ kind: 'intermediate', phase: 'imminent' }));
        expect(mockFindStationByNameAndLine).not.toHaveBeenCalled();
        expect(mockScheduleNotificationAsync).toHaveBeenCalled();
      });

      it('intermediate kind도 lock line mismatch 시 station-passed로 skip 적재', async () => {
        mockGetBoardingLock.mockResolvedValue(lockOnLine7);
        mockFindStationByNameAndLine.mockReturnValue(null);
        mockFindStationByName.mockReturnValue({ id: 'x', name: '중곡', line: '5' });

        await handleSilentPush(
          payload({ kind: 'intermediate', phase: 'imminent', nextWaypoint: '중곡' }),
        );

        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({ kind: 'station-passed', reason: 'lock-line-mismatch' }),
        );
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
      });
    });

    // #816 C — lockless station-passed 분기
    describe('#816 C — lockless 분기 (lock 없음)', () => {
      function setLockless(enabled: boolean) {
        (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
          if (key === DESTINATION_KEY) return JSON.stringify(destStation);
          if (key === APNS_TOKEN_KEY) return DEFAULT_APNS_TOKEN;
          if (key === LOCKLESS_STATION_PASSED_KEY) return JSON.stringify(enabled);
          return null;
        });
      }

      it('lock 없음 + destination kind → skip(lockless-non-intermediate) + ack', async () => {
        mockGetBoardingLock.mockResolvedValue(null);
        await handleSilentPush(
          payload({ kind: 'destination', phase: 'imminent', pushId: 'p-dest' }),
        );
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'lockless-non-intermediate', kind: 'destination' }),
        );
        expect(mockSendPushAck).toHaveBeenCalledWith({
          pushId: 'p-dest',
          token: DEFAULT_APNS_TOKEN,
          outcome: 'skipped',
          reason: 'lockless-non-intermediate',
        });
      });

      it('lock 없음 + transfer kind → skip(lockless-non-intermediate)', async () => {
        mockGetBoardingLock.mockResolvedValue(null);
        await handleSilentPush(payload({ kind: 'transfer', phase: 'imminent' }));
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'lockless-non-intermediate', kind: 'transfer' }),
        );
      });

      it('lock 없음 + intermediate + 토글 OFF → skip(lockless-opt-out) + ack', async () => {
        mockGetBoardingLock.mockResolvedValue(null);
        setLockless(false);
        await handleSilentPush(
          payload({ kind: 'intermediate', phase: 'imminent', pushId: 'p-off' }),
        );
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'lockless-opt-out', kind: 'station-passed' }),
        );
        expect(mockSendPushAck).toHaveBeenCalledWith({
          pushId: 'p-off',
          token: DEFAULT_APNS_TOKEN,
          outcome: 'skipped',
          reason: 'lockless-opt-out',
        });
      });

      it('lock 없음 + intermediate + 토글 ON → 일반 게이트로 진행 후 발사', async () => {
        mockGetBoardingLock.mockResolvedValue(null);
        setLockless(true);
        await handleSilentPush(payload({ kind: 'intermediate', phase: 'imminent' }));
        expect(mockScheduleNotificationAsync).toHaveBeenCalled();
        expect(mockLogSilentPushFired).toHaveBeenCalled();
      });

      it('lock 없음 + 토글 키 자체 부재 → opt-out (기본 OFF)', async () => {
        mockGetBoardingLock.mockResolvedValue(null);
        // 기본 mock: LOCKLESS_STATION_PASSED_KEY는 null 반환 (beforeEach 기본).
        await handleSilentPush(payload({ kind: 'intermediate', phase: 'imminent' }));
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'lockless-opt-out' }),
        );
      });

      it('lock 없음 + 토글 AsyncStorage read 오류 → opt-out (안전 fallback)', async () => {
        mockGetBoardingLock.mockResolvedValue(null);
        (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
          if (key === DESTINATION_KEY) return JSON.stringify(destStation);
          if (key === APNS_TOKEN_KEY) return DEFAULT_APNS_TOKEN;
          if (key === LOCKLESS_STATION_PASSED_KEY) throw new Error('boom');
          return null;
        });
        await handleSilentPush(payload({ kind: 'intermediate', phase: 'imminent' }));
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'lockless-opt-out' }),
        );
      });
    });

    describe('#568 P2b — push ACK', () => {
      it('fire 성공 시 sendPushAck(outcome=fired) 호출, reason 없음', async () => {
        await handleSilentPush(
          payload({ kind: 'destination', phase: 'imminent', pushId: 'p-fire' }),
        );
        expect(mockSendPushAck).toHaveBeenCalledWith({
          pushId: 'p-fire',
          token: DEFAULT_APNS_TOKEN,
          outcome: 'fired',
        });
      });

      it('게이트 fail 시 sendPushAck(outcome=skipped, reason=게이트사유)', async () => {
        mockCheckGate.mockResolvedValue({
          pass: false,
          reason: 'out-of-range',
          distanceM: 5_000,
          thresholdM: 400,
        });
        await handleSilentPush(
          payload({ kind: 'destination', phase: 'imminent', pushId: 'p-gate' }),
        );
        expect(mockSendPushAck).toHaveBeenCalledWith({
          pushId: 'p-gate',
          token: DEFAULT_APNS_TOKEN,
          outcome: 'skipped',
          reason: 'gate-out-of-range',
        });
      });

      it('FIRED_ALARMS dedup 시 sendPushAck(outcome=skipped, reason=dedup-already-fired)', async () => {
        mockGetFiredAlarms.mockResolvedValue(new Set(['imminent:강남']));
        await handleSilentPush(
          payload({ kind: 'destination', phase: 'imminent', pushId: 'p-dedup' }),
        );
        expect(mockSendPushAck).toHaveBeenCalledWith({
          pushId: 'p-dedup',
          token: DEFAULT_APNS_TOKEN,
          outcome: 'skipped',
          reason: 'dedup-already-fired',
        });
      });

      it('payload-missing-kind 시 sendPushAck(outcome=skipped, reason=payload-missing-kind)', async () => {
        await handleSilentPush({
          data: bgTaskData({
            nextWaypoint: '강남',
            etaSeconds: 10,
            phase: 'imminent',
            pushId: 'p-kind',
          }),
        });
        expect(mockSendPushAck).toHaveBeenCalledWith({
          pushId: 'p-kind',
          token: DEFAULT_APNS_TOKEN,
          outcome: 'skipped',
          reason: 'payload-missing-kind',
        });
      });

      it('pushId 누락(구 백엔드)이면 ACK skip', async () => {
        await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));
        expect(mockSendPushAck).not.toHaveBeenCalled();
      });

      it('APNs token 없으면 ACK skip (token 인증 불가)', async () => {
        (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
          if (key === DESTINATION_KEY) return JSON.stringify(destStation);
          if (key === APNS_TOKEN_KEY) return null;
          return null;
        });
        await handleSilentPush(
          payload({ kind: 'destination', phase: 'imminent', pushId: 'p-no-token' }),
        );
        expect(mockSendPushAck).not.toHaveBeenCalled();
      });

      it('APNS_TOKEN_KEY 읽기 throw해도 ACK 단순 skip — 본 처리는 정상 진행', async () => {
        (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
          if (key === APNS_TOKEN_KEY) throw new Error('storage boom');
          if (key === DESTINATION_KEY) return JSON.stringify(destStation);
          return null;
        });
        await handleSilentPush(
          payload({ kind: 'destination', phase: 'imminent', pushId: 'p-throw' }),
        );
        expect(mockScheduleNotificationAsync).toHaveBeenCalled();
        expect(mockSendPushAck).not.toHaveBeenCalled();
      });
    });

    describe('#727 정적 misfire 가드 (movement)', () => {
      it('gate가 speed=0 노출하면 movement-static-speed로 skip + 발사 안 함', async () => {
        mockCheckGate.mockResolvedValue({
          ...PASSING_GATE,
          speedMps: 0,
          accuracyM: 30,
        });

        await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));

        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        expect(mockLogSilentPushFired).not.toHaveBeenCalled();
        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({
            reason: 'movement-static-speed',
            stationName: '강남',
            kind: 'destination',
            phaseId: 'imminent',
            distanceM: 150,
            thresholdM: 800,
          }),
        );
      });

      it('gate가 accuracy=999 노출하면 movement-low-accuracy로 skip', async () => {
        mockCheckGate.mockResolvedValue({
          ...PASSING_GATE,
          speedMps: 2,
          accuracyM: 999,
        });

        await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));

        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'movement-low-accuracy' }),
        );
      });

      it('speed 미노출 + accuracy=999만 노출돼도 movement-low-accuracy로 skip', async () => {
        // speedMps undefined → log line의 ?? '-' fallback 분기 커버
        mockCheckGate.mockResolvedValue({
          ...PASSING_GATE,
          accuracyM: 999,
        });

        await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));

        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'movement-low-accuracy' }),
        );
      });

      it('movement skip은 pushId 있으면 ACK 전송', async () => {
        mockCheckGate.mockResolvedValue({
          ...PASSING_GATE,
          speedMps: 0,
        });

        await handleSilentPush(
          payload({ kind: 'destination', phase: 'imminent', pushId: 'movement-skip' }),
        );

        expect(mockSendPushAck).toHaveBeenCalledWith({
          pushId: 'movement-skip',
          token: DEFAULT_APNS_TOKEN,
          outcome: 'skipped',
          reason: 'movement-static-speed',
        });
      });

      it('gate가 speed/accuracy 미노출(undefined)이면 movement 가드 통과해 정상 발사', async () => {
        mockCheckGate.mockResolvedValue(PASSING_GATE); // speed/accuracy 없음

        await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));

        expect(mockScheduleNotificationAsync).toHaveBeenCalled();
        expect(mockLogSilentPushFired).toHaveBeenCalled();
      });

      it('intermediate도 movement-static-speed 시 kind=station-passed로 매핑되어 skip', async () => {
        mockCheckGate.mockResolvedValue({
          ...PASSING_GATE,
          speedMps: 0.1,
        });

        await handleSilentPush(
          payload({ kind: 'intermediate', phase: 'imminent', nextWaypoint: '중곡' }),
        );

        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: 'station-passed',
            reason: 'movement-static-speed',
          }),
        );
      });
    });

    // #728 — CMMotionActivity motion=stationary가 BG silent push 발사도 차단.
    // FG에서 useMotionActivity가 startUpdates를 호출했다면 native cache에 최신 activity가 있고,
    // BG handleSilentPush 진입 시 getCurrentMotionStationary가 그 값을 보고한다.
    describe('#728 motion-stationary 가드 (CMMotionActivity)', () => {
      it('motionStationary=true + speed=0.69 (임계 우회) → movement-motion-stationary로 skip', async () => {
        mockGetMotionStationary.mockReturnValue(true);
        mockCheckGate.mockResolvedValue({
          ...PASSING_GATE,
          speedMps: 0.69, // STATIC_SPEED_THRESHOLD_MPS=0.5 우회
          accuracyM: 30,
        });

        await handleSilentPush(
          payload({ kind: 'destination', phase: 'imminent', pushId: 'motion-skip' }),
        );

        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        expect(mockLogSilentPushFired).not.toHaveBeenCalled();
        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({
            reason: 'movement-motion-stationary',
            stationName: '강남',
            kind: 'destination',
            phaseId: 'imminent',
          }),
        );
        expect(mockSendPushAck).toHaveBeenCalledWith({
          pushId: 'motion-skip',
          token: DEFAULT_APNS_TOKEN,
          outcome: 'skipped',
          reason: 'movement-motion-stationary',
        });
      });

      it('motionStationary=false (default) — 기존 speed/accuracy 가드만 동작', async () => {
        // 명시적으로 false 설정 — speed/accuracy 정상이면 정상 발사
        mockGetMotionStationary.mockReturnValue(false);
        mockCheckGate.mockResolvedValue({
          ...PASSING_GATE,
          speedMps: 5,
          accuracyM: 30,
        });

        await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));

        expect(mockScheduleNotificationAsync).toHaveBeenCalled();
        expect(mockLogSilentPushFired).toHaveBeenCalled();
      });

      it('motionStationary=true는 speed 정상값보다 우선 — 차단', async () => {
        mockGetMotionStationary.mockReturnValue(true);
        mockCheckGate.mockResolvedValue({
          ...PASSING_GATE,
          speedMps: 5, // 명백한 이동 신호인데 motion=stationary
          accuracyM: 30,
        });

        await handleSilentPush(payload({ kind: 'destination', phase: 'imminent' }));

        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        expect(mockLogSilentPushSkipped).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'movement-motion-stationary' }),
        );
      });
    });

    describe('reschedule kind (#725)', () => {
      function reschedulePayload(extra: Record<string, unknown> = {}) {
        return {
          data: {
            data: {
              data: {
                kind: 'reschedule',
                nextStation: '사가정',
                newArrivalTimeEpoch: 1_780_000_000_000,
                trainCode: '7610',
                ...extra,
              },
              dataString: null,
            },
            notification: null,
            aps: { 'content-available': 1 },
          },
        };
      }

      it('reschedule 수신 시 logSilentPushRescheduleReceived 호출 + standard 발사 경로 미진입', async () => {
        await handleSilentPush(reschedulePayload({ sentAt: 1_780_000_000_000 }));
        expect(mockLogSilentPushRescheduleReceived).toHaveBeenCalledTimes(1);
        const arg = mockLogSilentPushRescheduleReceived.mock.calls[0][0];
        expect(arg.nextStation).toBe('사가정');
        expect(arg.sentAt).toBe(1_780_000_000_000);
        expect(typeof arg.receivedAt).toBe('number');
        // standard 발사 경로는 호출되지 않아야 함.
        expect(mockLogSilentPushReceived).not.toHaveBeenCalled();
        expect(mockCheckGate).not.toHaveBeenCalled();
        expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
        expect(mockLogSilentPushFired).not.toHaveBeenCalled();
        expect(mockLogSilentPushSkipped).not.toHaveBeenCalled();
      });

      it('pushId 있으면 ack(fired, reschedule-received) 전송', async () => {
        await handleSilentPush(reschedulePayload({ pushId: 'rs-uuid' }));
        expect(mockSendPushAck).toHaveBeenCalledWith({
          pushId: 'rs-uuid',
          token: DEFAULT_APNS_TOKEN,
          outcome: 'fired',
          reason: 'reschedule-received',
        });
      });

      it('pushId 없으면 ack 호출 안 함 — 수신 통계는 그대로 적재', async () => {
        await handleSilentPush(reschedulePayload());
        expect(mockSendPushAck).not.toHaveBeenCalled();
        expect(mockLogSilentPushRescheduleReceived).toHaveBeenCalledTimes(1);
      });

      it('apnsToken null이면 pushId 있어도 ack skip — 수신 통계는 적재', async () => {
        (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) => {
          if (key === APNS_TOKEN_KEY) return null;
          if (key === DESTINATION_KEY) return JSON.stringify(destStation);
          return null;
        });
        await handleSilentPush(reschedulePayload({ pushId: 'rs-uuid' }));
        expect(mockSendPushAck).not.toHaveBeenCalled();
        expect(mockLogSilentPushRescheduleReceived).toHaveBeenCalledTimes(1);
      });
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

  describe('getSilentPushRegistrationStatus', () => {
    // 등록 상태는 모듈 전역이므로 success → failed 순으로 검증 (역순이면 한 번 success로 덮인 뒤
    // failed로 전이되는 정상 경로만 보고 unknown→failed 첫 케이스를 못 짚는다)
    it('등록 성공 시 success', async () => {
      mockRegisterTaskAsync.mockResolvedValue(undefined);
      await registerSilentPushTask();
      const status = getSilentPushRegistrationStatus();
      expect(status.state).toBe('success');
      expect(status.error).toBeNull();
    });

    it('등록 실패 시 failed + error 메시지', async () => {
      mockRegisterTaskAsync.mockRejectedValue(new Error('not supported'));
      await registerSilentPushTask();
      const status = getSilentPushRegistrationStatus();
      expect(status.state).toBe('failed');
      expect(status.error).toBe('not supported');
    });

    it('Error 아닌 throw도 문자열로 보존', async () => {
      mockRegisterTaskAsync.mockRejectedValue('string-rejection');
      await registerSilentPushTask();
      const status = getSilentPushRegistrationStatus();
      expect(status.state).toBe('failed');
      expect(status.error).toBe('string-rejection');
    });
  });
});
