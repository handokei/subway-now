import ko from '../locales/ko.json';
import en from '../locales/en.json';
import ja from '../locales/ja.json';
import zh from '../locales/zh.json';
import { FEEDBACK_CATEGORIES } from '../../constants/feedbackCategories';

type FeedbackLocale = {
  feedback: Record<string, unknown> & { category?: Record<string, unknown> };
};

const LOCALES: Record<string, FeedbackLocale> = { ko, en, ja, zh } as Record<string, FeedbackLocale>;
const FLAT_KEYS = ['whereWrong', 'stationSearchPlaceholder', 'recommended', 'stationClear', 'attachNotice'];

describe('feedback 로케일 키 (#3366)', () => {
  it('카테고리 enum은 서버 계약 7종', () => {
    expect([...FEEDBACK_CATEGORIES]).toEqual([
      'alarm-missing',
      'alarm-late',
      'alarm-early',
      'wrong-station',
      'wrong-door',
      'boarding-not-detected',
      'other',
    ]);
  });

  describe.each(Object.keys(LOCALES))('%s', (lang) => {
    const { feedback } = LOCALES[lang];

    it.each(FLAT_KEYS)('feedback.%s 존재', (key) => {
      expect(typeof feedback[key]).toBe('string');
      expect((feedback[key] as string).length).toBeGreaterThan(0);
    });

    it.each([...FEEDBACK_CATEGORIES])('feedback.category.%s 존재', (category) => {
      const label = feedback.category?.[category];
      expect(typeof label).toBe('string');
      expect((label as string).length).toBeGreaterThan(0);
    });
  });

  it('ko 안내 문구는 스펙 한 줄 그대로', () => {
    expect(ko.feedback.attachNotice).toBe(
      '앱 버전·기기·최근 이동 기록(위치 좌표 제외)이 함께 전송됩니다',
    );
  });
});
