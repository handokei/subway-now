import { Vibration } from 'react-native';
import { vibrateAlarm, stopVibration } from '../alarmSound';

describe('alarmSound', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('vibrateAlarm', () => {
    it('취침 모드: 반복 진동한다', () => {
      const cancelSpy = jest.spyOn(Vibration, 'cancel');
      const vibrateSpy = jest.spyOn(Vibration, 'vibrate');
      vibrateAlarm(true);
      expect(cancelSpy).toHaveBeenCalled();
      expect(vibrateSpy).toHaveBeenCalledWith([0, 1000, 500, 1000, 500, 1000], true);
    });

    it('일반 모드: 1회 진동 후 5초 뒤 중지한다', () => {
      const cancelSpy = jest.spyOn(Vibration, 'cancel');
      const vibrateSpy = jest.spyOn(Vibration, 'vibrate');
      vibrateAlarm(false);
      expect(vibrateSpy).toHaveBeenCalledWith([0, 1000, 500, 1000, 500, 1000], false);
      cancelSpy.mockClear();
      jest.advanceTimersByTime(5000);
      expect(cancelSpy).toHaveBeenCalled();
    });
  });

  describe('stopVibration', () => {
    it('진동을 취소한다', () => {
      const cancelSpy = jest.spyOn(Vibration, 'cancel');
      stopVibration();
      expect(cancelSpy).toHaveBeenCalled();
    });
  });
});
