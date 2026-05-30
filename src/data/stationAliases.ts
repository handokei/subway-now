// 노선별 공식 역명이 달라 정규화(후행 괄호 제거)만으로 매칭되지 않는 환승역 별칭.
// key: 별칭 표기, value: canonical 표기로 통일.
// 예) 4호선 "총신대입구"와 7호선 "이수"는 같은 환승역이지만 공식 표기가 달라
// 별칭 테이블 없이는 transferGraph가 4↔7호선 환승을 이 역에서 도출하지 못한다.
export const STATION_ALIASES: Record<string, string> = {
  이수: '총신대입구',
};

export function applyStationAlias(name: string): string {
  return STATION_ALIASES[name] ?? name;
}
