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
} from '../stationNotification';
import { Station } from '../../types/station';
import { DirectRoute, TransferRoute, MultiTransferRoute } from '../stationRoute';

jest.mock('expo-notifications');
jest.mock('../logger', () => ({
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

const mockStartLiveActivity = jest.fn().mockResolvedValue(undefined);
const mockUpdateLiveActivity = jest.fn().mockResolvedValue(undefined);
const mockEndLiveActivity = jest.fn().mockResolvedValue(undefined);
const mockIsLiveActivityEnabled = jest.fn().mockReturnValue(true);

jest.mock('../../../modules/live-activity', () => ({
  startLiveActivity: (...args: unknown[]) => mockStartLiveActivity(...args),
  updateLiveActivity: (...args: unknown[]) => mockUpdateLiveActivity(...args),
  endLiveActivity: () => mockEndLiveActivity(),
  isLiveActivityEnabled: () => mockIsLiveActivityEnabled(),
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

const directRoute: DirectRoute = { type: 'direct', stops: 4 };
const transferRoute: TransferRoute = {
  type: 'transfer',
  transferName: '동대문',
  fromLine: '1',
  toLine: '4',
  stopsToTransfer: 3,
  stopsFromTransfer: 2,
};
const multiTransferRoute: MultiTransferRoute = {
  type: 'multi-transfer',
  transfers: [
    { transferName: '잠실', fromLine: '8', toLine: '2', stopsToTransfer: 3 },
    { transferName: '시청', fromLine: '2', toLine: '1', stopsToTransfer: 5 },
  ],
  stopsAfterLastTransfer: 4,
};

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
        name: '역 통과 알림',
        importance: Notifications.AndroidImportance.DEFAULT,
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      });
      expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    });

    it('Android에서 기존 채널 삭제 실패해도 정상 동작한다', async () => {
      jest.replaceProperty(Platform, 'OS', 'android');
      (Notifications.deleteNotificationChannelAsync as jest.Mock).mockRejectedValue(new Error('채널 없음'));
      await initStationNotification();
      expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith('station-alarm', expect.anything());
    });
  });

  describe('updateStationNotification (iOS - Live Activity)', () => {
    beforeEach(async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      jest.clearAllMocks();
      mockIsLiveActivityEnabled.mockReturnValue(true);
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
        })
      );
    });

    it('alarmEvent가 destination 타입이면 alarmType이 destination이다', async () => {
      await updateStationNotification(mockStation, 154, mockDestination, directRoute, 12, false, { phaseId: 'early', type: 'destination', stationName: '강남' });
      expect(mockUpdateLiveActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          alarmType: 'destination',
          alarmStationName: '강남',
        })
      );
    });

    it('alarmEvent가 없으면 alarmType이 포함되지 않는다', async () => {
      await updateStationNotification(mockStation, 154, mockDestination, directRoute);
      expect(mockUpdateLiveActivity).toHaveBeenCalledWith(
        expect.not.objectContaining({ alarmType: expect.anything() })
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
    it('iOS에서 endLiveActivity를 호출하고 station-passed 알림도 해제한다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      mockIsLiveActivityEnabled.mockReturnValue(true);

      await clearStationNotification();
      expect(mockEndLiveActivity).toHaveBeenCalled();
      expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith('station-passed');
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
      expectAlarmNotification('하차 알림', '다음 역 강남에서 내리세요!', { interruptionLevel: 'timeSensitive' });
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
      expectAlarmNotification('하차 알림', '다음 역 강남에서 내리세요!', { channelId: 'station-alarm', priority: 'max' });
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
        content: { title: '하차 알림', body: '다음 역 강남에서 내리세요!', sound: false, interruptionLevel: 'timeSensitive' },
        trigger: null,
      });
    });

    it('allowSpeaker=false이면 Android에서 무음 채널을 사용한다', async () => {
      jest.replaceProperty(Platform, 'OS', 'android');
      await sendAlarmNotification(earlyDest, false, false);
      expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
        identifier: 'station-alarm',
        content: { title: '하차 알림', body: '다음 역 강남에서 내리세요!', sound: false, channelId: 'station-alarm-silent', priority: 'max' },
        trigger: null,
      });
    });
  });

  describe('sendStationPassedNotification', () => {
    it('stopsRemaining이 있으면 남은 정거장 수를 body에 표시한다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await sendStationPassedNotification('역삼', '강남', 3);
      expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
        identifier: 'station-passed',
        content: { title: '역삼역 통과', body: '강남까지 3정거장 남음' },
        trigger: null,
      });
    });

    it('stopsRemaining이 null이면 현재 역만 표시한다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await sendStationPassedNotification('역삼', '강남', null);
      expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
        identifier: 'station-passed',
        content: { title: '역삼역 통과', body: '현재 역삼역' },
        trigger: null,
      });
    });

    it('Android에서는 channelId와 priority DEFAULT가 포함된다', async () => {
      jest.replaceProperty(Platform, 'OS', 'android');
      await sendStationPassedNotification('역삼', '강남', 3);
      expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
        identifier: 'station-passed',
        content: {
          title: '역삼역 통과',
          body: '강남까지 3정거장 남음',
          channelId: 'station-passed',
          priority: 'default',
        },
        trigger: null,
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
});
