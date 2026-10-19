import stationsData from '../../../data/stations.json';
import type { Station } from '../../types/station';
import { searchStations } from '../fuzzyStationSearch';
import { matchesStationQuery } from '../stationDisplay';
import { normalizeStationName } from '../normalizeStationName';

const allStations = stationsData as Station[];
const LIMIT = 8;
const baseNames = (query: string, limit = LIMIT): string[] =>
  searchStations(allStations, query, limit).map((s) => normalizeStationName(s.name));

describe('searchStations — verbatim 오타 (#3067)', () => {
  it.each(['광화몬', '광회문', '광호ㅓ몬'])('"%s" → 광화문 노출', (typo) => {
    expect(baseNames(typo)).toContain('광화문');
  });

  it('IME 조합 중 입력(자모 prefix) — "광화ㅁ" → 광화문 노출', () => {
    expect(baseNames('광화ㅁ')).toContain('광화문');
  });
});

describe('searchStations — 거부/회귀 금지', () => {
  it('"강남" 입력에 광화문 미노출 + 강남이 최상위', () => {
    const names = baseNames('강남');
    expect(names).not.toContain('광화문');
    expect(names[0]).toBe('강남');
  });

  it('전방일치가 최상위', () => {
    const [top] = searchStations(allStations, '서울', LIMIT);
    expect(top.name.startsWith('서울')).toBe(true);
  });

  it('기존 부분일치 결과 집합은 전부 보존(퍼지는 뒤에만 추가)', () => {
    const legacy = allStations.filter((s) => matchesStationQuery(s, '문', '문'));
    const got = new Set(searchStations(allStations, '문', 1000));
    for (const s of legacy) expect(got.has(s)).toBe(true);
  });

  it('랭킹: 전방일치 < 부분일치 < 퍼지 순', () => {
    const stations = [
      { name: '가나다광화문', nameEn: 'A' },
      { name: '광화문', nameEn: 'B' },
      { name: '광회문', nameEn: 'C' },
    ] as Station[];
    expect(searchStations(stations, '광화문', 10).map((s) => s.name)).toEqual([
      '광화문',
      '가나다광화문',
      '광회문',
    ]);
  });

  it('퍼지 단계는 편집거리 오름차순 (거리 2 입력이 앞에 있어도 거리 1이 먼저)', () => {
    const stations = [
      { name: '광회몬', nameEn: 'A' },
      { name: '광화몬', nameEn: 'B' },
    ] as Station[];
    expect(searchStations(stations, '광화문', 10).map((s) => s.name)).toEqual(['광화몬', '광회몬']);
  });

  it('영문 쿼리는 영문명 부분일치만, 퍼지 미적용', () => {
    const stations = [{ name: '강남', nameEn: 'Gangnam' }] as Station[];
    expect(searchStations(stations, 'gangn', 5)).toHaveLength(1);
    expect(searchStations(stations, 'gangnom', 5)).toHaveLength(0);
  });

  it('빈/공백 쿼리 → 빈 배열, limit 적용', () => {
    expect(searchStations(allStations, '   ', 5)).toEqual([]);
    expect(searchStations(allStations, '역', 3)).toHaveLength(3);
  });

  it('nameEn 없는 역도 안전', () => {
    const stations = [{ name: '강남' }] as Station[];
    expect(searchStations(stations, 'x', 5)).toEqual([]);
  });
});

describe('searchStations — 성능', () => {
  it('528역 키스트로크당 50ms 미만', () => {
    const start = Date.now();
    for (let i = 0; i < 20; i += 1) searchStations(allStations, '광호ㅓ몬', LIMIT);
    expect((Date.now() - start) / 20).toBeLessThan(50);
  });
});
