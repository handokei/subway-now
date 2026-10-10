import { Vibration } from 'react-native';

const VIBRATION_PATTERN = [0, 1000, 500, 1000, 500, 1000];
// 잠금화면 swipe-dismiss는 iOS가 JS bridge를 깨우지 않아 외부에서 진동을 멈출 신호가 없다(#623).
// 따라서 sleepMode 여부와 무관하게 항상 cap을 걸어 자동 종료 보장. SleepAlarmOverlay/listener는
// 추가 안전망일 뿐 — 진동 종료 약속의 SSOT는 이 timeout.
const VIBRATION_DURATION_MS = 5000;

export function vibrateAlarm(sleepMode: boolean): void {
  Vibration.cancel();
  Vibration.vibrate(VIBRATION_PATTERN, sleepMode);
  setTimeout(() => Vibration.cancel(), VIBRATION_DURATION_MS);
}

export function stopVibration(): void {
  Vibration.cancel();
}
