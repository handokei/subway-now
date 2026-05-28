import { describe, expect, it } from 'vitest';
import { LINE_ALIAS_MAP, canonicalLineName, matchLine } from '../lineAlias';

describe('canonicalLineName (#585)', () => {
  it.each([
    ['1', '1호선'],
    ['7', '7호선'],
    ['gyeongui', '경의중앙선'],
    ['bundang', '수인분당선'],
    ['sinbundang', '신분당선'],
    ['airport', '공항철도'],
  ])('maps line="%s" → "%s"', (line, expected) => {
    expect(canonicalLineName(line)).toBe(expected);
  });

  it('returns null for unknown line', () => {
    expect(canonicalLineName('unknown')).toBeNull();
  });
});

describe('matchLine', () => {
  it('returns false when subwayNm or line is empty', () => {
    expect(matchLine('', '2')).toBe(false);
    expect(matchLine('지하철2호선', '')).toBe(false);
  });

  it.each([
    ['지하철1호선', '1'],
    ['지하철9호선', '9'],
    ['경의중앙선', 'gyeongui'],
    ['지하철경의중앙선', 'gyeongui'],
    ['수인분당선', 'bundang'],
    ['지하철수인분당선', 'bundang'],
    ['분당선', 'bundang'],
    ['신분당선', 'sinbundang'],
    ['지하철신분당선', 'sinbundang'],
    ['공항철도', 'airport'],
    ['인천국제공항철도', 'airport'],
  ])('matches subwayNm="%s" against line="%s"', (subwayNm, line) => {
    expect(matchLine(subwayNm, line)).toBe(true);
  });

  it.each([
    ['지하철1호선', 'gyeongui'],
    ['경의중앙선', '1'],
    ['A선', 'B'],
  ])('rejects subwayNm="%s" against line="%s"', (subwayNm, line) => {
    expect(matchLine(subwayNm, line)).toBe(false);
  });

  it('falls back to substring matching for unmapped line codes', () => {
    expect(matchLine('미래노선', '미래')).toBe(true);
    expect(matchLine('미래', '미래노선')).toBe(true);
  });

  it('covers all line codes present in stations.json', () => {
    const expected = [
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      'gyeongui',
      'bundang',
      'sinbundang',
      'airport',
    ];
    for (const code of expected) {
      expect(LINE_ALIAS_MAP[code]).toBeDefined();
      expect(LINE_ALIAS_MAP[code].length).toBeGreaterThan(0);
    }
  });
});
