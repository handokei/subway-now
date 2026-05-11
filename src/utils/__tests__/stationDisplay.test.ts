import { getStationDisplayName, getStationDisplayNameByName, matchesStationQuery } from '../stationDisplay';
import type { Station } from '../../types/station';
import { installLanguageRestoreHook, setLang } from '../../testUtils/i18nLanguageOverride';

const stations: Station[] = [
  { id: '2-022', name: '강남', nameEn: 'Gangnam', line: '2', lineColor: '#009D3E', lat: 37.5, lng: 127 },
  { id: '4-001', name: '당고개', nameEn: 'Danggogae', line: '4', lineColor: '#00A2D1', lat: 37.66, lng: 127.07 },
  { id: '5-555', name: '신기역', line: '5', lineColor: '#996CAC', lat: 37, lng: 127 },
];

// 비한국어(en/ja 등)는 모두 동일 분기(nameEn fallback)를 타므로 데이터 주도로 검증한다.
// zh 등 새 언어 추가 시 이 배열에 한 줄만 추가하면 동일 검증이 자동 적용된다.
const NON_KO_LANGUAGES = ['en', 'ja'] as const;

installLanguageRestoreHook();

describe('getStationDisplayName', () => {
  it.each(NON_KO_LANGUAGES)('비한국어 모드(%s) + nameEn 존재 → nameEn 반환', (lang) => {
    setLang(lang);
    expect(getStationDisplayName(stations[0])).toBe('Gangnam');
  });

  it.each(NON_KO_LANGUAGES)('비한국어 모드(%s) + nameEn 누락 → 한글 fallback', (lang) => {
    setLang(lang);
    expect(getStationDisplayName(stations[2])).toBe('신기역');
  });

  it('한글 모드 → nameEn 있어도 한글 반환', () => {
    setLang('ko');
    expect(getStationDisplayName(stations[0])).toBe('강남');
  });
});

describe('getStationDisplayNameByName', () => {
  it.each(NON_KO_LANGUAGES)('비한국어 모드(%s) + 매칭되는 nameEn → 영문 반환', (lang) => {
    setLang(lang);
    expect(getStationDisplayNameByName('강남', stations)).toBe('Gangnam');
  });

  it('영문 모드 + 매칭 안 됨 → 입력 그대로 반환', () => {
    setLang('en');
    expect(getStationDisplayNameByName('없는역', stations)).toBe('없는역');
  });

  it('영문 모드 + nameEn 누락된 매칭 → 한글 fallback', () => {
    setLang('en');
    expect(getStationDisplayNameByName('신기역', stations)).toBe('신기역');
  });

  it('한글 모드 → 항상 입력 그대로', () => {
    setLang('ko');
    expect(getStationDisplayNameByName('강남', stations)).toBe('강남');
  });
});

describe('matchesStationQuery', () => {
  const station: Station = stations[0]; // 강남 / Gangnam
  const stationNoEn: Station = stations[2]; // 신기역 / nameEn 없음

  it('한글 부분 일치', () => {
    expect(matchesStationQuery(station, '강', '강')).toBe(true);
  });

  it('영문 부분 일치 (대소문자 무관)', () => {
    expect(matchesStationQuery(station, 'GANG', 'gang')).toBe(true);
  });

  it('한글/영문 모두 매칭 안 됨', () => {
    expect(matchesStationQuery(station, 'xyz', 'xyz')).toBe(false);
  });

  it('nameEn 누락 + 한글 매칭 안 됨 → false', () => {
    expect(matchesStationQuery(stationNoEn, 'xyz', 'xyz')).toBe(false);
  });

  it('nameEn 누락 + 한글 매칭 → true', () => {
    expect(matchesStationQuery(stationNoEn, '신기', '신기')).toBe(true);
  });
});
