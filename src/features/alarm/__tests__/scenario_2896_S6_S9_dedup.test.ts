/**
 * #2896 — S6 / S9 시나리오: 매역 알림 체인, "사용자에게 몇 건 도달했는가" 기준 판정.
 *
 * 테스트 전용 — 프로덕션 코드 수정 없음. 판정표는 PR 본문 참고.
 *
 * 범위: FG 로컬 보조 발사(①-아웃풋이자 #2122 `fireFgAuxStationPassedNotification`,
 * `stationNotification.ts:953-973`)와 backend remote alert push가 FG 표시 핸들러
 * (`setupNotificationHandler`, `stationNotification.ts:180-221`)를 함께 거칠 때, 어느 순서로
 * 도착하든 사용자에게 보이는 배너가 정확히 1건인지를 "최종 발사/표시 건수"로 센다.
 *
 * 두 채널이 상호 억제하는 메커니즘은 2가지:
 *  1차(design-intent, 미검증): apns-collapse-id 문자열 일치 — device
 *     `buildStationNotifCollapseId(deviceToken)`(`stationNotifCollapseId.ts:15`) vs backend
 *     `stationNotifCollapseId(trip.token)`(`backend/alarm-worker/src/collapseId.ts:72`). 이
 *     테스트는 OS 알림센터 수준 collapse를 시뮬레이트하지 않는다(JS에서 불가) — 대신 2차
 *     방어선만 직접 구동한다.
 *  2차: `isRecentLocalAuxFireDuplicate`(`stationNotification.ts:321-334`) — FG 표시 핸들러가
 *     "로컬이 방금 쏜 (station, kind)와 같은 backend push면 표시 억제"를 판정. **로컬이 먼저
 *     쏜 순서만 가드한다** — 반대 순서(backend 먼저 표시 → 그 후 device가 독자 판정으로 로컬
 *     발사)는 가드 대상이 아니다(`useStationAlarm.ts` `dispatchStationPassed`,
 *     :328-396 — backend 수신 여부를 전혀 참조하지 않는 자체 dedup만 가짐).
 */
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';

jest.mock('expo-notifications');

jest.mock('../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('live-activity', () => ({
  startLiveActivity: jest.fn().mockResolvedValue(undefined),
  updateLiveActivity: jest.fn().mockResolvedValue(undefined),
  endLiveActivity: jest.fn().mockResolvedValue(undefined),
  isLiveActivityEnabled: jest.fn().mockReturnValue(true),
  hasActiveLiveActivity: jest.fn().mockReturnValue(true),
}));

// #2122 두 방어선 중 2차(recentLocalStationFires)만 실제 store 동작을 재현한다 — 실제
// AsyncStorage TTL 타이밍에 기대지 않고, 테스트가 직접 관측 가능한 in-memory map으로 둔다.
// `markLocalStationFired`가 기록한 (kind, station)을 `hasRecentLocalStationFire`가 그대로
// 읽는다는 두 함수의 실제 계약(recentLocalStationFires.ts:57-85)을 그대로 모사.
const fireStore = new Map<string, number>();
const mockMarkLocalStationFired = jest.fn((stationName: string, kind: string) => {
  fireStore.set(`${kind}:${stationName}`, Date.now());
  return Promise.resolve();
});
const mockHasRecentLocalStationFire = jest.fn((stationName: string, kind: string) => {
  return Promise.resolve(fireStore.has(`${kind}:${stationName}`));
});
jest.mock('../utils/recentLocalStationFires', () => ({
  markLocalStationFired: (...args: [string, string]) => mockMarkLocalStationFired(...args),
  hasRecentLocalStationFire: (...args: [string, string]) => mockHasRecentLocalStationFire(...args),
}));

import {
  setupNotificationHandler,
  fireFgAuxStationPassedNotification,
} from '../utils/stationNotification';
import { APNS_TOKEN_KEY } from '../../../shared/constants/storageKeys';

const mockedSchedule = Notifications.scheduleNotificationAsync as jest.MockedFunction<
  typeof Notifications.scheduleNotificationAsync
>;
const mockedSetHandler = Notifications.setNotificationHandler as jest.MockedFunction<
  typeof Notifications.setNotificationHandler
>;

const DEVICE_TOKEN = 'a'.repeat(64);

type HandleNotification = (
  notification: Notifications.Notification,
) => Promise<Notifications.NotificationBehavior>;

