import { Audio } from 'expo-av';
import { Vibration } from 'react-native';
import * as AudioRoute from 'audio-route';
import { createLogger } from './logger';

const logger = createLogger('AlarmSound');
const VIBRATION_PATTERN = [0, 1000, 500, 1000, 500, 1000];
const VIBRATION_DURATION_MS = 5000;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ALARM_SOUND = require('../../assets/sounds/alarm.wav');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NOTIFICATION_SOUND = require('../../assets/sounds/notification.wav');

let currentSound: Audio.Sound | null = null;

function vibrateWithTimeout(repeat: boolean): void {
  Vibration.vibrate(VIBRATION_PATTERN, repeat);
  if (!repeat) {
    setTimeout(() => Vibration.cancel(), VIBRATION_DURATION_MS);
  }
}

export async function playAlarmWithRouting(sleepMode: boolean): Promise<void> {
  await stopAlarm();

  // 오디오 세션을 먼저 활성화해야 AVAudioSession.currentRoute가 정확한 출력 경로를 반환한다.
  // 백그라운드(화면 꺼짐)에서는 세션이 비활성 상태라 이어폰 감지가 실패할 수 있다.
  try {
    await Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
    });
  } catch (e) {
    logger.error('오디오 세션 설정 실패, 진동 fallback:', e);
    vibrateWithTimeout(sleepMode);
    return;
  }

  if (AudioRoute.isHeadphonesConnected()) {
    try {
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
    } catch (e) {
      logger.error('사운드 재생 실패, 진동 fallback:', e);
      vibrateWithTimeout(sleepMode);
    }
  } else {
    vibrateWithTimeout(true);
  }
}

export async function stopAlarm(): Promise<void> {
  const sound = currentSound;
  currentSound = null;
  if (sound) {
    try {
      await sound.unloadAsync();
    } catch (e) {
      logger.warn('사운드 해제 실패 (이미 해제됨):', e);
    }
  }
  Vibration.cancel();
}
