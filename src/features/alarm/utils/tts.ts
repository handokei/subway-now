import * as Speech from 'expo-speech';
import i18next from 'i18next';
import { FALLBACK_LANGUAGE, LANGUAGE_REGISTRY } from '../../../shared/i18n/types';
import { createLogger } from '../../../shared/utils/logger';

const logger = createLogger('TTS');

const FALLBACK_TTS_LOCALE =
  LANGUAGE_REGISTRY.find((l) => l.code === FALLBACK_LANGUAGE)!.ttsLocale;

function resolveTtsLocale(language: string): string {
  return (
    LANGUAGE_REGISTRY.find((l) => l.code === language)?.ttsLocale ?? FALLBACK_TTS_LOCALE
  );
}

export interface TtsGate {
  sleepMode: boolean;
  allowSpeaker: boolean;
}

export function speakAlarm(text: string, gate: TtsGate): void {
  if (gate.sleepMode || !gate.allowSpeaker) {
    return;
  }
  try {
    Speech.stop();
    Speech.speak(text, { language: resolveTtsLocale(i18next.language) });
  } catch (e) {
    logger.error('speak failed:', e);
  }
}
