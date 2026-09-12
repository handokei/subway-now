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
    it('취침 모드: 반복 진동 + 5초 뒤 자동 중지 (#623 잠금화면 dismiss 무력 회피)', () => {
      const cancelSpy = jest.spyOn(Vibration, 'cancel');
      const vibrateSpy = jest.spyOn(Vibration, 'vibrate');
      vibrateAlarm(true);
      expect(vibrateSpy).toHaveBeenCalledWith([0, 1000, 500, 1000, 500, 1000], true);
      cancelSpy.mockClear();
      jest.advanceTimersByTime(5000);
      expect(cancelSpy).toHaveBeenCalled();
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

  // #1987 (ADR-022 B6) — "안내시작 = 취침모드 강제" 회귀 방지.
  // 사용자 관찰 (2026-06-30, 2026-07-01) : "건대 알림 도착. 계속되는 진동은 취침모드에서만
  // 동작해야 함". `vibrateAlarm` 은 오직 `sleepMode` 파라미터 값으로만 repeat 여부를 결정하고,
  // navigation 상태 / 안내 시작 등 외부 상태가 이 정책을 뒤집을 수 없어야 한다.
  //
  // React Native `Vibration.vibrate(pattern, repeat)` — repeat=true 시 pattern 반복,
  // repeat=false 시 1회 실행. 취침 모드 OFF (repeat=false) → 반복 진동 절대 X.
  describe('#1987 (B6) — sleepMode 파라미터 단독으로 repeat 결정 (안내 시작과 무관)', () => {
    it('sleepMode=false 반복 호출 시 매번 repeat=false (반복 진동 절대 X)', () => {
      const vibrateSpy = jest.spyOn(Vibration, 'vibrate');
      // 안내 시작 후 여러 알람이 연속 fire되는 시나리오 모사.
      vibrateAlarm(false);
      vibrateAlarm(false);
      vibrateAlarm(false);
      // 모든 호출이 repeat=false 로 실행 — 반복 진동 절대 활성화되지 않음.
      const calls = vibrateSpy.mock.calls;
      expect(calls).toHaveLength(3);
      calls.forEach(([, repeat]) => {
        expect(repeat).toBe(false);
      });
    });

    it('sleepMode=true 반복 호출 시 매번 repeat=true (기존 취침 모드 정책 preservation)', () => {
      const vibrateSpy = jest.spyOn(Vibration, 'vibrate');
      vibrateAlarm(true);
      vibrateAlarm(true);
      const calls = vibrateSpy.mock.calls;
      expect(calls).toHaveLength(2);
      calls.forEach(([, repeat]) => {
        expect(repeat).toBe(true);
      });
    });

    it('sleepMode=false → true → false 토글 시나리오 (매 호출 시 파라미터가 SSOT)', () => {
      const vibrateSpy = jest.spyOn(Vibration, 'vibrate');
      vibrateAlarm(false);
      vibrateAlarm(true);
      vibrateAlarm(false);
      expect(vibrateSpy.mock.calls[0][1]).toBe(false);
      expect(vibrateSpy.mock.calls[1][1]).toBe(true);
      expect(vibrateSpy.mock.calls[2][1]).toBe(false);
    });
  });
});
