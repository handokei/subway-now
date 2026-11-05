import { describe, expect, it } from 'vitest';
import {
  SEOUL_STATION_QUERY_NAME,
  fromSeoulStationName,
  toSeoulQueryName,
} from '../seoulStationNameMap';

// #2868 — 2026-10-04 전수 census. 평명이 정식인 32개 + 특수 변형 3개 = 35 entry가 SSoT.
describe('seoulStationNameMap (#2868)', () => {
  it('maps 평명 정식 역 → Seoul 질의명 (괄호 제거)', () => {
    expect(toSeoulQueryName('왕십리(성동구청)')).toBe('왕십리');
    expect(toSeoulQueryName('강변(동서울터미널)')).toBe('강변');
    expect(toSeoulQueryName('흑석(중앙대입구)')).toBe('흑석');
  });

  it('특수 변형 3개는 괄호 제거가 아니라 명시 치환', () => {
    expect(toSeoulQueryName('공릉(서울과학기술대)')).toBe('공릉(서울산업대입구)');
    expect(toSeoulQueryName('자양(뚝섬한강공원)')).toBe('뚝섬유원지');
    expect(toSeoulQueryName('남한산성입구(성남법원.검찰청)')).toBe('남한산성입구(성남법원,검찰청)');
  });

  it('매핑 외 괄호명(정식)은 무변경 — 괄호 일괄 제거 회귀 가드', () => {
    expect(toSeoulQueryName('군자(능동)')).toBe('군자(능동)');
    expect(toSeoulQueryName('어린이대공원(세종대)')).toBe('어린이대공원(세종대)');
    expect(toSeoulQueryName('총신대입구(이수)')).toBe('총신대입구(이수)');
  });

  it('매핑에 없는 역명은 그대로 통과', () => {
    expect(toSeoulQueryName('서울역')).toBe('서울역');
  });

  it('정확히 35 entry', () => {
    expect(Object.keys(SEOUL_STATION_QUERY_NAME)).toHaveLength(35);
  });

  it('역매핑: Seoul 응답명 → stations.json명', () => {
    expect(fromSeoulStationName('왕십리')).toBe('왕십리(성동구청)');
    expect(fromSeoulStationName('뚝섬유원지')).toBe('자양(뚝섬한강공원)');
    expect(fromSeoulStationName('남한산성입구(성남법원,검찰청)')).toBe(
      '남한산성입구(성남법원.검찰청)',
    );
  });

  it('역매핑 외 역명은 그대로 통과', () => {
    expect(fromSeoulStationName('군자(능동)')).toBe('군자(능동)');
    expect(fromSeoulStationName('성수')).toBe('성수');
  });

  // 왕십리는 2·5호선 복수 노선 — 역매핑은 노선 무관 이름 문자열 수준 동일 치환이라 안전.
  it('복수 노선 역(왕십리)도 노선 파라미터 없이 동일 치환 — 충돌 없음', () => {
    expect(toSeoulQueryName('왕십리(성동구청)')).toBe('왕십리');
    expect(fromSeoulStationName('왕십리')).toBe('왕십리(성동구청)');
  });
});
