import * as Notifications from 'expo-notifications';
import { Platform, Vibration } from 'react-native';
import {
  setupNotificationHandler,
  initStationNotification,
  updateStationNotification,
  clearStationNotification,
  sendAlarmNotification,
  clearAlarmNotification,
  sendStationPassedNotification,
  sendTripEndedNotification,
  buildAlarmContent,
  buildLiveActivityData,
} from '../stationNotification';
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

jest.mock('../../../../../modules/live-activity', () => ({
  startLiveActivity: (...args: unknown[]) => mockStartLiveActivity(...args),
  updateLiveActivity: (...args: unknown[]) => mockUpdateLiveActivity(...args),
  endLiveActivity: () => mockEndLiveActivity(),
  isLiveActivityEnabled: () => mockIsLiveActivityEnabled(),
  // #1389 PR-4 — buildLiveActivityData가 LA_DISPLAY_MODE.CONFIRMED를 default로 참조하므로
  // 모킹 시에도 동일 enum 값을 노출. Swift mirror와 동기화된 wire format 상수.
  LA_DISPLAY_MODE: {
    CONFIRMED: 'confirmed',
    UNCONFIRMED: 'unconfirmed',
  },
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

function expectAlarmNotification(title: string, body: string, extra?: Record<string, unknown>) {
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
    identifier: 'station-alarm',
    content: { title, body, sound: 'alarm.wav', ...extra },
    trigger: null,
  });
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
      expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith('station-alarm-silent', {
        name: '하차/환승 알림 (무음)',
        importance: Notifications.AndroidImportance.MAX,
        sound: null,
        enableVibrate: true,
        vibrationPattern: [0, 1000, 500, 1000],
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
        bypassDnd: true,
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

    // #1389 PR-4 — 정합성 fallback 표시 모드 wire-through.
    describe('정합성 fallback display 모드 (#1389 PR-4)', () => {
      it('buildLiveActivityData(displayMode 인자 생략) — default confirmed 분기로 displayMode 키 omit', () => {
        // updateStationNotification은 default를 통과시키므로 default 분기 cover 불가능 —
        // builder 직접 호출로 default 매개변수 분기를 명시 cover.
        const data = buildLiveActivityData(mockStation, 154);
        expect(data).not.toHaveProperty('displayMode');
        expect(data).not.toHaveProperty('unconfirmedText');
      });

      it('displayMode 미지정 (updateStationNotification 경로) — payload에 displayMode/unconfirmedText 누락', async () => {
        await updateStationNotification(mockStation, 154);
        expect(mockUpdateLiveActivity).toHaveBeenCalledWith(
          expect.not.objectContaining({ displayMode: expect.anything() }),
        );
        expect(mockUpdateLiveActivity).toHaveBeenCalledWith(
          expect.not.objectContaining({ unconfirmedText: expect.anything() }),
        );
      });

      it('displayMode=unconfirmed — payload에 displayMode + i18n unconfirmedText 포함', async () => {
        await updateStationNotification(
          mockStation,
          154,
          null,
          null,
          null,
          false,
          null,
          undefined,
          'unconfirmed',
        );
        const callArgs = mockUpdateLiveActivity.mock.calls[0][0];
        expect(callArgs.displayMode).toBe('unconfirmed');
        // i18n 기본 ko locale 가정 — 테스트 환경 i18next 초기 ko.
        expect(typeof callArgs.unconfirmedText).toBe('string');
        expect((callArgs.unconfirmedText as string).length).toBeGreaterThan(0);
      });

      it('displayMode=confirmed 명시 — 기본과 동일 (omit)', async () => {
        await updateStationNotification(
          mockStation,
          154,
          null,
          null,
          null,
          false,
          null,
          undefined,
          'confirmed',
        );
        expect(mockUpdateLiveActivity).toHaveBeenCalledWith(
          expect.not.objectContaining({ displayMode: expect.anything() }),
        );
      });
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

  describe('sendAlarmNotification', () => {
    const earlyDest = { phaseId: 'early' as const, type: 'destination' as const, stationName: '강남' };
    const earlyTransfer = { phaseId: 'early' as const, type: 'transfer' as const, stationName: '시청' };
    const imminentDest = { phaseId: 'imminent' as const, type: 'destination' as const, stationName: '강남' };
    const imminentTransfer = { phaseId: 'imminent' as const, type: 'transfer' as const, stationName: '시청' };

    it('early destination이면 하차 알림을 보낸다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await sendAlarmNotification(earlyDest);
      expectAlarmNotification('하차 알림', '다음 역 강남에서 하차하세요!', { interruptionLevel: 'timeSensitive' });
      expect(mockVibrateAlarm).toHaveBeenCalledWith(false);
    });

    it('early transfer이면 환승 알림을 보낸다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await sendAlarmNotification(earlyTransfer);
      expectAlarmNotification('환승 알림', '다음 역 시청에서 환승하세요!', { interruptionLevel: 'timeSensitive' });
    });

    it('sleepMode가 true이면 vibrateAlarm에 true를 전달한다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await sendAlarmNotification(earlyDest, true);
      expect(mockVibrateAlarm).toHaveBeenCalledWith(true);
    });

    it('Android에서는 channelId와 priority MAX가 포함된다', async () => {
      jest.replaceProperty(Platform, 'OS', 'android');
      await sendAlarmNotification(earlyDest);
      expectAlarmNotification('하차 알림', '다음 역 강남에서 하차하세요!', { channelId: 'station-alarm', priority: 'max' });
    });

    it('dismiss 실패해도 schedule은 호출된다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      (Notifications.dismissNotificationAsync as jest.Mock).mockRejectedValueOnce(new Error('없음'));
      await sendAlarmNotification(earlyDest);
      expect(Notifications.scheduleNotificationAsync).toHaveBeenCalled();
    });

    it('imminent destination이면 도착 임박 알림을 보낸다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await sendAlarmNotification(imminentDest);
      expectAlarmNotification('도착 임박', '곧 강남에 도착합니다. 하차 준비하세요!', { interruptionLevel: 'timeSensitive' });
    });

    it('imminent transfer이면 환승 임박 알림을 보낸다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await sendAlarmNotification(imminentTransfer);
      expectAlarmNotification('환승 임박', '곧 시청에 도착합니다. 환승 준비하세요!', { interruptionLevel: 'timeSensitive' });
    });

    it('imminent + sleepMode이면 vibrateAlarm에 true를 전달한다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await sendAlarmNotification(imminentDest, true);
      expect(mockVibrateAlarm).toHaveBeenCalledWith(true);
    });

    it('imminent + Android에서는 channelId와 priority MAX가 포함된다', async () => {
      jest.replaceProperty(Platform, 'OS', 'android');
      await sendAlarmNotification(imminentDest);
      expectAlarmNotification('도착 임박', '곧 강남에 도착합니다. 하차 준비하세요!', { channelId: 'station-alarm', priority: 'max' });
    });

    it('allowSpeaker=false이면 iOS에서 sound를 false로 설정한다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await sendAlarmNotification(earlyDest, false, false);
      expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
        identifier: 'station-alarm',
        content: { title: '하차 알림', body: '다음 역 강남에서 하차하세요!', sound: false, interruptionLevel: 'timeSensitive' },
        trigger: null,
      });
    });

    it('allowSpeaker=false이면 Android에서 무음 채널을 사용한다', async () => {
      jest.replaceProperty(Platform, 'OS', 'android');
      await sendAlarmNotification(earlyDest, false, false);
      expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
        identifier: 'station-alarm',
        content: { title: '하차 알림', body: '다음 역 강남에서 하차하세요!', sound: false, channelId: 'station-alarm-silent', priority: 'max' },
        trigger: null,
      });
    });

    it('TTS는 알람 body를 sleepMode/allowSpeaker와 함께 호출한다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await sendAlarmNotification(earlyDest, false, true);
      expect(mockSpeakAlarm).toHaveBeenCalledWith('다음 역 강남에서 하차하세요!', {
        sleepMode: false,
        allowSpeaker: true,
      });
    });

    it('TTS는 silent 게이트(sleepMode/allowSpeaker)를 그대로 전달한다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await sendAlarmNotification(earlyDest, true, false);
      expect(mockSpeakAlarm).toHaveBeenCalledWith('다음 역 강남에서 하차하세요!', {
        sleepMode: true,
        allowSpeaker: false,
      });
    });

    describe('좌/우 하차 라인 (exitSide)', () => {
      it('event.direction이 없으면 본문에 좌/우 라인을 추가하지 않는다', async () => {
        jest.replaceProperty(Platform, 'OS', 'ios');
        await sendAlarmNotification(earlyDest);
        expectAlarmNotification('하차 알림', '다음 역 강남에서 하차하세요!', { interruptionLevel: 'timeSensitive' });
      });

      it('event.direction이 있고 데이터가 매칭되면 좌측 라인이 추가된다', async () => {
        jest.replaceProperty(Platform, 'OS', 'ios');
        await sendAlarmNotification({ ...earlyDest, direction: 'up' });
        expectAlarmNotification('하차 알림', '다음 역 강남에서 하차하세요!\n왼쪽 문으로 하차하세요', { interruptionLevel: 'timeSensitive' });
      });

      it('하행이면 오른쪽 라인이 추가된다', async () => {
        jest.replaceProperty(Platform, 'OS', 'ios');
        await sendAlarmNotification({ ...earlyDest, direction: 'down' });
        expectAlarmNotification('하차 알림', '다음 역 강남에서 하차하세요!\n오른쪽 문으로 하차하세요', { interruptionLevel: 'timeSensitive' });
      });

      it('섬식(both)이면 양쪽 라인이 추가된다', async () => {
        jest.replaceProperty(Platform, 'OS', 'ios');
        await sendAlarmNotification({ ...earlyTransfer, direction: 'up' });
        expectAlarmNotification('환승 알림', '다음 역 시청에서 환승하세요!\n양쪽 문이 열립니다', { interruptionLevel: 'timeSensitive' });
      });

      it('데이터에 없는 방향이면 본문에 좌/우 라인을 추가하지 않는다', async () => {
        jest.replaceProperty(Platform, 'OS', 'ios');
        await sendAlarmNotification({ ...earlyTransfer, direction: 'down' });
        expectAlarmNotification('환승 알림', '다음 역 시청에서 환승하세요!', { interruptionLevel: 'timeSensitive' });
      });
    });

    describe('빠른하차 힌트 (quickExit)', () => {
      it('해당 역의 빠른하차 데이터가 없으면 본문에 힌트가 붙지 않는다', async () => {
        jest.replaceProperty(Platform, 'OS', 'ios');
        await sendAlarmNotification({ phaseId: 'early', type: 'destination', stationName: '시청' });
        expectAlarmNotification('하차 알림', '다음 역 시청에서 하차하세요!', { interruptionLevel: 'timeSensitive' });
      });

      it('destination 알람이고 데이터가 있으면 "출구가 빠른 위치" 힌트가 붙는다', async () => {
        jest.replaceProperty(Platform, 'OS', 'ios');
        await sendAlarmNotification({ phaseId: 'early', type: 'destination', stationName: '잠실' });
        expectAlarmNotification('하차 알림', '다음 역 잠실에서 하차하세요!\n출구가 빠른 위치에서 하차하세요', { interruptionLevel: 'timeSensitive' });
      });

      it('transfer 알람이고 데이터가 있으면 "환승이 빠른 위치" 힌트가 붙는다', async () => {
        jest.replaceProperty(Platform, 'OS', 'ios');
        await sendAlarmNotification({ phaseId: 'early', type: 'transfer', stationName: '왕십리' });
        expectAlarmNotification('환승 알림', '다음 역 왕십리에서 환승하세요!\n환승이 빠른 위치에서 하차하세요', { interruptionLevel: 'timeSensitive' });
      });

      it('알람 대상역이 stations.json에도 없으면 힌트 없이 본문만 표시한다', async () => {
        jest.replaceProperty(Platform, 'OS', 'ios');
        await sendAlarmNotification({ phaseId: 'early', type: 'destination', stationName: '없는역' });
        expectAlarmNotification('하차 알림', '다음 역 없는역에서 하차하세요!', { interruptionLevel: 'timeSensitive' });
      });

      it('정규화 fallback — 괄호 부제가 붙은 이름이어도 매칭된다', async () => {
        jest.replaceProperty(Platform, 'OS', 'ios');
        // 잠실(2-016)이 stations.json에 "잠실(송파구청)" 같은 형태로 등록돼 있지 않더라도
        // 동일 케이스 보호. 잠실이 단일 이름이라 여기서는 정확 매칭으로 작동.
        await sendAlarmNotification({ phaseId: 'imminent', type: 'destination', stationName: '잠실' });
        expectAlarmNotification('도착 임박', '곧 잠실에 도착합니다. 하차 준비하세요!\n출구가 빠른 위치에서 하차하세요', { interruptionLevel: 'timeSensitive' });
      });
    });

    describe('domain breadcrumb', () => {
      beforeEach(() => {
        mockAddDomainBreadcrumb.mockClear();
        jest.replaceProperty(Platform, 'OS', 'ios');
      });

      it('alarm fire 시 alarm 카테고리 breadcrumb 추가', async () => {
        await sendAlarmNotification(earlyDest, true);
        expect(mockAddDomainBreadcrumb).toHaveBeenCalledWith('alarm', 'fire', {
          type: 'destination',
          phase: 'early',
          station: '강남',
          sleepMode: true,
          source: undefined,
        });
      });

      it('source가 있으면 breadcrumb data에 포함', async () => {
        await sendAlarmNotification(earlyTransfer, false, true, 'positionTrain');
        expect(mockAddDomainBreadcrumb).toHaveBeenCalledWith('alarm', 'fire', {
          type: 'transfer',
          phase: 'early',
          station: '시청',
          sleepMode: false,
          source: 'positionTrain',
        });
      });
    });
  });

  describe('sendStationPassedNotification', () => {
    it('마지막 구간(isTransfer=false)이면 목적지까지 남은 정거장 수를 body에 표시한다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await sendStationPassedNotification('역삼', '강남', {
        nextStationName: '강남',
        stopsToNextStation: 3,
        isTransfer: false,
        stopsToDestination: 3,
      });
      expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
        identifier: 'station-passed',
        content: { title: '역삼역 도착', body: '강남까지 3정거장 남음', sound: false },
        trigger: null,
      });
    });

    it('환승 전 구간(isTransfer=true)이면 환승역과 최종 목적지를 모두 표시한다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await sendStationPassedNotification('용마산', '이대', {
        nextStationName: '군자',
        stopsToNextStation: 2,
        isTransfer: true,
        stopsToDestination: 11,
      });
      expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
        identifier: 'station-passed',
        content: {
          title: '용마산역 도착',
          body: '군자 환승까지 2정거장 · 이대까지 11정거장',
          sound: false,
        },
        trigger: null,
      });
    });

    it('target이 null이면 현재 역만 표시한다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await sendStationPassedNotification('역삼', '강남', null);
      expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
        identifier: 'station-passed',
        content: { title: '역삼역 도착', body: '현재 역삼역', sound: false },
        trigger: null,
      });
    });

    it('Android에서는 channelId와 priority DEFAULT가 포함된다', async () => {
      jest.replaceProperty(Platform, 'OS', 'android');
      await sendStationPassedNotification('역삼', '강남', {
        nextStationName: '강남',
        stopsToNextStation: 3,
        isTransfer: false,
        stopsToDestination: 3,
      });
      expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
        identifier: 'station-passed',
        content: {
          title: '역삼역 도착',
          body: '강남까지 3정거장 남음',
          sound: false,
          channelId: 'station-passed',
          priority: 'default',
        },
        trigger: null,
      });
    });

    // #1224 — station-passed = 잠 깨우지 말 것. 진동 0 / 사운드 0 / 배너만
    it('#1224 — iOS scheduleNotification 호출에 sound: false가 포함된다 (잠 안 깨우기)', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await sendStationPassedNotification('역삼', '강남', null);
      expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.objectContaining({ sound: false }),
        }),
      );
    });

    it('#1224 — Android 채널은 sound: null + enableVibrate: false (진동/사운드 OFF)', async () => {
      // refreshNotificationChannels는 initStationNotification에서 호출되어 별도 단위로 검증되지만,
      // 정책 SSOT가 한 곳에 모이도록 동등 가드를 여기서도 명시한다.
      jest.replaceProperty(Platform, 'OS', 'android');
      (Notifications.deleteNotificationChannelAsync as jest.Mock).mockResolvedValue(undefined);
      await initStationNotification();
      expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith(
        'station-passed',
        expect.objectContaining({ sound: null, enableVibrate: false }),
      );
    });
  });

  // #1323 — trip 종료 user-facing surface. backend trip-ended push가 silent라 알림이 안 뜨던 회귀 차단.
  describe('sendTripEndedNotification', () => {
    it('destination-arrived → "목적지 도착" 제목 + 종료 본문 (iOS, sound: false)', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await sendTripEndedNotification('destination-arrived');
      expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
        identifier: 'trip-ended',
        content: { title: '목적지 도착', body: '경로 안내를 종료했어요', sound: false },
        trigger: null,
      });
    });

    it.each([
      ['eta-missing'],
      ['expired'],
      ['push-unrecoverable'],
      ['unknown'],
    ] as const)('non-arrived reason %s → 중립 "안내 종료" 제목', async (reason) => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await sendTripEndedNotification(reason);
      expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
        identifier: 'trip-ended',
        content: { title: '안내 종료', body: '경로 안내를 종료했어요', sound: false },
        trigger: null,
      });
    });

    it('Android에서는 station-passed 채널 + priority DEFAULT (잠 안 깨우기)', async () => {
      jest.replaceProperty(Platform, 'OS', 'android');
      await sendTripEndedNotification('destination-arrived');
      expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
        identifier: 'trip-ended',
        content: {
          title: '목적지 도착',
          body: '경로 안내를 종료했어요',
          sound: false,
          channelId: 'station-passed',
          priority: 'default',
        },
        trigger: null,
      });
    });

    it('종료 surface 시 domain breadcrumb(trip-ended-surface)를 남긴다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await sendTripEndedNotification('eta-missing');
      expect(mockAddDomainBreadcrumb).toHaveBeenCalledWith('alarm', 'trip-ended-surface', {
        reason: 'eta-missing',
      });
    });
  });

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

    it('ALARM_SILENT_CHANNEL_ID는 sound: null + enableVibrate: true 유지', async () => {
      jest.replaceProperty(Platform, 'OS', 'android');
      (Notifications.deleteNotificationChannelAsync as jest.Mock).mockResolvedValue(undefined);
      await initStationNotification();
      expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith('station-alarm-silent', {
        name: '하차/환승 알림 (무음)',
        importance: Notifications.AndroidImportance.MAX,
        sound: null,
        enableVibrate: true,
        vibrationPattern: [0, 1000, 500, 1000],
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
        bypassDnd: true,
      });
    });

    it('sendAlarmNotification(transfer/destination)은 sound: alarm.wav 유지', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await sendAlarmNotification({ phaseId: 'early', type: 'destination', stationName: '강남' });
      expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          identifier: 'station-alarm',
          content: expect.objectContaining({ sound: 'alarm.wav' }),
        }),
      );
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
    ] as const)('sendAlarmNotification source=%s → body 끝에 "%s" 부착 (자백 대상)', async (source, label) => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await sendAlarmNotification(earlyDest, false, true, source);
      expectAlarmNotification('하차 알림', `${baseBody} · ${label}`, { interruptionLevel: 'timeSensitive' });
    });

    it.each<['positionTrain' | 'routeProgress' | undefined]>([
      ['positionTrain'],
      ['routeProgress'],
      [undefined],
    ])('sendAlarmNotification source=%s → 라벨 부착 안 함 (정상 케이스 노이즈 회피)', async (source) => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await sendAlarmNotification(earlyDest, false, true, source);
      expectAlarmNotification('하차 알림', baseBody, { interruptionLevel: 'timeSensitive' });
    });

    it.each([
      ['gpsOnly' as const, '현재 역삼역 · GPS 추정'],
      ['positionTrain' as const, '현재 역삼역'],
      [undefined, '현재 역삼역'],
    ])('sendStationPassedNotification source=%s → body=%s', async (source, expectedBody) => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await sendStationPassedNotification('역삼', '강남', null, source);
      expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
        identifier: 'station-passed',
        content: { title: '역삼역 도착', body: expectedBody, sound: false },
        trigger: null,
      });
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
