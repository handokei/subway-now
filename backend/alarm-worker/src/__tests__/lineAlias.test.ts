import { describe, expect, it } from 'vitest';
import { LINE_ALIAS_MAP, matchLine } from '../lineAlias';

describe('matchLine', () => {
  it('returns false when subwayNm or line is empty', () => {
    expect(matchLine('', '2')).toBe(false);
    expect(matchLine('지하철2호선', '')).toBe(false);
  });

  it('matches numeric line codes against Seoul API names', () => {
    expect(matchLine('지하철1호선', '1')).toBe(true);
    expect(matchLine('지하철9호선', '9')).toBe(true);
  });

  it('matches gyeongui code against various Seoul API spellings', () => {
    expect(matchLine('경의중앙선', 'gyeongui')).toBe(true);
    expect(matchLine('지하철경의중앙선', 'gyeongui')).toBe(true);
  });

  it('matches bundang code', () => {
    expect(matchLine('수인분당선', 'bundang')).toBe(true);
    expect(matchLine('지하철수인분당선', 'bundang')).toBe(true);
    expect(matchLine('분당선', 'bundang')).toBe(true);
  });

  it('matches sinbundang code', () => {
    expect(matchLine('신분당선', 'sinbundang')).toBe(true);
    expect(matchLine('지하철신분당선', 'sinbundang')).toBe(true);
  });

  it('matches airport code', () => {
    expect(matchLine('공항철도', 'airport')).toBe(true);
    expect(matchLine('인천국제공항철도', 'airport')).toBe(true);
  });

  it('rejects mismatched lines for aliased codes', () => {
    expect(matchLine('지하철1호선', 'gyeongui')).toBe(false);
    expect(matchLine('경의중앙선', '1')).toBe(false);
  });

  it('falls back to substring matching for unmapped line codes', () => {
    expect(matchLine('미래노선', '미래')).toBe(true);
    expect(matchLine('미래', '미래노선')).toBe(true);
    expect(matchLine('A선', 'B')).toBe(false);
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
