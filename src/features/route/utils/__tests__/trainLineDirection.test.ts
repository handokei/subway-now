import i18next from 'i18next';
import { parseTrainLineDirection, buildDirectionMeta } from '../trainLineDirection';
import type { Station } from '../../../../shared/types/station';

const stations: Station[] = [
  { id: '1-001', name: '소요산', nameEn: 'Soyosan', line: '1', lineColor: '#0052A4', lat: 37, lng: 127 },
  { id: '1-141', name: '구로', nameEn: 'Guro', line: '1', lineColor: '#0052A4', lat: 37, lng: 127 },
  { id: '1-100', name: '도봉산', nameEn: 'Dobongsan', line: '1', lineColor: '#0052A4', lat: 37, lng: 127 },
  { id: '5-555', name: '없는역', line: '5', lineColor: '#996CAC', lat: 37, lng: 127 },
  { id: '5-216', name: '어린이대공원', nameEn: 'Children\'s Grand Park', line: '5', lineColor: '#996CAC', lat: 37, lng: 127 },
];

describe('parseTrainLineDirection', () => {
  afterEach(async () => {
    await i18next.changeLanguage('ko');
  });

  it.each([
    // [lang, input, expected]
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

describe('buildDirectionMeta (#807)', () => {
  // #807: 종착(마천행/방화행 등) 제거, **다음 인접역 방면**만 노출. nextStationLabel 미전달 시에만
  // 종착 fallback. terminal/destination 비교 없이 일관 통일.
  // 동일 어설션 블록 중복(SonarCloud CPD)을 피하기 위해 시나리오를 데이터 테이블로 통합.
  afterEach(async () => {
    await i18next.changeLanguage('ko');
  });

  // nextStationLabel 있음 — 항상 "<name>방면"만. (label, lang, destination, next, expected)
  it.each<[string, string, string, string, string]>([
    ['ko / 일반 종착', 'ko', '소요산행', '구로', '구로방면'],
    // 5호선 회귀 원본: 마천행/방화행 → 다음역방면만
    ['ko / 5호선 마천행', 'ko', '마천행', '중곡', '중곡방면'],
    ['ko / 5호선 방화행', 'ko', '방화행', '광화문', '광화문방면'],
    ['ko / 순환선', 'ko', '내선순환', '신도림', '신도림방면'],
    ['ko / terminal=next dedup 없이 next방면', 'ko', '도봉산행', '도봉산', '도봉산방면'],
    ['ko / 괄호 별칭 종착도 next방면만', 'ko', '어린이대공원(세종대)방면', '구의', '구의방면'],
    // 다국어 통일 — terminal과 무관하게 next만 i18n 변환
    ['en / via', 'en', '마천행', '중곡', 'via 중곡'],
    ['ja / 方面', 'ja', '마천행', '중곡', '중곡方面'],
    ['zh / 方向', 'zh', '마천행', '중곡', '중곡方向'],
  ])('%s', async (_, lang, destination, next, expected) => {
    await i18next.changeLanguage(lang);
    expect(buildDirectionMeta(destination, next, stations)).toBe(expected);
  });

  // nextStationLabel 없음(null) — 종착 fallback. (label, lang, destination, expected)
  it.each<[string, string, string, string]>([
    ['ko / 일반 종착', 'ko', '소요산행', '소요산행'],
    ['ko / 순환선', 'ko', '내선순환', '내선순환'],
    ['ko / 비정형 텍스트', 'ko', '급행임시', '급행임시'],
    ['en / 종착 fallback (Bound for ...)', 'en', '소요산행', 'Bound for Soyosan'],
  ])('null nextStation — %s', async (_, lang, destination, expected) => {
    await i18next.changeLanguage(lang);
    expect(buildDirectionMeta(destination, null, stations)).toBe(expected);
  });
});
