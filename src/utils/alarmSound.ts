import { Vibration } from 'react-native';

const VIBRATION_PATTERN = [0, 1000, 500, 1000, 500, 1000];
const VIBRATION_DURATION_MS = 5000;

export function vibrateAlarm(sleepMode: boolean): void {
  Vibration.cancel();
  Vibration.vibrate(VIBRATION_PATTERN, sleepMode);
  if (!sleepMode) {
    setTimeout(() => Vibration.cancel(), VIBRATION_DURATION_MS);
  }
}

export function stopVibration(): void {
  Vibration.cancel();
}
