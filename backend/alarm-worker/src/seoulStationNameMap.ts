/**
 * Seoul Open API 역명 매핑 (#2868).
 *
 * stations.json 역명(앱 전역 SSoT, BLDN_NM)과 Seoul Open API가 실제로 받아들이는/응답하는
 * 역명이 다른 35역 전수 매핑. 2026-10-04 전수 census 결과(라이브 API 실질의 + R2 캡처 어휘
 * 역방향 대조, 전 항목 실측)가 SSoT — 이 표가 코드다.
 *
 * - 평명이 정식인 32역: stations.json은 괄호 부기명을 쓰지만 Seoul은 평명만 받는다
 *   (예: '왕십리(성동구청)' → '왕십리').
 * - 특수 변형 3역: 괄호 제거로는 못 고친다 — Seoul이 구 부기명/구 역명/구두점을 다르게 쓴다.
 *
 * 괄호명이 정식인 19역(군자(능동), 어린이대공원(세종대), 총신대입구(이수) 등)은 이 맵에
 * **의도적으로 없다** — 현재 Seoul API가 괄호명 그대로 정상 응답한다(캡처 어휘로 확증).
 * **괄호 일괄 제거 normalize 함수를 만들지 말 것** — 이 19역을 역으로 부순다.
 */
export const SEOUL_STATION_QUERY_NAME: Readonly<Record<string, string>> = {
  // 평명이 정식 (32)
  '강변(동서울터미널)': '강변',
  '경복궁(정부서울청사)': '경복궁',
  '고려대(종암)': '고려대',
  '광교(경기대)': '광교',
  '광교중앙(아주대)': '광교중앙',
  '광화문(세종문화회관)': '광화문',
  '광흥창(서강)': '광흥창',
  '교대(법원.검찰청)': '교대',
  '구의(광진구청)': '구의',
  '남부터미널(예술의전당)': '남부터미널',
  '녹사평(용산구청)': '녹사평',
  '대림(구로구청)': '대림',
  '동작(현충원)': '동작',
  '미아(서울사이버대학)': '미아',
  '봉화산(서울의료원)': '봉화산',
  '삼성(무역센터)': '삼성',
  '상봉(시외버스터미널)': '상봉',
  '서울대입구(관악구청)': '서울대입구',
  '성신여대입구(돈암)': '성신여대입구',
  '수유(강북구청)': '수유',
  '숙대입구(갈월)': '숙대입구',
  '양재(서초구청)': '양재',
  '양재시민의숲(매헌)': '양재시민의숲',
  '온수(성공회대입구)': '온수',
  '왕십리(성동구청)': '왕십리',
  '이촌(국립중앙박물관)': '이촌',
  '잠실(송파구청)': '잠실',
  '청량리(서울시립대입구)': '청량리',
  '충정로(경기대입구)': '충정로',
  '한성대입구(삼선교)': '한성대입구',
  '회현(남대문시장)': '회현',
  '흑석(중앙대입구)': '흑석',
  // 특수 변형 (3) — 괄호 제거로는 못 고침
  '공릉(서울과학기술대)': '공릉(서울산업대입구)', // Seoul이 구 부기명 유지
  '자양(뚝섬한강공원)': '뚝섬유원지', // Seoul이 구 역명 전체 유지
  '남한산성입구(성남법원.검찰청)': '남한산성입구(성남법원,검찰청)', // 마침표→쉼표
};

/**
 * Seoul API 응답 역명(realtimePosition statnNm 등) → stations.json 역명. 역매핑.
 * `SEOUL_STATION_QUERY_NAME`에서 자동 역산 — 두 맵이 별도 손유지되며 drift 나는 것을 방지.
 */
export const SEOUL_RESPONSE_STATION_NAME: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(SEOUL_STATION_QUERY_NAME).map(([stationsJsonName, seoulName]) => [
    seoulName,
    stationsJsonName,
  ]),
);

/**
 * stations.json 역명 → Seoul API 질의/응답 역명. `fetchArrivals` URL 생성 직전에만 적용 —
 * 매핑에 없는 역은 원명 그대로 통과(괄호명이 정식인 19역 포함).
 */
export function toSeoulQueryName(stationsJsonName: string): string {
  return SEOUL_STATION_QUERY_NAME[stationsJsonName] ?? stationsJsonName;
}

/**
 * Seoul API 응답 역명 → stations.json 역명. `parsePositionEntry`에서만 적용 —
 * 매핑에 없는 역은 원명 그대로 통과.
 */
export function fromSeoulStationName(seoulName: string): string {
  return SEOUL_RESPONSE_STATION_NAME[seoulName] ?? seoulName;
}
