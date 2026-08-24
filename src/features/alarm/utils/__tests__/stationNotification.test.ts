import * as Notifications from 'expo-notifications';
import { Platform, Vibration } from 'react-native';
import i18next from 'i18next';
import {
  setupNotificationHandler,
  initStationNotification,
  updateStationNotification,
  clearStationNotification,
  clearAlarmNotification,
  buildAlarmContent,
  buildStationPassedContent,
  fireFgAuxStationPassedNotification,
  fireLocalAlarmNotification,
} from '../stationNotification';
import { buildStationNotifCollapseId } from '../stationNotifCollapseId';
import { APNS_TOKEN_KEY } from '../../../../shared/constants/storageKeys';
import { Station } from '../../../../shared/types/station';
import {
  makeDirectRoute,
  makeMultiTransferRoute,
  makeTransferRoute,
} from '../../../../testUtils/routeFixtures';

jest.mock('expo-notifications');
jest.mock('../../../../shared/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const mockVibrateAlarm = jest.fn();
const mockStopVibration = jest.fn();
jest.mock('../alarmSound', () => ({
  vibrateAlarm: (...args: unknown[]) => mockVibrateAlarm(...args),
  stopVibration: () => mockStopVibration(),
}));

const mockSpeakAlarm = jest.fn();
jest.mock('../tts', () => ({
  speakAlarm: (...args: unknown[]) => mockSpeakAlarm(...args),
}));

const mockStartLiveActivity = jest.fn().mockResolvedValue(undefined);
const mockUpdateLiveActivity = jest.fn().mockResolvedValue(undefined);
const mockEndLiveActivity = jest.fn().mockResolvedValue(undefined);
const mockIsLiveActivityEnabled = jest.fn().mockReturnValue(true);

jest.mock('live-activity', () => ({
  startLiveActivity: (...args: unknown[]) => mockStartLiveActivity(...args),
  updateLiveActivity: (...args: unknown[]) => mockUpdateLiveActivity(...args),
  endLiveActivity: () => mockEndLiveActivity(),
  isLiveActivityEnabled: () => mockIsLiveActivityEnabled(),
}));

const mockEnsureLiveActivityRegistered = jest.fn().mockResolvedValue(undefined);
const mockEndLiveActivityWithDeregister = jest.fn().mockResolvedValue(undefined);
jest.mock('../liveActivityPushChannel', () => ({
  ensureLiveActivityRegistered: (...args: unknown[]) =>
    mockEnsureLiveActivityRegistered(...args),
  endLiveActivityWithDeregister: (...args: unknown[]) =>
    mockEndLiveActivityWithDeregister(...args),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { ACTIVE_TRIP_KEY } from '../../../../shared/constants/storageKeys';

const mockHasFiredPushId = jest.fn();
jest.mock('../firedPushIds', () => ({
  hasFiredPushId: (...args: unknown[]) => mockHasFiredPushId(...args),
}));

// #2122 (FG 보조 발사) — 로컬 station-passed 발사 기록/조회 store. 2b 억제 판정과
// fireFgAuxStationPassedNotification 후처리 stamp를 분리 검증하기 위해 mock으로 격리.
const mockMarkLocalStationFired = jest.fn().mockResolvedValue(undefined);
const mockHasRecentLocalStationFire = jest.fn().mockResolvedValue(false);
jest.mock('../recentLocalStationFires', () => ({
  markLocalStationFired: (...args: unknown[]) => mockMarkLocalStationFired(...args),
  hasRecentLocalStationFire: (...args: unknown[]) => mockHasRecentLocalStationFire(...args),
}));

const mockSaveStationToWidget = jest.fn().mockResolvedValue(undefined);
const mockClearWidgetStation = jest.fn().mockResolvedValue(undefined);
const mockAddDomainBreadcrumb = jest.fn();
jest.mock('../../../../shared/infra/monitoring/breadcrumb', () => ({
  addLogBreadcrumb: jest.fn(),
  addDomainBreadcrumb: (...args: unknown[]) => mockAddDomainBreadcrumb(...args),
}));

jest.mock('../../../widget/api/widgetStorage', () => ({
  saveStationToWidget: (...args: unknown[]) => mockSaveStationToWidget(...args),
  clearWidgetStation: () => mockClearWidgetStation(),
}));

// 좌/우 알람 본문 분기 테스트용 픽스처. 강남=상행 left/하행 right, 시청=상행 both만 등록.
jest.mock('../../../../data/exitSide.json', () => ({
  강남: { up: 'left', down: 'right' },
  시청: { up: 'both' },
}));

// #1504 — direction-agnostic platform fallback SSOT.
// 강남(2-022)·시청(1-033/2-001)은 빈 매핑이라 primary(`exitSide.json`) 단독 분기 테스트가 그대로 유지된다.
// fallback 검증용으로 잠실(2-016)·왕십리(2-008)에만 명시 매핑을 등록한다. 두 역은 exitSide.json에 없어
// fallback 경로를 단독 측정한다.
jest.mock('../../../../data/platformExitSide.json', () => ({
  '2-016': 'right',
  '2-008': 'both',
}));

// 빠른하차 힌트 분기 테스트용 — 잠실(2-016)·왕십리(2-008)만 등록.
// 기존 테스트들이 자주 쓰는 강남(2-022)·시청(1-033)에는 데이터를 두지 않아 기존 본문 비교가 깨지지 않도록 한다.
jest.mock('../../../../data/quickExit.json', () => ({
  '2-016': { stairs: [{ doorNumber: '3-2' }] },
  '2-008': { elevator: [{ doorNumber: '5-1' }] },
}));

const mockStation: Station = {
  id: 'si-cheong-1',
  name: '시청',
  line: '1',
  lineColor: '#0052A4',
  lat: 37.5651,
  lng: 126.9774,
};

const mockDestination: Station = {
  id: 'seong-sin-4',
  name: '성신여대입구',
  line: '4',
  lineColor: '#00A2D1',
  lat: 37.5926,
  lng: 127.0163,
};

const directRoute = makeDirectRoute(4, '1');
const transferRoute = makeTransferRoute({
  transferName: '동대문',
  fromLine: '1',
  toLine: '4',
  stopsToTransfer: 3,
  stopsFromTransfer: 2,
});
const multiTransferRoute = makeMultiTransferRoute({
  transfers: [
    { transferName: '잠실', fromLine: '8', toLine: '2', stopsToTransfer: 3 },
    { transferName: '시청', fromLine: '2', toLine: '1', stopsToTransfer: 5 },
  ],
  stopsAfterLastTransfer: 4,
});

function expectNotificationContent(title: string, body: string) {
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
    expect.objectContaining({ content: { title, body } }),
  );
}

describe('stationNotification', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Notifications.setNotificationHandler as jest.Mock).mockReturnValue(undefined);
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted' });
    (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted' });
    (Notifications.dismissNotificationAsync as jest.Mock).mockResolvedValue(undefined);
    (Notifications.scheduleNotificationAsync as jest.Mock).mockResolvedValue('current-station');
    (Notifications.setNotificationChannelAsync as jest.Mock).mockResolvedValue(undefined);
    mockIsLiveActivityEnabled.mockReturnValue(true);
  });

  describe('setupNotificationHandler', () => {
    it('setNotificationHandler를 호출한다', () => {
      setupNotificationHandler();
      expect(Notifications.setNotificationHandler).toHaveBeenCalledWith(
        expect.objectContaining({ handleNotification: expect.any(Function) })
      );
    });

    it('일반 알림은 shouldPlaySound false, 알람 알림(sound 있음)은 true를 반환한다', async () => {
      setupNotificationHandler();
      const { handleNotification } = (Notifications.setNotificationHandler as jest.Mock).mock.calls[0][0];
      const normalResult = await handleNotification({ request: { identifier: 'current-station', content: { sound: null } } });
      expect(normalResult).toEqual({ shouldShowAlert: true, shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false });

      const alarmResult = await handleNotification({ request: { identifier: 'station-alarm', content: { sound: 'alarm.wav' } } });
      expect(alarmResult).toEqual({ shouldShowAlert: true, shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false });

      const silentAlarmResult = await handleNotification({ request: { identifier: 'station-alarm', content: { sound: null } } });
      expect(silentAlarmResult).toEqual({ shouldShowAlert: true, shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false });
    });

    it('#574 P2e — pushId가 firedPushIds에 있으면 모든 show 플래그 false로 suppress', async () => {
      mockHasFiredPushId.mockResolvedValueOnce(true);
      setupNotificationHandler();
      const { handleNotification } = (Notifications.setNotificationHandler as jest.Mock).mock.calls[0][0];
      const result = await handleNotification({
        request: { identifier: 'station-alarm', content: { sound: 'alarm.wav', data: { pushId: 'p1' } } },
      });
      expect(mockHasFiredPushId).toHaveBeenCalledWith('p1');
      expect(result).toEqual({
        shouldShowAlert: false,
        shouldShowBanner: false,
        shouldShowList: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
      });
    });

    it('#574 P2e — pushId가 fired set에 없으면 정상 표시', async () => {
      mockHasFiredPushId.mockResolvedValueOnce(false);
      setupNotificationHandler();
      const { handleNotification } = (Notifications.setNotificationHandler as jest.Mock).mock.calls[0][0];
      const result = await handleNotification({
        request: { identifier: 'station-alarm', content: { sound: 'alarm.wav', data: { pushId: 'fresh' } } },
      });
      expect(result.shouldShowAlert).toBe(true);
      expect(result.shouldPlaySound).toBe(true);
    });

    it('#574 P2e — data 없거나 pushId 누락이면 정상 표시 (hasFiredPushId 호출 안 함)', async () => {
      setupNotificationHandler();
      const { handleNotification } = (Notifications.setNotificationHandler as jest.Mock).mock.calls[0][0];
      const noData = await handleNotification({
        request: { identifier: 'station-alarm', content: { sound: null } },
      });
      expect(noData.shouldShowAlert).toBe(true);
      const dataNoPushId = await handleNotification({
        request: { identifier: 'station-alarm', content: { sound: null, data: { other: 'x' } } },
      });
      expect(dataNoPushId.shouldShowAlert).toBe(true);
      const emptyPushId = await handleNotification({
        request: { identifier: 'station-alarm', content: { sound: null, data: { pushId: '' } } },
      });
      expect(emptyPushId.shouldShowAlert).toBe(true);
      expect(mockHasFiredPushId).not.toHaveBeenCalled();
    });

    // #2122 (FG 보조 발사) — 2차 방어선. backend alert push data.nextWaypoint/kind가 최근 로컬
    // 발사(station-passed)와 일치하면 표시를 억제한다(1차 방어선은 apns-collapse-id 문자열 일치).
    describe('#2122 — 최근 로컬 발사(station,kind) 표시 억제 (2b)', () => {
      it('data.kind=intermediate + hasRecentLocalStationFire=true → 표시 억제', async () => {
        mockHasRecentLocalStationFire.mockResolvedValueOnce(true);
        setupNotificationHandler();
        const { handleNotification } = (Notifications.setNotificationHandler as jest.Mock).mock.calls[0][0];
        const result = await handleNotification({
          request: {
            identifier: 'station-notif-abc',
            content: { sound: null, data: { nextWaypoint: '중곡', kind: 'intermediate' } },
          },
        });
        expect(mockHasRecentLocalStationFire).toHaveBeenCalledWith('중곡', 'station-passed');
        expect(result).toEqual({
          shouldShowAlert: false,
          shouldShowBanner: false,
          shouldShowList: false,
          shouldPlaySound: false,
          shouldSetBadge: false,
        });
      });

      it('data.kind=intermediate + hasRecentLocalStationFire=false → 정상 표시', async () => {
        mockHasRecentLocalStationFire.mockResolvedValueOnce(false);
        setupNotificationHandler();
        const { handleNotification } = (Notifications.setNotificationHandler as jest.Mock).mock.calls[0][0];
        const result = await handleNotification({
          request: {
            identifier: 'station-notif-abc',
            content: { sound: null, data: { nextWaypoint: '중곡', kind: 'intermediate' } },
          },
        });
        expect(result.shouldShowAlert).toBe(true);
      });

      it('data.kind가 매핑 대상(intermediate/transfer/destination) 외이면 hasRecentLocalStationFire 호출 안 함 (정상 표시)', async () => {
        setupNotificationHandler();
        const { handleNotification } = (Notifications.setNotificationHandler as jest.Mock).mock.calls[0][0];
        const result = await handleNotification({
          request: {
            identifier: 'station-alarm',
            // #918 — transfer/destination도 이제 매핑 대상에 포함(OS 사전예약 3-소스 dedup
            // 확장)되므로, 매핑되지 않는 예시로는 두 채널 모두에 없는 임의 kind를 사용한다.
            content: { sound: null, data: { nextWaypoint: '중곡', kind: 'boarding-prompt' } },
          },
        });
        expect(mockHasRecentLocalStationFire).not.toHaveBeenCalled();
        expect(result.shouldShowAlert).toBe(true);
      });

      it('data 없거나 nextWaypoint/kind 누락이면 hasRecentLocalStationFire 호출 안 함 (정상 표시)', async () => {
        setupNotificationHandler();
        const { handleNotification } = (Notifications.setNotificationHandler as jest.Mock).mock.calls[0][0];
        const noData = await handleNotification({
          request: { identifier: 'station-notif-abc', content: { sound: null } },
        });
        expect(noData.shouldShowAlert).toBe(true);
        const noKind = await handleNotification({
          request: {
            identifier: 'station-notif-abc',
            content: { sound: null, data: { nextWaypoint: '중곡' } },
          },
        });
        expect(noKind.shouldShowAlert).toBe(true);
        const emptyStation = await handleNotification({
          request: {
            identifier: 'station-notif-abc',
            content: { sound: null, data: { nextWaypoint: '', kind: 'intermediate' } },
          },
        });
        expect(emptyStation.shouldShowAlert).toBe(true);
        expect(mockHasRecentLocalStationFire).not.toHaveBeenCalled();
      });
    });
  });

  describe('initStationNotification', () => {
    it('iOS에서는 critical alerts 포함 권한 요청만 한다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await initStationNotification();
      expect(Notifications.requestPermissionsAsync).toHaveBeenCalledWith({
        ios: {
          allowAlert: true,
          allowSound: true,
          allowCriticalAlerts: true,
        },
      });
      expect(Notifications.setNotificationChannelAsync).not.toHaveBeenCalled();
    });

    it('Android에서는 채널 생성 후 권한 요청한다', async () => {
      jest.replaceProperty(Platform, 'OS', 'android');
      (Notifications.deleteNotificationChannelAsync as jest.Mock).mockResolvedValue(undefined);
      await initStationNotification();
      expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith('station', {
        name: '현재 역',
        importance: Notifications.AndroidImportance.HIGH,
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      });
      expect(Notifications.deleteNotificationChannelAsync).toHaveBeenCalledWith('station-alarm');
      expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith('station-alarm', {
        name: '하차/환승 알림',
        importance: Notifications.AndroidImportance.MAX,
        sound: 'alarm.wav',
        enableVibrate: true,
        vibrationPattern: [0, 1000, 500, 1000],
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
        bypassDnd: true,
      });
      expect(Notifications.deleteNotificationChannelAsync).toHaveBeenCalledWith('station-alarm-silent');
      // #2158 P1 — stationPrescheduler(일반모드)가 이 채널을 재사용하므로 MAX+bypassDnd(취침용
      // 강제 알림 속성)를 제거하고 HIGH 이하로 낮춘다. Android 8+에서는 채널 속성이 고정이라
      // per-notification content.sound=false만으로는 loud를 막을 수 없다(채널 자체가 무음이어야 함).
      expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith('station-alarm-silent', {
        name: '하차/환승 알림 (무음)',
        importance: Notifications.AndroidImportance.HIGH,
        sound: null,
        enableVibrate: true,
        vibrationPattern: [0, 1000, 500, 1000],
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      });
      expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith('station-passed', {
        name: '역 도착 알림',
        importance: Notifications.AndroidImportance.DEFAULT,
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
        sound: null,
        enableVibrate: false,
      });
      expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    });

    it('Android에서 기존 채널 삭제 실패해도 정상 동작한다', async () => {
      jest.replaceProperty(Platform, 'OS', 'android');
      (Notifications.deleteNotificationChannelAsync as jest.Mock).mockRejectedValue(new Error('채널 없음'));
      await initStationNotification();
      expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith('station-alarm', expect.anything());
    });

    it('권한 요청 후 permission 카테고리 breadcrumb 추가', async () => {
      mockAddDomainBreadcrumb.mockClear();
      jest.replaceProperty(Platform, 'OS', 'ios');
      (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValueOnce({ status: 'granted' });
      await initStationNotification();
      expect(mockAddDomainBreadcrumb).toHaveBeenCalledWith('permission', 'notification', {
        status: 'granted',
      });
    });
  });

  describe('updateStationNotification (iOS - Live Activity)', () => {
    beforeEach(async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      jest.clearAllMocks();
      mockIsLiveActivityEnabled.mockReturnValue(true);
      await AsyncStorage.clear();
      mockEnsureLiveActivityRegistered.mockResolvedValue(undefined);
      mockEndLiveActivityWithDeregister.mockResolvedValue(undefined);
    });

    it('#1288 — ACTIVE_TRIP_KEY가 있으면 ensureLiveActivityRegistered 경로 사용', async () => {
      await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'apns-token-abc');
      await updateStationNotification(mockStation, 154);
      expect(mockEnsureLiveActivityRegistered).toHaveBeenCalledWith(
        'apns-token-abc',
        expect.objectContaining({ stationName: '시청', distanceM: 154 }),
      );
      expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
    });

    it('#1288 — ensureLiveActivityRegistered 실패 시 expo-notifications fallback', async () => {
      await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'apns-token-abc');
      mockEnsureLiveActivityRegistered.mockRejectedValueOnce(new Error('LA 등록 실패'));
      await updateStationNotification(mockStation, 154);
      expectNotificationContent('시청역', '1호선 · 약 154m');
    });

    it('updateLiveActivity를 호출한다', async () => {
      await updateStationNotification(mockStation, 154);
      expect(mockUpdateLiveActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          stationName: '시청',
          lineName: '1호선',
          lineColorHex: '#0052A4',
          distanceM: 154,
        })
      );
      expect(mockStartLiveActivity).not.toHaveBeenCalled();
    });

    it('연속 호출 시 항상 updateLiveActivity를 호출한다', async () => {
      await updateStationNotification(mockStation, 154);
      await updateStationNotification(mockStation, 100);
      expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(2);
      expect(mockStartLiveActivity).not.toHaveBeenCalled();
    });

    it('목적지 없으면 destinationName이 없다', async () => {
      await updateStationNotification(mockStation, 154);
      expect(mockUpdateLiveActivity).toHaveBeenCalledWith(
        expect.not.objectContaining({ destinationName: expect.anything() })
      );
    });

    it('직통 경로이면 stopsRemaining을 포함한다', async () => {
      await updateStationNotification(mockStation, 154, mockDestination, directRoute);
      expect(mockUpdateLiveActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          destinationName: '성신여대입구',
          stopsRemaining: 4,
        })
      );
    });

    it('환승 경로이면 환승 정보를 포함한다', async () => {
      await updateStationNotification(mockStation, 154, mockDestination, transferRoute);
      expect(mockUpdateLiveActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          destinationName: '성신여대입구',
          stopsToTransfer: 3,
          transferStationName: '동대문',
          stopsFromTransfer: 2,
        })
      );
    });

    it('multi-transfer 경로이면 두 환승 정보를 포함한다', async () => {
      await updateStationNotification(mockStation, 154, mockDestination, multiTransferRoute);
      expect(mockUpdateLiveActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          destinationName: '성신여대입구',
          stopsToTransfer: 3,
          transferStationName: '잠실',
          stopsToSecondTransfer: 5,
          secondTransferStationName: '시청',
          stopsAfterLastTransfer: 4,
        })
      );
    });

    it('etaMinutes를 전달하면 Live Activity 데이터에 포함된다', async () => {
      await updateStationNotification(mockStation, 154, mockDestination, directRoute, 12);
      expect(mockUpdateLiveActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          etaMinutes: 12,
        })
      );
    });

    it('isMock이 true이면 Live Activity 데이터에 포함된다', async () => {
      await updateStationNotification(mockStation, 154, mockDestination, directRoute, 12, true);
      expect(mockUpdateLiveActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          etaMinutes: 12,
          isMock: true,
        })
      );
    });

    it('etaMinutes가 없으면 Live Activity 데이터에 포함되지 않는다', async () => {
      await updateStationNotification(mockStation, 154, mockDestination, directRoute);
      expect(mockUpdateLiveActivity).toHaveBeenCalledWith(
        expect.not.objectContaining({ etaMinutes: expect.anything() })
      );
    });

    it('목적지만 있고 경로가 없으면 destinationName만 포함한다', async () => {
      await updateStationNotification(mockStation, 154, mockDestination, null);
      expect(mockUpdateLiveActivity).toHaveBeenCalledWith(
        expect.objectContaining({ destinationName: '성신여대입구' })
      );
      expect(mockUpdateLiveActivity).toHaveBeenCalledWith(
        expect.not.objectContaining({ stopsRemaining: expect.anything() })
      );
      expect(mockUpdateLiveActivity).toHaveBeenCalledWith(
        expect.not.objectContaining({ stopsToTransfer: expect.anything() })
      );
    });

    it('expo-notifications를 호출하지 않는다', async () => {
      await updateStationNotification(mockStation, 154);
      expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
    });

    it('isLiveActivityEnabled가 false이면 expo-notifications로 fallback한다', async () => {
      mockIsLiveActivityEnabled.mockReturnValue(false);
      await updateStationNotification(mockStation, 154);
      expect(mockStartLiveActivity).not.toHaveBeenCalled();
      expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
      expectNotificationContent('시청역', '1호선 · 약 154m');
    });

    it('updateLiveActivity 실패 시 expo-notifications로 폴백한다', async () => {
      mockUpdateLiveActivity.mockRejectedValueOnce(new Error('ActivityKit 오류'));
      await updateStationNotification(mockStation, 154);
      expectNotificationContent('시청역', '1호선 · 약 154m');
    });

    it('alarmEvent가 있으면 alarmType과 alarmStationName이 포함된다', async () => {
      await updateStationNotification(mockStation, 154, mockDestination, transferRoute, 12, false, { phaseId: 'early', type: 'transfer', stationName: '동대문' });
      expect(mockUpdateLiveActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          alarmType: 'transfer',
          alarmStationName: '동대문',
          alarmBody: '다음 역 동대문에서 환승하세요!',
          alarmShortLabel: '환승',
        })
      );
    });

    it('alarmEvent가 destination 타입이면 alarmType이 destination이다', async () => {
      await updateStationNotification(mockStation, 154, mockDestination, directRoute, 12, false, { phaseId: 'early', type: 'destination', stationName: '강남' });
      expect(mockUpdateLiveActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          alarmType: 'destination',
          alarmStationName: '강남',
          alarmBody: '다음 역 강남에서 하차하세요!',
          alarmShortLabel: '하차',
        })
      );
    });

    it('alarmEvent에 direction이 있으면 alarmBody에 좌/우 라인이 포함되고 alarmExitSide 필드가 채워진다', async () => {
      await updateStationNotification(mockStation, 154, mockDestination, directRoute, 12, false, { phaseId: 'early', type: 'destination', stationName: '강남', direction: 'up' });
      expect(mockUpdateLiveActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          alarmBody: '다음 역 강남에서 하차하세요!\n왼쪽 문으로 하차하세요',
          alarmExitSide: 'left',
        })
      );
    });

    it('alarmEvent에 direction이 있어도 데이터가 없으면 alarmExitSide가 빠진다', async () => {
      await updateStationNotification(mockStation, 154, mockDestination, directRoute, 12, false, { phaseId: 'early', type: 'destination', stationName: '미등록역', direction: 'up' });
      expect(mockUpdateLiveActivity).toHaveBeenCalledWith(
        expect.not.objectContaining({ alarmExitSide: expect.anything() })
      );
    });

    it('direct route + ETA가 있으면 routeSubtext/routeSummary/etaText/distanceText가 빌드된다', async () => {
      await updateStationNotification(mockStation, 154, mockDestination, directRoute, 12, false);
      expect(mockUpdateLiveActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          routeSubtext: expect.stringContaining('도착'),
          routeSummary: expect.stringContaining('→'),
          etaText: expect.stringContaining('12'),
          etaSubtext: '소요',
          distanceText: expect.stringContaining('154'),
        })
      );
    });

    it('isMock=true면 etaSubtext가 예상으로 빌드된다', async () => {
      await updateStationNotification(mockStation, 154, mockDestination, directRoute, 12, true);
      expect(mockUpdateLiveActivity).toHaveBeenCalledWith(
        expect.objectContaining({ etaSubtext: '예상' })
      );
    });

    it('transfer route이면 routeSubtext에 환승 역명이 포함된다', async () => {
      await updateStationNotification(mockStation, 154, mockDestination, transferRoute);
      expect(mockUpdateLiveActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          routeSubtext: expect.stringContaining('환승'),
          routeSummary: expect.stringContaining('환승'),
        })
      );
    });

    it('destination만 있고 route가 없으면 summaryDestinationOnly로 빌드된다', async () => {
      await updateStationNotification(mockStation, 154, mockDestination);
      expect(mockUpdateLiveActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          routeSummary: expect.stringMatching(/^→ /),
        })
      );
    });

    it('alarmEvent가 없으면 alarmType이 포함되지 않는다', async () => {
      await updateStationNotification(mockStation, 154, mockDestination, directRoute);
      expect(mockUpdateLiveActivity).toHaveBeenCalledWith(
        expect.not.objectContaining({ alarmType: expect.anything() })
      );
    });

    it('source 인자 전달 시 sourceLabel을 i18n 빌드해 LA 데이터에 포함 (#327)', async () => {
      await updateStationNotification(
        mockStation,
        154,
        mockDestination,
        directRoute,
        12,
        false,
        null,
        'gpsOnly',
      );
      expect(mockUpdateLiveActivity).toHaveBeenCalledWith(
        expect.objectContaining({ sourceLabel: 'GPS 추정' }),
      );
    });

    it('source 미지정 시 sourceLabel은 포함되지 않음 (호환 안전)', async () => {
      await updateStationNotification(mockStation, 154, mockDestination, directRoute);
      expect(mockUpdateLiveActivity).toHaveBeenCalledWith(
        expect.not.objectContaining({ sourceLabel: expect.anything() }),
      );
    });
  });

  describe('updateStationNotification (Android - expo-notifications)', () => {
    beforeEach(() => {
      jest.replaceProperty(Platform, 'OS', 'android');
    });

    it('목적지 없으면 역 이름과 거리를 표시한다', async () => {
      await updateStationNotification(mockStation, 154);
      expectNotificationContent('시청역', '1호선 · 약 154m');
    });

    it('직통 경로이면 목적지와 정거장 수를 표시한다', async () => {
      await updateStationNotification(mockStation, 154, mockDestination, directRoute);
      expectNotificationContent('시청 → 성신여대입구', '1호선 · 4정거장 남음');
    });

    it('환승 경로이면 환승 정보를 표시한다', async () => {
      await updateStationNotification(mockStation, 154, mockDestination, transferRoute);
      expectNotificationContent('시청 → 성신여대입구', '3정거장 후 동대문 환승');
    });

    it('multi-transfer 경로이면 두 환승 정보를 표시한다', async () => {
      await updateStationNotification(mockStation, 154, mockDestination, multiTransferRoute);
      expectNotificationContent('시청 → 성신여대입구', '3정거장 후 잠실 환승');
    });

    it('etaMinutes가 있으면 알림 body에 소요 시간이 포함된다', async () => {
      await updateStationNotification(mockStation, 154, mockDestination, directRoute, 12);
      expectNotificationContent('시청 → 성신여대입구', '1호선 · 4정거장 남음 · 약 12분');
    });

    it('isMock이면 알림 body에 (예상) 표시가 포함된다', async () => {
      await updateStationNotification(mockStation, 154, mockDestination, directRoute, 12, true);
      expectNotificationContent('시청 → 성신여대입구', '1호선 · 4정거장 남음 · 약 12분 (예상)');
    });

    it('dismiss가 실패해도 schedule은 호출된다', async () => {
      (Notifications.dismissNotificationAsync as jest.Mock).mockRejectedValue(new Error('없음'));
      await updateStationNotification(mockStation, 154);
      expect(Notifications.scheduleNotificationAsync).toHaveBeenCalled();
    });

    it('dismiss가 schedule보다 먼저 호출된다', async () => {
      const callOrder: string[] = [];
      (Notifications.dismissNotificationAsync as jest.Mock).mockImplementation(async () => { callOrder.push('dismiss'); });
      (Notifications.scheduleNotificationAsync as jest.Mock).mockImplementation(async () => { callOrder.push('schedule'); return 'id'; });
      await updateStationNotification(mockStation, 154);
      expect(callOrder).toEqual(['dismiss', 'schedule']);
    });

    it('목적지만 있고 경로가 없으면 제목에 목적지가 표시된다', async () => {
      await updateStationNotification(mockStation, 154, mockDestination, null);
      expectNotificationContent('시청 → 성신여대입구', '1호선 · 약 154m');
    });

    it('Live Activity를 호출하지 않는다', async () => {
      await updateStationNotification(mockStation, 154);
      expect(mockStartLiveActivity).not.toHaveBeenCalled();
    });
  });

  describe('clearStationNotification', () => {
    beforeEach(async () => {
      jest.clearAllMocks();
      await AsyncStorage.clear();
      mockEnsureLiveActivityRegistered.mockResolvedValue(undefined);
      mockEndLiveActivityWithDeregister.mockResolvedValue(undefined);
    });

    it('iOS에서 endLiveActivity를 호출하고 station-passed 알림도 해제한다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      mockIsLiveActivityEnabled.mockReturnValue(true);

      await clearStationNotification();
      expect(mockEndLiveActivity).toHaveBeenCalled();
      expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith('station-passed');
    });

    it('#1288 — ACTIVE_TRIP_KEY가 있으면 endLiveActivityWithDeregister 사용', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      mockIsLiveActivityEnabled.mockReturnValue(true);
      await AsyncStorage.setItem(ACTIVE_TRIP_KEY, 'apns-token-abc');

      await clearStationNotification();
      expect(mockEndLiveActivityWithDeregister).toHaveBeenCalledWith('apns-token-abc');
      expect(mockEndLiveActivity).not.toHaveBeenCalled();
    });

    it('iOS에서 endLiveActivity가 실패해도 에러를 던지지 않는다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      mockIsLiveActivityEnabled.mockReturnValue(true);
      mockEndLiveActivity.mockRejectedValueOnce(new Error('종료 실패'));

      await expect(clearStationNotification()).resolves.toBeUndefined();
    });

    it('station-passed dismiss 실패해도 에러를 던지지 않는다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      mockIsLiveActivityEnabled.mockReturnValue(true);
      (Notifications.dismissNotificationAsync as jest.Mock).mockRejectedValue(new Error('dismiss 실패'));

      await expect(clearStationNotification()).resolves.toBeUndefined();
    });

    it('iOS에서 Live Activity 비활성화 시 dismissNotificationAsync를 호출한다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      mockIsLiveActivityEnabled.mockReturnValue(false);
      await clearStationNotification();
      expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith('current-station');
      expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith('station-passed');
      expect(mockEndLiveActivity).not.toHaveBeenCalled();
    });

    it('Android에서 dismissNotificationAsync를 호출한다', async () => {
      jest.replaceProperty(Platform, 'OS', 'android');
      await clearStationNotification();
      expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith('current-station');
      expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith('station-passed');
      expect(mockEndLiveActivity).not.toHaveBeenCalled();
    });
  });

  // #2067 (Phase 2-device, D1) — sendAlarmNotification 제거(알람 배너는 원격 visible push가 담당).
  // 본 함수가 감싸던 buildAlarmContent(exit side / quick hint / phase 문구 조립)는 여전히
  // alarmScheduler/tripBoundScheduler/boardingLockScheduler(#2089 대상, 이번 PR 범위 밖)가
  // 소비하므로 stationNotification.ts에 남아있다 — 아래는 그 로직을 직접 검증한다.
  describe('buildAlarmContent', () => {
    const earlyDest = { phaseId: 'early' as const, type: 'destination' as const, stationName: '강남' };
    const earlyTransfer = { phaseId: 'early' as const, type: 'transfer' as const, stationName: '시청' };
    const imminentDest = { phaseId: 'imminent' as const, type: 'destination' as const, stationName: '강남' };
    const imminentTransfer = { phaseId: 'imminent' as const, type: 'transfer' as const, stationName: '시청' };

    it('early destination이면 하차 문구를 만든다', () => {
      expect(buildAlarmContent(earlyDest)).toEqual({
        title: '하차 알림',
        body: '다음 역 강남에서 하차하세요!',
      });
    });

    it('early transfer이면 환승 문구를 만든다', () => {
      expect(buildAlarmContent(earlyTransfer)).toEqual({
        title: '환승 알림',
        body: '다음 역 시청에서 환승하세요!',
      });
    });

    it('imminent destination이면 도착 임박 문구를 만든다', () => {
      expect(buildAlarmContent(imminentDest)).toEqual({
        title: '도착 임박',
        body: '곧 강남에 도착합니다. 하차 준비하세요!',
      });
    });

    it('imminent transfer이면 환승 임박 문구를 만든다', () => {
      expect(buildAlarmContent(imminentTransfer)).toEqual({
        title: '환승 임박',
        body: '곧 시청에 도착합니다. 환승 준비하세요!',
      });
    });

    describe('좌/우 하차 라인 (exitSide)', () => {
      it('event.direction이 없으면 본문에 좌/우 라인을 추가하지 않는다', () => {
        expect(buildAlarmContent(earlyDest).body).toBe('다음 역 강남에서 하차하세요!');
      });

      it('event.direction이 있고 데이터가 매칭되면 좌측 라인이 추가된다', () => {
        expect(buildAlarmContent({ ...earlyDest, direction: 'up' }).body).toBe(
          '다음 역 강남에서 하차하세요!\n왼쪽 문으로 하차하세요',
        );
      });

      it('하행이면 오른쪽 라인이 추가된다', () => {
        expect(buildAlarmContent({ ...earlyDest, direction: 'down' }).body).toBe(
          '다음 역 강남에서 하차하세요!\n오른쪽 문으로 하차하세요',
        );
      });

      it('섬식(both)이면 양쪽 라인이 추가된다', () => {
        expect(buildAlarmContent({ ...earlyTransfer, direction: 'up' }).body).toBe(
          '다음 역 시청에서 환승하세요!\n양쪽 문이 열립니다',
        );
      });

      it('데이터에 없는 방향이면 본문에 좌/우 라인을 추가하지 않는다', () => {
        expect(buildAlarmContent({ ...earlyTransfer, direction: 'down' }).body).toBe(
          '다음 역 시청에서 환승하세요!',
        );
      });

      // #1504 — direction-agnostic platformExitSide.json fallback.
      describe('platformExitSide fallback', () => {
        it('direction이 없어도 platformExitSide에 등록된 역이면 fallback이 적용된다', () => {
          // 잠실(2-016)='right' fixture. quickExit 힌트도 같이 등록돼 있어 함께 표시된다.
          expect(
            buildAlarmContent({ phaseId: 'early', type: 'destination', stationName: '잠실' }).body,
          ).toBe('다음 역 잠실에서 하차하세요!\n오른쪽 문으로 하차하세요\n출구가 빠른 위치에서 하차하세요');
        });

        it('primary가 매칭되면 fallback을 무시하고 primary 결과를 사용한다', () => {
          // 강남: primary up='left' / platformExitSide fixture 미등록 — primary 단독.
          expect(buildAlarmContent({ ...earlyDest, direction: 'up' }).body).toBe(
            '다음 역 강남에서 하차하세요!\n왼쪽 문으로 하차하세요',
          );
        });

        it('primary가 unmatched여도 platformExitSide에 매핑이 있으면 fallback이 적용된다', () => {
          // 왕십리(2-008): primary 미등록 / fallback='both'. direction이 있어도 primary null → fallback.
          expect(
            buildAlarmContent({
              phaseId: 'early',
              type: 'transfer',
              stationName: '왕십리(성동구청)',
              direction: 'up',
            }).body,
          ).toBe('다음 역 왕십리(성동구청)에서 환승하세요!\n양쪽 문이 열립니다\n환승이 빠른 위치에서 하차하세요');
        });

        it('stations.json에 없는 역은 fallback도 발화하지 않는다', () => {
          expect(
            buildAlarmContent({ phaseId: 'early', type: 'destination', stationName: '없는역' }).body,
          ).toBe('다음 역 없는역에서 하차하세요!');
        });
      });
    });

    describe('빠른하차 힌트 (quickExit)', () => {
      // #1504 SonarCloud dedup — quickExit 분기 매트릭스를 it.each로 통합.
      // 각 row: [phaseId, type, stationName, title, body].
      // 잠실/왕십리는 platformExitSide fallback fixture가 있어 좌/우 라인이 함께 붙는다.
      it.each([
        [
          '해당 역의 빠른하차 데이터가 없으면 본문에 힌트가 붙지 않는다',
          'early', 'destination', '시청',
          '하차 알림', '다음 역 시청에서 하차하세요!',
        ],
        [
          'destination 알람이고 데이터가 있으면 "출구가 빠른 위치" 힌트가 붙는다',
          'early', 'destination', '잠실',
          '하차 알림', '다음 역 잠실에서 하차하세요!\n오른쪽 문으로 하차하세요\n출구가 빠른 위치에서 하차하세요',
        ],
        [
          'transfer 알람이고 데이터가 있으면 "환승이 빠른 위치" 힌트가 붙는다',
          'early', 'transfer', '왕십리(성동구청)',
          '환승 알림', '다음 역 왕십리(성동구청)에서 환승하세요!\n양쪽 문이 열립니다\n환승이 빠른 위치에서 하차하세요',
        ],
        [
          '알람 대상역이 stations.json에도 없으면 힌트 없이 본문만 표시한다',
          'early', 'destination', '없는역',
          '하차 알림', '다음 역 없는역에서 하차하세요!',
        ],
        [
          '정규화 fallback — 괄호 부제가 붙은 이름이어도 매칭된다',
          'imminent', 'destination', '잠실',
          '도착 임박', '곧 잠실에 도착합니다. 하차 준비하세요!\n오른쪽 문으로 하차하세요\n출구가 빠른 위치에서 하차하세요',
        ],
      ] as const)('%s', (_label, phaseId, type, stationName, title, body) => {
        expect(buildAlarmContent({ phaseId, type, stationName })).toEqual({ title, body });
      });
    });
  });

  // #2064 (Phase 1-device) — sendStationPassedNotification 제거(매역 알림 backend visible push 단일
  // 채널 전환). STATION_PASSED_CHANNEL_ID 채널 설정 자체(sound:null/enableVibrate:false, #1224)는
  // 'Android 채널 재생성' 테스트(위, refreshNotificationChannels 전체 assert)가 계속 커버한다.

  // #2069 (Phase 3) — sendTripEndedNotification(D11) 제거. B12가 원격 alert push 단일 채널이라
  // 로컬 알림 재생성이 더 이상 필요 없다. 관련 테스트 전체 제거.

  // #1224 회귀 가드 — transfer/destination 알람 채널/페이로드는 변경 없음
  describe('#1224 회귀 가드 (transfer/destination 변경 없음)', () => {
    it('ALARM_CHANNEL_ID는 sound: alarm.wav + enableVibrate: true 유지', async () => {
      jest.replaceProperty(Platform, 'OS', 'android');
      (Notifications.deleteNotificationChannelAsync as jest.Mock).mockResolvedValue(undefined);
      await initStationNotification();
      expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith('station-alarm', {
        name: '하차/환승 알림',
        importance: Notifications.AndroidImportance.MAX,
        sound: 'alarm.wav',
        enableVibrate: true,
        vibrationPattern: [0, 1000, 500, 1000],
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
        bypassDnd: true,
      });
    });

    it('#2158 P1 — ALARM_SILENT_CHANNEL_ID는 sound: null + importance HIGH, bypassDnd 없음(stationPrescheduler 일반모드 재사용)', async () => {
      jest.replaceProperty(Platform, 'OS', 'android');
      (Notifications.deleteNotificationChannelAsync as jest.Mock).mockResolvedValue(undefined);
      await initStationNotification();
      expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith('station-alarm-silent', {
        name: '하차/환승 알림 (무음)',
        importance: Notifications.AndroidImportance.HIGH,
        sound: null,
        enableVibrate: true,
        vibrationPattern: [0, 1000, 500, 1000],
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      });
    });

  });

  describe('clearAlarmNotification', () => {
    it('사운드를 정지하고 station-alarm을 dismiss한다', async () => {
      await clearAlarmNotification();
      expect(mockStopVibration).toHaveBeenCalled();
      expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith('station-alarm');
    });

    it('dismiss 실패해도 에러를 던지지 않는다', async () => {
      (Notifications.dismissNotificationAsync as jest.Mock).mockRejectedValueOnce(new Error('없음'));
      await expect(clearAlarmNotification()).resolves.toBeUndefined();
    });
  });

  // #2379 (Phase 2-device 복원, #2067 되돌리기) — EXPO_PUBLIC_MINIMAL_ALARM 플래그 ON일 때 BG
  // pipeline이 직접 발사하는 device 로컬 transfer/destination 알람 배너.
  describe('fireLocalAlarmNotification (#2379 — #2067 sendAlarmNotification 복원)', () => {
    const earlyDest = { phaseId: 'early' as const, type: 'destination' as const, stationName: '강남' };

    it('buildAlarmContent와 동일한 title/body로 ALARM_NOTIFICATION_ID 알림을 예약한다', async () => {
      await fireLocalAlarmNotification(earlyDest);
      expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          identifier: 'station-alarm',
          content: expect.objectContaining({
            title: '하차 알림',
            body: '다음 역 강남에서 하차하세요!',
            sound: 'alarm.wav',
          }),
        }),
      );
    });

    it('iOS에서는 interruptionLevel: timeSensitive를 부착한다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await fireLocalAlarmNotification(earlyDest);
      expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.objectContaining({ interruptionLevel: 'timeSensitive' }),
        }),
      );
    });

    it('Android에서는 ALARM_CHANNEL_ID + MAX priority를 부착한다', async () => {
      jest.replaceProperty(Platform, 'OS', 'android');
      await fireLocalAlarmNotification(earlyDest);
      expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.objectContaining({
            channelId: 'station-alarm',
            priority: Notifications.AndroidNotificationPriority.MAX,
          }),
        }),
      );
    });

    it('source가 있으면 breadcrumb에 전달한다', async () => {
      await fireLocalAlarmNotification(earlyDest, 'positionTrain');
      expect(mockAddDomainBreadcrumb).toHaveBeenCalledWith('alarm', 'fire-local', {
        type: 'destination',
        phase: 'early',
        station: '강남',
        source: 'positionTrain',
      });
    });
  });

  describe('fireFgAuxStationPassedNotification (#2122 FG 보조 발사, #2362 count/target 배선)', () => {
    beforeEach(async () => {
      await AsyncStorage.clear();
    });

    it('device token 보유 시 backend collapse-id와 동일한 identifier로 "역 도착 / N정거장 남음" 로컬 알림을 발사하고 markLocalStationFired를 stamp한다', async () => {
      await AsyncStorage.setItem(APNS_TOKEN_KEY, 'a'.repeat(64));

      await fireFgAuxStationPassedNotification('중곡', 1, 'destination', '강남');

      const expectedId = buildStationNotifCollapseId('a'.repeat(64));
      expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          identifier: expectedId,
          content: expect.objectContaining({
            title: '중곡역 도착',
            body: '강남까지 1정거장 남음',
            sound: false,
          }),
          trigger: null,
        }),
      );
      expect(mockMarkLocalStationFired).toHaveBeenCalledWith('중곡', 'station-passed');
    });

    it('targetKind=transfer 전달 시에도 동일 템플릿으로 환승역명이 대상에 채워진다', async () => {
      await AsyncStorage.setItem(APNS_TOKEN_KEY, 'c'.repeat(64));

      await fireFgAuxStationPassedNotification('중곡', 2, 'transfer', '홍대입구');

      expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.objectContaining({
            body: '홍대입구까지 2정거장 남음',
          }),
        }),
      );
    });

    it('기존 동일 identifier 알림을 dismiss한 뒤 재발사한다 (scheduleNotification 공용 helper 재사용)', async () => {
      await AsyncStorage.setItem(APNS_TOKEN_KEY, 'b'.repeat(64));
      await fireFgAuxStationPassedNotification('강남', 3, 'destination', '홍대입구');
      const expectedId = buildStationNotifCollapseId('b'.repeat(64));
      expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith(expectedId);
    });

    it('device token 미보유 시(등록 전) 스킵 — 알림 발사/stamp 모두 안 함', async () => {
      await fireFgAuxStationPassedNotification('중곡', 1, 'destination', '강남');
      expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
      expect(mockMarkLocalStationFired).not.toHaveBeenCalled();
    });
  });

  describe('buildStationPassedContent (#2362 — 역 도착 + N정거장 남음)', () => {
    afterEach(async () => {
      await i18next.changeLanguage('ko');
    });

    // 강남/중곡 모두 stations.json에 동일 노선 중복 항목이 있어도 nameEn/nameJa/nameHanja가
    // 일치하는 안정적 실역명 — 4개 locale × count 단수/복수(destination target).
    it.each([
      ['ko', 1, '강남까지 1정거장 남음'],
      ['ko', 3, '강남까지 3정거장 남음'],
      ['en', 1, '1 stop to Gangnam'],
      ['en', 3, '3 stops to Gangnam'],
      ['ja', 1, 'カンナムまで残り1駅'],
      ['ja', 3, 'カンナムまで残り3駅'],
      ['zh', 1, '距江南还有1站'],
      ['zh', 3, '距江南还有3站'],
    ])('locale=%s, count=%s(destination target) → %s', async (lang, count, expectedBody) => {
      await i18next.changeLanguage(lang);
      const { body } = buildStationPassedContent('중곡', count as number, 'destination', '강남');
      expect(body).toBe(expectedBody);
    });

    // 환승 전(targetKind='transfer')도 동일 템플릿 — 대상만 환승역명으로 바뀐다.
    it.each([
      ['ko', '홍대입구까지 2정거장 남음'],
      ['en', '2 stops to Hongik Univ.'],
    ])('locale=%s, 환승 전(targetKind=transfer) → %s', async (lang, expectedBody) => {
      await i18next.changeLanguage(lang);
      const { body } = buildStationPassedContent('중곡', 2, 'transfer', '홍대입구');
      expect(body).toBe(expectedBody);
    });

    it('title은 targetKind와 무관하게 "{{역}}역 도착" 고정', () => {
      const { title } = buildStationPassedContent('중곡', 1, 'destination', '강남');
      expect(title).toBe('중곡역 도착');
    });
  });

  describe('widget storage 연동', () => {
    beforeEach(() => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      mockSaveStationToWidget.mockResolvedValue(undefined);
      mockClearWidgetStation.mockResolvedValue(undefined);
    });

    it('updateStationNotification은 saveStationToWidget을 호출하지 않는다 (#1079)', async () => {
      // 위젯 갱신은 useWidgetMirror가 직접 담당. updateStationNotification은 LA/알림만 담당.
      await updateStationNotification(mockStation, 250);
      expect(mockSaveStationToWidget).not.toHaveBeenCalled();
    });

    it('clearStationNotification은 위젯을 비우지 않는다 (#1094)', async () => {
      // 위젯 lifecycle은 HomeScreen mirror effect가 담당. destination이 사라져도
      // 사용자가 역 근처에 있는 동안 위젯이 "감지 중"으로 깜빡이는 회귀를 막기 위함.
      await clearStationNotification();
      expect(mockClearWidgetStation).not.toHaveBeenCalled();
    });
  });

  describe('source 라벨 자백 (#327)', () => {
    const earlyDest = { phaseId: 'early' as const, type: 'destination' as const, stationName: '강남' };
    const baseBody = '다음 역 강남에서 하차하세요!';

    // 자백 대상(gpsOnly/uncertain)만 라벨 부착. positionTrain/routeProgress는 정상 신뢰 케이스라 생략.
    it.each([
      ['gpsOnly', 'GPS 추정'],
      ['uncertain', '위치 확인 중'],
    ] as const)('buildAlarmContent source=%s → body 끝에 "%s" 부착 (자백 대상)', (source, label) => {
      expect(buildAlarmContent(earlyDest, source).body).toBe(`${baseBody} · ${label}`);
    });

    it.each<['positionTrain' | 'routeProgress' | undefined]>([
      ['positionTrain'],
      ['routeProgress'],
      [undefined],
    ])('buildAlarmContent source=%s → 라벨 부착 안 함 (정상 케이스 노이즈 회피)', (source) => {
      expect(buildAlarmContent(earlyDest, source).body).toBe(baseBody);
    });

    it.each([
      ['uncertain' as const, `${baseBody} · 위치 확인 중`],
      ['routeProgress' as const, baseBody],
      [undefined, baseBody],
    ])('buildAlarmContent source=%s → body=%s', (source, expectedBody) => {
      const { body } = buildAlarmContent(earlyDest, source);
      expect(body).toBe(expectedBody);
    });
  });
});
