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

    it('일반 알림은 shouldPlaySound false를 반환한다', async () => {
      setupNotificationHandler();
      const { handleNotification } = (Notifications.setNotificationHandler as jest.Mock).mock.calls[0][0];
      const mockNotification = { request: { identifier: 'current-station' } };
      const result = await handleNotification(mockNotification);
      expect(result).toEqual({ shouldShowAlert: true, shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false });
    });

    it('알람 알림은 shouldPlaySound true를 반환한다', async () => {
      setupNotificationHandler();
      const { handleNotification } = (Notifications.setNotificationHandler as jest.Mock).mock.calls[0][0];
      const mockNotification = { request: { identifier: 'station-alarm' } };
      const result = await handleNotification(mockNotification);
      expect(result).toEqual({ shouldShowAlert: true, shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false });
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
      await initStationNotification();
      expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith('station', {
        name: '현재 역',
        importance: Notifications.AndroidImportance.HIGH,
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      });
      expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith('station-alarm', {
        name: '하차/환승 알림',
        importance: Notifications.AndroidImportance.HIGH,
        sound: 'default',
        vibrationPattern: [0, 250, 250, 250],
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      });
      expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    });
  });

  describe('updateStationNotification (iOS - Live Activity)', () => {
    beforeEach(async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      // liveActivityStarted 초기화
      await clearStationNotification();
      jest.clearAllMocks();
      mockIsLiveActivityEnabled.mockReturnValue(true);
    });

    it('처음 호출 시 startLiveActivity를 호출한다', async () => {
      await updateStationNotification(mockStation, 154);
      expect(mockStartLiveActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          stationName: '시청',
          lineName: '1호선',
          lineColorHex: '#0052A4',
          distanceM: 154,
        })
      );
      expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
    });

    it('두 번째 호출부터는 updateLiveActivity를 호출한다', async () => {
      await updateStationNotification(mockStation, 154);
      await updateStationNotification(mockStation, 100);
      expect(mockStartLiveActivity).toHaveBeenCalledTimes(1);
      expect(mockUpdateLiveActivity).toHaveBeenCalledTimes(1);
    });

    it('목적지 없으면 destinationName이 없다', async () => {
      await updateStationNotification(mockStation, 154);
      expect(mockStartLiveActivity).toHaveBeenCalledWith(
        expect.not.objectContaining({ destinationName: expect.anything() })
      );
    });

    it('직통 경로이면 stopsRemaining을 포함한다', async () => {
      await updateStationNotification(mockStation, 154, mockDestination, directRoute);
      expect(mockStartLiveActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          destinationName: '성신여대입구',
          stopsRemaining: 4,
        })
      );
    });

    it('환승 경로이면 환승 정보를 포함한다', async () => {
      await updateStationNotification(mockStation, 154, mockDestination, transferRoute);
      expect(mockStartLiveActivity).toHaveBeenCalledWith(
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
      expect(mockStartLiveActivity).toHaveBeenCalledWith(
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
      expect(mockStartLiveActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          etaMinutes: 12,
        })
      );
    });

    it('isMock이 true이면 Live Activity 데이터에 포함된다', async () => {
      await updateStationNotification(mockStation, 154, mockDestination, directRoute, 12, true);
      expect(mockStartLiveActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          etaMinutes: 12,
          isMock: true,
        })
      );
    });

    it('etaMinutes가 없으면 Live Activity 데이터에 포함되지 않는다', async () => {
      await updateStationNotification(mockStation, 154, mockDestination, directRoute);
      expect(mockStartLiveActivity).toHaveBeenCalledWith(
        expect.not.objectContaining({ etaMinutes: expect.anything() })
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

    it('startLiveActivity 실패 시 expo-notifications로 폴백한다', async () => {
      mockStartLiveActivity.mockRejectedValueOnce(new Error('ActivityKit 오류'));
      await updateStationNotification(mockStation, 154);
      expectNotificationContent('시청역', '1호선 · 약 154m');
    });

    it('startLiveActivity 실패 시 liveActivityStarted를 false로 리셋한다', async () => {
      mockStartLiveActivity.mockRejectedValueOnce(new Error('ActivityKit 오류'));
      await updateStationNotification(mockStation, 154);
      // liveActivityStarted가 리셋됐으므로 다음 호출도 start를 사용해야 함
      jest.clearAllMocks();
      mockIsLiveActivityEnabled.mockReturnValue(true);
      await updateStationNotification(mockStation, 100);
      expect(mockStartLiveActivity).toHaveBeenCalled();
      expect(mockUpdateLiveActivity).not.toHaveBeenCalled();
    });

    it('updateLiveActivity 실패 시 liveActivityStarted를 false로 리셋한다', async () => {
      await updateStationNotification(mockStation, 154);
      mockUpdateLiveActivity.mockRejectedValueOnce(new Error('업데이트 오류'));
      await updateStationNotification(mockStation, 100);
      // liveActivityStarted가 리셋됐으므로 다음 호출은 start를 사용해야 함
      jest.clearAllMocks();
      mockIsLiveActivityEnabled.mockReturnValue(true);
      await updateStationNotification(mockStation, 80);
      expect(mockStartLiveActivity).toHaveBeenCalled();
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

    it('Live Activity를 호출하지 않는다', async () => {
      await updateStationNotification(mockStation, 154);
      expect(mockStartLiveActivity).not.toHaveBeenCalled();
    });
  });

  describe('clearStationNotification', () => {
    it('iOS에서 endLiveActivity를 호출하고 liveActivityStarted를 초기화한다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      // 먼저 start 상태로 만들기
      await updateStationNotification(mockStation, 154);
      jest.clearAllMocks();
      mockIsLiveActivityEnabled.mockReturnValue(true);

      await clearStationNotification();
      expect(mockEndLiveActivity).toHaveBeenCalled();
      expect(Notifications.dismissNotificationAsync).not.toHaveBeenCalled();

      // 초기화 확인: 다음 update는 start를 호출해야 함
      jest.clearAllMocks();
      mockIsLiveActivityEnabled.mockReturnValue(true);
      await updateStationNotification(mockStation, 100);
      expect(mockStartLiveActivity).toHaveBeenCalled();
    });

    it('iOS에서 endLiveActivity가 실패해도 liveActivityStarted를 초기화한다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await updateStationNotification(mockStation, 154);
      mockEndLiveActivity.mockRejectedValueOnce(new Error('종료 실패'));
      jest.clearAllMocks();
      mockEndLiveActivity.mockRejectedValueOnce(new Error('종료 실패'));
      mockIsLiveActivityEnabled.mockReturnValue(true);

      await clearStationNotification();

      // 에러 후에도 liveActivityStarted가 리셋되어야 함
      jest.clearAllMocks();
      mockIsLiveActivityEnabled.mockReturnValue(true);
      await updateStationNotification(mockStation, 100);
      expect(mockStartLiveActivity).toHaveBeenCalled();
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
      expectAlarmNotification('하차 알림', '다음 역 강남에서 내리세요!');
    });

    it('transfer 타입이면 환승 알림을 보낸다', async () => {
      jest.replaceProperty(Platform, 'OS', 'ios');
      await sendAlarmNotification('transfer', '시청');
      expectAlarmNotification('환승 알림', '다음 역 시청에서 환승하세요!');
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
  });

  describe('clearAlarmNotification', () => {
    it('station-alarm을 dismiss한다', async () => {
      await clearAlarmNotification();
      expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith('station-alarm');
    });

    it('dismiss 실패해도 에러를 던지지 않는다', async () => {
      (Notifications.dismissNotificationAsync as jest.Mock).mockRejectedValueOnce(new Error('없음'));
      await expect(clearAlarmNotification()).resolves.toBeUndefined();
    });
  });
});
