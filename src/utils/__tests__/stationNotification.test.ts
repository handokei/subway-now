import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import {
  setupNotificationHandler,
  initStationNotification,
  updateStationNotification,
  clearStationNotification,
  sendAlarmNotification,
  clearAlarmNotification,
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

const mockPlayAlarmWithRouting = jest.fn().mockResolvedValue(undefined);
const mockStopAlarm = jest.fn().mockResolvedValue(undefined);
jest.mock('../alarmSound', () => ({
  playAlarmWithRouting: (...args: unknown[]) => mockPlayAlarmWithRouting(...args),
  stopAlarm: () => mockStopAlarm(),
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
    content: { title, body, sound: true, ...extra },
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

    it('일반 알림은 shouldPlaySound false, 알람 알림은 true를 반환한다', async () => {
      setupNotificationHandler();
      const { handleNotification } = (Notifications.setNotificationHandler as jest.Mock).mock.calls[0][0];
      const normalResult = await handleNotification({ request: { identifier: 'current-station' } });
      expect(normalResult).toEqual({ shouldShowAlert: true, shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false });

      const alarmResult = await handleNotification({ request: { identifier: 'station-alarm' } });
      expect(alarmResult).toEqual({ shouldShowAlert: true, shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false });
    });
  });

  describe('initStationNotification', () => {
    it('iOS에서는 권한 요청만 한다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await initStationNotification();
      expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
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
        importance: Notifications.AndroidImportance.HIGH,
        sound: 'alarm.wav',
        enableVibrate: true,
        vibrationPattern: [0, 1000, 500, 1000],
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
      await updateStationNotification(mockStation, 154, mockDestination, transferRoute, 12, false, { type: 'transfer', stationName: '동대문' });
      expect(mockUpdateLiveActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          alarmType: 'transfer',
          alarmStationName: '동대문',
        })
      );
    });

    it('alarmEvent가 destination 타입이면 alarmType이 destination이다', async () => {
      await updateStationNotification(mockStation, 154, mockDestination, directRoute, 12, false, { type: 'destination', stationName: '강남' });
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
      expectNotificationContent('시청 → 성신여대입구', '3역 후 동대문 환승');
    });

    it('multi-transfer 경로이면 두 환승 정보를 표시한다', async () => {
      await updateStationNotification(mockStation, 154, mockDestination, multiTransferRoute);
      expectNotificationContent('시청 → 성신여대입구', '3역 후 잠실 환승');
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
    it('iOS에서 endLiveActivity를 호출한다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      mockIsLiveActivityEnabled.mockReturnValue(true);

      await clearStationNotification();
      expect(mockEndLiveActivity).toHaveBeenCalled();
      expect(Notifications.dismissNotificationAsync).not.toHaveBeenCalled();
    });

    it('iOS에서 endLiveActivity가 실패해도 에러를 던지지 않는다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      mockIsLiveActivityEnabled.mockReturnValue(true);
      mockEndLiveActivity.mockRejectedValueOnce(new Error('종료 실패'));

      await expect(clearStationNotification()).resolves.toBeUndefined();
    });

    it('iOS에서 Live Activity 비활성화 시 dismissNotificationAsync를 호출한다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      mockIsLiveActivityEnabled.mockReturnValue(false);
      await clearStationNotification();
      expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith('current-station');
      expect(mockEndLiveActivity).not.toHaveBeenCalled();
    });

    it('Android에서 dismissNotificationAsync를 호출한다', async () => {
      jest.replaceProperty(Platform, 'OS', 'android');
      await clearStationNotification();
      expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith('current-station');
      expect(mockEndLiveActivity).not.toHaveBeenCalled();
    });
  });

  describe('sendAlarmNotification', () => {
    it('destination 타입이면 하차 알림을 보낸다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await sendAlarmNotification('destination', '강남');
      expectAlarmNotification('하차 알림', '다음 역 강남에서 내리세요!', { interruptionLevel: 'timeSensitive' });
      expect(mockPlayAlarmWithRouting).toHaveBeenCalledWith(false);
    });

    it('transfer 타입이면 환승 알림을 보낸다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await sendAlarmNotification('transfer', '시청');
      expectAlarmNotification('환승 알림', '다음 역 시청에서 환승하세요!', { interruptionLevel: 'timeSensitive' });
      expect(mockPlayAlarmWithRouting).toHaveBeenCalledWith(false);
    });

    it('sleepMode가 true이면 playAlarmWithRouting에 true를 전달한다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await sendAlarmNotification('destination', '강남', true);
      expect(mockPlayAlarmWithRouting).toHaveBeenCalledWith(true);
    });

    it('Android에서는 channelId가 포함된다', async () => {
      jest.replaceProperty(Platform, 'OS', 'android');
      await sendAlarmNotification('destination', '강남');
      expectAlarmNotification('하차 알림', '다음 역 강남에서 내리세요!', { channelId: 'station-alarm' });
    });

    it('dismiss 실패해도 schedule은 호출된다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      (Notifications.dismissNotificationAsync as jest.Mock).mockRejectedValueOnce(new Error('없음'));
      await sendAlarmNotification('destination', '강남');
      expect(Notifications.scheduleNotificationAsync).toHaveBeenCalled();
    });

    it('timeBased destination이면 도착 임박 알림을 보낸다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await sendAlarmNotification('destination', '강남', false, true);
      expectAlarmNotification('도착 임박', '곧 강남에 도착합니다. 하차 준비하세요!', { interruptionLevel: 'timeSensitive' });
    });

    it('timeBased transfer이면 환승 임박 알림을 보낸다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await sendAlarmNotification('transfer', '시청', false, true);
      expectAlarmNotification('환승 임박', '곧 시청에 도착합니다. 환승 준비하세요!', { interruptionLevel: 'timeSensitive' });
    });

    it('timeBased + sleepMode이면 playAlarmWithRouting에 true를 전달한다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await sendAlarmNotification('destination', '강남', true, true);
      expect(mockPlayAlarmWithRouting).toHaveBeenCalledWith(true);
    });

    it('timeBased + Android에서는 channelId가 포함된다', async () => {
      jest.replaceProperty(Platform, 'OS', 'android');
      await sendAlarmNotification('destination', '강남', false, true);
      expectAlarmNotification('도착 임박', '곧 강남에 도착합니다. 하차 준비하세요!', { channelId: 'station-alarm' });
    });

    it('timeBased approaching이면 역 접근 알림을 보낸다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await sendAlarmNotification('approaching', '역삼', false, true);
      expectAlarmNotification('역 접근', '곧 역삼에 도착합니다.', { interruptionLevel: 'timeSensitive' });
    });

    it('timeBased approaching + Android에서는 channelId가 포함된다', async () => {
      jest.replaceProperty(Platform, 'OS', 'android');
      await sendAlarmNotification('approaching', '역삼', false, true);
      expectAlarmNotification('역 접근', '곧 역삼에 도착합니다.', { channelId: 'station-alarm' });
    });

    it('playAlarmWithRouting 실패해도 알림은 정상 예약된다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      mockPlayAlarmWithRouting.mockRejectedValueOnce(new Error('백그라운드 오디오 실패'));
      await sendAlarmNotification('destination', '강남');
      expect(Notifications.scheduleNotificationAsync).toHaveBeenCalled();
    });
  });

  describe('clearAlarmNotification', () => {
    it('사운드를 정지하고 station-alarm을 dismiss한다', async () => {
      await clearAlarmNotification();
      expect(mockStopAlarm).toHaveBeenCalled();
      expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith('station-alarm');
    });

    it('dismiss 실패해도 에러를 던지지 않는다', async () => {
      (Notifications.dismissNotificationAsync as jest.Mock).mockRejectedValueOnce(new Error('없음'));
      await expect(clearAlarmNotification()).resolves.toBeUndefined();
    });
  });
});