function captureHandler(): HandleNotification {
  setupNotificationHandler();
  const call = mockedSetHandler.mock.calls[mockedSetHandler.mock.calls.length - 1];
  return (call[0] as { handleNotification: HandleNotification }).handleNotification;
}

/** backend `sendAlertPush`(scheduled.ts:3805)가 싣는 payload shape 축약 재현. */
function remoteStationPush(
  station: string,
  pushId: string,
): Notifications.Notification {
  return {
    date: Date.now(),
    request: {
      identifier: `remote-${pushId}`,
      content: {
        title: '',
        subtitle: null,
        body: '',
        data: { nextWaypoint: station, kind: 'intermediate', pushId },
        sound: null,
        badge: null,
        launchImageName: null,
        categoryIdentifier: null,
        interruptionLevel: undefined,
        attachments: [],
      },
      trigger: null as unknown as Notifications.NotificationTrigger,
    },
  } as unknown as Notifications.Notification;
}

beforeEach(() => {
  jest.clearAllMocks();
  fireStore.clear();
  mockedSchedule.mockResolvedValue('id');
  (AsyncStorage.getItem as jest.Mock).mockImplementation(async (key: string) =>
    key === APNS_TOKEN_KEY ? DEVICE_TOKEN : null,
  );
});

describe('S6 — 지상 lock 트립: 역당 정확히 1건, 중복 0 (device 범위)', () => {
  it('로컬 FG 보조 발사가 먼저 도착 → 뒤늦은 backend push는 2차 방어선에 억제돼 총 1건', async () => {
    await fireFgAuxStationPassedNotification('강남', 3, 'destination', '서울역', '2');
    expect(mockedSchedule).toHaveBeenCalledTimes(1);

    const handler = captureHandler();
    const result = await handler(remoteStationPush('강남', 'p-late'));

    const totalDeliveredToUser = mockedSchedule.mock.calls.length + (result.shouldShowAlert ? 1 : 0);
    expect(totalDeliveredToUser).toBe(1);
  });

  it('backend push가 먼저 표시된 뒤 device가 독자 판정으로 로컬 보조 발사 → 총 2건 (스펙 위반)', async () => {
    const handler = captureHandler();
    const remoteResult = await handler(remoteStationPush('잠실', 'p-early'));
    // 2차 방어선은 "로컬이 먼저 쏜 경우"만 가드하므로, 로컬 기록이 없는 이 시점엔 표시된다.
    expect(remoteResult.shouldShowAlert).toBe(true);

    // useStationAlarm.dispatchStationPassed(useStationAlarm.ts:328-396)는 backend 수신 여부를
    // 전혀 참조하지 않고 자체 GPS/arvlCd 판정만으로 이 함수를 호출한다 — 재현.
    await fireFgAuxStationPassedNotification('잠실', 1, 'destination', '잠실', '2');

    const totalDeliveredToUser =
      mockedSchedule.mock.calls.length + (remoteResult.shouldShowAlert ? 1 : 0);
    // 스펙(S6): 어느 경로가 쏘든 정확히 1건이어야 한다. 현재 코드는 역순서에서 2건 — RED.
    expect(totalDeliveredToUser).toBe(1);
  });
});

describe('S9 — 같은 역에 2건 이상 발사 금지 (dedup)', () => {
  it('local-first 순서는 dedup된다 (1건)', async () => {
    await fireFgAuxStationPassedNotification('교대', 2, 'transfer', '사당', '2');
    const handler = captureHandler();
    const result = await handler(remoteStationPush('교대', 'p-dup-1'));

    const fired = mockedSchedule.mock.calls.length + (result.shouldShowAlert ? 1 : 0);
    expect(fired).toBeLessThanOrEqual(1);
  });

  it('remote-first 순서는 dedup되지 않는다 — 같은 역 2건 발사 (스펙 위반, RED)', async () => {
    const handler = captureHandler();
    const remoteResult = await handler(remoteStationPush('용마산', 'p-dup-2'));
    await fireFgAuxStationPassedNotification('용마산', 1, 'destination', '용마산', '7');

    const fired = mockedSchedule.mock.calls.length + (remoteResult.shouldShowAlert ? 1 : 0);
    // 스펙(S9): 같은 역 2건 이상 발사 금지. 현재 코드는 이 순서에서 2건 — RED.
    expect(fired).toBeLessThanOrEqual(1);
  });
});
