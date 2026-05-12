import { parseTrainType, parseTrainTypeFromDirectAt, TRAIN_TYPE_LABEL } from '../trainTypes';

describe('parseTrainType', () => {
  it('급행/ITX/특급 정확히 매핑', () => {
    expect(parseTrainType('급행')).toBe('express');
    expect(parseTrainType('ITX')).toBe('itx');
    expect(parseTrainType('특급')).toBe('rapid');
  });

  it('일반/누락/비문자열은 normal로 fallback', () => {
    expect(parseTrainType('일반')).toBe('normal');
    expect(parseTrainType('')).toBe('normal');
    expect(parseTrainType(undefined)).toBe('normal');
    expect(parseTrainType(null)).toBe('normal');
    expect(parseTrainType(123)).toBe('normal');
  });

  it('앞뒤 공백 trim', () => {
    expect(parseTrainType(' 급행 ')).toBe('express');
  });
});

describe('TRAIN_TYPE_LABEL', () => {
  it('각 타입의 라벨이 정의됨, normal은 빈 문자열', () => {
    expect(TRAIN_TYPE_LABEL.express).toBe('급행');
    expect(TRAIN_TYPE_LABEL.itx).toBe('ITX');
    expect(TRAIN_TYPE_LABEL.rapid).toBe('특급');
    expect(TRAIN_TYPE_LABEL.normal).toBe('');
  });
});

describe('parseTrainTypeFromDirectAt (realtimePosition API)', () => {
  it('1=express, 7=rapid, 0=normal', () => {
    expect(parseTrainTypeFromDirectAt(1)).toBe('express');
    expect(parseTrainTypeFromDirectAt(7)).toBe('rapid');
    expect(parseTrainTypeFromDirectAt(0)).toBe('normal');
  });

  it('숫자 문자열도 파싱', () => {
    expect(parseTrainTypeFromDirectAt('1')).toBe('express');
    expect(parseTrainTypeFromDirectAt('7')).toBe('rapid');
  });

  it('비숫자/누락은 normal', () => {
    expect(parseTrainTypeFromDirectAt(undefined)).toBe('normal');
    expect(parseTrainTypeFromDirectAt(null)).toBe('normal');
    expect(parseTrainTypeFromDirectAt('abc')).toBe('normal');
    expect(parseTrainTypeFromDirectAt(99)).toBe('normal');
  });
});
