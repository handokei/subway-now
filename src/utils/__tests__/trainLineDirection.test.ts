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

  it.each([
    // [lang, input, expected, 설명]
    ['ko', '내선순환', '내선순환'],
    ['en', '내선순환', 'Inner Loop'],
    ['ko', '외선순환', '외선순환'],
    ['en', '외선순환', 'Outer Loop'],
    ['ko', '소요산행', '소요산행'],
    ['en', '소요산행', 'Bound for Soyosan'],
    ['en', '알수없는행', 'Bound for 알수없는'],
    ['en', '없는역행', 'Bound for 없는역'],
    ['ko', '급행임시', '급행임시'],
    ['en', '', ''],
    ['en', '행', '행'],
  ])('lang=%s, input=%s → %s', async (lang, input, expected) => {
    await i18next.changeLanguage(lang);
    expect(parseTrainLineDirection(input, stations)).toBe(expected);
  });
});
