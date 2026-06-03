import i18next from 'i18next';
import {
  parseTrainLineDirection,
  getTerminalStationName,
  buildDirectionMeta,
} from '../trainLineDirection';
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

describe('getTerminalStationName (#792)', () => {
  // i18n에 독립적인 순수 추출 함수 — locale 전환 불필요.
  it.each([
    // 일반 종착
    ['도봉산행', '도봉산'],
    ['소요산행', '소요산'],
    ['구로행', '구로'],
    // 방면 패턴 (지선/분기)
    ['어린이대공원방면', '어린이대공원'],
    // 방면 + 괄호 별칭 (#792 회귀 원본)
    ['어린이대공원(세종대)방면', '어린이대공원'],
    ['응암(은평구청)방면', '응암'],
  ])('terminal 추출: "%s" → "%s"', (input, expected) => {
    expect(getTerminalStationName(input)).toBe(expected);
  });

  it.each([
    // 순환선은 종착 없음
    ['내선순환'],
    ['외선순환'],
    // 빈 문자열
    [''],
    // 접미사 단독 입력 — 역명 0길이라 null fallback
    ['방면'],
    ['(별칭)방면'],
    ['행'],
  ])('null 반환: "%s"', (input) => {
    expect(getTerminalStationName(input)).toBeNull();
  });

  it('비정형 텍스트는 null (안전한 fallback — caller가 dedup 못 함)', () => {
    expect(getTerminalStationName('급행임시')).toBeNull();
    expect(getTerminalStationName('운행중')).toBeNull();
  });
});

describe('buildDirectionMeta (#792)', () => {
  afterEach(async () => {
    await i18next.changeLanguage('ko');
  });

  describe('회귀 가드 — substring false-positive 방지', () => {
    it('destination="도봉산행" + nextStationLabel="도봉" → 정상 부착 (terminal "도봉산" ≠ "도봉")', () => {
      // 1호선 망월사 시뮬레이션. 이전 includes() 기반 dedup은 false-positive로 방면 정보를 누락했음.
      expect(buildDirectionMeta('도봉산행', '도봉', stations)).toBe('도봉산행 · 도봉방면');
    });

    it('destination="도봉산행" + nextStationLabel="도봉산" → dedup (terminal 정확 일치)', () => {
      expect(buildDirectionMeta('도봉산행', '도봉산', stations)).toBe('도봉산행');
    });

    it('destination="어린이대공원(세종대)방면" + nextStationLabel="어린이대공원" → dedup (#792 원본 회귀)', () => {
      expect(buildDirectionMeta('어린이대공원(세종대)방면', '어린이대공원', stations)).toBe(
        '어린이대공원(세종대)방면',
      );
    });
  });

  describe('순환선/nextStationLabel 미전달', () => {
    it('nextStationLabel=null이면 종착만 표기', () => {
      expect(buildDirectionMeta('소요산행', null, stations)).toBe('소요산행');
    });

    it('순환선은 terminal null이라 항상 부속 라벨 부착 (nextStationLabel 있을 때)', () => {
      expect(buildDirectionMeta('내선순환', '신도림', stations)).toBe('내선순환 · 신도림방면');
    });

    it('순환선 + nextStationLabel=null → 순환선만', () => {
      expect(buildDirectionMeta('내선순환', null, stations)).toBe('내선순환');
    });
  });

  describe('다국어 (#792 P1-2)', () => {
    it('en locale에서도 dedup 정상 동작 (terminal 비교는 i18n 독립)', async () => {
      await i18next.changeLanguage('en');
      expect(buildDirectionMeta('어린이대공원(세종대)방면', '어린이대공원', stations)).toBe(
        '어린이대공원(세종대)방면',
      );
    });

    it('en locale 부속 라벨은 "via {{name}}" 포맷', async () => {
      await i18next.changeLanguage('en');
      expect(buildDirectionMeta('소요산행', '구로', stations)).toBe('Bound for Soyosan · via 구로');
    });

    it('ja locale 부속 라벨은 "{{name}}方面" 포맷 (역명은 nameJa 없으면 nameEn fallback)', async () => {
      await i18next.changeLanguage('ja');
      expect(buildDirectionMeta('소요산행', '구로', stations)).toBe('Soyosan行き · 구로方面');
    });

    it('zh locale 부속 라벨은 "{{name}}方向" 포맷 (역명은 nameHanja 없으면 nameEn fallback)', async () => {
      await i18next.changeLanguage('zh');
      expect(buildDirectionMeta('소요산행', '구로', stations)).toBe('开往Soyosan · 구로方向');
    });
  });
});
