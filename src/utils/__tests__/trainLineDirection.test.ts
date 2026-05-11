import i18next from 'i18next';
import { parseTrainLineDirection } from '../trainLineDirection';
import type { Station } from '../../types/station';

const stations: Station[] = [
  { id: '1-001', name: '소요산', nameEn: 'Soyosan', line: '1', lineColor: '#0052A4', lat: 37, lng: 127 },
  { id: '1-141', name: '구로', nameEn: 'Guro', line: '1', lineColor: '#0052A4', lat: 37, lng: 127 },
  { id: '5-555', name: '없는역', line: '5', lineColor: '#996CAC', lat: 37, lng: 127 },
];

describe('parseTrainLineDirection', () => {
  afterEach(async () => {
    await i18next.changeLanguage('ko');
  });

  describe('내선/외선순환', () => {
    it('한글 모드: 내선순환은 그대로', () => {
      expect(parseTrainLineDirection('내선순환', stations)).toBe('내선순환');
    });

    it('영문 모드: 내선순환 → Inner Loop', async () => {
      await i18next.changeLanguage('en');
      expect(parseTrainLineDirection('내선순환', stations)).toBe('Inner Loop');
    });

    it('한글 모드: 외선순환은 그대로', () => {
      expect(parseTrainLineDirection('외선순환', stations)).toBe('외선순환');
    });

    it('영문 모드: 외선순환 → Outer Loop', async () => {
      await i18next.changeLanguage('en');
      expect(parseTrainLineDirection('외선순환', stations)).toBe('Outer Loop');
    });
  });

  describe('X행 패턴', () => {
    it('한글 모드: 소요산행은 그대로 표시', () => {
      expect(parseTrainLineDirection('소요산행', stations)).toBe('소요산행');
    });

    it('영문 모드: 소요산행 → Bound for Soyosan', async () => {
      await i18next.changeLanguage('en');
      expect(parseTrainLineDirection('소요산행', stations)).toBe('Bound for Soyosan');
    });

    it('영문 모드: 매칭 안 되는 역명 → 한글 그대로 boundFor', async () => {
      await i18next.changeLanguage('en');
      expect(parseTrainLineDirection('알수없는행', stations)).toBe('Bound for 알수없는');
    });

    it('nameEn 누락된 역의 X행 → 한글 fallback', async () => {
      await i18next.changeLanguage('en');
      expect(parseTrainLineDirection('없는역행', stations)).toBe('Bound for 없는역');
    });
  });

  describe('알 수 없는 패턴', () => {
    it('한글 모드: 패턴 외 입력은 원본 그대로', () => {
      expect(parseTrainLineDirection('급행임시', stations)).toBe('급행임시');
    });

    it('영문 모드: 빈 문자열 → 그대로', async () => {
      await i18next.changeLanguage('en');
      expect(parseTrainLineDirection('', stations)).toBe('');
    });

    it('영문 모드: "행" 단독 → 원본 그대로 (빈 역명 가드)', async () => {
      await i18next.changeLanguage('en');
      expect(parseTrainLineDirection('행', stations)).toBe('행');
    });
  });
});
