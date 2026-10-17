import fs from 'fs';
import path from 'path';
import {
  SEOUL_STATION_QUERY_NAME,
  fromSeoulStationName,
  toSeoulQueryName,
} from '../seoulStationNameMap';

// #2868 (device 편측 확장) — backend/alarm-worker/src/seoulStationNameMap.ts와 동일 35 entry를
// device shared 상수로 복제. device jest는 modulePathIgnorePatterns(`<rootDir>/backend/`)로
// backend 모듈을 직접 import할 수 없어(package.json jest config), fs로 backend 소스를 파싱해
// 두 사본이 drift 나면 이 테스트가 red가 되게 한다.
describe('seoulStationNameMap (#2868 device)', () => {
  it('맵 적용 — 평명이 정식인 역', () => {
    expect(toSeoulQueryName('왕십리(성동구청)')).toBe('왕십리');
    expect(toSeoulQueryName('강변(동서울터미널)')).toBe('강변');
    expect(toSeoulQueryName('흑석(중앙대입구)')).toBe('흑석');
  });

  it('특수 변형 3개는 명시 치환', () => {
    expect(toSeoulQueryName('공릉(서울과학기술대)')).toBe('공릉(서울산업대입구)');
    expect(toSeoulQueryName('자양(뚝섬한강공원)')).toBe('뚝섬유원지');
    expect(toSeoulQueryName('남한산성입구(성남법원.검찰청)')).toBe('남한산성입구(성남법원,검찰청)');
  });

  it('괄호명이 정식인 역은 무변경 — 괄호 일괄 제거 회귀 가드', () => {
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

  describe('backend 사본과 drift 가드', () => {
    function readBackendStationQueryName(): Record<string, string> {
      const backendPath = path.join(
        __dirname,
        '../../../../backend/alarm-worker/src/seoulStationNameMap.ts',
      );
      const source = fs.readFileSync(backendPath, 'utf-8');
      const match = source.match(
        /export const SEOUL_STATION_QUERY_NAME: Readonly<Record<string, string>> = (\{[\s\S]*?\n\});/,
      );
      if (!match) {
        throw new Error('backend SEOUL_STATION_QUERY_NAME 파싱 실패 — 소스 형식이 바뀌었는지 확인');
      }
      // eslint-disable-next-line @typescript-eslint/no-implied-eval -- 우리 레포 소스를 테스트
      // 시점에만 파싱하는 drift 가드. 외부 입력 없음.
      return new Function(`return (${match[1]});`)() as Record<string, string>;
    }

    it('device 맵과 backend 맵의 entry가 완전히 동일하다', () => {
      const backendMap = readBackendStationQueryName();
      expect(SEOUL_STATION_QUERY_NAME).toEqual(backendMap);
    });
  });
});
