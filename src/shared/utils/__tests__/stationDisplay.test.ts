import { getStationDisplayName, getStationDisplayNameByName, matchesStationQuery } from '../stationDisplay';
import type { Station } from '../../types/station';
import { installLanguageRestoreHook, setLang } from '../../../testUtils/i18nLanguageOverride';

const stations: Station[] = [
  {
    id: '2-022',
    name: '강남',
    nameEn: 'Gangnam',
    nameJa: 'カンナム',
    nameHanja: '江南',
    line: '2',
    lineColor: '#009D3E',
    lat: 37.5,
    lng: 127,
  },
  { id: '4-001', name: '당고개', nameEn: 'Danggogae', nameJa: 'タンゴゲ', line: '4', lineColor: '#00A2D1', lat: 37.66, lng: 127.07 },
  { id: '5-555', name: '신기역', line: '5', lineColor: '#996CAC', lat: 37, lng: 127 },
];

installLanguageRestoreHook();

describe('getStationDisplayName', () => {
  it('한글 모드 → name', () => {
    setLang('ko');
    expect(getStationDisplayName(stations[0])).toBe('강남');
  });

  it('영문 모드 + nameEn → nameEn', () => {
    setLang('en');
    expect(getStationDisplayName(stations[0])).toBe('Gangnam');
  });

  it('일본어 모드 + nameJa → nameJa', () => {
    setLang('ja');
    expect(getStationDisplayName(stations[0])).toBe('カンナム');
  });

  it('일본어 모드 + nameJa 누락 → nameEn 폴백', () => {
    setLang('ja');
    // 당고개: nameJa 없는 시나리오 시뮬레이션
    expect(getStationDisplayName({ name: '당고개', nameEn: 'Danggogae' })).toBe('Danggogae');
  });

  it('중국어 모드 + nameHanja → nameHanja', () => {
    setLang('zh');
    expect(getStationDisplayName(stations[0])).toBe('江南');
  });

  it('중국어 모드 + nameHanja 누락 → nameEn 폴백', () => {
    setLang('zh');
    expect(getStationDisplayName(stations[1])).toBe('Danggogae');
  });

  it('비한국어 모드 + 모든 다국어 누락 → 한글 방어 폴백', () => {
    setLang('ja');
    expect(getStationDisplayName(stations[2])).toBe('신기역');
  });

  it('미지원 언어 코드 → 영문 우선순위 사용', () => {
    setLang('fr' as never);
    expect(getStationDisplayName(stations[0])).toBe('Gangnam');
  });
});

describe('getStationDisplayNameByName', () => {
  it('한글 모드 → 입력 그대로', () => {
    setLang('ko');
    expect(getStationDisplayNameByName('강남', stations)).toBe('강남');
  });

  it('영문 모드 + 매칭 → nameEn', () => {
    setLang('en');
    expect(getStationDisplayNameByName('강남', stations)).toBe('Gangnam');
  });

  it('일본어 모드 + 매칭 → nameJa', () => {
    setLang('ja');
    expect(getStationDisplayNameByName('강남', stations)).toBe('カンナム');
  });

  it('중국어 모드 + 매칭 → nameHanja', () => {
    setLang('zh');
    expect(getStationDisplayNameByName('강남', stations)).toBe('江南');
  });

  it('비한국어 모드 + 매칭 없음 → 입력 그대로', () => {
    setLang('en');
    expect(getStationDisplayNameByName('없는역', stations)).toBe('없는역');
  });

  it('비한국어 모드 + 다국어 누락 → 한글 방어 폴백', () => {
    setLang('en');
    expect(getStationDisplayNameByName('신기역', stations)).toBe('신기역');
  });
});

describe('matchesStationQuery', () => {
  const station: Station = stations[0];
  const stationNoEn: Station = stations[2];

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
