import { Vibration } from 'react-native';
import { playAlarmWithRouting, stopAlarm } from '../alarmSound';

const mockPlayAsync = jest.fn().mockResolvedValue(undefined);
const mockUnloadAsync = jest.fn().mockResolvedValue(undefined);
const mockSetIsLoopingAsync = jest.fn().mockResolvedValue(undefined);
const mockSetOnPlaybackStatusUpdate = jest.fn();

const mockSound = {
  playAsync: mockPlayAsync,
  unloadAsync: mockUnloadAsync,
  setIsLoopingAsync: mockSetIsLoopingAsync,
  setOnPlaybackStatusUpdate: mockSetOnPlaybackStatusUpdate,
};

const mockCreateAsync = jest.fn().mockResolvedValue({ sound: mockSound });
const mockSetAudioModeAsync = jest.fn().mockResolvedValue(undefined);

jest.mock('expo-av', () => ({
  Audio: {
    Sound: {
      createAsync: (...args: unknown[]) => mockCreateAsync(...args),
    },
    setAudioModeAsync: (...args: unknown[]) => mockSetAudioModeAsync(...args),
  },
}));

const mockIsHeadphonesConnected = jest.fn();

jest.mock('../../../modules/audio-route', () => ({
  isHeadphonesConnected: () => mockIsHeadphonesConnected(),
}));

describe('alarmSound', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockIsHeadphonesConnected.mockReturnValue(false);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('playAlarmWithRouting', () => {
    it('이어폰 미연결 시 진동만 울린다', async () => {
      mockIsHeadphonesConnected.mockReturnValue(false);
      const vibrateSpy = jest.spyOn(Vibration, 'vibrate');
      await playAlarmWithRouting(false);
      expect(mockSetAudioModeAsync).toHaveBeenCalled();
      expect(vibrateSpy).toHaveBeenCalledWith([0, 1000, 500, 1000, 500, 1000], true);
      expect(mockCreateAsync).not.toHaveBeenCalled();
    });

    it('이어폰 미연결 시 5초 후 진동을 중지한다', async () => {
      mockIsHeadphonesConnected.mockReturnValue(false);
      const cancelSpy = jest.spyOn(Vibration, 'cancel');
      await playAlarmWithRouting(false);
      jest.advanceTimersByTime(5000);
      expect(cancelSpy).toHaveBeenCalled();
    });

    it('이어폰 연결 + 일반 모드: 알림음을 재생한다', async () => {
      mockIsHeadphonesConnected.mockReturnValue(true);
      await playAlarmWithRouting(false);
      expect(mockSetAudioModeAsync).toHaveBeenCalledWith({
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
      });
      expect(mockCreateAsync).toHaveBeenCalledWith(expect.anything());
      expect(mockSetIsLoopingAsync).not.toHaveBeenCalled();
      expect(mockPlayAsync).toHaveBeenCalled();
      expect(mockSetOnPlaybackStatusUpdate).toHaveBeenCalled();
    });

    it('이어폰 연결 + 일반 모드: 재생 완료 시 사운드를 정리한다', async () => {
      mockIsHeadphonesConnected.mockReturnValue(true);
      await playAlarmWithRouting(false);
      const callback = mockSetOnPlaybackStatusUpdate.mock.calls[0][0];
      callback({ isLoaded: true, didJustFinish: true });
      expect(mockUnloadAsync).toHaveBeenCalled();
    });

    it('이어폰 연결 + 일반 모드: 재생 중에는 정리하지 않는다', async () => {
      mockIsHeadphonesConnected.mockReturnValue(true);
      await playAlarmWithRouting(false);
      const callback = mockSetOnPlaybackStatusUpdate.mock.calls[0][0];
      callback({ isLoaded: true, didJustFinish: false });
      expect(mockUnloadAsync).not.toHaveBeenCalled();
    });

    it('이어폰 연결 + 일반 모드: unloaded 상태에서는 추가 정리하지 않는다', async () => {
      mockIsHeadphonesConnected.mockReturnValue(true);
      await playAlarmWithRouting(false);
      mockUnloadAsync.mockClear();
      const callback = mockSetOnPlaybackStatusUpdate.mock.calls[0][0];
      callback({ isLoaded: false });
      expect(mockUnloadAsync).not.toHaveBeenCalled();
    });

    it('이어폰 연결 + 취침 모드: 기상 알람음을 반복 재생한다', async () => {
      mockIsHeadphonesConnected.mockReturnValue(true);
      await playAlarmWithRouting(true);
      expect(mockSetIsLoopingAsync).toHaveBeenCalledWith(true);
      expect(mockPlayAsync).toHaveBeenCalled();
      expect(mockSetOnPlaybackStatusUpdate).not.toHaveBeenCalled();
    });

    it('이어폰 연결 + 사운드 재생 실패 시 진동으로 fallback한다', async () => {
      mockIsHeadphonesConnected.mockReturnValue(true);
      mockCreateAsync.mockRejectedValueOnce(new Error('audio error'));
      const vibrateSpy = jest.spyOn(Vibration, 'vibrate');
      await playAlarmWithRouting(false);
      expect(vibrateSpy).toHaveBeenCalledWith([0, 1000, 500, 1000, 500, 1000], false);
    });

    it('이어폰 연결 + 사운드 재생 실패 + 취침모드 시 반복 진동한다', async () => {
      mockIsHeadphonesConnected.mockReturnValue(true);
      mockCreateAsync.mockRejectedValueOnce(new Error('audio error'));
      const vibrateSpy = jest.spyOn(Vibration, 'vibrate');
      await playAlarmWithRouting(true);
      expect(vibrateSpy).toHaveBeenCalledWith([0, 1000, 500, 1000, 500, 1000], true);
    });

    it('이어폰 연결 + 사운드 재생 실패 + 일반모드 시 5초 후 진동 중지한다', async () => {
      mockIsHeadphonesConnected.mockReturnValue(true);
      mockCreateAsync.mockRejectedValueOnce(new Error('audio error'));
      const cancelSpy = jest.spyOn(Vibration, 'cancel');
      await playAlarmWithRouting(false);
      jest.advanceTimersByTime(5000);
      expect(cancelSpy).toHaveBeenCalled();
    });

    it('재생 전 이전 알람을 정리한다', async () => {
      mockIsHeadphonesConnected.mockReturnValue(true);
      await playAlarmWithRouting(false);
      jest.clearAllMocks();
      mockIsHeadphonesConnected.mockReturnValue(true);
      mockCreateAsync.mockResolvedValue({ sound: mockSound });
      await playAlarmWithRouting(false);
      expect(mockUnloadAsync).toHaveBeenCalled();
    });
  });

  describe('stopAlarm', () => {
    it('재생 중인 사운드를 정리한다', async () => {
      mockIsHeadphonesConnected.mockReturnValue(true);
      await playAlarmWithRouting(true);
      jest.clearAllMocks();
      await stopAlarm();
      expect(mockUnloadAsync).toHaveBeenCalled();
    });

    it('재생 중인 사운드가 없으면 Vibration만 취소한다', async () => {
      const cancelSpy = jest.spyOn(Vibration, 'cancel');
      await stopAlarm();
      expect(cancelSpy).toHaveBeenCalled();
      expect(mockUnloadAsync).not.toHaveBeenCalled();
    });
  });
});
