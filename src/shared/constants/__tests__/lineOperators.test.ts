import {
  LINE_OPERATORS,
  getLineOperator,
  isKorailLine,
} from '../lineOperators';
import type { LineNumber } from '../../types/station';

describe('lineOperators', () => {
  it('LINE_OPERATORS는 모든 LineNumber에 대해 운영사를 매핑한다', () => {
    const lines: LineNumber[] = [
      '1', '2', '3', '4', '5', '6', '7', '8', '9',
      'airport', 'gyeongui', 'bundang', 'sinbundang',
    ];
    for (const line of lines) {
      expect(LINE_OPERATORS[line]).toBeDefined();
    }
  });

  it('1~9호선은 seoul 운영사로 매핑된다', () => {
    expect(getLineOperator('1')).toBe('seoul');
    expect(getLineOperator('2')).toBe('seoul');
    expect(getLineOperator('3')).toBe('seoul');
    expect(getLineOperator('4')).toBe('seoul');
    expect(getLineOperator('5')).toBe('seoul');
    expect(getLineOperator('6')).toBe('seoul');
    expect(getLineOperator('7')).toBe('seoul');
    expect(getLineOperator('8')).toBe('seoul');
    expect(getLineOperator('9')).toBe('seoul');
  });

  it('경의중앙선/수인분당선은 korail 운영사로 매핑된다', () => {
    expect(getLineOperator('gyeongui')).toBe('korail');
    expect(getLineOperator('bundang')).toBe('korail');
  });

  it('공항철도/신분당선은 other 운영사로 매핑된다', () => {
    expect(getLineOperator('airport')).toBe('other');
    expect(getLineOperator('sinbundang')).toBe('other');
  });

  describe('isKorailLine', () => {
    it('Korail 운영 노선만 true', () => {
      expect(isKorailLine('gyeongui')).toBe(true);
      expect(isKorailLine('bundang')).toBe(true);
    });

    it('비-Korail 노선은 false', () => {
      expect(isKorailLine('1')).toBe(false);
      expect(isKorailLine('9')).toBe(false);
      expect(isKorailLine('airport')).toBe(false);
      expect(isKorailLine('sinbundang')).toBe(false);
    });
  });
});
