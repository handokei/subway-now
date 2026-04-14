import { Audio } from 'expo-av';
import { Vibration } from 'react-native';
import * as AudioRoute from 'audio-route';

const VIBRATION_PATTERN = [0, 1000, 500, 1000, 500, 1000];
const VIBRATION_DURATION_MS = 5000;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ALARM_SOUND = require('../../assets/sounds/alarm.wav');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NOTIFICATION_SOUND = require('../../assets/sounds/notification.wav');

let currentSound: Audio.Sound | null = null;

export async function playAlarmWithRouting(sleepMode: boolean): Promise<void> {
  await stopAlarm();

  // 오디오 세션을 먼저 활성화해야 AVAudioSession.currentRoute가 정확한 출력 경로를 반환한다.
  // 백그라운드(화면 꺼짐)에서는 세션이 비활성 상태라 이어폰 감지가 실패할 수 있다.
  await Audio.setAudioModeAsync({
    playsInSilentModeIOS: true,
    staysActiveInBackground: true,
  });

  if (AudioRoute.isHeadphonesConnected()) {
    const source = sleepMode ? ALARM_SOUND : NOTIFICATION_SOUND;
    const { sound } = await Audio.Sound.createAsync(source);
    currentSound = sound;

    if (sleepMode) {
      await sound.setIsLoopingAsync(true);
    }

    await sound.playAsync();

    if (!sleepMode) {
      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded && status.didJustFinish) {
          sound.unloadAsync();
          currentSound = null;
        }
      });
    }
  } else {
    Vibration.vibrate(VIBRATION_PATTERN, true);
    setTimeout(() => Vibration.cancel(), VIBRATION_DURATION_MS);
  }
}

export async function stopAlarm(): Promise<void> {
  const sound = currentSound;
  currentSound = null;
  if (sound) {
    await sound.unloadAsync();
  }
  Vibration.cancel();
}
