import * as Speech from 'expo-speech';
import i18next from 'i18next';
import { speakAlarm } from '../tts';

jest.mock('expo-speech', () => ({
  speak: jest.fn(),
}));

jest.mock('i18next', () => ({
  __esModule: true,
  default: { language: 'ko' },
}));

jest.mock('../logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

describe('speakAlarm', () => {
  const mockSpeak = Speech.speak as jest.Mock;
  const i18n = i18next as unknown as { language: string };

  beforeEach(() => {
    mockSpeak.mockReset();
    i18n.language = 'ko';
  });

  it('허용 조건이면 i18n.language에 매핑된 locale로 발화한다', () => {
    speakAlarm('테스트', { sleepMode: false, allowSpeaker: true });
    expect(mockSpeak).toHaveBeenCalledWith('테스트', { language: 'ko-KR' });
  });

  it.each([
    ['en', 'en-US'],
    ['ja', 'ja-JP'],
    ['zh', 'zh-CN'],
  ])('language=%s이면 locale=%s로 발화한다', (lang, locale) => {
    i18n.language = lang;
    speakAlarm('x', { sleepMode: false, allowSpeaker: true });
    expect(mockSpeak).toHaveBeenCalledWith('x', { language: locale });
  });

  it('알 수 없는 language는 en-US로 폴백한다', () => {
    i18n.language = 'fr';
    speakAlarm('x', { sleepMode: false, allowSpeaker: true });
    expect(mockSpeak).toHaveBeenCalledWith('x', { language: 'en-US' });
  });

  it('sleepMode이면 발화하지 않는다', () => {
    speakAlarm('x', { sleepMode: true, allowSpeaker: true });
    expect(mockSpeak).not.toHaveBeenCalled();
  });

  it('allowSpeaker=false이면 발화하지 않는다', () => {
    speakAlarm('x', { sleepMode: false, allowSpeaker: false });
    expect(mockSpeak).not.toHaveBeenCalled();
  });

  it('Speech.speak가 throw해도 예외를 삼킨다', () => {
    mockSpeak.mockImplementationOnce(() => {
      throw new Error('tts engine failed');
    });
    expect(() => speakAlarm('x', { sleepMode: false, allowSpeaker: true })).not.toThrow();
  });
});
