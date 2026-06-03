import i18next from 'i18next';
import { parseTrainLineDirection, buildDirectionMeta } from '../trainLineDirection';
import type { Station } from '../../types/station';

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
  afterEach(async () => {
    await i18next.changeLanguage('ko');
  });

  describe('nextStationLabel 있음 — 항상 "<name>방면"만', () => {
    it('일반 종착 + 다음역 → 다음역방면만 (종착 제거)', () => {
      expect(buildDirectionMeta('소요산행', '구로', stations)).toBe('구로방면');
    });

    it('5호선 마천행 — 종착 제거, 다음역방면만 (#807 회귀 원본)', () => {
      // 5호선 군자→중곡 진행 시 사용자가 보고 싶은 표시는 "중곡방면"뿐.
      expect(buildDirectionMeta('마천행', '중곡', stations)).toBe('중곡방면');
    });

    it('5호선 방화행 — 반대 방향도 동일하게 다음역방면만', () => {
      expect(buildDirectionMeta('방화행', '광화문', stations)).toBe('광화문방면');
    });

    it('순환선 + 다음역 → 다음역방면 (종착 정보 없으니 항상 방면)', () => {
      expect(buildDirectionMeta('내선순환', '신도림', stations)).toBe('신도림방면');
    });

    it('terminal 일치 케이스도 더 이상 dedup 없이 "<name>방면"', () => {
      // 종착이 사라졌으므로 dedup 개념 자체가 없음. terminal=nextStation도 단순 방면 표기.
      expect(buildDirectionMeta('도봉산행', '도봉산', stations)).toBe('도봉산방면');
    });

    it('괄호 별칭 종착 — 다음역명만 보이므로 별칭 영향 없음', () => {
      expect(buildDirectionMeta('어린이대공원(세종대)방면', '구의', stations)).toBe('구의방면');
    });
  });

  describe('nextStationLabel 없음(null) — 종착 fallback', () => {
    it('일반 종착', () => {
      expect(buildDirectionMeta('소요산행', null, stations)).toBe('소요산행');
    });

    it('순환선', () => {
      expect(buildDirectionMeta('내선순환', null, stations)).toBe('내선순환');
    });

    it('비정형 텍스트도 그대로 fallback', () => {
      expect(buildDirectionMeta('급행임시', null, stations)).toBe('급행임시');
    });
  });

  describe('다국어 — 다음역방면 표기 통일', () => {
    it('en locale: "via <name>" 포맷', async () => {
      await i18next.changeLanguage('en');
      expect(buildDirectionMeta('마천행', '중곡', stations)).toBe('via 중곡');
    });

    it('ja locale: "<name>方面" 포맷', async () => {
      await i18next.changeLanguage('ja');
      expect(buildDirectionMeta('마천행', '중곡', stations)).toBe('중곡方面');
    });

    it('zh locale: "<name>方向" 포맷', async () => {
      await i18next.changeLanguage('zh');
      expect(buildDirectionMeta('마천행', '중곡', stations)).toBe('중곡方向');
    });

    it('en locale + null nextStation → 종착 fallback (Bound for ...)', async () => {
      await i18next.changeLanguage('en');
      expect(buildDirectionMeta('소요산행', null, stations)).toBe('Bound for Soyosan');
    });
  });
});
